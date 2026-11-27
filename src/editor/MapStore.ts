import { t } from "../i18n";
import type { MapData, MapMeta, MapSlotSummary } from "./MapData";
import { MIN_OBJECT_SCALE, sanitizeColorOverrides } from "./MapData";
import { generateObjectId, summarizeStations } from "./MapData";
import { STATION_KIND_LABEL } from "../data/kitchen";
import { getIngredient } from "../data/ingredients";
import { DEFAULT_SCENARIO_ID, isScenarioId } from "../data/scenarios";
import { isDifficultyId } from "../data/difficulty";
import { sanitizeStarThresholds } from "../data/levelGoals";
import {
  MAX_MECHANISMS_PER_MAP,
  sanitizeLayoutPhases,
  sanitizeMechanismConfig,
} from "../data/mechanismConfig";
import { sanitizeRobotConfig } from "../data/robotConfig";

const SLOT_PREFIX = "byte-bistro:map-slot:";
const SLOT_INDEX_KEY = "byte-bistro:map-slot-index";

export interface MapStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const getBrowserStorage = (): MapStorageAdapter | null => {
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
    return globalThis.localStorage as unknown as MapStorageAdapter;
  } catch {
    return null;
  }
};

class MemoryStorage implements MapStorageAdapter {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const stringValue = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : [];

/** Station ids the game can turn into a tile: today's kinds plus the legacy machine ids. */
const KNOWN_STATION_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(STATION_KIND_LABEL),
  "ingredient_dispenser",
  "bit_crusher",
  "data_mixer",
  "compiler_oven",
  "cache_freezer",
  "plating_station",
  "serving_terminal",
]);

const roleValues = new Set(["station", "dispenser", "spawn", "decor", "robot", "mechanism"]);
const categoryValues = new Set([
  "room",
  "station",
  "dispenser",
  "machine",
  "screen",
  "storage",
  "pipe",
  "cable",
  "supply",
  "spawn",
  "decor",
  "robot",
  "mechanism",
]);

const sanitizeVector = (value: unknown): { x: number; y: number; z: number } | null => {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x, NaN);
  const y = finiteNumber(value.y, NaN);
  const z = finiteNumber(value.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
};

/** Level settings, fully defaulted and clamped so a hand-edited file cannot break a shift. */
export const sanitizeMapMeta = (value: unknown): MapMeta => {
  const record = isRecord(value) ? value : {};
  const difficultyId = record.difficultyId;
  return {
    description: stringValue(record.description, "").slice(0, 240),
    shiftDurationSeconds: Math.round(
      Math.min(900, Math.max(60, finiteNumber(record.shiftDurationSeconds, 195))),
    ),
    difficultyId: isDifficultyId(difficultyId) ? difficultyId : "standard",
    // Only kept when it is a sane ascending trio; a hand-edited file cannot ask for a star
    // at zero coins or put the second star below the first.
    starCoins: sanitizeStarThresholds(record.starCoins),
    layoutPhases: sanitizeLayoutPhases(record.layoutPhases),
  };
};

export const sanitizeMapData = (value: unknown): MapData | null => {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  const objects = Array.isArray(value.objects) ? value.objects : null;
  if (!objects) return null;
  const sanitizedObjects = [];
  const usedIds = new Set<string>();
  let mechanismCount = 0;
  for (const entry of objects) {
    if (!isRecord(entry)) continue;
    const position = sanitizeVector(entry.position);
    const rotation = sanitizeVector(entry.rotation);
    const rawScale = sanitizeVector(entry.scale);
    if (!position || !rotation || !rawScale) continue;
    // Zero or negative scale hides a model (unclickable) or turns it inside out.
    const scale = {
      x: Math.max(MIN_OBJECT_SCALE, Math.abs(rawScale.x)),
      y: Math.max(MIN_OBJECT_SCALE, Math.abs(rawScale.y)),
      z: Math.max(MIN_OBJECT_SCALE, Math.abs(rawScale.z)),
    };
    let role = stringValue(entry.role, "decor");
    const category = stringValue(entry.category, "decor");
    if (!roleValues.has(role) || !categoryValues.has(category)) continue;
    const assetId = stringValue(entry.assetId, "");
    if (!assetId) continue;
    const stationId = typeof entry.stationId === "string" ? entry.stationId : undefined;
    const ingredientId = typeof entry.ingredientId === "string" ? entry.ingredientId : undefined;
    // A station or crate the game cannot build (a typo, or an id from a newer version) would
    // place NaN-positioned tiles; it keeps its model as scenery instead.
    if (role === "station" && !(stationId && KNOWN_STATION_IDS.has(stationId))) role = "decor";
    if (role === "dispenser" && !(ingredientId && getIngredient(ingredientId))) role = "decor";
    // Objects are keyed by id everywhere (visuals, selection, edits); a repeated or missing
    // id would merge two objects into one invisible twin.
    // Past the cap a mechanism loads as plain scenery: a hand-edited file with a hundred
    // moving parts must not be able to cost a player their frame rate.
    if (role === "mechanism") {
      if (mechanismCount >= MAX_MECHANISMS_PER_MAP) role = "decor";
      else mechanismCount += 1;
    }
    const rawId = typeof entry.id === "string" ? entry.id.trim() : "";
    const id = rawId && !usedIds.has(rawId) ? rawId : generateObjectId();
    usedIds.add(id);
    sanitizedObjects.push({
      id,
      assetId,
      role: role as MapData["objects"][number]["role"],
      category: category as MapData["objects"][number]["category"],
      position,
      rotation,
      scale,
      collides: typeof entry.collides === "boolean" ? entry.collides : false,
      stationId: stationId as MapData["objects"][number]["stationId"],
      ingredientId,
      playerIndex: entry.playerIndex === 1 || entry.playerIndex === 2 || entry.playerIndex === 3 || entry.playerIndex === 4 ? entry.playerIndex as 1 | 2 | 3 | 4 : undefined,
      label: typeof entry.label === "string" ? entry.label : undefined,
      color: typeof entry.color === "string" ? entry.color : undefined,
      colors: sanitizeColorOverrides(entry.colors),
      // Only robots carry a config; giving every object one would bloat every saved map.
      robot: role === "robot" ? sanitizeRobotConfig(entry.robot) : undefined,
      mechanism: role === "mechanism" ? sanitizeMechanismConfig(entry.mechanism) : undefined,
    });
  }
  const environment = isRecord(value.environment) ? value.environment : {};
  return {
    version: 1,
    name: stringValue(value.name, t("editor.untitledMap")),
    createdAt: finiteNumber(value.createdAt, Date.now()),
    updatedAt: finiteNumber(value.updatedAt, Date.now()),
    environment: {
      ambient: stringValue(environment.ambient, "#27354A"),
      fog: stringValue(environment.fog, "#06101A"),
      fogDensity: finiteNumber(environment.fogDensity, 0.008),
    },
    objects: sanitizedObjects,
    scenarioId: isScenarioId(value.scenarioId) ? value.scenarioId : DEFAULT_SCENARIO_ID,
    meta: sanitizeMapMeta(value.meta),
  };
};

export class MapStore {
  private storage: MapStorageAdapter;
  private readonly memory = new MemoryStorage();

  constructor(
    private readonly prefix: string = SLOT_PREFIX,
    private readonly indexKey: string = SLOT_INDEX_KEY,
    storage: MapStorageAdapter | null = getBrowserStorage(),
  ) {
    this.storage = storage ?? this.memory;
  }

  get isPersistent(): boolean { return this.storage !== this.memory; }

  list(): MapSlotSummary[] {
    const slotIds = this.knownSlotIds();
    const summaries: MapSlotSummary[] = [];
    for (const slotId of slotIds) {
      const data = this.loadRaw(slotId);
      if (!data) continue;
      const { stations, dispensers } = summarizeStations(data.objects);
      summaries.push({
        slotId,
        name: data.name,
        updatedAt: data.updatedAt,
        objectCount: data.objects.length,
        stations,
        dispensers,
        scenarioId: data.scenarioId ?? DEFAULT_SCENARIO_ID,
        description: data.meta?.description ?? "",
        difficultyId: data.meta?.difficultyId ?? "standard",
        shiftDurationSeconds: data.meta?.shiftDurationSeconds ?? 195,
      });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  load(slotId: string): MapData | null {
    return this.loadRaw(slotId);
  }

  save(slotId: string, map: MapData): boolean {
    const sanitized = sanitizeMapData(map);
    if (!sanitized) return false;
    const serialized = JSON.stringify(sanitized);
    try {
      this.storage.setItem(this.slotKey(slotId), serialized);
      this.registerSlot(slotId);
      return true;
    } catch {
      return false;
    }
  }

  delete(slotId: string): boolean {
    try {
      this.storage.removeItem(this.slotKey(slotId));
      this.unregisterSlot(slotId);
      return true;
    } catch {
      return false;
    }
  }

  exists(slotId: string): boolean {
    return this.loadRaw(slotId) !== null;
  }

  generateSlotId(): string {
    return `slot-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xfff).toString(36)}`;
  }

  private loadRaw(slotId: string): MapData | null {
    try {
      const serialized = this.storage.getItem(this.slotKey(slotId));
      if (!serialized) return null;
      return sanitizeMapData(JSON.parse(serialized) as unknown);
    } catch {
      return null;
    }
  }

  private slotKey(slotId: string): string {
    return `${this.prefix}${slotId}`;
  }

  private knownSlotIds(): string[] {
    const ids = new Set<string>();
    try {
      const raw = this.storage.getItem(this.indexKey);
      if (raw) for (const id of stringArray(JSON.parse(raw) as unknown)) ids.add(id);
    } catch { /* Recover saved maps from their keys if the index is missing. */ }
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (key?.startsWith(this.prefix)) ids.add(key.slice(this.prefix.length));
      }
    } catch { /* The existing index remains usable if enumeration is unavailable. */ }
    return [...ids];
  }

  private registerSlot(slotId: string): void {
    const known = new Set(this.knownSlotIds());
    known.add(slotId);
    try {
      this.storage.setItem(this.indexKey, JSON.stringify([...known]));
    } catch {
      /* ignore */
    }
  }

  private unregisterSlot(slotId: string): void {
    const known = this.knownSlotIds().filter((id) => id !== slotId);
    try {
      this.storage.setItem(this.indexKey, JSON.stringify(known));
    } catch {
      /* ignore */
    }
  }
}
