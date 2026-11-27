import {
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  StandardMaterial,
  Vector3,
} from "@babylonjs/core";
import { COUNTER_HEIGHT } from "../../data/kitchen";
import { trackParticleSystem } from "../../core/perf/effectBudget";
import { t } from "../../i18n";
import { STOREY_REACH } from "../../physics/collisionPolicy";
import type { LoopHandle } from "../../core/SynthSfx";
import type { Disaster, DisasterHost } from "./types";

/** Radius of the puddle when the pipe bursts, and when it has spread all it will. */
export const FLOOD_START_RADIUS = 0.5;
export const FLOOD_MAX_RADIUS = 3.2;
/** Seconds the water takes to spread to its widest. */
export const FLOOD_SPREAD_SECONDS = 12;
/** Faster than this, in m/s, and a cook's feet go out from under them on the wet floor. */
export const SLIP_SPEED = 1;
/** Seconds of moving across the water before the slip. */
export const SLIP_SECONDS = 0.5;
/** Seconds a cook keeps their footing after getting up from a slip. */
const SLIP_COOLDOWN = 2.5;
const DRAIN_SECONDS = 2;

/**
 * A pipe bursts under a sink. Water sprays out of it and spreads across the floor in
 * a growing puddle; a cook who hurries across the wet floor slips and falls, sliding
 * the way they were going. Walking carefully, or going round, is safe. When it is
 * over the water drains away.
 */
export class SinkFlood implements Disaster {
  readonly kind = "flood" as const;
  readonly duration = 20;
  private clock = 0;
  private centre = new Vector3();
  private puddle: Mesh | null = null;
  private material: StandardMaterial | null = null;
  private texture: DynamicTexture | null = null;
  private spray: ParticleSystem | null = null;
  private sound: LoopHandle | null = null;
  private readonly slipping = new Map<number, number>();
  private readonly cooldown = new Map<number, number>();

  constructor(private readonly host: DisasterHost, private readonly random: () => number = Math.random) {}

  /** The puddle's radius now, in metres. */
  get radius(): number {
    if (this.clock >= this.duration) {
      const drained = Math.min(1, (this.clock - this.duration) / DRAIN_SECONDS);
      return FLOOD_MAX_RADIUS * (1 - drained);
    }
    const spread = Math.min(1, this.clock / FLOOD_SPREAD_SECONDS);
    // Fast at first, slowing as it spreads thin.
    return FLOOD_START_RADIUS + (FLOOD_MAX_RADIUS - FLOOD_START_RADIUS) * (1 - (1 - spread) * (1 - spread));
  }

  start(): void {
    const { scene, bounds } = this.host;
    this.clock = 0;
    const views = this.host.stationViews();
    const sinks = views.filter((view) => view.kind === "sink");
    const occupied = this.host.cooks.filter(cook => !cook.player.isAbducted);
    const onOccupiedFloor = (view: typeof views[number]): boolean => occupied.some(
      cook => Math.abs(view.root.position.y - cook.player.position.y) <= STOREY_REACH,
    );
    const nearbySinks = sinks.filter(onOccupiedFloor);
    const nearbyViews = views.filter(onOccupiedFloor);
    const pool = nearbySinks.length ? nearbySinks : occupied.length ? nearbyViews : sinks;
    const source = pool[Math.floor(this.random() * pool.length)];
    if (source) {
      const y = this.host.floorHeight(source.x, source.root.position.y, source.z);
      this.centre.set(source.x, y, source.z);
    } else if (occupied[0]) {
      const { x, y, z } = occupied[0].player.position;
      this.centre.set(x, this.host.floorHeight(x, y, z), z);
    } else {
      this.centre.set((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    }

    this.texture = this.ripples();
    const material = new StandardMaterial("flood-water", scene);
    if (this.texture) {
      material.diffuseTexture = this.texture;
      material.useAlphaFromDiffuseTexture = true;
    } else {
      material.diffuseColor = Color3.FromHexString("#5AAAFF");
      material.alpha = 0.55;
    }
    material.emissiveColor = Color3.FromHexString("#1E5FA8");
    material.specularColor = Color3.FromHexString("#CFEFFF");
    material.specularPower = 64;
    material.backFaceCulling = false;
    this.material = material;

    const puddle = MeshBuilder.CreateDisc("flood-puddle", { radius: 1, tessellation: 48 }, scene);
    puddle.rotation.x = Math.PI / 2;
    puddle.position.copyFrom(this.centre);
    puddle.position.y += 0.025;
    puddle.material = material;
    puddle.isPickable = false;
    this.puddle = puddle;

    const spray = new ParticleSystem("flood-spray", 220, scene);
    if (this.host.juiceTexture) spray.particleTexture = this.host.juiceTexture;
    spray.emitter = new Vector3(this.centre.x,
      (source?.root.position.y ?? this.centre.y) + (source?.topHeight ?? COUNTER_HEIGHT) - 0.1,
      this.centre.z);
    spray.minEmitBox = new Vector3(-0.2, 0, -0.2);
    spray.maxEmitBox = new Vector3(0.2, 0.1, 0.2);
    spray.color1 = new Color4(0.55, 0.82, 1, 0.9);
    spray.color2 = new Color4(0.3, 0.6, 1, 0.8);
    spray.colorDead = new Color4(0.5, 0.75, 1, 0);
    spray.minSize = 0.05;
    spray.maxSize = 0.13;
    spray.minLifeTime = 0.4;
    spray.maxLifeTime = 0.9;
    spray.emitRate = 160;
    spray.direction1 = new Vector3(-2.2, 2.6, -2.2);
    spray.direction2 = new Vector3(2.2, 4, 2.2);
    spray.minEmitPower = 0.6;
    spray.maxEmitPower = 1.1;
    spray.gravity = new Vector3(0, -9.8, 0);
    trackParticleSystem(spray).start();
    this.spray = spray;

    this.sound = this.host.sfx.loop("water", 0.9);
    this.host.sfx.play("zap", 0.6);
    this.update(0);
  }

  update(dt: number): boolean {
    this.clock += dt;
    const radius = this.radius;
    if (this.puddle) {
      this.puddle.scaling.setAll(Math.max(0.001, radius));
      // A gentle shimmer on the surface.
      if (this.texture) {
        this.texture.uOffset += dt * 0.03;
        this.texture.vOffset += dt * 0.02;
      }
    }
    if (this.clock >= this.duration) {
      this.spray?.stop();
      this.sound?.stop(1);
      this.sound = null;
      return this.clock < this.duration + DRAIN_SECONDS;
    }
    this.checkSlips(dt, radius);
    return true;
  }

  stop(): void {
    this.sound?.stop(0.4);
    this.sound = null;
    this.spray?.dispose();
    this.spray = null;
    this.puddle?.dispose();
    this.puddle = null;
    this.material?.dispose();
    this.material = null;
    this.texture?.dispose();
    this.texture = null;
  }

  /** Soft rings on a translucent blue sheet, scrolled slowly; null where there is no canvas. */
  private ripples(): DynamicTexture | null {
    let texture: DynamicTexture;
    try {
      texture = new DynamicTexture("flood-ripples", { width: 256, height: 256 }, this.host.scene, true);
    } catch {
      return null;
    }
    texture.hasAlpha = true;
    const context = texture.getContext();
    context.clearRect(0, 0, 256, 256);
    context.fillStyle = "rgba(90, 170, 255, 0.55)";
    context.fillRect(0, 0, 256, 256);
    context.strokeStyle = "rgba(225, 245, 255, 0.55)";
    context.lineWidth = 3;
    for (let i = 0; i < 14; i += 1) {
      context.beginPath();
      context.arc(this.random() * 256, this.random() * 256, 8 + this.random() * 26, 0, Math.PI * 2);
      context.stroke();
    }
    texture.update();
    texture.wrapU = DynamicTexture.WRAP_ADDRESSMODE;
    texture.wrapV = DynamicTexture.WRAP_ADDRESSMODE;
    texture.uScale = 3;
    texture.vScale = 3;
    return texture;
  }

  private checkSlips(dt: number, radius: number): void {
    for (const cook of this.host.cooks) {
      const player = cook.player;
      const left = (this.cooldown.get(cook.index) ?? 0) - dt;
      this.cooldown.set(cook.index, left);
      if (player.isDowned()) {
        this.slipping.delete(cook.index);
        continue;
      }
      const dx = player.position.x - this.centre.x;
      const dz = player.position.z - this.centre.z;
      const wet = Math.abs(player.position.y - this.centre.y) <= STOREY_REACH &&
        dx * dx + dz * dz < radius * radius * 0.92;
      const vx = player.velocity.x;
      const vz = player.velocity.z;
      const speed = Math.hypot(vx, vz);
      if (!wet || speed < SLIP_SPEED || left > 0) {
        this.slipping.delete(cook.index);
        continue;
      }
      const slip = (this.slipping.get(cook.index) ?? 0) + dt;
      this.slipping.set(cook.index, slip);
      if (slip < SLIP_SECONDS) continue;
      this.slipping.delete(cook.index);
      this.cooldown.set(cook.index, SLIP_COOLDOWN);
      // The feet go forwards: they slide on the way they were heading.
      this.host.hitCook(cook, player.position.x - vx / speed, player.position.z - vz / speed, 0.4);
      this.host.sfx.play("splat", 0.7);
      this.host.notify(t("disaster.slipped", { name: cook.label }), "warning");
    }
  }
}
