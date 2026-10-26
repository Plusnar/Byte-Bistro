import {
  Color3,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Node,
} from "@babylonjs/core";
import { t } from "../../i18n";
import type { LoopHandle } from "../../core/SynthSfx";
import { DISASTER_MODEL_IDS } from "./assets";
import { spawnProp, type Prop } from "./props";
import { between, type Disaster, type DisasterHost, type DisasterStationView } from "./types";

/** How long the lane flashes on the floor before the car arrives. */
export const LANE_WARNING_SECONDS = 1.5;
const CAR_SPEED = 16;
/** Half the width of the truck's lane: stations and cooks closer than this are hit. */
const LANE_HALF_WIDTH = 1.4;
const CAR_HALF_LENGTH = 2.85;
/** Seconds the kitchen lies wrecked after each pass before it puts itself back together. */
export const WRECKED_SECONDS = 3.5;
/** Seconds the pieces take to fly back to their places. */
export const REBUILD_SECONDS = 1.5;
/** How many times the truck comes through before the event is over. */
export const PASSES = 3;
/** Roughly how long one pass takes from its lane flashing to the kitchen rebuilt. */
const PASS_SECONDS = LANE_WARNING_SECONDS + 2 + WRECKED_SECONDS + REBUILD_SECONDS;
const GRAVITY = 18;

interface Wreck {
  readonly view: DisasterStationView;
  /** Holds the station's visible parts while they fly; its collider stays put. */
  readonly flight: TransformNode;
  readonly parts: Node[];
  readonly home: Vector3;
  readonly homeRotation: Quaternion;
  readonly velocity: Vector3;
  readonly spin: Vector3;
  /** Where it came to rest, to fly back from. */
  readonly rest: Vector3;
  readonly restRotation: Quaternion;
  launched: boolean;
}

type Phase = "lane" | "drive" | "wrecked" | "rebuild" | "done";

/**
 * A runaway stainless pickup crashes through the kitchen three times, each time
 * along a new line. A flashing lane on the floor shows where, with the horn, before
 * it comes through: counters in its way go flying with whatever is on them, and so
 * does anyone standing there. A few seconds later every piece flies back to where it
 * was, with its contents, and the lane for the next pass lights up.
 *
 * Only the counters' models move. Their colliders and the kitchen's own record of
 * the stations stay where they are, so cooking carries on and nothing is lost.
 */
export class TeslaCrash implements Disaster {
  readonly kind = "tesla" as const;
  readonly duration = PASSES * PASS_SECONDS;
  private phase: Phase = "lane";
  /** Passes completed so far. */
  private pass = 0;
  private clock = 0;
  private car: Prop | null = null;
  private lane: Mesh | null = null;
  private laneMaterial: StandardMaterial | null = null;
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly direction = new Vector3();
  private travelled = 0;
  private length = 0;
  private readonly wrecks: Wreck[] = [];
  private readonly hitCooks = new Set<number>();
  private engine: LoopHandle | null = null;
  private scattered = false;

  constructor(private readonly host: DisasterHost, private readonly random: () => number = Math.random) {}

  get currentPhase(): Phase {
    return this.phase;
  }

  /** Passes the truck has finished, 0..PASSES. */
  get passes(): number {
    return this.pass;
  }

  start(): void {
    this.pass = 0;
    this.laneMaterial = new StandardMaterial("tesla-lane", this.host.scene);
    this.laneMaterial.diffuseColor = Color3.FromHexString("#FF3355");
    this.laneMaterial.emissiveColor = Color3.FromHexString("#FF3355");
    this.laneMaterial.disableLighting = true;
    this.laneMaterial.alpha = 0.35;
    this.beginPass();
  }

  /**
   * Lights the lane for the next pass and parks the truck at its start. The first and
   * last passes run the long way across through a cook's row; the middle one cuts
   * front to back through a cook's column.
   */
  private beginPass(): void {
    const { bounds, cooks, scene, assets } = this.host;
    this.phase = "lane";
    this.clock = 0;
    this.travelled = 0;
    this.scattered = false;
    this.hitCooks.clear();
    const victims = cooks.filter((cook) => !cook.player.isAbducted);
    const cook = victims[Math.floor(this.random() * victims.length)];
    const across = this.pass !== 1;
    // Each pass comes from the other side to the one before.
    const forwards = (this.pass % 2 === 0) === (this.random() < 0.5);
    const margin = 9;
    if (across) {
      const z = cook
        ? Math.min(bounds.maxZ, Math.max(bounds.minZ, cook.player.position.z + between(-0.4, 0.4, this.random)))
        : between(bounds.minZ, bounds.maxZ, this.random);
      this.from.set(forwards ? bounds.minX - margin : bounds.maxX + margin, 0, z);
      this.to.set(forwards ? bounds.maxX + margin : bounds.minX - margin, 0, z);
    } else {
      const x = cook
        ? Math.min(bounds.maxX, Math.max(bounds.minX, cook.player.position.x + between(-0.4, 0.4, this.random)))
        : between(bounds.minX, bounds.maxX, this.random);
      this.from.set(x, 0, forwards ? bounds.minZ - margin : bounds.maxZ + margin);
      this.to.set(x, 0, forwards ? bounds.maxZ + margin : bounds.minZ - margin);
    }
    this.to.subtractToRef(this.from, this.direction);
    this.length = this.direction.length();
    this.direction.normalize();

    this.lane?.dispose();
    this.lane = MeshBuilder.CreateGround("tesla-lane", {
      width: across ? bounds.maxX - bounds.minX + 4 : LANE_HALF_WIDTH * 2,
      height: across ? LANE_HALF_WIDTH * 2 : bounds.maxZ - bounds.minZ + 4,
    }, scene);
    this.lane.position.set(
      across ? (bounds.minX + bounds.maxX) / 2 : this.from.x,
      0.035,
      across ? this.from.z : (bounds.minZ + bounds.maxZ) / 2,
    );
    this.lane.material = this.laneMaterial;
    this.lane.isPickable = false;

    this.car?.dispose();
    this.car = spawnProp(scene, assets, DISASTER_MODEL_IDS.tesla, "tesla", (parent) => this.fallbackCar(parent));
    this.car.root.position.copyFrom(this.from);
    this.car.root.rotation.y = Math.atan2(this.direction.x, this.direction.z);
    this.host.sfx.play("horn");
  }

  update(dt: number): boolean {
    this.clock += dt;
    switch (this.phase) {
      case "lane":
        if (this.lane) this.lane.visibility = 0.5 + 0.5 * Math.abs(Math.sin(this.clock * 12));
        if (this.clock >= LANE_WARNING_SECONDS) {
          this.phase = "drive";
          this.clock = 0;
          this.engine = this.host.sfx.loop("engine", 1);
          this.host.sfx.play("horn");
        }
        break;
      case "drive":
        this.drive(dt);
        break;
      case "wrecked":
        for (const wreck of this.wrecks) this.fly(wreck, dt);
        if (this.clock >= WRECKED_SECONDS) {
          this.phase = "rebuild";
          this.clock = 0;
          for (const wreck of this.wrecks) {
            wreck.rest.copyFrom(wreck.flight.position);
            wreck.restRotation.copyFrom(wreck.flight.rotationQuaternion ?? Quaternion.Identity());
          }
        }
        break;
      case "rebuild":
        this.rebuild(Math.min(1, this.clock / REBUILD_SECONDS));
        if (this.clock >= REBUILD_SECONDS) {
          this.restoreAll();
          this.pass += 1;
          if (this.pass < PASSES) {
            this.beginPass();
          } else {
            this.phase = "done";
            this.host.notify(t("disaster.over"), "success");
          }
        }
        break;
      case "done":
        return false;
    }
    return true;
  }

  stop(): void {
    this.restoreAll();
    this.engine?.stop(0.3);
    this.engine = null;
    this.car?.dispose();
    this.car = null;
    this.lane?.dispose();
    this.lane = null;
    this.laneMaterial?.dispose();
    this.laneMaterial = null;
    this.phase = "done";
  }

  private drive(dt: number): void {
    const car = this.car!;
    this.travelled += CAR_SPEED * dt;
    this.from.addToRef(this.direction.scale(this.travelled), car.root.position);
    // A rattle on the suspension at that speed.
    car.root.position.y = Math.abs(Math.sin(this.travelled * 3)) * 0.04;
    const front = car.root.position.add(this.direction.scale(CAR_HALF_LENGTH));

    for (const view of this.host.stationViews()) {
      // Views are listed afresh each call, so they are matched by their node.
      if (this.wrecks.some((wreck) => wreck.view.root === view.root)) continue;
      const along = (view.x - this.from.x) * this.direction.x + (view.z - this.from.z) * this.direction.z;
      const lateral = Math.abs((view.x - this.from.x) * this.direction.z - (view.z - this.from.z) * this.direction.x);
      if (lateral > LANE_HALF_WIDTH || along > this.travelled + CAR_HALF_LENGTH) continue;
      this.launch(view, lateral);
    }
    for (const cook of this.host.cooks) {
      if (this.hitCooks.has(cook.index) || cook.player.isAbducted) continue;
      const p = cook.player.position;
      const along = (p.x - car.root.position.x) * this.direction.x + (p.z - car.root.position.z) * this.direction.z;
      const lateral = Math.abs((p.x - this.from.x) * this.direction.z - (p.z - this.from.z) * this.direction.x);
      if (lateral > LANE_HALF_WIDTH * 0.9 || Math.abs(along) > CAR_HALF_LENGTH) continue;
      this.hitCooks.add(cook.index);
      this.host.hitCook(cook, car.root.position.x, car.root.position.z, 1);
      this.host.notify(t("disaster.runOver", { name: cook.label }), "error");
    }
    const { bounds } = this.host;
    const centre = new Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
    const passedCentre = (centre.x - front.x) * this.direction.x + (centre.z - front.z) * this.direction.z < 0;
    if (!this.scattered && passedCentre) {
      this.scattered = true;
      this.host.scatterFloorItems(front.x, front.z, 3, 7);
    }
    for (const wreck of this.wrecks) this.fly(wreck, dt);

    if (this.travelled >= this.length) {
      this.engine?.stop(0.6);
      this.engine = null;
      this.car?.dispose();
      this.car = null;
      this.lane?.dispose();
      this.lane = null;
      this.phase = "wrecked";
      this.clock = 0;
    }
  }

  /** Sends a counter's models flying out of the car's way, spinning. */
  private launch(view: DisasterStationView, lateral: number): void {
    const root = view.root;
    const flight = new TransformNode(`${root.name}-wreck`, this.host.scene);
    root.computeWorldMatrix(true);
    flight.position.copyFrom(root.getAbsolutePosition());
    flight.rotationQuaternion = Quaternion.FromEulerAngles(0, root.rotation.y, 0);
    const parts = root.getChildren().filter((child) => !child.name.endsWith("-collider"));
    for (const part of parts) (part as TransformNode).setParent?.(flight);

    // Thrown ahead of the car and out to the side it was on, high into the air.
    const side = (view.x - this.from.x) * this.direction.z - (view.z - this.from.z) * this.direction.x >= 0 ? 1 : -1;
    const push = between(5, 9, this.random) * (1.2 - lateral / LANE_HALF_WIDTH * 0.4);
    const velocity = new Vector3(
      this.direction.x * push + this.direction.z * side * between(2, 4, this.random),
      between(5, 8, this.random),
      this.direction.z * push - this.direction.x * side * between(2, 4, this.random),
    );
    this.wrecks.push({
      view,
      flight,
      parts,
      home: flight.position.clone(),
      homeRotation: flight.rotationQuaternion.clone(),
      velocity,
      spin: new Vector3(between(-6, 6, this.random), between(-8, 8, this.random), between(-6, 6, this.random)),
      rest: Vector3.Zero(),
      restRotation: Quaternion.Identity(),
      launched: true,
    });
    this.host.sfx.play("crash", this.wrecks.length === 1 ? 1 : 0.6);
    this.host.shake(0.3, 0.6);
  }

  private fly(wreck: Wreck, dt: number): void {
    if (!wreck.launched) return;
    const flight = wreck.flight;
    wreck.velocity.y -= GRAVITY * dt;
    flight.position.addInPlace(wreck.velocity.scale(dt));
    const turn = Quaternion.FromEulerAngles(wreck.spin.x * dt, wreck.spin.y * dt, wreck.spin.z * dt);
    flight.rotationQuaternion = turn.multiply(flight.rotationQuaternion!);
    if (flight.position.y > 0) return;
    // Bounces, slowing, until it lies still where it fell.
    flight.position.y = 0;
    if (Math.abs(wreck.velocity.y) < 1.5) {
      wreck.velocity.setAll(0);
      wreck.spin.setAll(0);
      wreck.launched = false;
      return;
    }
    wreck.velocity.y = -wreck.velocity.y * 0.35;
    wreck.velocity.x *= 0.55;
    wreck.velocity.z *= 0.55;
    wreck.spin.scaleInPlace(0.5);
  }

  /** Every piece flies home along an arc and settles into its old place. */
  private rebuild(t: number): void {
    const eased = t * t * (3 - 2 * t);
    for (const wreck of this.wrecks) {
      Vector3.LerpToRef(wreck.rest, wreck.home, eased, wreck.flight.position);
      wreck.flight.position.y += Math.sin(Math.PI * t) * 2.2;
      Quaternion.SlerpToRef(wreck.restRotation, wreck.homeRotation, eased, wreck.flight.rotationQuaternion!);
    }
  }

  private restoreAll(): void {
    for (const wreck of this.wrecks) {
      const flight = wreck.flight;
      flight.position.copyFrom(wreck.home);
      flight.rotationQuaternion!.copyFrom(wreck.homeRotation);
      flight.computeWorldMatrix(true);
      const root = wreck.view.root;
      if (!root.isDisposed()) {
        for (const part of wreck.parts) {
          if (!part.isDisposed()) (part as TransformNode).setParent?.(root);
        }
      }
      flight.dispose(false, false);
    }
    this.wrecks.length = 0;
  }

  /** A steel box, shown until the model has loaded. */
  private fallbackCar(parent: TransformNode): void {
    const scene = this.host.scene;
    const paint = new StandardMaterial("tesla-fallback-paint", scene);
    paint.diffuseColor = Color3.FromHexString("#9EA2A8");
    const body = MeshBuilder.CreateBox("tesla-fallback-body", { width: 2, height: 1.1, depth: 5.7 }, scene);
    body.position.y = 0.7;
    body.material = paint;
    body.parent = parent;
  }
}
