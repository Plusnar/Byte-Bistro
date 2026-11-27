import { sanitizeMapData, type MapStore } from "../editor/MapStore";
import type { MapData } from "../editor/MapData";
import { AccountApiError, deleteAccountMap, listAccountMaps, readAccountMap, writeAccountMap } from "./PlayerAccount";

interface PendingMap {
  readonly slotId: string;
  readonly map: MapData | null;
  readonly expected: number | null;
  readonly recovery?: boolean;
}

export type MapSyncStatus = "synced" | "conflict" | "local" | "temporary" | "session" | "superseded";

export class AccountMaps {
  private userId: string | null = null;
  private generation = 0;
  private readonly tabId: string;
  private readonly pending = new Map<string, PendingMap>();
  private readonly queue = new Map<string, Promise<MapSyncStatus>>();
  onConflict?: (original: string, recovery: string) => void;
  private versions: Record<string, number> = {};

  constructor(private readonly store: MapStore, private readonly storage: Storage | null = safeStorage()) {
    this.tabId = store.generateSlotId();
  }

  private key(userId: string): string { return 'byte-bistro:account:' + userId + ':maps'; }
  private journal(userId: string): string { return this.key(userId) + ':pending:'; }

  private synced(userId: string): Record<string, number> {
    try {
      const value: unknown = JSON.parse(this.storage?.getItem(this.key(userId)) ?? "{}");
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([, time]) => typeof time === "number"));
    } catch { return {}; }
  }

  private baseKey(userId: string, slotId: string): string { return this.key(userId) + ':base:' + slotId; }

  private localWasSynced(userId: string, slotId: string, map: MapData): boolean {
    try {
      const base = this.storage?.getItem(this.baseKey(userId, slotId));
      return base === JSON.stringify([this.versions[slotId], map.updatedAt]);
    } catch { return false; }
  }

  private remember(userId: string, slotId: string, version: number | null, map?: MapData): void {
    const synced = this.synced(userId);
    if (version === null) {
      delete synced[slotId];
      delete this.versions[slotId];
    } else {
      synced[slotId] = version;
      this.versions[slotId] = version;
    }
    try {
      this.storage?.setItem(this.key(userId), JSON.stringify(synced));
      if (map) this.storage?.setItem(this.baseKey(userId, slotId), JSON.stringify([version, map.updatedAt]));
      else this.storage?.removeItem(this.baseKey(userId, slotId));
    } catch { /* Local copy stays available. */ }
  }

  private restorePending(userId: string): void {
    const prefix = this.journal(userId);
    try {
      for (let index = 0; this.storage && index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(prefix) || this.pending.has(key)) continue;
        let data: PendingMap | null;
        try { data = JSON.parse(this.storage.getItem(key) ?? "null") as PendingMap | null; }
        catch { continue; }
        if (!data || typeof data.slotId !== "string" ||
            (data.expected !== null && !Number.isSafeInteger(data.expected))) continue;
        const map = data.map === null ? null : sanitizeMapData(data.map);
        if (data.map !== null && !map) continue;
        this.pending.set(key, { ...data, map });
      }
    } catch { /* Keep the copies already restored. */ }
  }

  private persist(key: string, operation: PendingMap): boolean {
    this.pending.set(key, operation);
    try {
      this.storage?.setItem(key, JSON.stringify(operation));
      return this.storage !== null;
    } catch { return false; }
  }

  private forget(key: string): void {
    this.pending.delete(key);
    try { this.storage?.removeItem(key); } catch { /* A stale entry is recovered on next sign-in. */ }
  }

  get signedIn(): boolean { return this.userId !== null; }

  async signIn(userId: string, report: (status: MapSyncStatus) => void = () => {}): Promise<string[]> {
    if (this.userId !== userId) {
      this.signOut();
      this.userId = userId;
      this.versions = this.synced(userId);
    }
    const generation = this.generation;
    this.restorePending(userId);
    const prefix = this.journal(userId);
    const remote = await listAccountMaps(userId);
    if (generation !== this.generation) return [];
    const owned = new Set(remote.map(({ slotId }) => slotId));
    const waiting = new Set<string>();
    for (const [key, operation] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      owned.add(operation.slotId);
      waiting.add(operation.slotId);
      if (operation.map && !this.store.exists(operation.slotId)) this.store.save(operation.slotId, operation.map);
      if (!operation.recovery) this.enqueue(userId, key).then(report);
    }
    for (const entry of remote) {
      const slotId = entry.slotId;
      if (waiting.has(slotId) || this.queue.has(slotId)) continue;
      if (this.versions[slotId] === entry.updatedAt && this.store.exists(slotId)) continue;
      const response = await readAccountMap(userId, slotId).catch(() => null);
      if (generation !== this.generation) return [];
      if (this.queue.has(slotId) || waiting.has(slotId)) continue;
      const map = sanitizeMapData(response?.map);
      if (!map || !response) continue;
      const local = this.store.load(slotId);
      // A legacy browser slot without a recorded base might contain an unsent edit.
      if (local && !this.localWasSynced(userId, slotId, local) && JSON.stringify(local) !== JSON.stringify(map)) {
        if (!this.recover(userId, slotId, local)) { report("local"); continue; }
        report("conflict");
      }
      if (this.store.save(slotId, map)) this.remember(userId, slotId, response.updatedAt ?? entry.updatedAt, map);
    }
    for (const slotId of Object.keys(this.versions)) {
      if (owned.has(slotId) || this.queue.has(slotId)) continue;
      const local = this.store.load(slotId);
      if (local && !this.localWasSynced(userId, slotId, local)) {
        if (!this.recover(userId, slotId, local)) { report("local"); continue; }
        report("conflict");
      }
      if (this.store.delete(slotId)) this.remember(userId, slotId, null);
    }
    return this.store.list().map(({ slotId }) => slotId).filter(slotId => !owned.has(slotId) &&
      ![...this.pending].some(([key, operation]) => key.startsWith(prefix) && operation.slotId === slotId));
  }

  signOut(): void {
    const userId = this.userId;
    this.generation++;
    this.userId = null;
    this.queue.clear();
    if (!userId) return;
    const owned = new Set(Object.keys(this.versions));
    for (const [key, operation] of this.pending) {
      if (key.startsWith(this.journal(userId))) owned.add(operation.slotId);
    }
    for (const slotId of owned) this.store.delete(slotId);
    this.versions = {};
  }

  upload(slotId: string, map: MapData | null = this.store.load(slotId)): Promise<MapSyncStatus> {
    return map ? this.record(slotId, map) : Promise.resolve("local");
  }

  remove(slotId: string): Promise<MapSyncStatus> {
    return this.record(slotId, null);
  }

  private record(slotId: string, map: MapData | null): Promise<MapSyncStatus> {
    const userId = this.userId;
    if (!userId) return Promise.resolve("session");
    const key = this.journal(userId) + this.tabId + ':' + slotId;
    const earlier = this.pending.get(key);
    const operation = { slotId, map, expected: earlier ? earlier.expected : this.versions[slotId] ?? null };
    const persisted = this.persist(key, operation);
    for (const [otherKey, other] of this.pending) {
      if (persisted && otherKey !== key && otherKey.startsWith(this.journal(userId)) && other.slotId === slotId && other.recovery) {
        this.forget(otherKey);
      }
    }
    return this.enqueue(userId, key);
  }

  private enqueue(userId: string, key: string): Promise<MapSyncStatus> {
    const slotId = this.pending.get(key)!.slotId;
    const generation = this.generation;
    const previous = this.queue.get(slotId);
    const task = (previous ?? Promise.resolve("local")).then(async (status): Promise<MapSyncStatus> => {
      if (generation !== this.generation) return "superseded";
      const operation = this.pending.get(key);
      if (!operation) return status;
      try {
        let version: number | null = null;
        if (operation.map) version = await writeAccountMap(userId, slotId, operation.map, operation.expected);
        else if (operation.expected !== null) await deleteAccountMap(userId, slotId, operation.expected);
        else {
          // A deletion recorded before the first account fetch cannot erase an unseen version.
          const exists = await readAccountMap(userId, slotId).then(() => true, (error: unknown) => {
            if (error instanceof AccountApiError && error.status === 404) return false;
            throw error;
          });
          if (exists) throw new AccountApiError("conflict", 409);
        }
        if (generation !== this.generation) return "superseded";
        this.remember(userId, slotId, version, operation.map ?? undefined);
        const newer = this.pending.get(key);
        if (newer === operation) this.forget(key);
        else if (newer) this.persist(key, { ...newer, expected: version });
        return "synced";
      } catch (error) {
        if (generation !== this.generation) return "superseded";
        if (error instanceof AccountApiError && error.status === 401) return "session";
        if (error instanceof AccountApiError && error.code === "conflict") {
          const latest = this.pending.get(key);
          if (!latest) return "conflict";
          try {
            const response = await readAccountMap(userId, slotId).catch((cause: unknown) => {
              if (cause instanceof AccountApiError && cause.status === 404) return null;
              throw cause;
            });
            if (generation !== this.generation || this.pending.get(key) !== latest) return "conflict";
            const remote = sanitizeMapData(response?.map);
            const local = this.store.load(slotId);
            const differs = JSON.stringify(latest.map) !== JSON.stringify(remote);
            const otherLocalEdit = local && JSON.stringify(local) !== JSON.stringify(latest.map);
            if (latest.map && differs && !this.recover(userId, slotId, latest.map)) return "conflict";
            if (otherLocalEdit) {
              // Another tab owns the visible slot now. Recover this edit independently.
              this.forget(key);
              return "conflict";
            }
            if (remote ? !this.store.save(slotId, remote) : !this.store.delete(slotId)) return "conflict";
            this.remember(userId, slotId, response?.updatedAt ?? null, remote ?? undefined);
            this.forget(key);
            return differs ? "conflict" : "synced";
          } catch { return "conflict"; }
        }
        return this.store.isPersistent ? "local" : "temporary";
      }
    });
    this.queue.set(slotId, task);
    void task.then(() => { if (this.queue.get(slotId) === task) this.queue.delete(slotId); });
    return task;
  }

  private recover(userId: string, original: string, map: MapData): boolean {
    const slotId = this.store.generateSlotId();
    const key = this.journal(userId) + this.tabId + ':' + slotId;
    const copy = { ...map, name: (map.name.slice(0, 32) + ' (local)').trim(), updatedAt: Date.now() };
    if (!this.persist(key, { slotId, map: copy, expected: null, recovery: true }) || !this.store.save(slotId, copy)) {
      this.forget(key);
      return false;
    }
    this.onConflict?.(original, slotId);
    return true;
  }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}
