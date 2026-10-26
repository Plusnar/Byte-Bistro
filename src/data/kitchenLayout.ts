import type { MovementBounds } from "../entities/Player";
import type { MapData } from "../editor/MapData";
import type { KitchenStationKind, StationId } from "../types/game";
import { KITCHEN_TILE } from "./kitchen";

export type InitialItemKind = "pan" | "pot" | "tray" | "bowl" | "extinguisher";

export interface KitchenStationPlacement {
  readonly kind: KitchenStationKind;
  readonly x: number;
  readonly z: number;
  readonly rotationY: number;
  readonly ingredientId?: string;
  readonly initial?: InitialItemKind;
}

export interface KitchenLayout {
  readonly stations: readonly KitchenStationPlacement[];
  readonly playerBounds: MovementBounds;
  readonly spawns: readonly [{ x: number; z: number }, { x: number; z: number }];
  /** Where the wedding guests mingle; kept outside the cooking floor. */
  readonly receptionArea: MovementBounds | null;
}

const T = KITCHEN_TILE;
/** Grid column centres: 16 tiles spanning x = -9.6 .. 9.6. */
const column = (index: number): number => Number((-9 + index * T).toFixed(2));

// Station fronts face the walkway: rotation 0 faces +z, PI faces -z.
const FACE_NORTH = 0;
const FACE_SOUTH = Math.PI;
const FACE_EAST = Math.PI / 2;
const FACE_WEST = -Math.PI / 2;

// The room's front wall hides anything south of z ≈ -5, so the kitchen starts
// at -4.4 and leaves 2 m walkways between the rows.
const FRONT_ROW_Z = -4.4;
const PASS_ROW_Z = 2.0;
const ISLAND_Z = -1.2;
const SIDE_COLUMN_Z = [-3.2, -2.0, -0.8, 0.4] as const;

const row = (
  z: number,
  rotationY: number,
  tiles: readonly (Omit<KitchenStationPlacement, "x" | "z" | "rotationY"> & { col: number })[],
): KitchenStationPlacement[] =>
  tiles.map(({ col, ...rest }) => ({ ...rest, x: column(col), z, rotationY }));

const side = (
  x: number,
  rotationY: number,
  kinds: readonly (Omit<KitchenStationPlacement, "x" | "z" | "rotationY">)[],
): KitchenStationPlacement[] =>
  kinds.map((rest, index) => ({ ...rest, x, z: SIDE_COLUMN_Z[index] ?? 0, rotationY }));

/**
 * Default Overcooked-style kitchen: ingredient crates along the front wall,
 * chopping on the left, stoves on the right, plates and delivery on the pass.
 */
export const DEFAULT_KITCHEN_LAYOUT: KitchenLayout = {
  stations: [
    ...row(FRONT_ROW_Z, FACE_NORTH, [
      { col: 0, kind: "counter" },
      { col: 1, kind: "crate", ingredientId: "ram_module" },
      { col: 2, kind: "crate", ingredientId: "binary_sugar" },
      { col: 3, kind: "crate", ingredientId: "cache_cream" },
      { col: 4, kind: "crate", ingredientId: "cache_fragment" },
      { col: 5, kind: "crate", ingredientId: "cooling_fluid" },
      { col: 6, kind: "crate", ingredientId: "data_cream" },
      { col: 7, kind: "counter" },
      { col: 8, kind: "counter" },
      { col: 9, kind: "trash" },
      { col: 10, kind: "counter" },
      { col: 11, kind: "counter" },
      { col: 12, kind: "counter" },
      { col: 13, kind: "counter" },
      { col: 14, kind: "extinguisher_stand", initial: "extinguisher" },
      { col: 15, kind: "counter" },
    ]),
    ...side(column(0), FACE_EAST, [
      { kind: "cutting_board" },
      { kind: "counter" },
      { kind: "cutting_board" },
      { kind: "counter" },
    ]),
    ...side(column(15), FACE_WEST, [
      { kind: "stove", initial: "pan" },
      { kind: "counter" },
      { kind: "stove", initial: "pan" },
      { kind: "counter" },
    ]),
    ...row(ISLAND_Z, FACE_SOUTH, [
      { col: 5, kind: "mixer", initial: "bowl" },
      { col: 6, kind: "cutting_board" },
      { col: 7, kind: "counter" },
      { col: 8, kind: "oven", initial: "tray" },
      { col: 9, kind: "counter" },
      { col: 10, kind: "stove", initial: "pot" },
    ]),
    ...row(PASS_ROW_Z, FACE_SOUTH, [
      { col: 0, kind: "counter" },
      { col: 1, kind: "counter" },
      { col: 2, kind: "counter" },
      { col: 3, kind: "counter" },
      { col: 4, kind: "counter" },
      { col: 5, kind: "plate_rack" },
      { col: 6, kind: "counter" },
      { col: 7, kind: "delivery" },
      { col: 8, kind: "delivery" },
      { col: 9, kind: "counter" },
      { col: 10, kind: "dirty_return" },
      { col: 11, kind: "sink" },
      { col: 12, kind: "counter" },
      { col: 13, kind: "counter" },
      { col: 14, kind: "counter" },
      { col: 15, kind: "counter" },
    ]),
  ],
  playerBounds: { minX: -8.2, maxX: 8.2, minZ: -3.5, maxZ: 1.1 },
  spawns: [
    { x: -1.2, z: -2.7 },
    { x: 1.2, z: -2.7 },
  ],
  // The open aisle of the wedding hall, between the round tables and in front of the
  // altar (see scenes/weddingHall.ts); nothing stands inside it.
  receptionArea: { minX: -3.6, maxX: 3.6, minZ: 3.0, maxZ: 4.9 },
};

/** Legacy machine stations from older custom maps mapped onto kitchen tiles. */
const LEGACY_STATION_KIND: Readonly<Partial<Record<StationId, KitchenStationKind>>> = {
  bit_crusher: "cutting_board",
  data_mixer: "counter",
  compiler_oven: "stove",
  cache_freezer: "counter",
  plating_station: "plate_rack",
  serving_terminal: "delivery",
};

export const stationKindFor = (stationId: StationId): KitchenStationKind | null => {
  if (stationId === "ingredient_dispenser") return null;
  return LEGACY_STATION_KIND[stationId] ?? (stationId as KitchenStationKind);
};

/** Converts editor station/dispenser objects into kitchen tiles. */
export const stationsFromMap = (map: MapData): KitchenStationPlacement[] => {
  const stations: KitchenStationPlacement[] = [];
  let stoveCount = 0;
  for (const object of map.objects) {
    const base = { x: object.position.x, z: object.position.z, rotationY: object.rotation.y };
    if (object.role === "dispenser" && object.ingredientId) {
      stations.push({ ...base, kind: "crate", ingredientId: object.ingredientId });
      continue;
    }
    if (object.role !== "station" || !object.stationId) continue;
    const kind = stationKindFor(object.stationId);
    if (!kind) continue;
    if (kind === "stove") {
      // Alternate pans and pots so every cooking recipe stays possible.
      stations.push({ ...base, kind, initial: stoveCount % 2 === 0 ? "pan" : "pot" });
      stoveCount += 1;
    } else if (kind === "oven") {
      // Each comes with its own vessel: without one the station is unusable, and there is
      // nowhere else in the kitchen to find a tray or a bowl.
      stations.push({ ...base, kind, initial: "tray" });
    } else if (kind === "mixer") {
      stations.push({ ...base, kind, initial: "bowl" });
    } else if (kind === "extinguisher_stand") {
      stations.push({ ...base, kind, initial: "extinguisher" });
    } else {
      stations.push({ ...base, kind });
    }
  }
  return stations;
};
