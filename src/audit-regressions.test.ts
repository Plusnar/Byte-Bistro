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
import { WEDDING_SCENARIO } from "./data/scenarios";
import { stationsFromMap } from "./data/kitchenLayout";
import { isSeeThroughStructure, StructureMaterials, STRUCTURE_OPACITY } from "./core/render/structureVisibility";
import { isMapPlayable, mapRequirements } from "./editor/validation";

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

it("fades upper structure using shared materials while ground and ordinary props stay opaque", () => {
  expect(isSeeThroughStructure("build-wall", 0)).toBe(true);
  expect(isSeeThroughStructure("build-floor", 0)).toBe(false);
  expect(isSeeThroughStructure("build-floor", 2)).toBe(true);
  expect(isSeeThroughStructure("library:Scenario/truss.glb", 0, "room")).toBe(true);
  expect(isSeeThroughStructure("library:Scenario/wall_clock.glb", 2, "decor")).toBe(false);

  const engine = new NullEngine();
  const scene = new Scene(engine);
  const materials = new StructureMaterials();
  try {
    const original = new PBRMaterial("shared opaque atlas", scene);
    original.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    const wall = MeshBuilder.CreateBox("wall", {}, scene);
    const otherWall = MeshBuilder.CreateBox("other wall", {}, scene);
    const prop = MeshBuilder.CreateBox("prop", {}, scene);
    wall.material = otherWall.material = prop.material = original;
    wall.checkCollisions = true;

    materials.fade(wall);
    materials.fade(otherWall);
    expect(wall.material).toBe(otherWall.material);
    expect(wall.material?.alpha).toBeCloseTo(STRUCTURE_OPACITY);
    expect(wall.material?.needAlphaBlendingForMesh(wall)).toBe(true);
    expect(prop.material?.needAlphaBlendingForMesh(prop)).toBe(false);
    expect(wall.checkCollisions).toBe(true);
    materials.restore(wall);
    expect(wall.material).toBe(original);
  } finally {
    materials.dispose();
    scene.dispose();
    engine.dispose();
  }
});
