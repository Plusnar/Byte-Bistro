import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { LayoutPhase } from "../data/mechanismConfig";
import type { MechanismPlacement } from "./KitchenEnvironment";
import {
  IDLE_STATE,
  isPresentAt,
  isRunningAt,
  isWarningAt,
  bottleFlight,
  bottleHits,
  bottlePosition,
  crewMembers,
  isCrewKind,
  MARCH_BODY_RADIUS,
  marchMembers,
  pairPortals,
  pushOutOfMarch,
  stateAt,
  VANISH_WARNING_SECONDS,
  type MechanismState,
} from "../gameplay/mechanisms/MechanismSystem";

/**
 * Drives the level's moving parts: the thin Babylon side of `MechanismSystem`.
 *
 * All it does is read a state for the current moment and apply it to a node. The clock it
 * is given is the pausable kitchen clock, so a paused game simply stops — the pose is a
 * function of time, never of an accumulated step, and a long frame cannot make a platform
 * skip through a wall.
 *
 * It owns nothing: `KitchenEnvironment` creates and disposes the nodes.
 */

/** How close a cook's feet have to be to a platform's top to count as standing on it. */
const RIDE_HEIGHT_TOLERANCE = 0.35;

/**
 * Longest step a rider may be carried in one frame.
 *
 * The pose itself is a function of time and needs no cap, but the distance a passenger is
 * dragged does: the kitchen clock runs for the whole session, so the first frame after a
 * reset, or after a long stall, would otherwise sweep a cook across the room. The same
 * ceiling `KitchenScene.update` puts on its own delta.
 */
const MAX_CARRY_STEP_SECONDS = 0.1;

/** How close to a portal's centre something has to be to go through it. */
const PORTAL_RADIUS = 0.55;
/**
 * How far in front of the far portal things come out: clear of its radius, so walking
 * out does not send a cook straight back in.
 */
const PORTAL_EXIT_OFFSET = 0.95;

/** A cook's radius, for the parade's push (cooks are 0.66 m wide). */
const RIDER_RADIUS = 0.33;

/** A blinking floor alternates on this period, in seconds. Fast enough to read as urgent. */
const BLINK_PERIOD = 0.15;
const BLINK_DIM = 0.3;

export interface MechanismRider {
  /** Where the rider is now, read each frame. */
  readonly position: Vector3;
  /** Moves them by this much, respecting collision. */
  carry(x: number, z: number): void;
  /** Their floor vanished from under them. */
  fell?(): void;
  /** Something thrown (a bottle) hit them, coming from (fromX, fromZ). */
  hit?(fromX: number, fromZ: number): void;
}

/** Where the shift is, for phases and for warning ahead of one. */
export interface ShiftClock {
  /** 0 at the whistle, 1 at the buzzer. */
  readonly progress: number;
  readonly duration: number;
}

/** Bookkeeping per mechanism that the pure system has no business knowing about. */
interface Runtime {
  /** Seconds spent switched off by a layout phase, taken off the clock it reads. */
  frozen: number;
  /** The local clock last frame, so motion resumes exactly where it stopped. */
  previousLocal: number;
  /** Bottle fights: the throw that last hit someone, so one bottle hits once. */
  lastHitThrow: number;
  /** Vanishing floors: whether it was there last frame. */
  present: boolean;
  /** The visibility last written, so a steady floor costs no writes. */
  visibility: number;
  /** A conveyor's pull, turned to match how the designer placed it. */
  pushX: number;
  pushZ: number;
  /** Cached once: the mechanism's own meshes, for the blink. */
  readonly meshes: readonly AbstractMesh[];
}

const OFF: MechanismState = IDLE_STATE;
const NO_SHIFT: ShiftClock = { progress: 0, duration: 0 };

export class KitchenMechanisms {
  private readonly states = new Map<MechanismPlacement, MechanismState>();
  private readonly runtimes: readonly Runtime[];
  private readonly partners: ReadonlyMap<number, number>;
  private previousSeconds = 0;
  /** Reused every frame for the parade's marcher positions. */
  private readonly marchScratch: { x: number; z: number }[] = [];

  constructor(
    private readonly placements: readonly MechanismPlacement[],
    private readonly phases?: readonly LayoutPhase[],
  ) {
    this.runtimes = placements.map((placement) => ({
      frozen: 0,
      previousLocal: 0,
      lastHitThrow: -1,
      present: true,
      visibility: 1,
      pushX: 0,
      pushZ: 0,
      meshes: placement.node.getChildMeshes(false),
    }));
    this.partners = pairPortals(placements.map((placement) => placement.config));
  }

  get isEmpty(): boolean {
    return this.placements.length === 0;
  }

  /**
   * Puts every mechanism back at its opening pose, for the start of a shift.
   *
   * @param seconds the kitchen clock now. It accumulates across the whole session rather
   * than restarting with the shift, so a reset that assumed zero would make the next frame
   * look like hours had passed.
   */
  reset(seconds = 0): void {
    this.previousSeconds = seconds;
    this.states.clear();
    this.placements.forEach((placement, index) => {
      const runtime = this.runtimes[index]!;
      runtime.frozen = 0;
      runtime.previousLocal = seconds;
      runtime.pushX = 0;
      runtime.pushZ = 0;
      placement.node.position.copyFrom(placement.origin);
      placement.node.rotation.y = placement.originYaw;
      if (!runtime.present) placement.node.setEnabled(true);
      runtime.present = true;
      this.setVisibility(runtime, 1);
    });
  }

  /**
   * Moves every mechanism to where it belongs at `seconds`, and carries whatever is riding.
   *
   * @param seconds the pausable kitchen clock, in seconds.
   * @param shift how far into the shift we are; drives the layout phases.
   */
  update(seconds: number, riders: readonly MechanismRider[], shift: ShiftClock = NO_SHIFT): void {
    if (this.placements.length === 0) return;
    const elapsed = Math.max(0, seconds - this.previousSeconds);
    const step = Math.min(MAX_CARRY_STEP_SECONDS, elapsed);

    this.placements.forEach((placement, index) => {
      const runtime = this.runtimes[index]!;
      const running = isRunningAt(this.phases, placement.id, shift.progress);
      // Switched off, its own clock stands still: when it comes back on it carries on
      // from where it stopped instead of jumping to where the shift clock says.
      if (!running) runtime.frozen += elapsed;
      const local = seconds - runtime.frozen;

      const state = running ? stateAt(placement.config, local, runtime.previousLocal) : OFF;
      runtime.previousLocal = local;
      this.states.set(placement, state);

      if (running) this.applyPose(placement, runtime, state);
      if (placement.config.kind === "vanishing_floor") {
        this.updateFloor(placement, runtime, running, local, shift, riders);
      }
      if (placement.config.kind === "march") {
        // Nobody rides a parade: it faces its way, steps while it travels, and shoves.
        placement.march?.update(placement.node.position, state.pose.yaw, running && state.active);
        this.pushOutOfMarch(placement, riders);
      } else if (isCrewKind(placement.config.kind)) {
        // The party crews: solid like the parade, and the throwers' bottles hit.
        placement.crew?.update(placement.node.position, placement.node.rotation.y, running && state.active);
        this.pushOutOfCrew(placement, riders);
        if (placement.config.kind === "bottle_fight") this.flyBottle(placement, runtime, running && state.active, riders);
      } else if (running) {
        this.carryRiders(placement, runtime, state, step, riders);
      }
    });
    this.previousSeconds = seconds;
  }

  /**
   * Slides a resting floor item along whatever belt it is lying on.
   *
   * Written straight into the position, unlike a cook: a dropped ingredient has no
   * collider of its own, and the bounds it is clamped to are the same ones the throw
   * physics uses, so it cannot be pushed out of the room.
   */
  pushItem(
    position: Vector3,
    deltaSeconds: number,
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): void {
    if (this.placements.length === 0 || deltaSeconds <= 0) return;
    for (const [index, placement] of this.placements.entries()) {
      if (placement.config.kind !== "conveyor") continue;
      if (!this.states.get(placement)?.active) continue;
      if (!this.isRiding(placement, position)) continue;
      const runtime = this.runtimes[index]!;
      position.x = Math.min(maxX, Math.max(minX, position.x + runtime.pushX * deltaSeconds));
      position.z = Math.min(maxZ, Math.max(minZ, position.z + runtime.pushZ * deltaSeconds));
      return;
    }
  }

  /**
   * Where something at `position` comes out, if it has stepped into an open portal.
   *
   * Writes the exit into `out` and returns true; returns false when it is not in a portal,
   * or the portal is closed, or its partner is. The exit is in front of the far portal, in
   * the direction the designer turned it, so a portal against a wall can be aimed away
   * from the wall.
   */
  findPortalExit(position: Vector3, out: Vector3): boolean {
    for (const [index, partnerIndex] of this.partners) {
      const portal = this.placements[index]!;
      const partner = this.placements[partnerIndex]!;
      if (!this.states.get(portal)?.active || !this.states.get(partner)?.active) continue;
      const dx = position.x - portal.node.position.x;
      const dz = position.z - portal.node.position.z;
      if (dx * dx + dz * dz > PORTAL_RADIUS * PORTAL_RADIUS) continue;
      const yaw = partner.node.rotation.y;
      out.set(
        partner.node.position.x + Math.sin(yaw) * PORTAL_EXIT_OFFSET,
        position.y,
        partner.node.position.z + Math.cos(yaw) * PORTAL_EXIT_OFFSET,
      );
      return true;
    }
    return false;
  }

  /** The state of one mechanism, for the HUD and for tests. */
  stateOf(placement: MechanismPlacement): MechanismState | undefined {
    return this.states.get(placement);
  }

  private applyPose(placement: MechanismPlacement, runtime: Runtime, state: MechanismState): void {
    const node = placement.node;
    node.position.set(
      placement.origin.x + state.pose.x,
      placement.origin.y + state.pose.y,
      placement.origin.z + state.pose.z,
    );
    // On top of the yaw it was placed at, never instead of it: a belt the designer turned
    // in the editor has to stay turned. A parade's yaw is its marchers' (MarchLine), each
    // turning in place; turning the node would swing the whole column round its middle.
    node.rotation.y = placement.originYaw + (placement.config.kind === "march" ? 0 : state.pose.yaw);
    // A conveyor pulls along its own length, turned however it was placed — so rotating a
    // belt is how it is aimed. Its length is whichever of its measured sides is longer:
    // the stock belt runs along its x, and pulling along z shoved cooks sideways off it.
    const along = placement.halfExtentX > placement.halfExtentZ ? Math.PI / 2 : 0;
    const angle = placement.originYaw + along;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    runtime.pushX = state.pushX * cos + state.pushZ * sin;
    runtime.pushZ = state.pushZ * cos - state.pushX * sin;
  }

  /**
   * Shows or hides a vanishing floor, blinks it before it goes, and drops whoever was on
   * it when it went.
   *
   * The blink is the mesh's own visibility, not a particle or a glow: the rules say no
   * quality level may switch off something that tells the player about danger, and this
   * cannot be switched off.
   */
  private updateFloor(
    placement: MechanismPlacement,
    runtime: Runtime,
    running: boolean,
    local: number,
    shift: ShiftClock,
    riders: readonly MechanismRider[],
  ): void {
    const present = running && isPresentAt(placement.config, local);
    if (runtime.present && !present) {
      // Checked before the floor is switched off, while it is still where they stood.
      for (const rider of riders) {
        if (this.isRiding(placement, rider.position)) rider.fell?.();
      }
    }
    if (present !== runtime.present) {
      placement.node.setEnabled(present);
      runtime.present = present;
    }

    // About to go: either its own interval is ending, or a layout phase is about to switch
    // it off. Looking a warning's length ahead in the shift covers any order of phases.
    const lead = shift.duration > 0 ? VANISH_WARNING_SECONDS / shift.duration : 0;
    const goingSoon = present && (
      isWarningAt(placement.config, local) ||
      (lead > 0 && !isRunningAt(this.phases, placement.id, shift.progress + lead))
    );
    const blink = Math.floor(local / BLINK_PERIOD) % 2 === 0 ? 1 : BLINK_DIM;
    this.setVisibility(runtime, goingSoon ? blink : 1);
  }

  private setVisibility(runtime: Runtime, visibility: number): void {
    if (runtime.visibility === visibility) return;
    runtime.visibility = visibility;
    for (const mesh of runtime.meshes) mesh.visibility = visibility;
  }

  /**
   * Babylon's collision does not carry what stands on a moving surface, so this does it.
   *
   * A platform drags its riders by exactly the distance it moved; a conveyor pushes
   * anything over it at its own speed. Both go through `carry`, which sweeps with collision
   * rather than writing a position — a belt pressing a cook into a counter must stop at
   * the counter, not post them through it.
   */
  private carryRiders(
    placement: MechanismPlacement,
    runtime: Runtime,
    state: MechanismState,
    deltaSeconds: number,
    riders: readonly MechanismRider[],
  ): void {
    const movesRiders = runtime.pushX !== 0 || runtime.pushZ !== 0 ||
      state.delta.x !== 0 || state.delta.z !== 0;
    if (!movesRiders || deltaSeconds <= 0) return;

    for (const rider of riders) {
      if (!this.isRiding(placement, rider.position)) continue;
      rider.carry(
        state.delta.x + runtime.pushX * deltaSeconds,
        state.delta.z + runtime.pushZ * deltaSeconds,
      );
    }
  }

  /**
   * The parade is solid: whoever overlaps a marcher is moved out of them, through `carry`,
   * so a cook shoved toward a counter stops at the counter. Applied every frame, standing
   * still or walking, which is what makes the column push rather than pass through.
   */
  private pushOutOfMarch(placement: MechanismPlacement, riders: readonly MechanismRider[]): void {
    const members = marchMembers(placement.config, placement.node.position, this.marchScratch);
    for (const rider of riders) {
      const push = pushOutOfMarch(rider.position, members, MARCH_BODY_RADIUS + RIDER_RADIUS);
      if (push) rider.carry(push.x, push.z);
    }
  }

  /** Brawlers and runners are solid too: cooks are moved out of them. */
  private pushOutOfCrew(placement: MechanismPlacement, riders: readonly MechanismRider[]): void {
    const members = crewMembers(placement.config, placement.node.position, placement.node.rotation.y, this.marchScratch);
    for (const rider of riders) {
      const push = pushOutOfMarch(rider.position, members, MARCH_BODY_RADIUS + RIDER_RADIUS);
      if (push) rider.carry(push.x, push.z);
    }
  }

  /**
   * The bottle between two throwers: where the first thrower's clip is decides whether one
   * is in the air and where (MechanismSystem.bottleFlight). A cook in its way is knocked
   * over, once per bottle.
   */
  private flyBottle(placement: MechanismPlacement, runtime: Runtime, active: boolean, riders: readonly MechanismRider[]): void {
    const crew = placement.crew;
    if (!crew) return;
    const { progress, cycles } = crew.throwProgress();
    const flight = active ? bottleFlight(progress, cycles) : null;
    if (!flight) {
      crew.showBottle(null, 0);
      return;
    }
    const members = crewMembers(placement.config, placement.node.position, placement.node.rotation.y, this.marchScratch);
    const bottle = bottlePosition(flight, members);
    crew.showBottle(bottle, flight.progress);
    if (runtime.lastHitThrow === flight.throwIndex) return;
    for (const rider of riders) {
      if (!bottleHits(bottle, rider.position)) continue;
      runtime.lastHitThrow = flight.throwIndex;
      rider.hit?.(bottle.x, bottle.z);
      crew.showBottle(null, 0);
      return;
    }
  }

  /**
   * Whether `position` is over this mechanism and close enough to its top to be carried.
   *
   * Tested in the mechanism's own frame, against its measured size: a belt is two metres
   * long and one wide, and turning it turns the area it carries.
   */
  private isRiding(placement: MechanismPlacement, position: Vector3): boolean {
    const node = placement.node;
    const dx = position.x - node.position.x;
    const dz = position.z - node.position.z;
    // Into the node's frame: undo its yaw. Its local +z faces (sin, cos) in the world.
    const cos = Math.cos(node.rotation.y);
    const sin = Math.sin(node.rotation.y);
    const localX = dx * cos - dz * sin;
    const localZ = dx * sin + dz * cos;
    if (Math.abs(localX - placement.centerX) > placement.halfExtentX) return false;
    if (Math.abs(localZ - placement.centerZ) > placement.halfExtentZ) return false;
    // Measured against the surface a passenger actually stands on, not the node's base:
    // a platform is a solid box, and anything riding it is up on its lid. A flat belt
    // measures nearly zero, so this stays right for conveyors too.
    const feet = position.y - node.position.y;
    return feet >= -RIDE_HEIGHT_TOLERANCE &&
      feet <= placement.topHeight + RIDE_HEIGHT_TOLERANCE;
  }
}
