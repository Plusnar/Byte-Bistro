import { Color3, MeshBuilder, StandardMaterial, TransformNode, Vector3, type Mesh } from "@babylonjs/core";
import { t } from "../../i18n";
import { DISASTER_MODEL_IDS } from "./assets";
import { spawnProp, type Prop } from "./props";
import { between, type Disaster, type DisasterHost, type LooseItem } from "./types";

/** Most rats in the kitchen at once. */
export const MAX_RATS = 3;
/** Seconds between one rat sneaking in and the next. */
export const RAT_GAP: readonly [number, number] = [3, 5];
/** A cook this close scares a rat into dropping what it carries. */
export const SCARE_RADIUS = 0.6;
/** Slower than a running cook (5.25 m/s), quick enough to need chasing. */
const SEEK_SPEED = 2.8;
const FLEE_SPEED = 3.6;
const GRAB_RADIUS = 0.3;
/** Within this of an item on a counter, the rat jumps up onto it. */
const CLIMB_RADIUS = 0.8;
/** The rat model is life size; this makes it read from the camera. */
const RAT_SCALE = 2.3;

type RatState = "seek" | "flee";

interface Rat {
  readonly prop: Prop;
  state: RatState;
  /** The item it is after, by id, while seeking. */
  targetId: string | null;
  /** What it carries off, while fleeing with loot. */
  loot: LooseItem | null;
  lootLabel: string;
  readonly crumb: Mesh;
  readonly exit: Vector3;
  clock: number;
  /** Seconds left before it may be scared again (it just dropped something). */
  calm: number;
}

/**
 * Rats sneak in from the edges of the kitchen, a few at a time, and run off with
 * food: anything lying on the floor, or sitting on a counter nobody is working at.
 * Food on a board being chopped or in a pot on the stove is safe. A cook who gets
 * close enough scares the rat into dropping what it took and running off without
 * it; a rat that makes it out takes the food with it.
 */
export class RatHeist implements Disaster {
  readonly kind = "rats" as const;
  readonly duration = 20;
  private clock = 0;
  private nextRat = 0;
  private readonly rats: Rat[] = [];
  private crumbMaterial: StandardMaterial | null = null;

  constructor(private readonly host: DisasterHost, private readonly random: () => number = Math.random) {}

  get count(): number {
    return this.rats.length;
  }

  /** How many rats are carrying something off right now. */
  get carrying(): number {
    return this.rats.filter((rat) => rat.loot !== null).length;
  }

  start(): void {
    this.clock = 0;
    this.nextRat = 0;
    this.crumbMaterial = new StandardMaterial("rat-loot", this.host.scene);
    this.crumbMaterial.diffuseColor = Color3.FromHexString("#FFC94D");
    this.crumbMaterial.emissiveColor = Color3.FromHexString("#5A3A00");
    // Two at once to open with, so the heist reads straight away.
    this.addRat();
    this.addRat();
  }

  update(dt: number): boolean {
    this.clock += dt;
    if (this.clock < this.duration) {
      this.nextRat -= dt;
      if (this.nextRat <= 0) {
        if (this.rats.length < MAX_RATS) this.addRat();
        this.nextRat = between(RAT_GAP[0], RAT_GAP[1], this.random);
      }
    }
    for (const rat of [...this.rats]) this.updateRat(rat, dt);
    return this.clock < this.duration || this.rats.length > 0;
  }

  stop(): void {
    // Anything still in a rat's mouth goes back on the floor rather than vanishing.
    for (const rat of this.rats) this.release(rat);
    for (const rat of this.rats) rat.prop.dispose();
    this.rats.length = 0;
    this.crumbMaterial?.dispose();
    this.crumbMaterial = null;
  }

  private addRat(): void {
    const { bounds, scene, assets } = this.host;
    // In from a random edge, and back out of the nearest one later.
    const side = Math.floor(this.random() * 4);
    const along = this.random();
    const x = side < 2 ? bounds.minX + (bounds.maxX - bounds.minX) * along : side === 2 ? bounds.minX - 1 : bounds.maxX + 1;
    const z = side >= 2 ? bounds.minZ + (bounds.maxZ - bounds.minZ) * along : side === 0 ? bounds.minZ - 1 : bounds.maxZ + 1;
    const prop = spawnProp(scene, assets, DISASTER_MODEL_IDS.rat, "rat", (parent) => this.fallbackRat(parent));
    prop.root.position.set(x, 0, z);
    prop.root.scaling.setAll(RAT_SCALE);
    const crumb = MeshBuilder.CreateSphere("rat-loot", { diameter: 0.07, segments: 6 }, scene);
    crumb.material = this.crumbMaterial;
    crumb.parent = prop.root;
    // In its mouth: the model faces +Z.
    crumb.position.set(0, 0.09, 0.23);
    crumb.isVisible = false;
    crumb.isPickable = false;
    this.rats.push({
      prop,
      state: "seek",
      targetId: null,
      loot: null,
      lootLabel: "",
      crumb,
      exit: new Vector3(x, 0, z),
      clock: this.random() * 10,
      calm: 0,
    });
    this.host.sfx.play("squeak");
  }

  private updateRat(rat: Rat, dt: number): void {
    rat.clock += dt;
    rat.calm = Math.max(0, rat.calm - dt);
    const root = rat.prop.root;

    // A cook close by sends it running, dropping whatever it has.
    if (rat.calm <= 0) {
      for (const cook of this.host.cooks) {
        if (cook.player.isAbducted) continue;
        const dx = cook.player.position.x - root.position.x;
        const dz = cook.player.position.z - root.position.z;
        if (dx * dx + dz * dz > SCARE_RADIUS * SCARE_RADIUS) continue;
        if (rat.loot) {
          this.release(rat);
          this.host.notify(t("disaster.scared", { name: cook.label }), "success");
        }
        this.flee(rat);
        rat.calm = 1.5;
        this.host.sfx.play("squeak", 1.2);
        break;
      }
    }

    if (rat.state === "seek") {
      // Done for the day: the last rats head home empty-handed.
      if (this.clock >= this.duration) {
        this.flee(rat);
        return;
      }
      const targets = this.host.stealables();
      let target = rat.targetId ? targets.find((item) => item.id === rat.targetId) : undefined;
      if (!target) {
        // The nearest food not already claimed by another rat.
        const claimed = new Set(this.rats.map((other) => other.targetId));
        let best = Infinity;
        for (const item of targets) {
          if (claimed.has(item.id)) continue;
          const distance = Math.hypot(item.x - root.position.x, item.z - root.position.z);
          if (distance < best) {
            best = distance;
            target = item;
          }
        }
        rat.targetId = target?.id ?? null;
      }
      if (!target) {
        // Nothing to steal: scurry about near where it came in.
        this.wander(rat, dt);
        return;
      }
      const distance = this.moveTowards(rat, target.x, target.z, SEEK_SPEED, dt);
      // Up onto the counter for food left on top of it.
      const up = target.y > 0.1 && distance < CLIMB_RADIUS ? target.y * (1 - distance / CLIMB_RADIUS) * 1.4 : 0;
      root.position.y += (Math.min(target.y, up) - root.position.y) * Math.min(1, dt * 14);
      if (distance < GRAB_RADIUS) {
        const loot = target.take();
        if (loot) {
          rat.loot = loot;
          rat.lootLabel = target.label;
          rat.crumb.isVisible = true;
          this.host.notify(t("disaster.stolen", { item: target.label }), "error");
          this.host.sfx.play("squeak");
        }
        this.flee(rat);
      }
      return;
    }

    // Fleeing: down off any counter and out the nearest edge.
    root.position.y += (0 - root.position.y) * Math.min(1, dt * 10);
    const distance = this.moveTowards(rat, rat.exit.x, rat.exit.z, FLEE_SPEED, dt);
    if (distance < 0.2) {
      // Out of the kitchen: what it carried is gone for good.
      rat.prop.dispose();
      this.rats.splice(this.rats.indexOf(rat), 1);
    }
  }

  private flee(rat: Rat): void {
    rat.state = "flee";
    rat.targetId = null;
    const { bounds } = this.host;
    const p = rat.prop.root.position;
    const options = [
      new Vector3(bounds.minX - 1.5, 0, p.z),
      new Vector3(bounds.maxX + 1.5, 0, p.z),
      new Vector3(p.x, 0, bounds.minZ - 1.5),
      new Vector3(p.x, 0, bounds.maxZ + 1.5),
    ];
    options.sort((a, b) => Vector3.Distance(a, p) - Vector3.Distance(b, p));
    rat.exit.copyFrom(options[0]!);
  }

  /** Drops the rat's loot on the floor where it is. */
  private release(rat: Rat): void {
    if (!rat.loot) return;
    const p = rat.prop.root.position;
    this.host.dropLoose(rat.loot, p.x, p.z);
    rat.loot = null;
    rat.crumb.isVisible = false;
  }

  private wander(rat: Rat, dt: number): void {
    const root = rat.prop.root;
    const angle = rat.clock * 1.3;
    this.moveTowards(rat, root.position.x + Math.cos(angle), root.position.z + Math.sin(angle), SEEK_SPEED * 0.4, dt);
  }

  /** Runs the rat towards (x, z), trotting; returns how far it still has to go. */
  private moveTowards(rat: Rat, x: number, z: number, speed: number, dt: number): number {
    const root = rat.prop.root;
    const dx = x - root.position.x;
    const dz = z - root.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 1e-3) {
      const step = Math.min(distance, speed * dt);
      root.position.x += (dx / distance) * step;
      root.position.z += (dz / distance) * step;
      // The model faces +Z in the game; turn it to the way it runs.
      const yaw = Math.atan2(dx, dz);
      const turn = Math.atan2(Math.sin(yaw - root.rotation.y), Math.cos(yaw - root.rotation.y));
      root.rotation.y += turn * Math.min(1, dt * 14);
    }
    // A scurrying wobble.
    root.rotation.z = Math.sin(rat.clock * 30) * 0.08;
    return distance;
  }

  /** A grey ball with a tail, shown until the model has loaded. */
  private fallbackRat(parent: TransformNode): void {
    const scene = this.host.scene;
    const fur = new StandardMaterial("rat-fallback", scene);
    fur.diffuseColor = Color3.FromHexString("#6B686C");
    const body = MeshBuilder.CreateSphere("rat-fallback-body", { diameter: 0.18, segments: 8 }, scene);
    body.scaling.set(0.8, 0.7, 1.3);
    body.position.y = 0.08;
    body.material = fur;
    body.parent = parent;
  }
}
