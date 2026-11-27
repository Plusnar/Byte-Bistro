import { beforeEach, describe, expect, it, vi } from "vitest";
import { MapStore, type MapStorageAdapter } from "../editor/MapStore";
import type { MapData } from "../editor/MapData";

/** The account's maps, as the server keeps them. */
const remote = new Map<string, { map: unknown; updatedAt: number }>();
let clock = 1_000;
const downloads: string[] = [];

vi.mock("./PlayerAccount", async (original) => ({
  ...await original<typeof import("./PlayerAccount")>(),
  listAccountMaps: async () => [...remote].map(([slotId, entry]) => ({ slotId, name: "m", updatedAt: entry.updatedAt })),
  readAccountMap: async (_account: string, slotId: string) => { downloads.push(slotId); return remote.get(slotId); },
  writeAccountMap: async (_account: string, slotId: string, map: unknown) => {
    clock += 1;
    remote.set(slotId, { map: structuredClone(map), updatedAt: clock });
    return clock;
  },
  deleteAccountMap: async (_account: string, slotId: string) => { remote.delete(slotId); },
}));

const { AccountMaps } = await import("./AccountMaps");

class MemoryStorage implements MapStorageAdapter, Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}

const map = (name: string): MapData => ({
  version: 1, name, createdAt: 1, updatedAt: 1,
  environment: { ambient: "#000000", fog: "#000000", fogDensity: 0 },
  objects: [],
} as unknown as MapData);

const setup = (storage = new MemoryStorage()) => {
  const store = new MapStore(undefined, undefined, storage);
  return { storage, store, maps: new AccountMaps(store, storage as unknown as Storage) };
};

beforeEach(() => {
  remote.clear();
  downloads.length = 0;
});

describe("AccountMaps", () => {
  it("downloads the account's maps on sign-in and only again when they change", async () => {
    remote.set("slot-a", { map: map("Cozinha A"), updatedAt: 5 });
    const { storage, store, maps } = setup();
    expect(await maps.signIn("u1")).toEqual([]);
    expect(store.load("slot-a")?.name).toBe("Cozinha A");
    expect(downloads).toEqual(["slot-a"]);

    // The game opened again with the session still alive: nothing new, nothing downloaded.
    await setup(storage).maps.signIn("u1");
    expect(downloads).toEqual(["slot-a"]);

    remote.set("slot-a", { map: map("Cozinha A2"), updatedAt: 9 });
    await setup(storage).maps.signIn("u1");
    expect(store.load("slot-a")?.name).toBe("Cozinha A2");
  });

  it("removes the account's maps from the browser on sign-out, keeping maps never uploaded", async () => {
    remote.set("slot-a", { map: map("Da conta"), updatedAt: 5 });
    const { store, maps } = setup();
    store.save("slot-local", map("Só aqui"));
    expect(await maps.signIn("u1")).toEqual(["slot-local"]);
    maps.signOut();
    expect(store.exists("slot-a")).toBe(false);
    expect(store.exists("slot-local")).toBe(true);
  });

  it("uploads saves, deletes on the account and follows deletions made elsewhere", async () => {
    const { storage, store, maps } = setup();
    await maps.signIn("u1");
    store.save("slot-new", map("Nova"));
    await maps.upload("slot-new");
    expect(remote.has("slot-new")).toBe(true);

    // The upload is remembered: opening the game again does not download it back.
    await setup(storage).maps.signIn("u1");
    expect(downloads).toEqual([]);

    await maps.remove("slot-new");
    expect(remote.has("slot-new")).toBe(false);

    store.save("slot-b", map("B"));
    await maps.upload("slot-b");
    remote.delete("slot-b"); // deleted on another device
    maps.signOut();
    store.save("slot-b", map("B"));
    await maps.signIn("u1");
    expect(store.exists("slot-b")).toBe(false);
  });

  it("does nothing on the account while signed out", async () => {
    const { store, maps } = setup();
    store.save("slot-x", map("X"));
    await maps.upload("slot-x");
    await maps.remove("slot-x");
    expect(remote.size).toBe(0);
    expect(maps.signedIn).toBe(false);
  });
});
