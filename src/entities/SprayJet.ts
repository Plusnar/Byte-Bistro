import { Color4, ParticleSystem, Vector3, type BaseTexture, type Scene } from "@babylonjs/core";
import { trackParticleSystem } from "../core/perf/effectBudget";

/** How fast the jet leaves the nozzle, in m/s. */
const JET_SPEED = 5.5;
/** Sideways spread of the jet, as a share of its speed. */
const SPREAD = 0.16;

/**
 * The extinguisher's jet: a cone of white powder from the nozzle towards the fire.
 *
 * One per cook, made the first time they spray. `aim` points it every frame;
 * `stop` lets the last of the cloud drift and fade instead of cutting it.
 */
export class SprayJet {
  private readonly system: ParticleSystem;
  private readonly direction = new Vector3();

  constructor(scene: Scene, texture: BaseTexture, name: string) {
    const system = new ParticleSystem(name, 260, scene);
    system.particleTexture = texture;
    system.emitter = Vector3.Zero();
    system.minEmitBox = Vector3.Zero();
    system.maxEmitBox = Vector3.Zero();
    system.color1 = new Color4(1, 1, 1, 0.95);
    system.color2 = new Color4(0.86, 0.92, 1, 0.85);
    system.colorDead = new Color4(0.8, 0.84, 0.9, 0);
    system.minSize = 0.08;
    system.maxSize = 0.22;
    system.minLifeTime = 0.35;
    system.maxLifeTime = 0.6;
    system.emitRate = 220;
    system.minEmitPower = 0.85;
    system.maxEmitPower = 1.15;
    // The powder slows and billows out as it goes.
    system.addSizeGradient(0, 0.4);
    system.addSizeGradient(1, 2.4);
    system.addDragGradient(0, 0);
    system.addDragGradient(1, 0.6);
    system.gravity = new Vector3(0, -0.6, 0);
    this.system = trackParticleSystem(system);
  }

  get active(): boolean {
    return this.system.isStarted();
  }

  /** Sprays from `nozzle` towards `target`, both world positions. */
  aim(nozzle: Vector3, target: Vector3): void {
    (this.system.emitter as Vector3).copyFrom(nozzle);
    target.subtractToRef(nozzle, this.direction);
    const distance = this.direction.length();
    if (distance < 1e-3) return;
    this.direction.scaleInPlace(JET_SPEED / distance);
    const side = JET_SPEED * SPREAD;
    this.system.direction1.set(this.direction.x - side, this.direction.y - side, this.direction.z - side);
    this.system.direction2.set(this.direction.x + side, this.direction.y + side, this.direction.z + side);
    // Long enough to reach the fire and a little beyond, not across the kitchen.
    const reach = Math.min(1.4, distance / JET_SPEED + 0.12);
    this.system.minLifeTime = reach * 0.7;
    this.system.maxLifeTime = reach;
    if (!this.system.isStarted()) this.system.start();
  }

  stop(): void {
    if (this.system.isStarted()) this.system.stop();
  }

  dispose(): void {
    this.system.dispose();
  }
}
