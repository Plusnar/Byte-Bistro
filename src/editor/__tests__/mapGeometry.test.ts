import { describe, expect, it } from "vitest";
import { wrapAngle, type MapPlacedObject } from "../MapData";
import { computeBounds } from "../../scenes/KitchenEnvironment";

describe("wrapAngle", () => {
  it("brings any angle into (-π, π]", () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 2)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 2 + 0.3)).toBeCloseTo(0.3);
    expect(wrapAngle(-Math.PI * 2 - 0.3)).toBeCloseTo(-0.3);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
  });
});

describe("computeBounds", () => {
  const placed = (assetId: string, role: MapPlacedObject["role"], x: number, z: number, scale = 1): MapPlacedObject => ({
    id: `${assetId}-${x}-${z}`,
    assetId,
    role,
    category: role === "station" ? "station" : role === "spawn" ? "spawn" : "decor",
    position: { x, y: 0, z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: scale, y: scale, z: scale },
    collides: true,
  });
  const floor = "library:Scenario/Praca/piso_paver.glb";

  it("follows the floors and the kitchen, not scenery placed far away", () => {
    const objects = [
      placed(floor, "decor", 0, 0, 1.25),
      placed(floor, "decor", 5, 0, 1.25),
      placed("build-player-spawn-1", "spawn", 1, 0),
      // A church 40 m away must not stretch where the cooks may walk.
      placed("library:Scenario/IgrejaMatriz/igreja_matriz_completa.glb", "decor", 40, 40, 1.25),
    ];
    const bounds = computeBounds(objects);
    expect(bounds.maxX).toBeLessThan(10);
    expect(bounds.maxZ).toBeLessThan(5);
    expect(bounds.minX).toBeLessThan(-0.6);
  });

  it("falls back to every object for a map of pure scenery", () => {
    const bounds = computeBounds([placed("build-block", "decor", 20, 0)]);
    expect(bounds.maxX).toBeGreaterThan(20);
  });
});

describe("placementsFromMap geometry", () => {
  const wall = (z: number): MapPlacedObject => ({
    id: `wall-${z}`,
    assetId: "library:Scenario/Praca/parede_colonial.glb",
    role: "decor",
    category: "room",
    position: { x: 0, y: 0, z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1.25, y: 1.25, z: 1.25 },
    collides: true,
  });
  const map = { version: 1, name: "t", createdAt: 0, updatedAt: 0, environment: { ambient: "#000000", fog: "#000000", fogDensity: 0 }, objects: [wall(-6), wall(6)] } as const;

  it("keeps joined walls solid and at their authored height", async () => {
    const { placementsFromMap } = await import("../../scenes/KitchenEnvironment");
    const placed = placementsFromMap(map);
    for (const wall of placed) {
      expect(wall.scale?.y).toBeCloseTo(1.25);
      expect(wall.collides).toBe(true);
    }
  });
});

describe("the lot limits who can walk where", () => {
  const object = (assetId: string, x: number, z: number, role: MapPlacedObject["role"] = "decor", playerIndex?: 1 | 2): MapPlacedObject => ({
    id: `${assetId}-${x}-${z}`, assetId, role, category: role === "spawn" ? "spawn" : "room",
    position: { x, y: 0, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.25, y: 1.25, z: 1.25 },
    collides: true, playerIndex,
  });
  const floor = "library:Scenario/Praca/piso_paver.glb";

  it("never lets the movement bounds cross the marked lot line", async () => {
    const { deriveAnchorsFromMap, LOT_EDGE_INSET } = await import("../../scenes/KitchenEnvironment");
    const { BUILD_LOT_HALF } = await import("../buildTools");
    // Floors laid right up to (and past) the lot edge.
    const map = { version: 1, name: "t", createdAt: 0, updatedAt: 0,
      environment: { ambient: "#000000", fog: "#000000", fogDensity: 0 },
      objects: [object(floor, -19.375, 0), object(floor, 25, 25), object("build-player-spawn-1", 30, 0, "spawn", 1)] } as const;
    const anchors = deriveAnchorsFromMap(map);
    const edge = BUILD_LOT_HALF - LOT_EDGE_INSET;
    expect(anchors.bounds.minX).toBeGreaterThanOrEqual(-edge);
    expect(anchors.bounds.maxX).toBeLessThanOrEqual(edge);
    expect(anchors.bounds.maxZ).toBeLessThanOrEqual(edge);
    // A spawn placed off the lot starts on its edge.
    expect(anchors.playerSpawns[0]!.x).toBeLessThanOrEqual(edge);
  });
});
