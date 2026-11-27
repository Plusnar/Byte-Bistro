import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssetManager } from "./core/AssetManager";
import { assetCache } from "./core/assets/AssetCache";
import { AccountMaps } from "./core/AccountMaps";
import { AccountApiError, listAccountMaps, readAccountMap, writeAccountMap, deleteAccountMap } from "./core/PlayerAccount";
import { MapStore } from "./editor/MapStore";
import type { MapData } from "./editor/MapData";
import { Vector3, MeshBuilder, Scene, NullEngine, PBRMaterial } from "@babylonjs/core";
import { flightGroundContact } from "./physics/groundProbe";
import { heightAt, throwLaunch, throwSphereContact, throwStationContact } from "./gameplay/throwArc";
import { UNIVILLE_MENU, UNIVILLE_SCENARIO, WEDDING_MENU, WEDDING_SCENARIO } from "./data/scenarios";
import { stationsFromMap } from "./data/kitchenLayout";
import { CHOP_SECONDS, MIX_SECONDS, getFoodDefinition, vesselForState } from "./data/kitchen";
import { RECIPES } from "./data/recipes";
import { createCookware, createFood, createPlate, cookDuration, type KitchenItem } from "./gameplay/kitchen/KitchenItems";
import { computeGuide } from "./gameplay/kitchen/KitchenGuide";
import { KitchenModel, type Workstation } from "./gameplay/kitchen/KitchenModel";
import { isConstruction, ConstructionMaterials } from "./core/render/structureVisibility";
import { isMapPlayable, mapRequirements } from "./editor/validation";
import { campusDarkness, rainZones } from "./scenes/CampusStorm";
import { getOfficialLevel } from "./data/officialLevels";
import { resultMusic, Soundtrack } from "./core/Soundtrack";

vi.mock("./core/PlayerAccount", async (original) => ({
  ...await original<typeof import("./core/PlayerAccount")>(),
  listAccountMaps: vi.fn(),
  readAccountMap: vi.fn(),
  writeAccountMap: vi.fn(),
  deleteAccountMap: vi.fn(),
}));

class BrowserStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

const map = (name: string, updatedAt = 1): MapData => ({
  version: 1, name, createdAt: 1, updatedAt,
  environment: { ambient: "#ffffff", fog: "#000000", fogDensity: 0 },
  objects: [], scenarioId: "wedding",
});

const SLOT = "slot-a";
const USER = "user-a";

describe("soundtrack", () => {
  it("preserves the fractional music durations when loading official maps", () => {
    expect(getOfficialLevel("schlachtfest")?.map.meta?.shiftDurationSeconds).toBe(204.8);
    expect(getOfficialLevel("salao-pauli")?.map.meta?.shiftDurationSeconds).toBe(202.24);
  });

  it("plays defeat music for C and D, and success music for S, A and B", () => {
    expect((["S", "A", "B", "C", "D"] as const).map(resultMusic))
      .toEqual(["success", "success", "success", "defeat", "defeat"]);
  });

  it("preloads the stage and plays continuously while the browser cannot seek", () => {
    const browser = new EventTarget();
    let seekableEnd = 0;
    const audio = Object.assign(new EventTarget(), {
      currentTime: 0.2, duration: 204.8, seeking: false,
      buffered: { length: 1, start: () => 0, end: () => 2 },
      seekable: { length: 1, start: () => 0, end: () => seekableEnd },
      pause: vi.fn(), play: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(), removeAttribute: vi.fn(),
      preload: "", src: "",
    });
    vi.stubGlobal("window", browser);
    vi.stubGlobal("Audio", function () { return audio; });
    const music = new Soundtrack();
    try {
      const gesture = new Event("pointerup");
      Object.defineProperty(gesture, "isTrusted", { value: true });
      browser.dispatchEvent(gesture);
      music.update("schlachtfest", true, 0);
      expect(audio.preload).toBe("auto");
      expect(audio.src).toMatch(/schlachtfest\.mp3$/);
      expect(audio.play).not.toHaveBeenCalled();
      music.update("schlachtfest", false, 0.8);
      expect(audio.play).toHaveBeenCalledTimes(1);
      expect(audio.currentTime).toBe(0.2);
      seekableEnd = 2;
      music.update("schlachtfest", false, 0.8);
      expect(audio.currentTime).toBe(0.8);
      music.update("schlachtfest", false, 1.55);
      expect(audio.currentTime).toBe(0.8);
    } finally {
      music.dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe("the official Univille storm", () => {
  it("loads the Univille menu, duration, difficulty and kitchen from the shipped map", () => {
    const level = getOfficialLevel("univille")!;
    expect(level.map.scenarioId).toBe(UNIVILLE_SCENARIO.id);
    expect(level.map.meta).toMatchObject({ shiftDurationSeconds: 195, difficultyId: "meltdown" });
    expect(UNIVILLE_SCENARIO.recipeIds).toEqual(UNIVILLE_MENU);
    expect(isMapPlayable(level.map)).toBe(true);
  });

  it("darkens over three seconds before each ten-second blackout", () => {
    for (const start of [17, 44, 71]) {
      expect(campusDarkness(start - 3)).toBe(0);
      expect(campusDarkness(start - 2.5)).toBeGreaterThan(0);
      expect(campusDarkness(start - 1.5)).toBeCloseTo(0.5);
      expect(campusDarkness(start - 0.25)).toBeLessThan(1);
      expect(campusDarkness(start)).toBe(1);
      expect(campusDarkness(start + 9.999)).toBe(1);
      expect(campusDarkness(start + 10)).toBe(0);
    }
  });

  it("keeps every rain emitter outside the indoor footprint", () => {
    const shelter = UNIVILLE_SCENARIO.stormShelter!;
    const zones = rainZones(shelter);
    expect(zones).toHaveLength(4);
    for (const zone of zones) {
      expect(zone.maxX <= shelter.minX || zone.minX >= shelter.maxX ||
        zone.maxZ <= shelter.minZ || zone.minZ >= shelter.maxZ).toBe(true);
    }
  });
});

describe("recipe preparation", () => {
  it.each(RECIPES.map(recipe => [recipe.id, recipe] as const))("prepares and serves %s from its required states", (_id, recipe) => {
    const model = new KitchenModel([
      { id: "board", kind: "cutting_board", x: 0, z: 0, rotationY: 0 },
      { id: "vessel", kind: "stove", x: 3, z: 0, rotationY: 0 },
      { id: "delivery", kind: "delivery", x: 6, z: 0, rotationY: 0 },
    ], [recipe]);
    const [board, cooking, delivery] = model.stations as [Workstation, Workstation, Workstation];
    const plate = createPlate();
    const apply = (station: Workstation, held: KitchenItem | null): KitchenItem | null => {
      const result = model.grab(station, held, 0);
      if (result.kind !== "changed") throw new Error(JSON.stringify(result));
      return result.held;
    };
    for (const component of recipe.components) {
      const food = createFood(component.ingredientId, 0);
      const vessel = vesselForState(component.state);
      apply(board, food);
      if (component.state !== "raw" && getFoodDefinition(food.ingredientId)?.chop) {
        expect(model.grab(board, plate, 0).kind).toBe("blocked");
        model.work(board, null, CHOP_SECONDS + 0.01);
      }
      if (vessel) {
        expect(model.grab(board, plate, 0).kind).toBe("blocked");
        const cookware = createCookware(vessel);
        const station = { ...cooking, item: cookware, spec: {
          ...cooking.spec, kind: vessel === "bowl" ? "mixer" : vessel === "tray" ? "oven" : "stove",
        } } satisfies Workstation;
        model.stations[1] = station;
        apply(station, apply(board, null));
        expect(model.grab(station, plate, 0).kind).toBe("blocked");
        if (vessel === "bowl") model.work(station, null, MIX_SECONDS + 0.01);
        else model.update(cookDuration(cookware) + 0.01);
        apply(station, plate);
      } else {
        apply(board, plate);
      }
    }
    expect(plate.contents.map(({ ingredientId, state }) => ({ ingredientId, state }))).toEqual(recipe.components);
    expect(model.grab(delivery, plate, 0)).toMatchObject({ kind: "deliver", recipe });
  });

  it("keeps the wedding cookie counter accurate across partial batches and rejects the frying pan", () => {
    const recipes = RECIPES.filter(recipe => WEDDING_MENU.includes(recipe.id));
    const cookies = recipes.find(recipe => recipe.id === "cache_cookies")!;
    const model = new KitchenModel([
      { id: "pan", kind: "stove", x: 0, z: 0, rotationY: 0, initialItem: () => createCookware("pan") },
      { id: "pot", kind: "stove", x: 3, z: 0, rotationY: 0, initialItem: () => createCookware("pot") },
    ], recipes);
    const [pan, stove] = model.stations as [Workstation, Workstation];
    const pot = stove.item as ReturnType<typeof createCookware>;
    const chopped = () => ({ ...createFood("cache_fragment", 0), state: "chopped" as const });
    const plate = createPlate();
    const stages = (processing = false) => computeGuide(cookies, [
      { item: plate, holder: 0 }, { item: pot, holder: null, processing },
    ]).componentStages.map(component => component.stage);
    expect(model.grab(pan, chopped(), 0).kind).toBe("blocked");
    expect(model.grab(stove, chopped(), 0).kind).toBe("changed");
    model.update(cookDuration(pot) + 0.01);
    expect(stages()).toEqual(["plate", "fetch", "fetch"]);
    expect(model.grab(stove, chopped(), 0)).toMatchObject({ kind: "changed", message: expect.any(String) });
    expect(stages(true)).toEqual(["cooking", "cooking", "fetch"]);
    expect(model.grab(stove, plate, 0).kind).toBe("blocked");
    model.update(cookDuration(pot) + 0.01);
    expect(model.grab(stove, plate, 0).kind).toBe("changed");
    expect(stages()).toEqual(["plated", "plated", "fetch"]);
    expect(model.grab(stove, chopped(), 0).kind).toBe("changed");
    model.update(cookDuration(pot) + 0.01);
    expect(model.grab(stove, plate, 0).kind).toBe("changed");
    expect(stages()).toEqual(["plated", "plated", "plated"]);
  });
});

describe("editor map sync", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listAccountMaps).mockResolvedValue([]);
  });

  it("serializes snapshots and carries the acknowledged version into the next write and delete", async () => {
    const storage = new BrowserStorage();
    const store = new MapStore(undefined, undefined, storage);
    const sync = new AccountMaps(store, storage);
    await sync.signIn(USER);
    let acknowledge!: (version: number) => void;
    vi.mocked(writeAccountMap).mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    vi.mocked(writeAccountMap).mockResolvedValueOnce(11);
    store.save(SLOT, map("First"));
    const first = sync.upload(SLOT);
    await Promise.resolve();
    expect(writeAccountMap).toHaveBeenCalledTimes(1);
    store.save(SLOT, map("Latest", 2));
    const last = sync.upload(SLOT);
    acknowledge(10);
    expect(await first).toBe("synced");
    expect(await last).toBe("synced");
    expect(writeAccountMap).toHaveBeenLastCalledWith(USER, SLOT, expect.objectContaining({ name: "Latest" }), 10);
    store.delete(SLOT);
    expect(await sync.remove(SLOT)).toBe("synced");
    expect(deleteAccountMap).toHaveBeenLastCalledWith(USER, SLOT, 11);
  });

  it("retains offline work across logout and recovers a local copy after a remote conflict", async () => {
    const storage = new BrowserStorage();
    const store = new MapStore(undefined, undefined, storage);
    const initial = map("Cloud base");
    vi.mocked(listAccountMaps).mockResolvedValue([{ slotId: SLOT, name: initial.name, updatedAt: 20 }]);
    vi.mocked(readAccountMap).mockResolvedValue({ map: initial, updatedAt: 20 });
    const sync = new AccountMaps(store, storage);
    await sync.signIn(USER);
    store.save(SLOT, map("My draft", 2));
    vi.mocked(writeAccountMap).mockRejectedValueOnce(new TypeError("offline"));
    expect(await sync.upload(SLOT)).toBe("local");
    sync.signOut();
    expect(store.list()).toHaveLength(0);

    const other = map("Other device", 3);
    vi.mocked(listAccountMaps).mockResolvedValue([{ slotId: SLOT, name: other.name, updatedAt: 21 }]);
    vi.mocked(readAccountMap).mockResolvedValue({ map: other, updatedAt: 21 });
    vi.mocked(writeAccountMap).mockRejectedValueOnce(new AccountApiError("conflict", 409));
    const reopened = new AccountMaps(store, storage);
    const result = new Promise(resolve => { void reopened.signIn(USER, resolve); });
    expect(await result).toBe("conflict");
    expect(writeAccountMap).toHaveBeenLastCalledWith(USER, SLOT, expect.objectContaining({ name: "My draft" }), 20);
    expect(store.load(SLOT)?.name).toBe("Other device");
    expect(store.list().map(slot => slot.name)).toContain("My draft (local)");
  });

  it("marks fallback memory as temporary", async () => {
    const store = new MapStore(undefined, undefined, null);
    const sync = new AccountMaps(store, null);
    await sync.signIn(USER);
    store.save(SLOT, map("Temporary"));
    vi.mocked(writeAccountMap).mockRejectedValueOnce(new TypeError("offline"));
    expect(await sync.upload(SLOT)).toBe("temporary");
  });
});

it("leaves a required download shared when its scene closes during loading", async () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  let complete!: (bytes: ArrayBuffer) => void;
  const loading = vi.spyOn(assetCache, "fetch")
    .mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const assets = new AssetManager(scene, [{ id: "pending", url: "http://localhost/pending.glb", required: true }]);
  try {
    const attempt = assets.preload("pending");
    assets.dispose();
    scene.dispose();
    complete(new ArrayBuffer(10));
    expect(await attempt).toBe(false);
    expect(assets.stats()).toEqual({ pending: 0, liveInstances: 0, containers: 0 });
  } finally {
    loading.mockRestore();
    engine.dispose();
  }
});

describe("throw contacts", () => {
  it("uses the raised floor along the same arc at 30 and 60 fps and on an uneven frame", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const floor = MeshBuilder.CreateBox("upper-floor", { width: 24, height: 0.25, depth: 12 }, scene);
      floor.position.y = 2 - 0.125;
      floor.checkCollisions = true;
      floor.computeWorldMatrix(true);
      const launch = throwLaunch(0.35);
      for (const frameTimes of [[1 / 30], [1 / 60], [0.011, 0.081, 0.018]]) {
        const previous = new Vector3(0, 2.9, 0);
        const next = new Vector3();
        let impact: Vector3 | undefined;
        let time = 0;
        for (let frame = 0; time < 2; frame += 1) {
          time += frameTimes[frame % frameTimes.length]!;
          next.set(time * launch.speed, heightAt(2.9, launch, time), 0);
          const contact = flightGroundContact(previous, next, [floor]);
          if (contact <= 1) { impact = Vector3.Lerp(previous, next, contact); break; }
          previous.copyFrom(next);
        }
        expect(impact?.y).toBeCloseTo(2, 4);
      }
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("sees the first swept player and ignores stations under the flight's storey", () => {
    const from = new Vector3(-2, 3, 0);
    const to = new Vector3(2, 3, 0);
    expect(throwSphereContact(from, to, 0, 3, 0, 0.4)).toBeCloseTo(0.4);
    expect(throwSphereContact(from, to, 0, 0.9, 0, 0.4)).toBe(Infinity);
    expect(throwStationContact(from, to, 0, 0, 0.5, 0, 0.9)).toBe(Infinity);
    expect(throwStationContact(from, to, 0, 0, 0.5, 2.5, 3.4)).toBeCloseTo(0.375);
  });
});

it("warns about unknown decorations but blocks unknown mechanisms and overlapping starts", () => {
  const scenario = {
    ...WEDDING_SCENARIO,
    requirements: { requiresSpawns: false, requiresFloor: false, stations: [], ingredients: [] },
  };
  const decor = { id: "a", assetId: "library:unknown.glb", role: "decor", category: "decor",
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }, collides: false } as const;
  const draft = { ...map("Draft"), objects: [decor] };
  expect(mapRequirements(draft, scenario)).toMatchObject([{ satisfied: false, blocking: false }]);
  expect(isMapPlayable(draft, scenario)).toBe(true);
  expect(isMapPlayable({ ...draft, objects: [{ ...decor, role: "mechanism" }] }, scenario)).toBe(false);
  const spawn = { ...decor, role: "spawn", assetId: "build-player-spawn-1", category: "spawn", playerIndex: 1 } as const;
  expect(isMapPlayable({ ...draft, objects: [spawn, { ...spawn, id: "b", playerIndex: 2 }] }, scenario)).toBe(false);
});

it("keeps the precise height of supply crates when building the kitchen", () => {
  const base = { id: "crate", assetId: "crate", role: "dispenser", category: "dispenser", ingredientId: "data_cream",
    rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, collides: true } as const;
  const heights = [0, 0.04, 1.15, 4];
  const objects = heights.map((y, i) => ({ ...base, id: String(i), position: { x: 0, y, z: 0 } }));
  expect(stationsFromMap({ ...map("Multiple floors"), objects }).map(crate => crate.y)).toEqual(heights);
});

it("renders construction materials opaque without changing shared materials or collision", () => {
  expect(isConstruction("build-wall")).toBe(true);
  expect(isConstruction("build-floor")).toBe(true);
  expect(isConstruction("library:Scenario/piso_madeira.glb")).toBe(true);
  expect(isConstruction("library:Scenario/wall_clock.glb", "decor")).toBe(false);

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const materials = new ConstructionMaterials();
  try {
    const original = new PBRMaterial("shared translucent atlas", scene);
    original.alpha = 0.4;
    original.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    const floor = MeshBuilder.CreateBox("upper floor", {}, scene);
    const window = MeshBuilder.CreateBox("window", {}, scene);
    const prop = MeshBuilder.CreateBox("prop", {}, scene);
    floor.material = window.material = prop.material = original;
    floor.position.y = 2.5;
    floor.checkCollisions = true;

    materials.apply(floor);
    materials.apply(window);
    expect(floor.material).toBe(window.material);
    expect(floor.material?.alpha).toBe(1);
    expect(floor.material?.needAlphaBlendingForMesh(floor)).toBe(false);
    expect(prop.material?.alpha).toBe(0.4);
    expect(prop.material?.needAlphaBlendingForMesh(prop)).toBe(true);
    expect(floor.position.y).toBe(2.5);
    expect(floor.checkCollisions).toBe(true);
  } finally {
    materials.dispose();
    scene.dispose();
    engine.dispose();
  }
});
