import { ASSET_LIBRARY } from "../data/assetLibrary";
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
import { ROBOT_ASSET_ID, ROBOT_PRESETS, type RobotConfig } from "../data/robotConfig";

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

const STATION_LABELS: Readonly<Record<string, { label: string; color: string }>> = {
  ingredient_dispenser: { label: "Ingredients", color: "#44DFFF" },
  bit_crusher: { label: "Bit Crusher", color: "#FF65C3" },
  data_mixer: { label: "Data Mixer", color: "#A986FF" },
  compiler_oven: { label: "Compiler Oven", color: "#FF8B4D" },
  cache_freezer: { label: "Cache Freezer", color: "#55E7FF" },
  plating_station: { label: "Plating Station", color: "#7DFFAD" },
  serving_terminal: { label: "Feed CORE", color: "#40F2FF" },
};

export interface EditorAssetEntry {
  readonly assetId: string;
  readonly label: string;
  readonly category: PlacedObjectCategory;
  readonly role: "decor" | "station" | "dispenser" | "spawn" | "robot";
  readonly stationId?: string;
  readonly ingredientId?: string;
  readonly playerIndex?: 1 | 2;
  readonly color?: string;
  readonly pack?: string;
  /** Placement scale; kitchen tiles use the in-game 1.2 m footprint. */
  readonly scale?: { x: number; y: number; z: number };
  /** Starting config for `role === "robot"` entries. */
  readonly robot?: RobotConfig;
}

const TILE_SCALE = { x: 0.6, y: 0.9, z: 0.6 } as const;

/** Model shown in the editor for each kitchen tile (the game draws its own). */
const KITCHEN_STATION_MODEL: Readonly<Record<KitchenStationKind, KitchenModelName>> = {
  crate: "crate",
  counter: "kitchencounter_straight_A",
  cutting_board: "kitchencounter_straight_B",
  stove: "stove_single",
  sink: "kitchencounter_sink",
  plate_rack: "kitchencounter_straight_B",
  dirty_return: "kitchencounter_straight_B",
  trash: "barrel",
  delivery: "kitchencounter_straight_B",
  extinguisher_stand: "kitchencounter_straight_A",
};

export const kitchenStationEntry = (kind: KitchenStationKind): EditorAssetEntry => ({
  assetId: kitchenAssetId(KITCHEN_STATION_MODEL[kind]),
  label: `Cozinha // ${STATION_KIND_LABEL[kind]}`,
  category: "station",
  role: "station",
  stationId: kind,
  color: "#FF9F43",
  scale: TILE_SCALE,
});

export const kitchenCrateEntry = (ingredientId: string, label: string): EditorAssetEntry => ({
  // Crates now use the bespoke bulk art, which is an already-resolved asset id.
  assetId: CRATE_MODEL_BY_INGREDIENT[ingredientId] ?? kitchenAssetId("crate"),
  label: `Caixa // ${label}`,
  category: "dispenser",
  role: "dispenser",
  ingredientId,
  color: "#44DFFF",
  scale: { x: 0.6, y: 0.98, z: 0.6 },
});

export const EDITOR_ASSET_CATALOG: readonly EditorAssetEntry[] = (() => {
  const entries: EditorAssetEntry[] = [
    { assetId: "build-player-spawn-1", label: "Início do Jogador 1", category: "spawn", role: "spawn", playerIndex: 1, color: "#55F3EC" },
    { assetId: "build-player-spawn-2", label: "Início do Jogador 2", category: "spawn", role: "spawn", playerIndex: 2, color: "#FF65C3" },
    { assetId: "build-floor", label: "Piso modular 2 x 2", category: "room", role: "decor", color: "#64758a" },
    { assetId: "build-wall", label: "Parede 2 x 3", category: "room", role: "decor", color: "#a9bccc" },
    { assetId: "build-block", label: "Bloco / bancada", category: "storage", role: "decor", color: "#d5a26c" },
    { assetId: "scenario-room-wide", label: "Ambiente completo", category: "room", role: "decor" },
    ...(Object.keys(KITCHEN_STATION_MODEL) as KitchenStationKind[])
      .filter((kind) => kind !== "crate")
      .map(kitchenStationEntry),
    ...KITCHEN_DISPENSER_ANCHORS.map((anchor) => kitchenCrateEntry(anchor.ingredientId, anchor.label)),
    // Robots are one model with four starting configs; the inspector tunes them per instance.
    ...ROBOT_PRESETS.map((preset): EditorAssetEntry => ({
      assetId: ROBOT_ASSET_ID,
      label: preset.label,
      category: "robot",
      role: "robot",
      color: "#9FE8FF",
      robot: preset.config,
    })),
  ];
  const seen = new Set<string>();

  for (const anchor of KITCHEN_DISPENSER_ANCHORS) {
    entries.push({
      assetId: "scenario-hopper",
      label: `Dispenser // ${anchor.label}`,
      category: "dispenser",
      role: "dispenser",
      ingredientId: anchor.ingredientId,
      color: anchor.color,
    });
    seen.add("scenario-hopper");
  }

  for (const anchor of KITCHEN_STATION_ANCHORS) {
    if (anchor.id === "ingredient_dispenser") continue;
    const info = STATION_LABELS[anchor.id];
    if (!info) continue;
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
      label: info.label,
      category: "station",
      role: "station",
      stationId: anchor.id,
      color: info.color,
    });
    seen.add(assetId);
    if (anchor.id === "serving_terminal") {
      entries.push({
        assetId: "scenario-cash-register",
        label: "CORE Register",
        category: "machine",
        role: "station",
        stationId: "serving_terminal",
        color: info.color,
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
    entries.push({
      assetId: placement.assetId,
      label: humanizeAsset(placement.assetId),
      category,
      role: "decor",
    });
  }

  for (const placement of STATION_ASSET_PLACEMENTS_REF) {
    if (seen.has(placement.assetId)) continue;
    if (placement.assetId === "scenario-hopper") continue;
    seen.add(placement.assetId);
    entries.push({
      assetId: placement.assetId,
      label: humanizeAsset(placement.assetId),
      category: detectCategory(placement.assetId),
      role: "decor",
    });
  }

  for (const [ingredientId, visual] of Object.entries(INGREDIENT_SCENARIO_VISUALS)) {
    entries.push({
      assetId: visual.assetId,
      label: `Ingredient // ${ingredientId.replace(/_/g, " ")}`,
      category: "decor",
      role: "decor",
    });
  }

  const registered = new Set(entries.map(entry => entry.assetId));
  for (const model of SCENARIO_ASSETS) {
    if (!registered.has(model.id)) entries.push({ assetId: model.id, label: humanizeAsset(model.id), category: detectCategory(model.id), role: "decor" });
  }
  for (const model of ASSET_LIBRARY) {
    entries.push({
      assetId: model.id,
      label: model.label,
      category: model.category,
      role: "decor",
      pack: model.pack,
      ...(model.scale ? { scale: { ...model.scale } } : {}),
    });
  }
  return entries;
})();

export const generateObjectId = (): string => createUid("obj");

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
