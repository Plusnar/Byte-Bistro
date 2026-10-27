import type { LayoutPhase, MechanismConfig, MechanismWaypoint } from "../../data/mechanismConfig";

/**
 * Where every moving part of a level is at a given moment.
 *
 * Pure and time-driven: the state is a function of the shift clock, not of an accumulated
 * step, so the same second always looks the same. That is what lets this be tested without
 * a Babylon engine, and it is also why pausing cannot make a platform jump — the caller
 * passes the pausable kitchen clock, which simply stops.
 *
 * The Babylon side is `src/scenes/KitchenMechanisms.ts`; nothing here knows what a mesh is.
 */

export interface MechanismPose {
  /** Offset from the placed position, in metres. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Extra yaw, in radians. Only a turntable produces any. */
  readonly yaw: number;
}

export interface MechanismState {
  readonly pose: MechanismPose;
  /** How far the pose moved since the previous sample; what a rider has to be carried by. */
  readonly delta: MechanismPose;
  /** Whether it is running right now; an interval mechanism rests between bursts. */
  readonly active: boolean;
  /** A conveyor's pull, in metres per second. Zero for everything else. */
  readonly pushX: number;
  readonly pushZ: number;
}

const STILL: MechanismPose = { x: 0, y: 0, z: 0, yaw: 0 };

export const IDLE_STATE: MechanismState = {
  pose: STILL,
  delta: STILL,
  active: false,
  pushX: 0,
  pushZ: 0,
};

/** Whether an interval mechanism is in its running phase at `seconds`. */
export const isActiveAt = (config: MechanismConfig, seconds: number): boolean => {
  const activation = config.activation;
  if (activation.mode === "always") return true;
  const cycle = activation.onSeconds + activation.offSeconds;
  if (cycle <= 0) return true;
  const offset = (seconds + config.phase) % cycle;
  return (offset < 0 ? offset + cycle : offset) < activation.onSeconds;
};

/**
 * The stops a platform visits, in order: where it was placed, then its waypoints.
 *
 * The placed position is always the first stop, so a single waypoint already describes a
 * there-and-back rather than a one-way trip to nowhere.
 */
const stopsOf = (config: MechanismConfig): readonly MechanismWaypoint[] =>
  [{ x: 0, y: 0, z: 0 }, ...config.waypoints];

/** Total metres along one pass of the route. */
const routeLength = (stops: readonly MechanismWaypoint[]): number => {
  let total = 0;
  for (let index = 1; index < stops.length; index += 1) {
    total += distance(stops[index - 1]!, stops[index]!);
  }
  return total;
};

const distance = (a: MechanismWaypoint, b: MechanismWaypoint): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

const lerp = (a: number, b: number, amount: number): number => a + (b - a) * amount;

/** The point `travelled` metres along the route, clamped to its ends. */
const pointAlong = (
  stops: readonly MechanismWaypoint[],
  travelled: number,
): MechanismWaypoint => {
  let remaining = Math.max(0, travelled);
  for (let index = 1; index < stops.length; index += 1) {
    const from = stops[index - 1]!;
    const to = stops[index]!;
    const leg = distance(from, to);
    if (leg <= 0) continue;
    if (remaining <= leg) {
      const amount = remaining / leg;
      return {
        x: lerp(from.x, to.x, amount),
        y: lerp(from.y, to.y, amount),
        z: lerp(from.z, to.z, amount),
      };
    }
    remaining -= leg;
  }
  return stops[stops.length - 1] ?? { x: 0, y: 0, z: 0 };
};

/**
 * Where a platform sits at `seconds`.
 *
 * The cycle is out and back, with a pause at each end. Ping-pong rather than a loop,
 * because a platform that teleports home at the end of its route would carry a cook
 * through a wall.
 */
const platformPose = (config: MechanismConfig, seconds: number): MechanismPose => {
  const stops = stopsOf(config);
  const length = routeLength(stops);
  if (length <= 0 || config.speed <= 0) return STILL;

  const travelSeconds = length / config.speed;
  const cycle = (travelSeconds + config.pauseSeconds) * 2;
  const raw = (seconds + config.phase) % cycle;
  const offset = raw < 0 ? raw + cycle : raw;

  // Out, pause, back, pause.
  let travelled: number;
  if (offset < travelSeconds) travelled = (offset / travelSeconds) * length;
  else if (offset < travelSeconds + config.pauseSeconds) travelled = length;
  else if (offset < travelSeconds * 2 + config.pauseSeconds) {
    const back = offset - travelSeconds - config.pauseSeconds;
    travelled = length - (back / travelSeconds) * length;
  } else travelled = 0;

  const point = pointAlong(stops, travelled);
  return { x: point.x, y: point.y, z: point.z, yaw: 0 };
};

/** Where a mechanism sits at `seconds`, ignoring whether it is resting. */
export const poseAt = (config: MechanismConfig, seconds: number): MechanismPose => {
  switch (config.kind) {
    case "platform":
      return platformPose(config, seconds);
    case "turntable":
      return { x: 0, y: 0, z: 0, yaw: (seconds + config.phase) * config.speed * Math.PI * 2 };
    case "conveyor":
      // A conveyor's belt is scenery; only what rides it moves.
    case "vanishing_floor":
    case "portal":
      // These change what they do, not where they are.
      return STILL;
  }
};

/**
 * The full state at `seconds`, including how far it moved since `previousSeconds`.
 *
 * A resting mechanism holds its pose rather than snapping home, so an interval platform
 * waits where it stopped and nobody standing on it is thrown off.
 */
export const stateAt = (
  config: MechanismConfig,
  seconds: number,
  previousSeconds: number,
): MechanismState => {
  const active = isActiveAt(config, seconds);
  // While resting, the clock the pose is read from stands still too.
  const clock = active ? seconds : lastActiveMoment(config, seconds);
  const previousClock = isActiveAt(config, previousSeconds)
    ? previousSeconds
    : lastActiveMoment(config, previousSeconds);

  const pose = poseAt(config, clock);
  const previous = poseAt(config, previousClock);
  return {
    pose,
    delta: {
      x: pose.x - previous.x,
      y: pose.y - previous.y,
      z: pose.z - previous.z,
      yaw: pose.yaw - previous.yaw,
    },
    active,
    pushX: active && config.kind === "conveyor" ? Math.sin(config.directionYaw) * config.speed : 0,
    pushZ: active && config.kind === "conveyor" ? Math.cos(config.directionYaw) * config.speed : 0,
  };
};

/** The moment this cycle's running phase ended, so a resting mechanism freezes there. */
const lastActiveMoment = (config: MechanismConfig, seconds: number): number => {
  const activation = config.activation;
  if (activation.mode === "always") return seconds;
  const cycle = activation.onSeconds + activation.offSeconds;
  if (cycle <= 0) return seconds;
  const raw = (seconds + config.phase) % cycle;
  const offset = raw < 0 ? raw + cycle : raw;
  return seconds - (offset - activation.onSeconds);
};

export interface MechanismFootprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Every square metre this mechanism ever occupies, as one rectangle.
 *
 * The robots' navigation takes this once, at load, and treats it as permanently blocked.
 * That is the whole reason the NavGrid never has to be rebuilt: it is already pessimistic
 * about where a platform might be. Robots mill about the reception and have no business
 * riding the kitchen's machinery anyway.
 */
export const footprintOf = (
  config: MechanismConfig,
  origin: { readonly x: number; readonly z: number },
  halfSize: number,
): MechanismFootprint => {
  const stops = stopsOf(config);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const stop of stops) {
    minX = Math.min(minX, origin.x + stop.x);
    maxX = Math.max(maxX, origin.x + stop.x);
    minZ = Math.min(minZ, origin.z + stop.z);
    maxZ = Math.max(maxZ, origin.z + stop.z);
  }
  // A turntable sweeps a circle, so its corners reach further than its sides.
  const reach = config.kind === "turntable" ? halfSize * Math.SQRT2 : halfSize;
  return {
    minX: minX - reach,
    maxX: maxX + reach,
    minZ: minZ - reach,
    maxZ: maxZ + reach,
  };
};

// ---------------------------------------------------------------------------------------
// Vanishing floors

/**
 * Seconds of warning before a floor goes. The player has to be able to read it and step
 * off, so it is long enough to react to rather than a flicker.
 */
export const VANISH_WARNING_SECONDS = 1.5;

/**
 * Whether a vanishing floor is there to stand on at `seconds`. It is present while its
 * interval is "on" and gone while it is "off"; an always-on one never goes on its own and
 * only leaves when a layout phase switches it off.
 */
export const isPresentAt = (config: MechanismConfig, seconds: number): boolean =>
  isActiveAt(config, seconds);

/**
 * Whether a floor that is still there is about to go, so it can blink.
 *
 * Only meaningful for an interval floor: an always-on one has no "about to" — when a
 * phase removes it, the scene warns ahead of the phase instead.
 */
export const isWarningAt = (config: MechanismConfig, seconds: number): boolean => {
  const activation = config.activation;
  if (activation.mode !== "interval") return false;
  const cycle = activation.onSeconds + activation.offSeconds;
  if (cycle <= 0) return false;
  const raw = (seconds + config.phase) % cycle;
  const offset = raw < 0 ? raw + cycle : raw;
  return offset < activation.onSeconds &&
    offset >= activation.onSeconds - Math.min(VANISH_WARNING_SECONDS, activation.onSeconds);
};

// ---------------------------------------------------------------------------------------
// Portals

/**
 * Links portals into pairs by their `portalPairId`.
 *
 * Exactly two portals with the same id make a pair; one alone or three or more link
 * nothing, because "which of the three do I come out of" has no good answer. Returns, for
 * each index that has a partner, the partner's index.
 */
export const pairPortals = (
  portals: readonly { readonly kind: string; readonly portalPairId: string }[],
): Map<number, number> => {
  const groups = new Map<string, number[]>();
  portals.forEach((portal, index) => {
    if (portal.kind !== "portal" || !portal.portalPairId) return;
    const group = groups.get(portal.portalPairId) ?? [];
    group.push(index);
    groups.set(portal.portalPairId, group);
  });
  const partners = new Map<number, number>();
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const [a, b] = group as [number, number];
    partners.set(a, b);
    partners.set(b, a);
  }
  return partners;
};

/** The pair ids that do not form exactly one pair, for the editor to flag. */
export const unpairedPortalIds = (
  portals: readonly { readonly kind: string; readonly portalPairId: string }[],
): string[] => {
  const counts = new Map<string, number>();
  let blank = 0;
  for (const portal of portals) {
    if (portal.kind !== "portal") continue;
    if (!portal.portalPairId) {
      blank += 1;
      continue;
    }
    counts.set(portal.portalPairId, (counts.get(portal.portalPairId) ?? 0) + 1);
  }
  const broken = [...counts].filter(([, count]) => count !== 2).map(([id]) => id);
  // A portal with no id at all is unpaired too; reported once, under an empty name.
  return blank > 0 ? [...broken, ""] : broken;
};

// ---------------------------------------------------------------------------------------
// Layout phases

/**
 * Whether the mechanism `id` is switched on at `progress` through the shift.
 *
 * Everything starts on. Phases apply in order and the last one to mention an id wins, so
 * "off at 0.0, on again at 0.5" describes a shortcut that opens halfway through. Pure and
 * idempotent: the same progress always gives the same answer, however it was reached.
 */
export const isRunningAt = (
  phases: readonly LayoutPhase[] | undefined,
  id: string,
  progress: number,
): boolean => {
  if (!phases || phases.length === 0) return true;
  let running = true;
  for (const phase of phases) {
    if (phase.atProgress > progress) break;
    if (phase.disable.includes(id)) running = false;
    if (phase.enable.includes(id)) running = true;
  }
  return running;
};

/** The next phase still to come after `progress`, for warning the players ahead of it. */
export const nextPhaseAfter = (
  phases: readonly LayoutPhase[] | undefined,
  progress: number,
): LayoutPhase | null => phases?.find((phase) => phase.atProgress > progress) ?? null;

/**
 * How many phases have happened by `progress`, so the scene can announce each one once as
 * the shift crosses it.
 */
export const phasesReached = (
  phases: readonly LayoutPhase[] | undefined,
  progress: number,
): number => phases?.filter((phase) => phase.atProgress <= progress).length ?? 0;
