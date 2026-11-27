import { Color3, Light, PBRMaterial, PointLight, SpotLight, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import type { AbstractMesh, Scene } from "@babylonjs/core";
import { qualityManager } from "../core/perf/QualityManager";
import { PauliBeam } from "./PauliBeam";

const PREFIX = "library:Scenario/SalaoPauli/";
const FIXTURES = {
  [`${PREFIX}light_spot.glb`]: {
    lens: "Pauli lente RGB spot", kind: "spot", height: 0.287, front: 0.275,
    range: 7, intensity: 1.85, colors: ["#E13CF3", "#2FA1FF", "#FFD169", "#FD4483"],
  },
  [`${PREFIX}light_wash.glb`]: {
    lens: "Pauli lente RGB wash", kind: "wash", height: 0.128, front: 0.181,
    range: 5, intensity: 1.35, colors: ["#34D3FF", "#EB466C", "#6755FF", "#38F3C9"],
  },
  [`${PREFIX}light_disco.glb`]: {
    lens: "Pauli disco rotor", kind: "disco", height: 0, front: 0,
    range: 8, intensity: 2.2, colors: ["#FF4DAE", "#32BAFF", "#A275FF", "#4DFFB6", "#FFCA58", "#F26FFF"],
  },
} as const;

type FixtureId = keyof typeof FIXTURES;
export const isPauliFixture = (assetId: string): assetId is FixtureId => Object.hasOwn(FIXTURES, assetId);

// Reserve GPU light slots for the kitchen's own ambient, key and accents. Extra fixtures
// retain the same animated lens, while the first four placed fixtures cast light.
export const MAX_PAULI_EMITTERS = 4;
const SECONDS_PER_COLOR = 1.8;
const BEAM_COUNT = 6;
const TURN = Math.PI * 2;

type Fixture = (typeof FIXTURES)[FixtureId];
interface Group {
  readonly intensity: number;
  readonly palette: readonly Color3[];
  readonly color: Color3;
  readonly lenses: Set<PBRMaterial>;
  readonly emitters: (PointLight | SpotLight)[];
}

interface MovingSpot {
  readonly light: SpotLight;
  readonly restDirection: Vector3;
  readonly palette: readonly Color3[];
  readonly phase: number;
  readonly beam: PauliBeam;
}

interface Disco {
  readonly light: SpotLight;
  readonly rotor: TransformNode;
  readonly beams: readonly PauliBeam[];
  readonly palette: readonly Color3[];
}

const samplePalette = (palette: readonly Color3[], phase: number, target: Color3): void => {
  const position = phase % palette.length;
  const index = Math.floor(position);
  const t = position - index;
  Color3.LerpToRef(palette[index]!, palette[(index + 1) % palette.length]!, t * t * (3 - 2 * t), target);
};

export class PauliLighting {
  private readonly groups = new Map<Fixture, Group>();
  private readonly spots: MovingSpot[] = [];
  private readonly globes: Disco[] = [];
  private readonly direction = Vector3.Zero();
  private readonly tinted = new Color3();
  private readonly visualRoot: TransformNode;
  private readonly stopQuality: () => void;
  private readonly reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private beamCount = BEAM_COUNT;
  private emitterCount = 0;
  private elapsed = 0;
  private power = 1;

  constructor(private readonly scene: Scene, parent?: TransformNode) {
    // Only light effects animate under this root. The fixture housings remain static décor.
    this.visualRoot = new TransformNode("pauli-light-effects", scene);
    if (parent) this.visualRoot.parent = parent;
    this.stopQuality = qualityManager.subscribe(({ level }) => {
      this.beamCount = level === "high" ? BEAM_COUNT : level === "medium" ? 4 : 3;
      for (const globe of this.globes) {
        globe.beams.forEach((beam, index) => beam.mesh.setEnabled(index < this.beamCount));
      }
    });
  }

  attach(assetId: FixtureId, root: TransformNode, meshes: readonly AbstractMesh[], powered: boolean): void {
    const fixture = FIXTURES[assetId];
    let group = this.groups.get(fixture);
    if (!group) {
      const palette = fixture.colors.map(hex => Color3.FromHexString(hex).toLinearSpace(true));
      group = { intensity: fixture.intensity, palette, color: palette[0]!.clone(), lenses: new Set(), emitters: [] };
      this.groups.set(fixture, group);
    }
    for (const mesh of meshes) {
      const material = mesh.material;
      if (material instanceof PBRMaterial && material.name.split("#", 1)[0] === fixture.lens) {
        material.emissiveColor.copyFrom(group.color);
        if (fixture.kind === "disco") material.emissiveIntensity = .35;
        group.lenses.add(material);
      }
    }
    if (!powered) return;

    // Fixtures face +Z in Babylon. The placement matrix includes the editor's rotation and elevation.
    const world = root.computeWorldMatrix(true);
    const source = Vector3.TransformCoordinates(new Vector3(0, fixture.height, fixture.front), world);
    const restDirection = Vector3.TransformNormal(new Vector3(0, -0.68, 1), world).normalize();
    const emitter = fixture.kind === "wash"
      ? new PointLight(root.name + "-rgb", source, this.scene)
      : new SpotLight(root.name + "-rgb", source, restDirection.clone(), fixture.kind === "disco" ? .48 : .63, 3, this.scene);
    emitter.falloffType = Light.FALLOFF_STANDARD;
    emitter.range = fixture.range;
    emitter.intensity = fixture.intensity;
    emitter.diffuse.copyFrom(group.color);
    group.emitters.push(emitter);
    this.emitterCount++;
    if (emitter instanceof SpotLight) {
      const palette = fixture.colors.map(hex => Color3.FromHexString(hex));
      if (fixture.kind === "disco") {
        const rotor = new TransformNode(`${root.name}-disco-rotor`, this.scene);
        rotor.parent = this.visualRoot;
        rotor.position.copyFrom(source);
        for (const mesh of meshes) {
          if (mesh.material?.name.split("#", 1)[0] === fixture.lens) mesh.setParent(rotor, true);
        }
        const beams = Array.from({ length: BEAM_COUNT }, (_, index) => {
          const beam = new PauliBeam(`${root.name}-disco-beam-${index}`, this.scene, this.visualRoot, .24);
          beam.mesh.setEnabled(index < this.beamCount);
          return beam;
        });
        this.globes.push({ light: emitter, rotor, beams, palette });
      } else {
        const beam = new PauliBeam(`${root.name}-spot-beam`, this.scene, this.visualRoot, .34);
        this.spots.push({ light: emitter, restDirection, palette, phase: source.x * .9, beam });
      }
    }
    this.update(0);
  }

  reserveLightSlots(): void {
    if (!this.emitterCount) return;
    const slots = 4 + this.emitterCount;
    for (const material of this.scene.materials) {
      if (material.isFrozen) continue;
      if (material instanceof PBRMaterial || material instanceof StandardMaterial) {
        material.maxSimultaneousLights = Math.max(material.maxSimultaneousLights, slots);
      }
    }
  }

  update(deltaSeconds: number, power = 1): void {
    this.elapsed += this.reducedMotion ? 0 : deltaSeconds;
    const colorPhase = this.elapsed / SECONDS_PER_COLOR;
    for (const group of this.groups.values()) {
      samplePalette(group.palette, colorPhase, group.color);
      for (const lens of group.lenses) group.color.scaleToRef(power, lens.emissiveColor);
      for (const emitter of group.emitters) {
        emitter.diffuse.copyFrom(group.color);
        if (power !== this.power) emitter.intensity = group.intensity * power;
      }
    }
    this.power = power;
    for (const spot of this.spots) {
      const yaw = Math.sin(this.elapsed * .82 + spot.phase) * .55;
      const { x, y, z } = spot.restDirection;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      spot.light.direction.set(x * cos + z * sin, y, z * cos - x * sin);
      samplePalette(spot.palette, colorPhase, this.tinted);
      this.tinted.scaleInPlace(power);
      spot.beam.aim(spot.light.position, spot.light.direction, spot.light.range, .15, this.tinted);
    }
    for (const globe of this.globes) {
      const rotation = this.elapsed * .67;
      globe.rotor.rotation.y = rotation;
      for (let index = 0; index < this.beamCount; index++) {
        const angle = rotation + TURN * index / this.beamCount;
        const tilt = -.59 - .24 * Math.sin(rotation * .63 + index * .9);
        this.direction.set(Math.sin(angle), tilt, Math.cos(angle)).normalize();
        samplePalette(globe.palette, colorPhase + index, this.tinted);
        this.tinted.scaleInPlace(power);
        globe.beams[index]!.aim(globe.light.position, this.direction, globe.light.range, .085, this.tinted);
        if (index === 0) globe.light.direction.copyFrom(this.direction);
      }
    }
  }

  dispose(): void {
    this.stopQuality();
    for (const spot of this.spots) spot.beam.dispose();
    for (const globe of this.globes) for (const beam of globe.beams) beam.dispose();
    this.visualRoot.dispose(false, false);
    for (const group of this.groups.values()) {
      for (const emitter of group.emitters) emitter.dispose();
    }
    this.groups.clear();
    this.spots.length = 0;
    this.globes.length = 0;
    this.emitterCount = 0;
  }
}
