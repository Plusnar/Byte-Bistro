import type { StarThresholds, StationId } from "../types/game";
import type { DifficultyId } from "../data/difficulty";
import type { RobotConfig } from "../data/robotConfig";
import type { LayoutPhase, MechanismConfig } from "../data/mechanismConfig";

export type PlacedObjectRole =
  | "station"
  | "dispenser"
  | "spawn"
  | "decor"
  | "robot"
  /** Moves during a shift; the one exception to the static-scenery rule. See AGENTS.md. */
  | "mechanism";

export type PlacedObjectCategory =
  | "room"
  | "station"
  | "dispenser"
  | "machine"
  | "screen"
  | "storage"
  | "pipe"
  | "cable"
  | "supply"
  | "spawn"
  | "decor"
  | "robot"
  | "mechanism";

export interface MapPlacedObject {
  readonly id: string;
  readonly assetId: string;
  readonly role: PlacedObjectRole;
  readonly category: PlacedObjectCategory;
  readonly position: { x: number; y: number; z: number };
  readonly rotation: { x: number; y: number; z: number };
  readonly scale: { x: number; y: number; z: number };
  readonly collides: boolean;
  readonly stationId?: StationId;
  readonly ingredientId?: string;
  readonly playerIndex?: 1 | 2 | 3 | 4;
  readonly label?: string;
  readonly color?: string;
  /**
   * Design-tool colours: material name → sRGB hex. Only overridden parts are listed; the
   * rest keep the model's own colours. See `src/scenes/materialOverrides.ts`.
   */
  readonly colors?: Readonly<Record<string, string>>;
  /** Only on `role === "robot"`; see `src/data/robotConfig.ts`. */
  readonly robot?: RobotConfig;
  /** Only on `role === "mechanism"`; see `src/data/mechanismConfig.ts`. */
  readonly mechanism?: MechanismConfig;
}

/** Smallest scale an axis may have; below it a model vanishes and cannot be clicked. */
export const MIN_OBJECT_SCALE = 0.05;

/** An angle brought into (-π, π], so a full turn reads as no turn at all. */
export const wrapAngle = (angle: number): number => {
  const turn = Math.PI * 2;
  const wrapped = angle - turn * Math.floor((angle + Math.PI) / turn);
  // floor maps +π to -π; keep +π so the interval is (-π, π].
  return wrapped === -Math.PI ? Math.PI : wrapped;
};

/** Design-tool colours: at most 24 parts, names up to 64 characters, `#rrggbb` values. */
export const sanitizeColorOverrides = (value: unknown): Record<string, string> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, hex] of Object.entries(value)) {
    if (Object.keys(clean).length >= 24) break;
    if (name.length === 0 || name.length > 64 || typeof hex !== "string" || !/^#[0-9a-f]{6}$/i.test(hex)) continue;
    clean[name] = hex.toLowerCase();
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
};

/** Whether two colour sets paint an object the same. */
export const sameColors = (
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined,
): boolean => {
  const keys = Object.keys(a ?? {});
  if (keys.length !== Object.keys(b ?? {}).length) return false;
  return keys.every((key) => a?.[key] === b?.[key]);
};

export interface MapEnvironment {
  readonly ambient: string;
  readonly fog: string;
  readonly fogDensity: number;
}

/**
 * Level settings a designer picks when saving, so a map built in game can be shipped as a
 * level without anyone touching code.
 */
export interface MapMeta {
  readonly description: string;
  readonly shiftDurationSeconds: number;
  readonly difficultyId: DifficultyId;
  /**
   * Hand-set coin targets for one, two and three stars. Left out, they are derived from
   * the level's own menu and length — see `src/data/levelGoals.ts`, which is the sane
   * default and keeps re-balancing automatic.
   */
  readonly starCoins?: StarThresholds;
  /**
   * When the kitchen changes shape during a shift: which mechanisms switch on and off, and
   * at what point. See `src/data/mechanismConfig.ts`.
   */
  readonly layoutPhases?: readonly LayoutPhase[];
}

export interface MapData {
  readonly version: 1;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly environment: MapEnvironment;
  readonly objects: readonly MapPlacedObject[];
  /**
   * Which scenario's rules this map plays under. Optional so every map saved before
   * scenarios existed still loads — the sanitiser fills in the default.
   */
  readonly scenarioId?: string;
  readonly meta?: MapMeta;
}

export interface MapSlotSummary {
  readonly slotId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly objectCount: number;
  readonly stations: number;
  readonly dispensers: number;
  readonly scenarioId: string;
  readonly description: string;
  readonly difficultyId: DifficultyId;
  readonly shiftDurationSeconds: number;
}

const createUid = (() => {
  let sequence = 0;
  return (prefix: string): string =>
    `${prefix}-${Date.now().toString(36)}-${(sequence++).toString(36)}`;
})();

export const generateObjectId = (): string => createUid("obj");

export const summarizeStations = (objects: readonly MapPlacedObject[]): { stations: number; dispensers: number } => {
  let stations = 0;
  let dispensers = 0;
  for (const object of objects) {
    if (object.role === "station") stations += 1;
    else if (object.role === "dispenser") dispensers += 1;
  }
  return { stations, dispensers };
};
