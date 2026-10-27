import { t } from "../i18n";

/**
 * Mechanisms placed from the editor: the parts of a level that move during a shift.
 *
 * The scenery rule in AGENTS.md says a level is static once it is loaded, because the whole
 * of it is batched by material and its colliders are frozen. A mechanism is the one
 * exception, and it pays for itself: it sits outside the static batch (batched inside its
 * own node instead), it has one owner that disposes it, its whole travel is handed to the
 * robots' navigation as a fixed obstacle, and the sanitizer caps how many a map may have.
 *
 * Like `robotConfig`, this is a typed sub-object rather than a generic property bag:
 * `sanitizeMapData` is a whitelist by design, and a bag cannot be whitelisted without
 * giving up the validation that keeps corrupt maps out.
 */

export type MechanismKind =
  | "conveyor"
  | "platform"
  | "turntable"
  /** Present while "on", gone while "off"; blinks before it goes. */
  | "vanishing_floor"
  /** Paired with the one other portal sharing its `portalPairId`. */
  | "portal";

/** How a mechanism behaves over time. */
export type MechanismActivation =
  | { readonly mode: "always" }
  /** Runs for `onSeconds`, rests for `offSeconds`, forever. */
  | { readonly mode: "interval"; readonly onSeconds: number; readonly offSeconds: number };

/** A point the platform travels to, as an offset in metres from where it was placed. */
export interface MechanismWaypoint {
  readonly x: number;
  readonly z: number;
  readonly y: number;
}

export interface MechanismConfig {
  readonly kind: MechanismKind;
  /**
   * Metres per second for a conveyor's pull and a platform's travel; turns per second for
   * a turntable.
   */
  readonly speed: number;
  /** Conveyor only: which way it pulls, as a yaw in radians from +z. */
  readonly directionYaw: number;
  /**
   * Platform only: where it goes, relative to its placed position. The placed position is
   * always the first stop, so one waypoint already makes a there-and-back.
   */
  readonly waypoints: readonly MechanismWaypoint[];
  /** Platform only: seconds spent waiting at each end before turning around. */
  readonly pauseSeconds: number;
  /** Shifts a mechanism's cycle, so two next to each other need not move in lockstep. */
  readonly phase: number;
  readonly activation: MechanismActivation;
  /**
   * Portal only: the two portals that share this id are linked. Anything else — one alone,
   * or three with the same id — links nothing, and the editor flags it.
   */
  readonly portalPairId: string;
}

export const MECHANISM_KINDS: readonly MechanismKind[] = [
  "conveyor",
  "platform",
  "turntable",
  "vanishing_floor",
  "portal",
];

/**
 * Hard ceiling on moving parts per map.
 *
 * Every mechanism is a draw call or two that the static batch cannot absorb (see
 * `performance-budget.json`, which allows 450 and measures 326). Twenty-four fits in that
 * headroom with room to spare; past it, the extras load as ordinary scenery rather than
 * quietly costing a player their frame rate.
 */
export const MAX_MECHANISMS_PER_MAP = 24;

/** At most this many stops, so one object cannot describe a tour of the whole kitchen. */
export const MAX_WAYPOINTS = 4;

export const SPEED_RANGE = { min: 0.1, max: 6 } as const;
export const PAUSE_RANGE = { min: 0, max: 10 } as const;
/** Waypoints are clamped to the build lot, the same bounds the editor draws within. */
export const WAYPOINT_RANGE = { min: -20, max: 20 } as const;
export const INTERVAL_RANGE = { min: 0.5, max: 60 } as const;

export const DEFAULT_MECHANISM_CONFIG: MechanismConfig = {
  kind: "conveyor",
  speed: 1.4,
  directionYaw: 0,
  waypoints: [],
  pauseSeconds: 0.6,
  phase: 0,
  activation: { mode: "always" },
  portalPairId: "",
};

/** Labels for the editor's inspector; read through, so they follow the language. */
export const MECHANISM_KIND_LABEL: Readonly<Record<MechanismKind, string>> = {
  get conveyor() { return t("editor.mechanismConveyor"); },
  get platform() { return t("editor.mechanismPlatform"); },
  get turntable() { return t("editor.mechanismTurntable"); },
  get vanishing_floor() { return t("editor.mechanismVanishingFloor"); },
  get portal() { return t("editor.mechanismPortal"); },
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** An angle brought into (-π, π], so a config cannot ask for forty turns of offset. */
const wrapAngle = (angle: number): number => {
  const turn = Math.PI * 2;
  const wrapped = angle - turn * Math.floor((angle + Math.PI) / turn);
  return wrapped === -Math.PI ? Math.PI : wrapped;
};

const sanitizeWaypoints = (value: unknown): MechanismWaypoint[] => {
  if (!Array.isArray(value)) return [];
  const points: MechanismWaypoint[] = [];
  for (const entry of value) {
    if (points.length >= MAX_WAYPOINTS || !isRecord(entry)) continue;
    points.push({
      x: clamp(finite(entry.x, 0), WAYPOINT_RANGE.min, WAYPOINT_RANGE.max),
      y: clamp(finite(entry.y, 0), WAYPOINT_RANGE.min, WAYPOINT_RANGE.max),
      z: clamp(finite(entry.z, 0), WAYPOINT_RANGE.min, WAYPOINT_RANGE.max),
    });
  }
  return points;
};

const sanitizeActivation = (value: unknown): MechanismActivation => {
  if (!isRecord(value) || value.mode !== "interval") return { mode: "always" };
  return {
    mode: "interval",
    onSeconds: clamp(finite(value.onSeconds, 4), INTERVAL_RANGE.min, INTERVAL_RANGE.max),
    offSeconds: clamp(finite(value.offSeconds, 4), INTERVAL_RANGE.min, INTERVAL_RANGE.max),
  };
};

const isMechanismKind = (value: unknown): value is MechanismKind =>
  typeof value === "string" && (MECHANISM_KINDS as readonly string[]).includes(value);

/**
 * Returns a fully defaulted, clamped config for any input.
 *
 * Total rather than partial on purpose, for the same reason as the robots': the runtime
 * reads these every frame, and a hand-edited level must not be able to produce a platform
 * crossing the room forty times a second.
 */
export const sanitizeMechanismConfig = (value: unknown): MechanismConfig => {
  const record = isRecord(value) ? value : {};
  return {
    kind: isMechanismKind(record.kind) ? record.kind : DEFAULT_MECHANISM_CONFIG.kind,
    speed: clamp(finite(record.speed, DEFAULT_MECHANISM_CONFIG.speed), SPEED_RANGE.min, SPEED_RANGE.max),
    directionYaw: wrapAngle(finite(record.directionYaw, 0)),
    waypoints: sanitizeWaypoints(record.waypoints),
    pauseSeconds: clamp(
      finite(record.pauseSeconds, DEFAULT_MECHANISM_CONFIG.pauseSeconds),
      PAUSE_RANGE.min,
      PAUSE_RANGE.max,
    ),
    phase: Math.max(0, finite(record.phase, 0)),
    activation: sanitizeActivation(record.activation),
    portalPairId: sanitizePairId(record.portalPairId),
  };
};

/** Short and plain, so a pair id cannot smuggle anything into the save. */
const sanitizePairId = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, 24).replace(/[^\w-]/g, "") : "";

// ---------------------------------------------------------------------------------------
// Layout phases

/**
 * A moment in the shift when the kitchen changes shape: some mechanisms switch on, others
 * off. This is how a level splits in two halfway through, or opens a shortcut for the
 * final rush.
 *
 * "Off" means the same thing for every kind: a moving part holds still, a vanishing floor
 * is gone, a portal stops linking. Phases are listed by id, which is the placed object's
 * own id in the map.
 */
export interface LayoutPhase {
  /** How far into the shift it happens, 0 at the whistle and 1 at the buzzer. */
  readonly atProgress: number;
  readonly enable: readonly string[];
  readonly disable: readonly string[];
}

/** Enough for a level to change shape a few times, not enough to strobe. */
export const MAX_LAYOUT_PHASES = 8;
/** Per list; a phase that names more mechanisms than a map can hold is garbage. */
const MAX_PHASE_IDS = MAX_MECHANISMS_PER_MAP;

const sanitizeIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const entry of value) {
    if (ids.length >= MAX_PHASE_IDS) break;
    if (typeof entry !== "string") continue;
    const id = entry.trim().slice(0, 64);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

/**
 * Keeps a map's phases sane: in order, inside the shift, short, and each one actually
 * doing something. Returns them sorted by `atProgress`, which is the order they apply in.
 */
export const sanitizeLayoutPhases = (value: unknown): LayoutPhase[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const phases: LayoutPhase[] = [];
  for (const entry of value) {
    if (phases.length >= MAX_LAYOUT_PHASES || !isRecord(entry)) continue;
    const enable = sanitizeIds(entry.enable);
    const disable = sanitizeIds(entry.disable);
    if (enable.length === 0 && disable.length === 0) continue;
    phases.push({
      atProgress: clamp(finite(entry.atProgress, 0), 0, 1),
      enable,
      disable,
    });
  }
  if (phases.length === 0) return undefined;
  return phases.sort((a, b) => a.atProgress - b.atProgress);
};
