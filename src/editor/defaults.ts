import { getIngredient } from "../data/ingredients";
import { DEFAULT_KITCHEN_LAYOUT } from "../data/kitchenLayout";
import { EDITOR_ASSET_CATALOG, kitchenCrateEntry, kitchenStationEntry } from "./catalog";
import type { MapData, MapPlacedObject } from "./MapData";

const createObject = (
  id: string,
  role: MapPlacedObject["role"],
  category: MapPlacedObject["category"],
  assetId: string,
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  scale: { x: number; y: number; z: number } = { x: 1, y: 1, z: 1 },
  extras: Partial<MapPlacedObject> = {},
): MapPlacedObject => ({
  id,
  assetId,
  role,
  category,
  position,
  rotation,
  scale,
  collides: false,
  ...extras,
});

export const createDefaultMap = (name = "Sala padrão"): MapData => {
  const now = Date.now();
  const objects: MapPlacedObject[] = [];

  objects.push(
    createObject("default-room", "decor", "room", "scenario-room-wide",
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 1.08, y: 1.08, z: 1.22 },
      { collides: true, label: "Ambiente completo", color: "#374357" },
    ),
  );

  const layout = DEFAULT_KITCHEN_LAYOUT;
  objects.push(
    createObject("default-player-spawn-1", "spawn", "spawn", "build-player-spawn-1",
      { x: layout.spawns[0].x, y: 0, z: layout.spawns[0].z },
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      { playerIndex: 1, label: "Início do Jogador 1", color: "#55F3EC" },
    ),
    createObject("default-player-spawn-2", "spawn", "spawn", "build-player-spawn-2",
      { x: layout.spawns[1].x, y: 0, z: layout.spawns[1].z },
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 1 },
      { playerIndex: 2, label: "Início do Jogador 2", color: "#FF65C3" },
    ),
  );

  layout.stations.forEach((station, index) => {
    const entry = station.kind === "crate"
      ? kitchenCrateEntry(station.ingredientId ?? "", getIngredient(station.ingredientId ?? "")?.displayName ?? "")
      : kitchenStationEntry(station.kind);
    objects.push(
      createObject(
        `default-${station.kind}-${index}`,
        entry.role,
        entry.category,
        entry.assetId,
        { x: station.x, y: 0, z: station.z },
        { x: 0, y: station.rotationY, z: 0 },
        { ...(entry.scale ?? { x: 1, y: 1, z: 1 }) },
        {
          collides: true,
          stationId: entry.stationId as MapPlacedObject["stationId"],
          ingredientId: entry.ingredientId,
          label: entry.label,
          color: entry.color,
        },
      ),
    );
  });

  return {
    version: 1,
    name,
    createdAt: now,
    updatedAt: now,
    environment: {
      ambient: "#27354A",
      fog: "#06101A",
      fogDensity: 0.008,
    },
    objects,
  };
};

export const emptyMap = (name = "Mapa vazio"): MapData => {
  const now = Date.now();
  return {
    version: 1,
    name,
    createdAt: now,
    updatedAt: now,
    environment: {
      ambient: "#27354A",
      fog: "#06101A",
      fogDensity: 0.008,
    },
    objects: [],
  };
};

void EDITOR_ASSET_CATALOG;
