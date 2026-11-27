import { describe, expect, it } from "vitest";
import { isMapPlayable, mapRequirements } from "../validation";
import { WEDDING_SCENARIO, type ScenarioDefinition } from "../../data/scenarios";
import type { MapData, MapPlacedObject } from "../MapData";
import { DEFAULT_MECHANISM_CONFIG } from "../../data/mechanismConfig";
// Top level, not a dynamic import inside the test: this pulls Babylon in through the
// catalogue, which costs seconds and would otherwise land on the test's own timeout.
import { createDefaultMap } from "../defaults";

const object = (overrides: Partial<MapPlacedObject> & { id: string }): MapPlacedObject => ({
  assetId: "build-floor",
  role: "decor",
  category: "room",
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
  collides: false,
  ...overrides,
});

const map = (objects: MapPlacedObject[], scenarioId?: string): MapData => ({
  version: 1,
  name: "Mapa",
  createdAt: 0,
  updatedAt: 0,
  environment: { ambient: "#27354A", fog: "#06101A", fogDensity: 0.008 },
  objects,
  scenarioId,
});

const weddingComplete = (): MapPlacedObject[] => [
  object({ id: "floor", assetId: "build-floor" }),
  object({ id: "p1", role: "spawn", category: "spawn", playerIndex: 1, position: { x: -2, y: 0, z: 0 } }),
  object({ id: "p2", role: "spawn", category: "spawn", playerIndex: 2, position: { x: 2, y: 0, z: 0 } }),
  // Indexed, not keyed by id: two requirements share the "stove" id (the second is the pot).
  ...WEDDING_SCENARIO.requirements.stations.map((station, index) =>
    object({
      id: `st-${index}-${station.id}`,
      role: "station",
      category: "station",
      stationId: station.id as MapPlacedObject["stationId"],
      position: { x: index * 2, y: 0, z: -4 },
    })),
  ...WEDDING_SCENARIO.requirements.ingredients.map((ingredient, index) =>
    object({
      id: `in-${ingredient.id}`,
      role: "dispenser",
      category: "dispenser",
      ingredientId: ingredient.id,
      position: { x: index * 2, y: 0, z: 4 },
    })),
];

describe("mapRequirements", () => {
  it("reports everything missing for an empty map", () => {
    const requirements = mapRequirements(map([]));
    expect(requirements.every((requirement) => !requirement.satisfied)).toBe(true);
    expect(requirements).toHaveLength(
      3 + WEDDING_SCENARIO.requirements.stations.length +
        WEDDING_SCENARIO.requirements.ingredients.length,
    );
  });

  it("passes a fully equipped wedding kitchen", () => {
    expect(isMapPlayable(map(weddingComplete()))).toBe(true);
  });

  it("still fails when one crate is missing", () => {
    const objects = weddingComplete().filter((entry) => entry.id !== "in-data_cream");
    const missing = mapRequirements(map(objects)).filter((requirement) => !requirement.satisfied);
    expect(missing.map((requirement) => requirement.label)).toEqual(["Ingrediente: Creme de dados"]);
  });

  it("checks a map against its own scenario, not against the wedding", () => {
    // Without this, every new scenario would be born unplayable with Play disabled forever.
    const minimal: ScenarioDefinition = {
      ...WEDDING_SCENARIO,
      id: "minimal",
      requirements: { stations: [], ingredients: [], requiresSpawns: true, requiresFloor: false },
    };
    const objects = [
      object({ id: "p1", role: "spawn", category: "spawn", playerIndex: 1, position: { x: -2, y: 0, z: 0 } }),
      object({ id: "p2", role: "spawn", category: "spawn", playerIndex: 2, position: { x: 2, y: 0, z: 0 } }),
    ];
    expect(isMapPlayable(map(objects), minimal)).toBe(true);
    // The same map under the wedding's rules is nowhere near playable.
    expect(isMapPlayable(map(objects))).toBe(false);
  });

  it("accepts a room shell in place of a floor tile", () => {
    const objects = weddingComplete().map((entry) =>
      entry.id === "floor" ? object({ id: "floor", assetId: "scenario-room-wide" }) : entry);
    expect(isMapPlayable(map(objects))).toBe(true);
  });
});

describe("the editor's default map", () => {
  it("is playable, so a fresh map never opens with Play disabled", () => {
    const missing = mapRequirements(createDefaultMap())
      .filter((requirement) => !requirement.satisfied)
      .map((requirement) => requirement.label);
    expect(missing).toEqual([]);
  });

  it("counts duplicates, so one stove is not enough for the pot", () => {
    // stationsFromMap alternates pan/pot per stove; a single stove never yields a pot.
    const oneStove = mapRequirements(map([
      object({ id: "s1", role: "station", category: "station", stationId: "stove" }),
    ]));
    const labels = oneStove.filter((requirement) => requirement.satisfied)
      .map((requirement) => requirement.label);
    expect(labels).toContain("Fogão");
    expect(labels).not.toContain("Panela (exige um 2º fogão)");

    const twoStoves = mapRequirements(map([
      object({ id: "s1", role: "station", category: "station", stationId: "stove" }),
      object({ id: "s2", role: "station", category: "station", stationId: "stove" }),
    ]));
    expect(twoStoves.filter((r) => r.satisfied).map((r) => r.label))
      .toContain("Panela (exige um 2º fogão)");
  });
});

describe("mechanisms", () => {
  // Keep portals clear of the complete kitchen's stations.
  const portal = (id: string, pair: string, x: number): MapPlacedObject =>
    object({
      id,
      role: "mechanism",
      category: "mechanism",
      assetId: "scenario-scanner-low",
      position: { x, y: 0, z: 15 },
      mechanism: { ...DEFAULT_MECHANISM_CONFIG, kind: "portal", portalPairId: pair },
    });

  const failing = (data: MapData): string[] =>
    mapRequirements(data).filter((requirement) => !requirement.satisfied).map((r) => r.label);

  it("is playable with a properly paired portal", () => {
    const data = map([...weddingComplete(), portal("a", "A", 12), portal("b", "A", 16)]);
    expect(isMapPlayable(data)).toBe(true);
  });

  it("flags a portal on its own", () => {
    const data = map([...weddingComplete(), portal("a", "A", 12)]);
    expect(isMapPlayable(data)).toBe(false);
    expect(failing(data).some((label) => label.includes("A"))).toBe(true);
  });

  it("flags three portals sharing one name", () => {
    const data = map([
      ...weddingComplete(),
      portal("a", "A", 10),
      portal("b", "A", 14),
      portal("c", "A", 18),
    ]);
    expect(isMapPlayable(data)).toBe(false);
  });

  it("flags a layout phase that names a mechanism the map does not have", () => {
    const data: MapData = {
      ...map([...weddingComplete(), portal("a", "A", 12), portal("b", "A", 16)]),
      meta: {
        description: "",
        shiftDurationSeconds: 195,
        difficultyId: "standard",
        layoutPhases: [{ atProgress: 0.5, enable: [], disable: ["deleted-bridge"] }],
      },
    };
    expect(isMapPlayable(data)).toBe(false);
  });

  it("accepts a layout phase whose every name exists", () => {
    const data: MapData = {
      ...map([...weddingComplete(), portal("a", "A", 12), portal("b", "A", 16)]),
      meta: {
        description: "",
        shiftDurationSeconds: 195,
        difficultyId: "standard",
        layoutPhases: [{ atProgress: 0.5, enable: [], disable: ["a"] }],
      },
    };
    expect(isMapPlayable(data)).toBe(true);
  });
});
