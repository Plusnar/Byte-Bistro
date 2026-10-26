import {
  Color3,
  Color4,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { t } from "../../i18n";
import type { LoopHandle } from "../../core/SynthSfx";
import { trackParticleSystem } from "../../core/perf/effectBudget";
import { DISASTER_MODEL_IDS } from "./assets";
import { spawnProp, type Prop } from "./props";
import { between, type Disaster, type DisasterCook, type DisasterHost } from "./types";

/** How high the saucer hovers, in metres. */
const HOVER_HEIGHT = 5.2;
/** Radius of the patch of floor the beam lights; a cook inside it gets taken. */
export const BEAM_RADIUS = 0.95;
/** Seconds a cook has to stand in the light before it takes them. */
export const BEAM_GRAB_SECONDS = 0.6;
/** Seconds a cook spends inside the saucer before it drops them back. */
export const ABDUCTED_SECONDS = 5;
/** Slower than a walking cook (3.4 m/s), so the light can always be outrun. */
const CHASE_SPEED = 2.3;
const BEAM_ON_SECONDS = 3.6;
const BEAM_OFF_SECONDS = 1.3;
const ARRIVE_SECONDS = 1.6;

interface Captive {
  readonly cook: DisasterCook;
  /** Seconds spent inside the saucer; they come back at ABDUCTED_SECONDS. */
  clock: number;
  dropped: boolean;
}

/**
 * A flying saucer hunts the cooks. It drifts after the nearest one with its beam
 * cycling on and off; anyone who stays in the light for a moment is lifted inside,
 * spends five seconds aboard, and falls back out of the sky onto the spot they
 * started the shift on, in a puff of smoke. Anywhere else could drop them outside
 * the room or on top of a counter, in a map shaped any way. The saucer flies off
 * when its time is up, after giving everyone back.
 */
export class AlienAbduction implements Disaster {
  readonly kind = "ufo" as const;
  readonly duration = 20;
  private clock = 0;
  private ship: Prop | null = null;
  private beam: Mesh | null = null;
  private spot: Mesh | null = null;
  private readonly materials: StandardMaterial[] = [];
  private beamOn = false;
  private beamClock = 0;
  private readonly exposure = new Map<number, number>();
  private readonly captives: Captive[] = [];
  private readonly entry = new Vector3();
  private readonly exit = new Vector3();
  private hum: LoopHandle | null = null;
  private wander = 0;

  constructor(private readonly host: DisasterHost, private readonly random: () => number = Math.random) {}

  /** The saucer's position, for tests and the camera. */
  get position(): Vector3 | null {
    return this.ship?.root.position ?? null;
  }

  start(): void {
    const { scene, assets, bounds } = this.host;
    this.clock = 0;
    this.ship = spawnProp(scene, assets, DISASTER_MODEL_IDS.ufo, "ufo", (parent) => this.fallbackSaucer(parent));
    // In from one side, high, and out the other when it leaves.
    const fromLeft = this.random() < 0.5;
    const midZ = (bounds.minZ + bounds.maxZ) / 2;
    this.entry.set(fromLeft ? bounds.minX - 8 : bounds.maxX + 8, HOVER_HEIGHT + 5, midZ);
    this.exit.set(fromLeft ? bounds.maxX + 10 : bounds.minX - 10, HOVER_HEIGHT + 8, midZ);
    this.ship.root.position.copyFrom(this.entry);

    const beamMaterial = this.material("ufo-beam", "#7DFFC8", 0.26);
    const spotMaterial = this.material("ufo-spot", "#B8FFE0", 0.5);
    this.beam = MeshBuilder.CreateCylinder("ufo-beam", {
      height: HOVER_HEIGHT,
      diameterTop: 0.7,
      diameterBottom: BEAM_RADIUS * 2,
      tessellation: 32,
      cap: Mesh.NO_CAP,
    }, scene);
    this.beam.material = beamMaterial;
    this.beam.isPickable = false;
    this.spot = MeshBuilder.CreateDisc("ufo-spot", { radius: BEAM_RADIUS, tessellation: 40 }, scene);
    this.spot.rotation.x = Math.PI / 2;
    this.spot.material = spotMaterial;
    this.spot.isPickable = false;
    this.setBeam(false);
    this.hum = this.host.sfx.loop("ufo", 0.9);
  }

  update(dt: number): boolean {
    const ship = this.ship;
    if (!ship) return false;
    this.clock += dt;
    this.wander += dt;
    const root = ship.root;
    const leaving = this.clock >= this.duration && this.captives.length === 0;

    if (this.clock < ARRIVE_SECONDS) {
      const t = this.clock / ARRIVE_SECONDS;
      const target = this.chaseTarget();
      Vector3.LerpToRef(this.entry, new Vector3(target.x, HOVER_HEIGHT, target.z), t * t * (3 - 2 * t), root.position);
    } else if (leaving) {
      // Up and away; done once it is out of sight.
      const toExit = this.exit.subtract(root.position);
      const distance = toExit.length();
      if (distance < 0.5) return false;
      root.position.addInPlace(toExit.scale(Math.min(1, (9 * dt) / distance)));
    } else {
      this.chase(root, dt);
    }
    // Bob and spin like a saucer should.
    root.rotation.y += dt * 1.6;
    root.rotation.z = Math.sin(this.wander * 1.3) * 0.06;
    root.position.y += Math.sin(this.wander * 2.1) * 0.004;

    this.cycleBeam(dt, leaving);
    this.placeBeam(root.position);
    if (this.beamOn) this.grab(root, dt);
    this.updateCaptives(dt);
    return true;
  }

  stop(): void {
    for (const captive of this.captives) {
      if (!captive.dropped && captive.cook.player.isAbducted) {
        const spot = this.host.freeSpot();
        captive.cook.player.dropFromSky(spot.x, spot.z);
      }
    }
    this.captives.length = 0;
    this.hum?.stop(0.6);
    this.hum = null;
    this.ship?.dispose();
    this.ship = null;
    this.beam?.dispose();
    this.beam = null;
    this.spot?.dispose();
    this.spot = null;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }

  /** The cook it is after: the nearest one still in the kitchen. */
  private chaseTarget(): Vector3 {
    const root = this.ship!.root.position;
    let best: Vector3 | null = null;
    let bestDistance = Infinity;
    for (const cook of this.host.cooks) {
      if (cook.player.isAbducted) continue;
      const position = cook.player.position;
      const distance = Math.hypot(position.x - root.x, position.z - root.z);
      if (distance < bestDistance) {
        best = position;
        bestDistance = distance;
      }
    }
    const { bounds } = this.host;
    return best ?? new Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
  }

  private chase(root: TransformNode, dt: number): void {
    const target = this.chaseTarget();
    // A loose circle round the target, so it sweeps rather than sits on them.
    const goalX = target.x + Math.cos(this.wander * 0.8) * 1.2;
    const goalZ = target.z + Math.sin(this.wander * 1.1) * 1.2;
    const dx = goalX - root.position.x;
    const dz = goalZ - root.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 1e-3) {
      const step = Math.min(distance, CHASE_SPEED * dt);
      root.position.x += (dx / distance) * step;
      root.position.z += (dz / distance) * step;
    }
    root.position.y += (HOVER_HEIGHT - root.position.y) * Math.min(1, dt * 2);
  }

  private cycleBeam(dt: number, leaving: boolean): void {
    if (leaving || this.clock < ARRIVE_SECONDS) {
      if (this.beamOn) this.setBeam(false);
      return;
    }
    this.beamClock += dt;
    const limit = this.beamOn ? BEAM_ON_SECONDS : BEAM_OFF_SECONDS;
    if (this.beamClock >= limit * between(0.85, 1.15, this.random)) {
      this.beamClock = 0;
      this.setBeam(!this.beamOn);
      if (this.beamOn) this.host.sfx.play("beam");
    }
  }

  private setBeam(on: boolean): void {
    this.beamOn = on;
    if (this.beam) this.beam.isVisible = on;
    if (this.spot) this.spot.isVisible = on;
    if (!on) this.exposure.clear();
  }

  private placeBeam(ship: Vector3): void {
    const height = Math.max(0.5, ship.y - 0.25);
    if (this.beam) {
      this.beam.position.set(ship.x, height / 2, ship.z);
      this.beam.scaling.y = height / HOVER_HEIGHT;
      this.beam.visibility = 0.75 + Math.sin(this.wander * 14) * 0.25;
    }
    this.spot?.position.set(ship.x, 0.04, ship.z);
  }

  /** Anyone in the light long enough is lifted up into the saucer. */
  private grab(root: TransformNode, dt: number): void {
    for (const cook of this.host.cooks) {
      const player = cook.player;
      // Just dropped back and still getting up: the light leaves them alone.
      if (player.isAbducted || player.isDowned()) continue;
      const dx = player.position.x - root.position.x;
      const dz = player.position.z - root.position.z;
      if (dx * dx + dz * dz > BEAM_RADIUS * BEAM_RADIUS) {
        this.exposure.delete(cook.index);
        continue;
      }
      const exposed = (this.exposure.get(cook.index) ?? 0) + dt;
      this.exposure.set(cook.index, exposed);
      if (exposed < BEAM_GRAB_SECONDS) continue;
      this.exposure.delete(cook.index);
      this.host.dropHeld(cook);
      player.abduct(root);
      this.captives.push({ cook, clock: 0, dropped: false });
      this.host.sfx.play("abduct");
      this.host.notify(t("disaster.abducted", { name: cook.label }), "error");
    }
  }

  private updateCaptives(dt: number): void {
    for (const captive of [...this.captives]) {
      const player = captive.cook.player;
      if (!captive.dropped) {
        // The five seconds count from when the cook is inside, not up the beam.
        if (player.isGone) captive.clock += dt;
        if (captive.clock < ABDUCTED_SECONDS) continue;
        const spot = this.host.spawnPoint(captive.cook);
        player.dropFromSky(spot.x, spot.z);
        captive.dropped = true;
        continue;
      }
      // Back on the floor: the landing thumps and the view jolts.
      if (!player.isAbducted) {
        this.puff(player.position);
        this.host.sfx.play("land");
        this.host.shake(0.18, 0.35);
        this.host.notify(t("disaster.returned", { name: captive.cook.label }), "warning");
        this.captives.splice(this.captives.indexOf(captive), 1);
      }
    }
  }

  /** A burst of dust and smoke where a cook lands, billowing out and up and fading. */
  private puff(at: Vector3): void {
    const smoke = new ParticleSystem("ufo-landing-smoke", 70, this.host.scene);
    if (this.host.juiceTexture) smoke.particleTexture = this.host.juiceTexture;
    smoke.emitter = new Vector3(at.x, 0.15, at.z);
    smoke.minEmitBox = new Vector3(-0.25, 0, -0.25);
    smoke.maxEmitBox = new Vector3(0.25, 0.1, 0.25);
    smoke.color1 = new Color4(0.92, 0.9, 0.88, 0.85);
    smoke.color2 = new Color4(0.7, 0.68, 0.7, 0.75);
    smoke.colorDead = new Color4(0.6, 0.6, 0.62, 0);
    smoke.minSize = 0.35;
    smoke.maxSize = 0.9;
    smoke.minScaleX = 1;
    smoke.maxScaleX = 1.4;
    smoke.minLifeTime = 0.7;
    smoke.maxLifeTime = 1.4;
    smoke.manualEmitCount = 70;
    // Out along the floor, and a little up: a ring of dust thrown off by the landing.
    smoke.direction1 = new Vector3(-1.6, 0.4, -1.6);
    smoke.direction2 = new Vector3(1.6, 1.4, 1.6);
    smoke.minEmitPower = 0.8;
    smoke.maxEmitPower = 1.8;
    smoke.gravity = new Vector3(0, 0.6, 0);
    smoke.minAngularSpeed = -1.5;
    smoke.maxAngularSpeed = 1.5;
    smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    smoke.targetStopDuration = 0.25;
    smoke.disposeOnStop = true;
    trackParticleSystem(smoke).start();
  }

  /** A saucer from primitives, shown until the model has loaded. */
  private fallbackSaucer(parent: TransformNode): void {
    const scene = this.host.scene;
    const hull = this.material("ufo-fallback-hull", "#B8C4D6", 1, true);
    const dome = this.material("ufo-fallback-dome", "#6FF2FF", 0.7);
    const disc = MeshBuilder.CreateSphere("ufo-fallback-disc", { diameter: 3.2, segments: 16 }, scene);
    disc.scaling.y = 0.22;
    disc.material = hull;
    disc.parent = parent;
    const top = MeshBuilder.CreateSphere("ufo-fallback-dome", { diameter: 1.2, segments: 12 }, scene);
    top.position.y = 0.3;
    top.material = dome;
    top.parent = parent;
  }

  private material(name: string, hex: string, alpha: number, lit = false): StandardMaterial {
    const material = new StandardMaterial(name, this.host.scene);
    const colour = Color3.FromHexString(hex);
    material.diffuseColor = colour;
    material.emissiveColor = lit ? colour.scale(0.3) : colour;
    material.disableLighting = !lit;
    material.alpha = alpha;
    material.backFaceCulling = false;
    this.materials.push(material);
    return material;
  }
}
