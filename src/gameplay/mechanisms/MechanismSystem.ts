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

// ---------------------------------------------------------------------------------------
// The German parade

/** Seven marchers, a little under a metre apart, each about a body wide. */
export const MARCH_SIZE = 7;
export const MARCH_SPACING = 0.85;
export const MARCH_BODY_RADIUS = 0.36;

const smoothstep = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * Which way the marchers face at `seconds`, as radians added to the route's own heading:
 * 0 on the way out, π on the way back, turning about smoothly during each pause (a quick
 * flip when there is no pause). Uses the same out-pause-back-pause cycle as `platformPose`,
 * so they turn exactly while the column stands at an end.
 */
export const marchHeading = (config: MechanismConfig, seconds: number): number => {
  const length = routeLength(stopsOf(config));
  if (length <= 0 || config.speed <= 0) return 0;
  const travel = length / config.speed;
  const pause = config.pauseSeconds;
  const cycle = (travel + pause) * 2;
  const raw = (seconds + config.phase) % cycle;
  const offset = raw < 0 ? raw + cycle : raw;
  if (offset < travel) return 0;
  if (offset < travel + pause) return Math.PI * smoothstep((offset - travel) / pause);
  if (offset < travel * 2 + pause) return Math.PI;
  return pause > 0 ? Math.PI + Math.PI * smoothstep((offset - travel * 2 - pause) / pause) : 0;
};

/** The route's direction, unit length in x/z: toward the first waypoint (+z without one). */
export const marchDirection = (config: MechanismConfig): { x: number; z: number } => {
  const first = config.waypoints[0];
  const length = first ? Math.hypot(first.x, first.z) : 0;
  return first && length > 1e-6 ? { x: first.x / length, z: first.z / length } : { x: 0, z: 1 };
};

/**
 * Where each marcher stands, in a column along the route, centred on `center`. Pass `out`
 * to have it filled in place: the scene asks every frame.
 */
export const marchMembers = (
  config: MechanismConfig,
  center: { readonly x: number; readonly z: number },
  out: { x: number; z: number }[] = [],
): { x: number; z: number }[] => {
  const direction = marchDirection(config);
  for (let index = 0; index < MARCH_SIZE; index += 1) {
    const along = (index - (MARCH_SIZE - 1) / 2) * MARCH_SPACING;
    const member = out[index] ?? (out[index] = { x: 0, z: 0 });
    member.x = center.x + direction.x * along;
    member.z = center.z + direction.z * along;
  }
  out.length = MARCH_SIZE;
  return out;
};

/**
 * How far to move something at `position` so it no longer overlaps any marcher, or null
 * when it is clear. `reach` is the marcher's radius plus its own. The column walking into
 * a cook therefore shoves them ahead or aside, a little each frame, never through.
 */
export const pushOutOfMarch = (
  position: { readonly x: number; readonly z: number },
  members: readonly { readonly x: number; readonly z: number }[],
  reach: number,
): { x: number; z: number } | null => {
  let pushX = 0;
  let pushZ = 0;
  for (const member of members) {
    const dx = position.x - member.x;
    const dz = position.z - member.z;
    const distance = Math.hypot(dx, dz);
    if (distance >= reach) continue;
    if (distance < 1e-4) {
      pushX += reach;
      continue;
    }
    pushX += (dx / distance) * (reach - distance);
    pushZ += (dz / distance) * (reach - distance);
  }
  return pushX === 0 && pushZ === 0 ? null : { x: pushX, z: pushZ };
};

/**
 * A parade's route turned into the world: the editor stores it in the object's own frame
 * ("five metres ahead"), so rotating the object is how a designer aims it.
 */
export const marchInWorld = (config: MechanismConfig, yaw: number): MechanismConfig => {
  if (config.kind !== "march") return config;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    ...config,
    waypoints: config.waypoints.map((point) => ({
      x: point.x * cos + point.z * sin,
      y: point.y,
      z: -point.x * sin + point.z * cos,
    })),
  };
};

// ---------------------------------------------------------------------------------------
// The party gone wrong: bottle throwers, brawlers, a robot running in circles

export type CrewKind = "bottle_fight" | "brawl" | "panic_run";
export const isCrewKind = (kind: string): kind is CrewKind =>
  kind === "bottle_fight" || kind === "brawl" || kind === "panic_run";

/** Brawlers stand this far apart, face to face. */
export const BRAWL_GAP = 1.1;
/** The bottle throwers' gap and the panic runner's radius, unless the editor sets one. */
export const BOTTLE_GAP = { default: 4, min: 2, max: 8 } as const;
export const PANIC_RADIUS = { default: 1.5, min: 0.6, max: 5 } as const;

/** A crew's size from its one waypoint: the throwers' gap, or the runner's radius. */
export const crewSpan = (config: MechanismConfig): number => {
  const first = config.waypoints[0];
  const length = first ? Math.hypot(first.x, first.z) : 0;
  const range = config.kind === "panic_run" ? PANIC_RADIUS : BOTTLE_GAP;
  return length > 0 ? Math.min(range.max, Math.max(range.min, length)) : range.default;
};

/**
 * Where each robot of a crew stands, in the world, around the mechanism's node: the pair
 * face to face along the node's own x (turned by `yaw`), or the runner on the node itself.
 */
export const crewMembers = (
  config: MechanismConfig,
  center: { readonly x: number; readonly z: number },
  yaw: number,
  out: { x: number; z: number }[] = [],
): { x: number; z: number }[] => {
  if (config.kind === "march") return marchMembers(config, center, out);
  const half = config.kind === "brawl" ? BRAWL_GAP / 2 : config.kind === "bottle_fight" ? crewSpan(config) / 2 : 0;
  const count = config.kind === "panic_run" ? 1 : 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  for (let index = 0; index < count; index += 1) {
    const along = count === 1 ? 0 : (index === 0 ? -half : half);
    const member = out[index] ?? (out[index] = { x: 0, z: 0 });
    // The node's local +x in the world, for a node turned by `yaw` (Babylon's convention).
    member.x = center.x + along * cos;
    member.z = center.z - along * sin;
  }
  out.length = count;
  return out;
};

/** Where Drunk_Throw lets go of the bottle, as a fraction of the clip (robot_poses.py). */
export const BOTTLE_RELEASE = 0.48;
/** How much of the clip a bottle spends in the air (0.3 × 2.4 s ≈ 0.7 s). */
export const BOTTLE_FLIGHT = 0.3;
/** How high a bottle leaves the hand, lands, and arcs over the gap, in metres. */
export const BOTTLE_HEIGHTS = { release: 1.35, landing: 1.05, arc: 0.35 } as const;
/** A cook this close to a bottle in the air is hit. */
export const BOTTLE_HIT_RADIUS = 0.45;

export interface BottleFlight {
  /** Which thrower it left: 0 or 1. */
  readonly thrower: 0 | 1;
  /** 0 at the hand, 1 at the other robot. */
  readonly progress: number;
  /** Which throw this is, so one bottle hits at most once. */
  readonly throwIndex: number;
}

/**
 * The bottle in the air, if any, when the first thrower's clip is at `clipProgress`
 * (0..1, `cycles` loops played so far). The second thrower runs half a clip behind, so
 * they take turns: one throws, the other ducks, then throws back.
 */
export const bottleFlight = (clipProgress: number, cycles = 0): BottleFlight | null => {
  const p = ((clipProgress % 1) + 1) % 1;
  const first = (p - BOTTLE_RELEASE + 1) % 1;
  if (first < BOTTLE_FLIGHT) return { thrower: 0, progress: first / BOTTLE_FLIGHT, throwIndex: cycles * 2 };
  const second = (p - BOTTLE_RELEASE - 0.5 + 2) % 1;
  if (second < BOTTLE_FLIGHT) return { thrower: 1, progress: second / BOTTLE_FLIGHT, throwIndex: cycles * 2 + 1 };
  return null;
};

/** Where the bottle is, between the two throwers, on its arc. */
export const bottlePosition = (
  flight: BottleFlight,
  members: readonly { readonly x: number; readonly z: number }[],
): { x: number; y: number; z: number } => {
  const from = members[flight.thrower]!;
  const to = members[flight.thrower === 0 ? 1 : 0]!;
  const s = flight.progress;
  return {
    x: from.x + (to.x - from.x) * s,
    z: from.z + (to.z - from.z) * s,
    y: BOTTLE_HEIGHTS.release + (BOTTLE_HEIGHTS.landing - BOTTLE_HEIGHTS.release) * s + BOTTLE_HEIGHTS.arc * 4 * s * (1 - s),
  };
};

/** Whether a bottle at `bottle` hits a cook standing at `cook` (feet), cooks being ~1.8 m tall. */
export const bottleHits = (
  bottle: { readonly x: number; readonly y: number; readonly z: number },
  cook: { readonly x: number; readonly y: number; readonly z: number },
): boolean =>
  Math.hypot(bottle.x - cook.x, bottle.z - cook.z) < BOTTLE_HIT_RADIUS &&
  bottle.y > cook.y + 0.2 && bottle.y < cook.y + 2;

/** Where a mechanism sits at `seconds`, ignoring whether it is resting. */
export const poseAt = (config: MechanismConfig, seconds: number): MechanismPose => {
  switch (config.kind) {
    case "platform":
      return platformPose(config, seconds);
    case "turntable":
      return { x: 0, y: 0, z: 0, yaw: (seconds + config.phase) * config.speed * Math.PI * 2 };
    case "march":
      // The column travels like a platform; its yaw is which way the marchers face
      // (see marchHeading), applied to each of them, never to the column as a whole.
      return { ...platformPose(config, seconds), yaw: marchHeading(config, seconds) };
    case "panic_run": {
      // Round and round the placed spot, facing the way it runs.
      const radius = crewSpan(config);
      const angle = ((seconds + config.phase) * config.speed) / radius;
      return {
        x: radius * Math.sin(angle),
        y: 0,
        z: radius * Math.cos(angle),
        yaw: Math.atan2(Math.cos(angle), -Math.sin(angle)),
      };
    }
    case "bottle_fight":
    case "brawl":
      // They stay where they were placed; all the action is in their clips.
      return STILL;
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
  if (isCrewKind(config.kind)) {
    // Pessimistic square: the robots can stand any way round the placed spot.
    const reach = (config.kind === "panic_run" ? crewSpan(config) : config.kind === "brawl" ? BRAWL_GAP / 2 : crewSpan(config) / 2)
      + MARCH_BODY_RADIUS;
    return { minX: origin.x - reach, maxX: origin.x + reach, minZ: origin.z - reach, maxZ: origin.z + reach };
  }
  if (config.kind === "march") {
    // The whole column, at both ends of its route: a marcher reaches half the column's
    // length beyond its centre, along the route.
    const direction = marchDirection(config);
    const half = ((MARCH_SIZE - 1) / 2) * MARCH_SPACING;
    for (const stop of stops) {
      for (const side of [-1, 1]) {
        const x = origin.x + stop.x + direction.x * half * side;
        const z = origin.z + stop.z + direction.z * half * side;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    return {
      minX: minX - MARCH_BODY_RADIUS,
      maxX: maxX + MARCH_BODY_RADIUS,
      minZ: minZ - MARCH_BODY_RADIUS,
      maxZ: maxZ + MARCH_BODY_RADIUS,
    };
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
