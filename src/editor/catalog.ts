import { getLanguage, t, translate } from "../i18n";
import { PLAYER_COLORS } from "../data/players";
import { portugueseAssetName } from "../i18n/assetNames";
import { ASSET_LIBRARY, libraryLabel } from "../data/assetLibrary";
import { isSolidByDefault } from "../physics/collisionPolicy";
import { SCENARIO_ASSETS } from "../data/scenarioAssets";
import {
  KITCHEN_DISPENSER_ANCHORS,
  KITCHEN_STATION_ANCHORS,
  DECOR_PLACEMENTS_REF,
  STATION_ASSET_PLACEMENTS_REF,
} from "../scenes/KitchenEnvironment";
import { INGREDIENT_SCENARIO_VISUALS } from "../data/scenarioAssets";
import type { MapData, MapPlacedObject, PlacedObjectCategory } from "./MapData";
import {
  CRATE_MODEL_BY_INGREDIENT,
  STATION_KIND_LABEL,
  kitchenAssetId,
  type KitchenModelName,
} from "../data/kitchen";
import type { KitchenStationKind } from "../types/game";
import {
  DEFAULT_MECHANISM_CONFIG,
  MECHANISM_KIND_LABEL,
  sanitizeMechanismConfig,
  type MechanismConfig,
} from "../data/mechanismConfig";
import { ROBOT_ASSET_ID, ROBOT_PRESETS, type RobotConfig } from "../data/robotConfig";
import { OVEN_ASSET_ID } from "../data/stationAssets";
import { getIngredient } from "../data/ingredients";

const createUid = (() => {
  let sequence = 0;
  return (prefix: string): string =>
    `${prefix}-${Date.now().toString(36)}-${(sequence++).toString(36)}`;
})();

const toFixedVector = (
  value: { x: number; y: number; z: number },
): { x: number; y: number; z: number } => ({
  x: Number(value.x.toFixed(4)),
  y: Number(value.y.toFixed(4)),
  z: Number(value.z.toFixed(4)),
});

const humanizeAsset = (assetId: string): string => {
  const tail = assetId.replace(/^scenario-/, "").replace(/^food-/, "");
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
};

const detectCategory = (assetId: string): PlacedObjectCategory => {
  if (assetId === "scenario-room-wide") return "room";
  if (assetId.startsWith("scenario-machine") || assetId === "scenario-freezer-standing" || assetId === "scenario-scanner-low" || assetId === "scenario-conveyor-long" || assetId === "scenario-cash-register") return "machine";
  if (assetId === "scenario-screen-wide") return "screen";
  if (assetId === "scenario-robot-arm") return "decor";
  if (assetId === "scenario-hopper") return "supply";
  if (assetId.startsWith("scenario-shelf") || assetId.startsWith("scenario-box")) return "storage";
  if (assetId.startsWith("scenario-pipe") || assetId.startsWith("scenario-cable")) return "pipe";
  if (assetId.startsWith("scenario-screen")) return "screen";
  if (assetId.startsWith("food-")) return "decor";
  return "decor";
};

const STATION_ASSET_OVERRIDE: Readonly<Record<string, { stationId: string; label: string; color: string }>> = {
  "scenario-machine-fortified": { stationId: "bit_crusher", label: "Bit Crusher", color: "#FF65C3" },
  "scenario-machine-bed": { stationId: "data_mixer", label: "Data Mixer", color: "#A986FF" },
  "scenario-freezer-standing": { stationId: "cache_freezer", label: "Cache Freezer", color: "#55E7FF" },
  "scenario-machine": { stationId: "compiler_oven", label: "Compiler Oven", color: "#FF8B4D" },
  "scenario-scanner-low": { stationId: "plating_station", label: "Plating Scanner", color: "#7DFFAD" },
  "scenario-conveyor-long": { stationId: "serving_terminal", label: "Feed CORE", color: "#40F2FF" },
  "scenario-cash-register": { stationId: "serving_terminal", label: "Feed CORE", color: "#40F2FF" },
};

const STATION_COLORS: Readonly<Record<string, string>> = {
  ingredient_dispenser: "#44DFFF",
  bit_crusher: "#FF65C3",
  data_mixer: "#A986FF",
  compiler_oven: "#FF8B4D",
  cache_freezer: "#55E7FF",
  plating_station: "#7DFFAD",
  serving_terminal: "#40F2FF",
};

const stationAnchorLabel = (id: string): string =>
  id === "serving_terminal" ? t("editor.feedCore") : translate(`stations.${id}`);

const ingredientName = (ingredientId: string): string =>
  getIngredient(ingredientId)?.displayName ?? ingredientId.replace(/_/g, " ");

/** A model named after its id ("scenario-machine-bed"): English as is, Portuguese by glossary. */
const assetIdLabel = (assetId: string): string => {
  const english = humanizeAsset(assetId);
  return getLanguage() === "en" ? english : portugueseAssetName(english);
};

export interface EditorAssetEntry {
  readonly assetId: string;
  /** In the current language: entries read it from the catalogues each time. */
  readonly label: string;
  readonly category: PlacedObjectCategory;
  readonly role: "decor" | "station" | "dispenser" | "spawn" | "robot" | "mechanism";
  readonly stationId?: string;
  readonly ingredientId?: string;
  readonly playerIndex?: 1 | 2 | 3 | 4;
  readonly color?: string;
  readonly pack?: string;
  /** Placement scale; kitchen tiles use the in-game 1.2 m footprint. */
  readonly scale?: { x: number; y: number; z: number };
  /** Starting config for `role === "robot"` entries. */
  readonly robot?: RobotConfig;
  /** Starting config for `role === "mechanism"` entries. */
  readonly mechanism?: MechanismConfig;
}

const TILE_SCALE = { x: 0.6, y: 0.9, z: 0.6 } as const;

/**
 * Model shown in the editor for each kitchen tile (the game draws its own). Kinds with a
 * bespoke model use it instead: the oven as itself (OVEN_ASSET_ID), the mixer as a
 * counter whose dressing adds the stand mixer (EditorScene.dressStation).
 */
const KITCHEN_STATION_MODEL: Readonly<Record<KitchenStationKind, KitchenModelName>> = {
  crate: "crate",
  counter: "kitchencounter_straight_A",
  cutting_board: "kitchencounter_straight_B",
  stove: "stove_single",
  oven: "stove_single",
  mixer: "kitchencounter_straight_A",
  sink: "kitchencounter_sink",
  plate_rack: "kitchencounter_straight_B",
  dirty_return: "kitchencounter_straight_B",
  trash: "barrel",
  delivery: "kitchencounter_straight_B",
  extinguisher_stand: "kitchencounter_straight_A",
};


/**
 * The level's moving parts, as the catalogue offers them.
 *
 * One entry per kind, each with a sane starting config the inspector then tunes. A
 * platform ships with one waypoint, so dropping one already gives a there-and-back rather
 * than a block that sits still and looks broken.
 */
const PLATFORMER_BASE =
  "Scenario/KayKit_Platformer_Pack_1.0_FREE/KayKit_Platformer_Pack_1.0_FREE/Assets/gltf";

const MECHANISM_PRESETS: readonly EditorAssetEntry[] = [
  {
    assetId: "scenario-conveyor-long",
    get label() { return t("editor.mechanismPrefix", { name: MECHANISM_KIND_LABEL.conveyor }); },
    category: "mechanism",
    role: "mechanism",
    color: "#59E6FF",
    mechanism: { ...DEFAULT_MECHANISM_CONFIG, kind: "conveyor" },
  },
  {
    assetId: "scenario-box-large",
    get label() { return t("editor.mechanismPrefix", { name: MECHANISM_KIND_LABEL.platform }); },
    category: "mechanism",
    role: "mechanism",
    color: "#FFC95E",
    mechanism: {
      ...DEFAULT_MECHANISM_CONFIG,
      kind: "platform",
      waypoints: [{ x: 0, y: 0, z: 3.6 }],
    },
  },
  {
    assetId: "scenario-scanner-low",
    get label() { return t("editor.mechanismPrefix", { name: MECHANISM_KIND_LABEL.turntable }); },
    category: "mechanism",
    role: "mechanism",
    color: "#C79BFF",
    mechanism: { ...DEFAULT_MECHANISM_CONFIG, kind: "turntable", speed: 0.25 },
  },
  {
    // The editor's own floor tile: flat, so a cook walks onto it. A platformer block was
    // tried first and stood a metre tall, well past the 0.58 m a cook can step up.
    assetId: "build-floor",
    get label() { return t("editor.mechanismPrefix", { name: MECHANISM_KIND_LABEL.vanishing_floor }); },
    category: "mechanism",
    role: "mechanism",
    color: "#7FD7FF",
    // Off as long as it is on, so dropping one already shows the whole cycle — warning
    // blink included — without touching the inspector.
    mechanism: {
      ...DEFAULT_MECHANISM_CONFIG,
      kind: "vanishing_floor",
      activation: { mode: "interval", onSeconds: 6, offSeconds: 4 },
    },
  },
  {
    assetId: `library:${PLATFORMER_BASE}/blue/arch_blue.gltf`,
    get label() { return t("editor.mechanismPrefix", { name: MECHANISM_KIND_LABEL.portal }); },
    category: "mechanism",
    role: "mechanism",
    color: "#9F8BFF",
    // Two dropped from the catalogue already pair up. A third would not, and the editor
    // says so: rename its pair in the inspector.
    mechanism: { ...DEFAULT_MECHANISM_CONFIG, kind: "portal", portalPairId: "A" },
  },
];

export const kitchenStationEntry = (kind: KitchenStationKind): EditorAssetEntry => ({
  assetId: kind === "oven" ? OVEN_ASSET_ID : kitchenAssetId(KITCHEN_STATION_MODEL[kind]),
  get label() { return t("editor.kitchenPrefix", { name: STATION_KIND_LABEL[kind] }); },
  category: "station",
  role: "station",
  stationId: kind,
  color: "#FF9F43",
  scale: TILE_SCALE,
});

export const kitchenCrateEntry = (ingredientId: string): EditorAssetEntry => ({
  // Crates now use the bespoke bulk art, which is an already-resolved asset id.
  assetId: CRATE_MODEL_BY_INGREDIENT[ingredientId] ?? kitchenAssetId("crate"),
  get label() { return t("editor.cratePrefix", { name: ingredientName(ingredientId) }); },
  category: "dispenser",
  role: "dispenser",
  ingredientId,
  color: "#44DFFF",
  scale: { x: 0.6, y: 0.98, z: 0.6 },
});

export const EDITOR_ASSET_CATALOG: readonly EditorAssetEntry[] = (() => {
  const entries: EditorAssetEntry[] = [
    { assetId: "build-player-spawn-1", get label() { return t("editor.spawn1"); }, category: "spawn", role: "spawn", playerIndex: 1, color: PLAYER_COLORS[0] },
    { assetId: "build-player-spawn-2", get label() { return t("editor.spawn2"); }, category: "spawn", role: "spawn", playerIndex: 2, color: PLAYER_COLORS[1] },
    { assetId: "build-player-spawn-3", get label() { return t("editor.spawn3"); }, category: "spawn", role: "spawn", playerIndex: 3, color: PLAYER_COLORS[2] },
    { assetId: "build-player-spawn-4", get label() { return t("editor.spawn4"); }, category: "spawn", role: "spawn", playerIndex: 4, color: PLAYER_COLORS[3] },
    { assetId: "build-floor", get label() { return t("editor.modularFloor"); }, category: "room", role: "decor", color: "#64758a" },
    { assetId: "build-wall", get label() { return t("editor.modularWall"); }, category: "room", role: "decor", color: "#a9bccc" },
    { assetId: "build-block", get label() { return t("editor.blockCounter"); }, category: "storage", role: "decor", color: "#d5a26c" },
    { assetId: "scenario-room-wide", get label() { return t("editor.fullRoom"); }, category: "room", role: "decor" },
    ...(Object.keys(KITCHEN_STATION_MODEL) as KitchenStationKind[])
      .filter((kind) => kind !== "crate")
      .map(kitchenStationEntry),
    ...KITCHEN_DISPENSER_ANCHORS.map((anchor) => kitchenCrateEntry(anchor.ingredientId)),
    // Robots are one model with four starting configs; the inspector tunes them per instance.
    ...ROBOT_PRESETS.map((preset): EditorAssetEntry => ({
      assetId: ROBOT_ASSET_ID,
      get label() { return preset.label; },
      category: "robot",
      role: "robot",
      color: "#9FE8FF",
      robot: preset.config,
    })),
    // Moving parts. The conveyor model was already in the catalogue as a parked delivery
    // counter; it finally moves. See the mechanism exception in AGENTS.md.
    ...MECHANISM_PRESETS,
  ];
  const seen = new Set<string>();

  for (const anchor of KITCHEN_DISPENSER_ANCHORS) {
    entries.push({
      assetId: "scenario-hopper",
      get label() { return t("editor.dispenserPrefix", { name: ingredientName(anchor.ingredientId) }); },
      category: "dispenser",
      role: "dispenser",
      ingredientId: anchor.ingredientId,
      color: anchor.color,
    });
    seen.add("scenario-hopper");
  }

  for (const anchor of KITCHEN_STATION_ANCHORS) {
    if (anchor.id === "ingredient_dispenser") continue;
    const color = STATION_COLORS[anchor.id];
    if (!color) continue;
    const stationId = anchor.id;
    const override = STATION_ASSET_OVERRIDE[anchor.id === "serving_terminal" ? "scenario-conveyor-long" : ""];
    const assetId = (() => {
      if (anchor.id === "bit_crusher") return "scenario-machine-fortified";
      if (anchor.id === "data_mixer") return "scenario-machine-bed";
      if (anchor.id === "cache_freezer") return "scenario-freezer-standing";
      if (anchor.id === "compiler_oven") return "scenario-machine";
      if (anchor.id === "plating_station") return "scenario-scanner-low";
      if (anchor.id === "serving_terminal") return "scenario-conveyor-long";
      return "";
    })();
    if (!assetId) continue;
    entries.push({
      assetId,
      get label() { return stationAnchorLabel(stationId); },
      category: "station",
      role: "station",
      stationId: anchor.id,
      color,
    });
    seen.add(assetId);
    if (anchor.id === "serving_terminal") {
      entries.push({
        assetId: "scenario-cash-register",
        get label() { return t("editor.coreRegister"); },
        category: "machine",
        role: "station",
        stationId: "serving_terminal",
        color,
      });
      seen.add("scenario-cash-register");
    }
    void override;
  }

  for (const placement of DECOR_PLACEMENTS_REF) {
    if (seen.has(placement.assetId)) continue;
    seen.add(placement.assetId);
    const category = detectCategory(placement.assetId);
    if (category === "room") continue;
    const assetId = placement.assetId;
    entries.push({
      assetId,
      get label() { return assetIdLabel(assetId); },
      category,
      role: "decor",
    });
  }

  for (const placement of STATION_ASSET_PLACEMENTS_REF) {
    if (seen.has(placement.assetId)) continue;
    if (placement.assetId === "scenario-hopper") continue;
    seen.add(placement.assetId);
    const assetId = placement.assetId;
    entries.push({
      assetId,
      get label() { return assetIdLabel(assetId); },
      category: detectCategory(assetId),
      role: "decor",
    });
  }

  for (const [ingredientId, visual] of Object.entries(INGREDIENT_SCENARIO_VISUALS)) {
    entries.push({
      assetId: visual.assetId,
      get label() { return t("editor.ingredientPrefix", { name: ingredientName(ingredientId) }); },
      category: "decor",
      role: "decor",
    });
  }

  const registered = new Set(entries.map(entry => entry.assetId));
  for (const model of SCENARIO_ASSETS) {
    if (!registered.has(model.id)) {
      const assetId = model.id;
      entries.push({ assetId, get label() { return assetIdLabel(assetId); }, category: detectCategory(assetId), role: "decor" });
    }
  }
  for (const model of ASSET_LIBRARY) {
    entries.push({
      assetId: model.id,
      get label() { return libraryLabel(model); },
      category: model.category,
      role: "decor",
      pack: model.pack,
      ...(model.scale ? { scale: { ...model.scale } } : {}),
    });
  }
  return entries;
})();

export const generateObjectId = (): string => createUid("obj");

/**
 * What to call a placed object, in the current language: its catalogue entry's name when it
 * has one (a map saved in another language still reads in this one), else the stored label.
 */
export const objectLabel = (object: MapPlacedObject): string | undefined => {
  const entry = EDITOR_ASSET_CATALOG.find((candidate) =>
    candidate.assetId === object.assetId &&
    (candidate.stationId ?? undefined) === (object.stationId ?? undefined) &&
    (candidate.ingredientId ?? undefined) === (object.ingredientId ?? undefined) &&
    (candidate.playerIndex ?? undefined) === (object.playerIndex ?? undefined) &&
    candidate.role === object.role);
  return object.role === "robot" ? object.label : entry?.label ?? object.label;
};

export const createPlacedObject = (asset: EditorAssetEntry, position: { x: number; y: number; z: number }): MapPlacedObject => ({
  id: generateObjectId(),
  assetId: asset.assetId,
  role: asset.role,
  category: asset.category,
  position: toFixedVector(position),
  rotation: { x: 0, y: 0, z: 0 },
  scale: { ...(asset.scale ?? { x: 1, y: 1, z: 1 }) },
  collides: isSolidByDefault(asset),
  stationId: asset.stationId as MapPlacedObject["stationId"],
  ingredientId: asset.ingredientId,
  playerIndex: asset.playerIndex,
  label: asset.label,
  color: asset.color,
  robot: asset.role === "robot" ? { ...(asset.robot ?? ROBOT_PRESETS[0]!.config) } : undefined,
  // Without this a placed mechanism carried no config at all: "Save and play" ran it as
  // static scenery, and a save and reload defaulted every kind to a conveyor. Sanitised
  // rather than spread, so the copy is deep — two placed belts never share one route.
  mechanism: asset.role === "mechanism" ? sanitizeMechanismConfig(asset.mechanism) : undefined,
});

export const cloneMapData = (data: MapData, name?: string): MapData => ({
  ...data,
  name: name ?? data.name,
  updatedAt: Date.now(),
  objects: data.objects.map((entry) => ({
    ...entry,
    position: { ...entry.position },
    rotation: { ...entry.rotation },
    scale: { ...entry.scale },
  })),
});

export const roundPlacement = (entry: MapPlacedObject): MapPlacedObject => ({
  ...entry,
  position: toFixedVector(entry.position),
  rotation: toFixedVector(entry.rotation),
  scale: toFixedVector(entry.scale),
});

export const summarizeStations = (objects: readonly MapPlacedObject[]): { stations: number; dispensers: number } => {
  let stations = 0;
  let dispensers = 0;
  for (const object of objects) {
    if (object.role === "station") stations += 1;
    else if (object.role === "dispenser") dispensers += 1;
  }
  return { stations, dispensers };
};
