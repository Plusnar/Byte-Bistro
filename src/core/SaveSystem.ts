import { createDefaultPersistentState } from "./GameState";
import type {
  PersistentGameState,
  ShiftRank,
  StationId,
} from "../types/game";
import { clamp } from "../utils/math";
import { sanitizeLevelRanks } from "../data/levelRanks";

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const SAVE_KEY = "byte-bistro:save";

const STATION_IDS: ReadonlySet<string> = new Set<StationId>([
  "ingredient_dispenser",
  "bit_crusher",
  "data_mixer",
  "compiler_oven",
  "cache_freezer",
  "plating_station",
  "serving_terminal",
]);

const SHIFT_RANKS: ReadonlySet<string> = new Set<ShiftRank>(["S", "A", "B", "C", "D"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringArray = (value: unknown, fallback: readonly string[]): string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : [...fallback];

const stationArray = (value: unknown, fallback: readonly StationId[]): StationId[] => {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return [...fallback];
  }
  return value.filter((entry): entry is StationId => STATION_IDS.has(entry));
};

const rankValue = (value: unknown, fallback: ShiftRank | null): ShiftRank | null => {
  if (value === null) return null;
  return typeof value === "string" && SHIFT_RANKS.has(value) ? (value as ShiftRank) : fallback;
};

const upgradeRecord = (
  value: unknown,
  fallback: Readonly<Record<string, number>>,
): Record<string, number> => {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  const upgrades: Record<string, number> = {};
  for (const [key, level] of Object.entries(value)) {
    if (typeof level === "number" && Number.isFinite(level) && level >= 0) {
      upgrades[key] = level;
    }
  }
  return upgrades;
};

const sanitizePersistentState = (
  value: unknown,
  fallback: PersistentGameState,
): PersistentGameState => {
  if (!isRecord(value)) {
    return fallback;
  }
  const rawSettings = isRecord(value.settings) ? value.settings : {};
  return {
    version: Math.max(1, Math.floor(finiteNumber(value.version, fallback.version))),
    credits: Math.max(0, Math.floor(finiteNumber(value.credits, fallback.credits))),
    unlockedRecipes: stringArray(value.unlockedRecipes, fallback.unlockedRecipes),
    unlockedStations: stationArray(value.unlockedStations, fallback.unlockedStations),
    highestRank: rankValue(value.highestRank, fallback.highestRank),
    // Older saves have none; they start with every level unplayed.
    levelRanks: sanitizeLevelRanks(value.levelRanks),
    settings: {
      masterVolume: clamp(
        finiteNumber(rawSettings.masterVolume, fallback.settings.masterVolume),
        0,
        1,
      ),
      reducedMotion:
        typeof rawSettings.reducedMotion === "boolean"
          ? rawSettings.reducedMotion
          : fallback.settings.reducedMotion,
      showDebug:
        typeof rawSettings.showDebug === "boolean"
          ? rawSettings.showDebug
          : fallback.settings.showDebug,
    },
    chapter: Math.max(1, Math.floor(finiteNumber(value.chapter, fallback.chapter))),
    upgrades: upgradeRecord(value.upgrades, fallback.upgrades),
  };
};

class MemoryStorage implements StorageAdapter {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const getBrowserStorage = (): StorageAdapter | null => {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
};

export class SaveSystem {
  private storage: StorageAdapter | null;
  private readonly memory = new MemoryStorage();
  /** The last write to storage threw (quota, privacy mode); memory is ahead of it. */
  private lastWriteFailed = false;

  constructor(
    private readonly key: string = SAVE_KEY,
    storage: StorageAdapter | null = getBrowserStorage(),
    private readonly createDefaults: () => PersistentGameState = createDefaultPersistentState,
  ) {
    this.storage = storage;
  }

  load(): PersistentGameState {
    const defaults = this.createDefaults();
    const serialized = this.readSerialized();
    if (serialized === null) {
      return defaults;
    }
    try {
      return sanitizePersistentState(JSON.parse(serialized) as unknown, defaults);
    } catch {
      return defaults;
    }
  }

  save(state: PersistentGameState): boolean {
    const serialized = JSON.stringify(sanitizePersistentState(state, this.createDefaults()));
    this.memory.setItem(this.key, serialized);
    if (this.storage === null) {
      return false;
    }
    try {
      this.storage.setItem(this.key, serialized);
      this.lastWriteFailed = false;
      return true;
    } catch {
      // Storage is kept, not dropped: a full quota is often temporary (the player deletes a
      // map), and giving up for the session lost every later rank and credit on reload.
      // Until a write succeeds again, memory holds the newest state.
      this.lastWriteFailed = true;
      return false;
    }
  }

  clear(): boolean {
    this.memory.removeItem(this.key);
    if (this.storage === null) {
      return false;
    }
    try {
      this.storage.removeItem(this.key);
      return true;
    } catch {
      this.storage = null;
      return false;
    }
  }

  isUsingFallback(): boolean {
    return this.storage === null || this.lastWriteFailed;
  }

  private readSerialized(): string | null {
    // After a failed write the stored copy is older than the one in memory.
    if (this.lastWriteFailed) return this.memory.getItem(this.key);
    if (this.storage !== null) {
      try {
        const stored = this.storage.getItem(this.key);
        if (stored !== null) {
          this.memory.setItem(this.key, stored);
          return stored;
        }
      } catch {
        this.storage = null;
      }
    }
    return this.memory.getItem(this.key);
  }
}
