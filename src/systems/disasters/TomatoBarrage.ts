import {
  Color3,
  Color4,
  MeshBuilder,
  ParticleSystem,
  StandardMaterial,
  Vector3,
  type BaseTexture,
} from "@babylonjs/core";
import { KITCHEN_TILE } from "../../data/kitchen";
import { trackParticleSystem } from "../../core/perf/effectBudget";
import { t } from "../../i18n";
import { STOREY_REACH } from "../../physics/collisionPolicy";
import type { WeddingGuest } from "../WeddingGuests";
import { DISASTER_MODEL_IDS } from "./assets";
import { spawnProp, type Prop } from "./props";
import { between, type Disaster, type DisasterCook, type DisasterHost } from "./types";

/** Seconds between one volley and the next. */
export const VOLLEY_GAP: readonly [number, number] = [2, 5];
/** Most robots throwing at once. */
export const MAX_THROWERS = 2;
/** Seconds a splattered tomato lies on the floor before it is gone. */
export const SPLAT_SECONDS = 4;
const GRAVITY = 14;
const HIT_RADIUS = 0.5;
/** How the tomato model is scaled up from life size, so it reads from the camera. */
const TOMATO_SCALE = 2.2;

interface Tomato {
  readonly prop: Prop;
  readonly velocity: Vector3;
  readonly spin: Vector3;
  readonly floorY: number;
  /** Null while flying; seconds on the floor once it has splattered. */
  splatted: number | null;
}

interface PendingThrow {
  /** Seconds until the robot's hand lets go. */
  delay: number;
  readonly from: () => Vector3;
  readonly target: DisasterCook;
}

/**
 * The wedding robots lose their patience and throw tomatoes at the cooks: one or
 * two of them at a time, a few seconds apart. A tomato that lands on a cook knocks
 * them over and makes them drop what they hold; the rest splat on the floor and
 * the counters, and are cleaned away after a while.
 */
export class TomatoBarrage implements Disaster {
  readonly kind = "tomatoes" as const;
  readonly duration = 20;
  private clock = 0;
  private nextVolley = 0.8;
  private readonly flying: Tomato[] = [];
  private readonly pending: PendingThrow[] = [];
  private juiceTexture: BaseTexture | null = null;
  private readonly materials: StandardMaterial[] = [];

  constructor(
    private readonly host: DisasterHost,
    private readonly random: () => number = Math.random,
    texture: BaseTexture | null = null,
  ) {
    this.juiceTexture = texture;
  }

  /** Robots throwing right now, for the at-most-two rule. */
  get throwers(): number {
    return this.pending.length;
  }

  get tomatoes(): number {
    return this.flying.length;
  }

  start(): void {
    this.clock = 0;
    this.nextVolley = 0.8;
  }

  update(dt: number): boolean {
    this.clock += dt;
    if (this.clock < this.duration) {
      this.nextVolley -= dt;
      if (this.nextVolley <= 0 && this.pending.length === 0) {
        this.volley();
        this.nextVolley = between(VOLLEY_GAP[0], VOLLEY_GAP[1], this.random);
      }
    }
    for (const throwing of [...this.pending]) {
      throwing.delay -= dt;
      if (throwing.delay > 0) continue;
      this.pending.splice(this.pending.indexOf(throwing), 1);
      this.launch(throwing.from(), throwing.target);
    }
    for (const tomato of [...this.flying]) this.updateTomato(tomato, dt);
    return this.clock < this.duration || this.flying.length > 0 || this.pending.length > 0;
  }

  stop(): void {
    for (const tomato of this.flying) tomato.prop.dispose();
    this.flying.length = 0;
    this.pending.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }

  /** One robot, or now and then two, each picks a cook to throw at. */
  private volley(): void {
    const targets = this.host.cooks.filter((cook) => !cook.player.isAbducted);
    if (targets.length === 0) return;
    const count = this.random() < 0.35 ? MAX_THROWERS : 1;
    const robots = [...this.host.robots.idleRobots];
    for (let i = 0; i < count; i += 1) {
      const target = targets[Math.floor(this.random() * targets.length)]!;
      if (robots.length > 0) {
        const robot = robots.splice(Math.floor(this.random() * robots.length), 1)[0]!;
        this.robotThrow(robot, target);
      } else {
        this.edgeThrow(target);
      }
    }
  }

  private robotThrow(robot: WeddingGuest, target: DisasterCook): void {
    // Holds the slot at once, so the next volley waits for this one.
    const pending: PendingThrow = {
      delay: 0.5,
      from: () => {
        const yaw = robot.root.rotation.y;
        const at = robot.root.position;
        return new Vector3(at.x + Math.sin(yaw) * 0.35, at.y + 1.45, at.z + Math.cos(yaw) * 0.35);
      },
      target,
    };
    this.pending.push(pending);
    void this.host.robots.throwAt(robot, target.player.position).then((release) => {
      pending.delay = release ?? 0.2;
    });
  }

  /** With no robots about, the tomatoes come over the kitchen's far edge. */
  private edgeThrow(target: DisasterCook): void {
    const { bounds } = this.host;
    const x = between(bounds.minX, bounds.maxX, this.random);
    const from = new Vector3(x, target.player.position.y + 1.6, bounds.maxZ + 3);
    this.pending.push({ delay: 0.1, from: () => from, target });
  }

  /** Lobs a tomato from `from` to land where the cook stands now. */
  private launch(from: Vector3, target: DisasterCook): void {
    const to = target.player.position;
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const time = Math.min(1.4, Math.max(0.6, distance / 8));
    const aimY = to.y + 0.9;
    const velocity = new Vector3(
      (to.x - from.x) / time,
      (aimY - from.y + 0.5 * GRAVITY * time * time) / time,
      (to.z - from.z) / time,
    );
    const prop = spawnProp(this.host.scene, this.host.assets, DISASTER_MODEL_IDS.tomato, "tomato", (parent) => {
      const ball = MeshBuilder.CreateSphere("tomato-fallback", { diameter: 0.16, segments: 8 }, this.host.scene);
      ball.material = this.flatMaterial("tomato-fallback", "#D9261C");
      ball.parent = parent;
    });
    prop.root.position.copyFrom(from);
    prop.root.scaling.setAll(TOMATO_SCALE);
    this.flying.push({
      prop,
      velocity,
      floorY: this.host.floorHeight(to.x, to.y, to.z),
      spin: new Vector3(between(-9, 9, this.random), between(-9, 9, this.random), between(-9, 9, this.random)),
      splatted: null,
    });
    this.host.sfx.play("throw", 0.8);
  }

  private updateTomato(tomato: Tomato, dt: number): void {
    const root = tomato.prop.root;
    if (tomato.splatted !== null) {
      tomato.splatted += dt;
      // Lies there, then shrinks away.
      const fade = Math.max(0, tomato.splatted - (SPLAT_SECONDS - 0.6)) / 0.6;
      root.scaling.set(TOMATO_SCALE * 1.5 * (1 - fade), TOMATO_SCALE * 0.3 * (1 - fade), TOMATO_SCALE * 1.5 * (1 - fade));
      if (tomato.splatted >= SPLAT_SECONDS) {
        tomato.prop.dispose();
        this.flying.splice(this.flying.indexOf(tomato), 1);
      }
      return;
    }

    tomato.velocity.y -= GRAVITY * dt;
    root.position.addInPlace(tomato.velocity.scale(dt));
    root.rotation.addInPlace(tomato.spin.scale(dt));

    for (const cook of this.host.cooks) {
      const player = cook.player;
      if (player.isDowned()) continue;
      const dx = player.position.x - root.position.x;
      const dz = player.position.z - root.position.z;
      const height = root.position.y - player.position.y;
      if (dx * dx + dz * dz > HIT_RADIUS * HIT_RADIUS || height < 0.1 || height > 1.6) continue;
      this.host.hitCook(cook, root.position.x - tomato.velocity.x * 0.05, root.position.z - tomato.velocity.z * 0.05, 0.5);
      this.host.notify(t("disaster.splatted", { name: cook.label }), "warning");
      this.splat(tomato, new Vector3(player.position.x, player.position.y + 0.02, player.position.z));
      return;
    }

    if (tomato.velocity.y > 0) return;
    const floor = this.surfaceUnder(root.position.x, tomato.floorY, root.position.z);
    if (root.position.y <= floor) this.splat(tomato, new Vector3(root.position.x, floor + 0.01, root.position.z));
  }

  /** The counter top under (x, z), or the floor. */
  private surfaceUnder(x: number, y: number, z: number): number {
    const half = KITCHEN_TILE / 2;
    for (const view of this.host.stationViews()) {
      if (Math.abs(view.root.position.y - y) <= STOREY_REACH &&
        Math.abs(view.x - x) < half && Math.abs(view.z - z) < half) return view.root.position.y + view.topHeight;
    }
    return this.host.floorHeight(x, y, z);
  }

  private splat(tomato: Tomato, at: Vector3): void {
    tomato.splatted = 0;
    const root = tomato.prop.root;
    root.position.copyFrom(at);
    root.rotation.set(0, root.rotation.y, 0);
    this.host.sfx.play("splat");
    this.burst(at);
  }

  /** A short spray of red juice where the tomato burst. */
  private burst(at: Vector3): void {
    if (!this.juiceTexture) return;
    const juice = new ParticleSystem("tomato-juice", 40, this.host.scene);
    juice.particleTexture = this.juiceTexture;
    juice.emitter = at.add(new Vector3(0, 0.1, 0));
    juice.color1 = new Color4(0.95, 0.12, 0.08, 1);
    juice.color2 = new Color4(0.75, 0.05, 0.04, 1);
    juice.colorDead = new Color4(0.5, 0.02, 0.02, 0);
    juice.minSize = 0.05;
    juice.maxSize = 0.13;
    juice.minLifeTime = 0.25;
    juice.maxLifeTime = 0.55;
    juice.direction1 = new Vector3(-1.4, 2.2, -1.4);
    juice.direction2 = new Vector3(1.4, 3.4, 1.4);
    juice.gravity = new Vector3(0, -12, 0);
    juice.manualEmitCount = 36;
    juice.targetStopDuration = 0.6;
    juice.disposeOnStop = true;
    trackParticleSystem(juice).start();
  }

  private flatMaterial(name: string, hex: string): StandardMaterial {
    const existing = this.materials.find((material) => material.name === name);
    if (existing) return existing;
    const material = new StandardMaterial(name, this.host.scene);
    material.diffuseColor = Color3.FromHexString(hex);
    this.materials.push(material);
    return material;
  }
}

