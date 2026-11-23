import {
  Color4, DynamicTexture, Layer, MaterialPluginBase, ParticleSystem, Texture, TransformNode, Vector3,
  type AbstractMesh, type Material, type Scene, type UniformBuffer,
} from "@babylonjs/core";
import type { AssetManager, ModelAssetDefinition, ModelInstance } from "../core/AssetManager";
import { bundledModelUrl } from "../core/assets/assetRegistry";
import { trackParticleSystem } from "../core/perf/effectBudget";
import { measureBounds } from "../entities/modelFit";
import { publicUrl } from "../utils/assetUrl";

export const GALAXY_URL = publicUrl("assets/ui/level-map/galaxy-scroll.webp");
const GALAXY_ASPECT = 2;
const WIND_RATE = .40;
const IDLE_WIND_STRENGTH = .024;
const TURN_WIND_STRENGTH = .21;

const ORBIT_MODELS = {
  ufo: "src/assets/disasters/ufo.glb",
  satellite: "src/assets/map-town/orbit-satellite.glb",
  robot: "src/assets/map-town/orbit-robot.glb",
  meteor: "src/assets/map-town/orbit-meteor.glb",
} as const;

export const ORBIT_ASSETS: ModelAssetDefinition[] = Object.entries(ORBIT_MODELS).map(([id, path]) => ({
  id: `orbit-${id}`, url: bundledModelUrl(path), priority: "background",
}));

interface Flight {
  readonly model: keyof typeof ORBIT_MODELS;
  readonly size: number;
  readonly lane: number;
  readonly depth: number;
  readonly direction: 1 | -1;
  readonly duration: number;
  readonly pause: number;
  readonly offset: number;
  readonly pitch: number;
  readonly tumble: number;
}

const FLIGHTS: readonly Flight[] = [
  { model: "ufo", size: 2.05, lane: .34, depth: -10, direction: 1, duration: 37, pause: 8, offset: 9, pitch: .16, tumble: .18 },
  { model: "satellite", size: 1.63, lane: .65, depth: -15, direction: -1, duration: 43, pause: 9, offset: 10, pitch: .88, tumble: .54 },
  { model: "satellite", size: 1.30, lane: -.63, depth: -19, direction: 1, duration: 49, pause: 11, offset: 56, pitch: 1.04, tumble: .36 },
  { model: "robot", size: 1.37, lane: -.33, depth: -12, direction: 1, duration: 44, pause: 8, offset: 9, pitch: .13, tumble: .22 },
  { model: "robot", size: 1.13, lane: -.44, depth: -16, direction: -1, duration: 46, pause: 9, offset: 12, pitch: .15, tumble: .25 },
  { model: "meteor", size: 1.06, lane: .54, depth: -21, direction: 1, duration: 34, pause: 7, offset: 36, pitch: .43, tumble: 2.4 },
  { model: "meteor", size: .81, lane: -.67, depth: -24, direction: -1, duration: 39, pause: 7, offset: 30, pitch: .35, tumble: 2.1 },
];

interface Traveler {
  readonly flight: Flight;
  readonly pivot: TransformNode;
  readonly instance: ModelInstance;
}

/** The exported UV pair carries the vertex's height above its plant base and its plant's phase. */
export class PlanetWind extends MaterialPluginBase {
  private time = 0;
  private strength = 0;
  private turnBend = 0;

  constructor(material: Material) {
    super(material, "PlanetWind", 180, {}, true, true);
  }

  override getClassName(): string { return "PlanetWind"; }

  update(delta: number, reducedMotion: boolean, turnSpeedRatio: number): void {
    if (reducedMotion) {
      this.strength = 0;
      this.turnBend = 0;
      return;
    }
    this.time = (this.time + delta) % (Math.PI * 2 / WIND_RATE * 64);
    this.strength = IDLE_WIND_STRENGTH;
    const target = turnSpeedRatio * TURN_WIND_STRENGTH;
    this.turnBend += (target - this.turnBend) * (1 - Math.exp(-delta * 5));
  }

  override getAttributes(attributes: string[], _scene: Scene, _mesh: AbstractMesh): void {
    if (!attributes.includes("uv")) attributes.push("uv");
  }

  override getUniforms() {
    return {
      ubo: [{ name: "planetWind", size: 3, type: "vec3" }],
      vertex: "uniform vec3 planetWind;",
    };
  }

  override bindForSubMesh(uniforms: UniformBuffer): void {
    uniforms.updateFloat3("planetWind", this.time, this.strength, this.turnBend);
  }

  override getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_DEFINITIONS: `
        #ifndef UV1
          attribute vec2 uv;
        #endif
      `,
      CUSTOM_VERTEX_UPDATE_POSITION: `
        vec3 radial = normalize(positionUpdated);
        vec3 breeze = vec3(0.83, 0.29, 0.47);
        vec3 tangent = breeze - radial * dot(radial, breeze);
        float wave = sin(planetWind.x * ${WIND_RATE} + uv.y * 6.28318);
        // The crowns trail the surface's motion around the local Z axis.
        vec3 turnTangent = vec3(-radial.y, radial.x, 0.0);
        positionUpdated += (tangent * wave * planetWind.y - turnTangent * planetWind.z) * uv.x * uv.x;
      `,
    };
  }
}

/** Drifting galaxy, stardust, and traffic passing behind the planet. */
export class LevelMapSpace {
  private galaxy: Texture | null = null;
  private backdrop: Layer | null = null;
  private dust: ParticleSystem | null = null;
  private animated = false;
  private elapsed = 0;
  private centerU = 0;
  private centerV = 0;
  private halfWidth = 0;
  private halfHeight = 0;
  private readonly travelers: Traveler[] = [];
  private disposed = false;

  constructor(private readonly scene: Scene, private readonly assets: AssetManager) {}

  create(hasGalaxy: boolean): void {
    if (this.dust) return;
    if (hasGalaxy) {
      this.galaxy = this.assets.createTexture(GALAXY_URL, { priority: "background" });
      this.galaxy.wrapU = Texture.MIRROR_ADDRESSMODE;
      this.galaxy.wrapV = Texture.MIRROR_ADDRESSMODE;
      this.backdrop = new Layer("level-map-galaxy", null, this.scene, true);
      this.backdrop.texture = this.galaxy;
    }

    const sprite = new DynamicTexture("map-stardust-sprite", 32, this.scene, false);
    sprite.hasAlpha = true;
    const canvas = sprite.getContext();
    const fade = canvas.createRadialGradient(16, 16, 0, 16, 16, 16);
    fade.addColorStop(0, "#ffffff");
    fade.addColorStop(.24, "#e3f4ffff");
    fade.addColorStop(.55, "#a5bbff61");
    fade.addColorStop(1, "#a5bbff00");
    canvas.fillStyle = fade;
    canvas.fillRect(0, 0, 32, 32);
    sprite.update();

    const dust = new ParticleSystem("level-map-stardust", 128, this.scene);
    dust.particleTexture = sprite;
    dust.emitter = Vector3.Zero();
    dust.createBoxEmitter(
      new Vector3(.82, -.26, -.2), new Vector3(1, -.12, .6),
      new Vector3(-19, -10, -29), new Vector3(15, 10, 10),
    );
    dust.color1 = new Color4(.64, .79, 1, .72);
    dust.color2 = new Color4(.89, .68, 1, .86);
    dust.colorDead = new Color4(.3, .48, 1, 0);
    dust.minSize = .028;
    dust.maxSize = .12;
    dust.minLifeTime = 3.8;
    dust.maxLifeTime = 7.8;
    dust.minEmitPower = .6;
    dust.maxEmitPower = 1.7;
    dust.emitRate = 18;
    dust.blendMode = ParticleSystem.BLENDMODE_ADD;
    dust.preWarmCycles = 28;
    dust.preWarmStepOffset = 5;
    this.dust = trackParticleSystem(dust);
    if (this.animated) this.dust.start();
  }

  resize(aspect: number): void {
    if (!this.galaxy) return;
    this.galaxy.uScale = Math.min(1, aspect / GALAXY_ASPECT);
    this.galaxy.vScale = Math.min(1, GALAXY_ASPECT / aspect);
    this.centerU = (1 - this.galaxy.uScale) * .5;
    this.centerV = (1 - this.galaxy.vScale) * .5;
    this.updateTextureOffset();
  }

  setCameraBounds(halfWidth: number, halfHeight: number): void {
    this.halfWidth = halfWidth;
    this.halfHeight = halfHeight;
  }

  async loadTravelers(): Promise<void> {
    await Promise.all(FLIGHTS.map(async (flight, index) => {
      const id = `orbit-${flight.model}`;
      if (!await this.assets.preload(id) || this.disposed) return;
      const instance = this.assets.instantiateLoaded(id, { namePrefix: `orbit-${index}-` });
      if (!instance) return;
      const bounds = measureBounds(instance.rootNodes);
      if (!bounds) {
        instance.dispose();
        return;
      }
      const pivot = new TransformNode(`orbit-flight-${flight.model}-${index}`, this.scene);
      const model = new TransformNode(`orbit-model-${index}`, this.scene, true);
      model.parent = pivot;
      const scale = flight.size / bounds.size;
      model.scaling.setAll(scale);
      model.position.y = -(bounds.minimumY + bounds.maximumY) * .5 * scale;
      for (const root of instance.rootNodes) root.parent = model;
      for (const mesh of pivot.getChildMeshes()) mesh.isPickable = false;
      const traveler = { flight, pivot, instance };
      this.travelers.push(traveler);
      this.updateTraveler(traveler, this.animated);
    }));
  }

  update(delta: number, animated: boolean): void {
    if (animated !== this.animated) {
      this.animated = animated;
      if (animated) this.dust?.start();
      else {
        this.dust?.stop();
        this.dust?.reset();
      }
    }
    if (animated) this.elapsed += delta;
    for (const traveler of this.travelers) this.updateTraveler(traveler, animated);
    if (!animated) return;
    this.updateTextureOffset();
  }

  private updateTraveler({ flight, pivot }: Traveler, animated: boolean): void {
    const time = (this.elapsed + flight.offset) % (flight.duration + flight.pause);
    const visible = animated && time < flight.duration;
    if (visible !== pivot.isEnabled()) pivot.setEnabled(visible);
    if (!visible) return;

    const progress = time / flight.duration;
    const hover = time * .84 + flight.offset;
    // Wrap past either edge, including the model's width, at every aspect ratio and zoom.
    const edge = this.halfWidth + flight.size * 1.25;
    pivot.position.set(
      (progress * 2 - 1) * edge * flight.direction,
      this.halfHeight * flight.lane + Math.sin(hover) * .27 - (progress - .5) * .95,
      flight.depth + Math.cos(progress * Math.PI * 2) * 1.0,
    );
    pivot.rotation.set(
      flight.pitch + Math.sin(hover * .65) * .13,
      flight.direction * .26 + (progress - .5) * flight.tumble,
      -flight.direction * .19 + Math.cos(hover * .57) * .2 + (progress - .5) * flight.tumble,
    );
  }

  private updateTextureOffset(): void {
    if (!this.galaxy) return;
    this.galaxy.uOffset = this.centerU + (this.elapsed * .012) % 2;
    this.galaxy.vOffset = this.centerV + (this.elapsed * .004) % 2;
  }

  dispose(): void {
    this.disposed = true;
    for (const { pivot, instance } of this.travelers) {
      instance.dispose();
      pivot.dispose();
    }
    this.travelers.length = 0;
    this.dust?.dispose();
    this.backdrop?.dispose();
  }
}
