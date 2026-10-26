import type { PersistentBytes } from "./AssetCache";

/**
 * Keeps downloaded models across sessions, in the browser's Cache Storage.
 *
 * Only content-addressed files are ever offered to it (a Vite hash in the name, or a
 * `?v=<hash>` from the build's asset manifest), so an entry is valid for as long as it
 * exists: a new version of a file has a new key, and the old one simply stops being asked
 * for and ages out. That is the whole update story — no version numbers to compare, no way
 * to mix files from two builds.
 *
 * Bounded and disposable by design:
 *   - a byte budget (default 160 MB, or a fifth of the origin's quota if smaller), least
 *     recently used first out; entries unused for 30 days go too;
 *   - tiny files (under 1 kB) are left to the HTTP cache, huge ones are not stored. The
 *     kitchen is dozens of 5–15 kB pieces: keeping them makes a return visit request-free;
 *   - every failure (no Cache API, quota, private mode, an evicted or truncated entry) falls
 *     back to the network. The browser may wipe the store at any time and the game only
 *     notices as a download.
 *
 * The index (sizes, last use) lives in localStorage: reading it costs nothing at startup,
 * and an index that disagrees with the cache is corrected on the next read.
 */
interface IndexEntry {
  readonly bytes: number;
  lastUsed: number;
}

export interface PersistentAssetStoreOptions {
  readonly cacheName?: string;
  readonly maxBytes?: number;
  readonly maxAgeMs?: number;
  /** Files smaller than this are left to the HTTP cache. */
  readonly minEntryBytes?: number;
  readonly maxEntryBytes?: number;
  readonly caches?: CacheStorage | null;
  readonly indexStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly now?: () => number;
  readonly whenIdle?: (callback: () => void) => void;
}

const INDEX_KEY = "byte-bistro:asset-store";
const DAY_MS = 24 * 60 * 60 * 1000;

export class PersistentAssetStore implements PersistentBytes {
  readonly cacheName: string;
  private maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly minEntryBytes: number;
  private readonly maxEntryBytes: number;
  private readonly caches: CacheStorage | null;
  private readonly indexStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  private readonly now: () => number;
  private readonly whenIdle: (callback: () => void) => void;
  private index: Record<string, IndexEntry>;
  private cache: Promise<Cache | null> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private hits = 0;
  private misses = 0;

  constructor(options: PersistentAssetStoreOptions = {}) {
    this.cacheName = options.cacheName ?? "bb-assets-v1";
    this.maxBytes = options.maxBytes ?? 160 * 1024 * 1024;
    this.maxAgeMs = options.maxAgeMs ?? 30 * DAY_MS;
    this.minEntryBytes = options.minEntryBytes ?? 1024;
    this.maxEntryBytes = options.maxEntryBytes ?? 32 * 1024 * 1024;
    this.caches = options.caches === undefined
      ? (typeof caches === "undefined" ? null : caches)
      : options.caches;
    this.indexStorage = options.indexStorage === undefined ? safeLocalStorage() : options.indexStorage;
    this.now = options.now ?? (() => Date.now());
    this.whenIdle = options.whenIdle ?? defaultWhenIdle;
    this.index = this.readIndex();
  }

  get available(): boolean {
    return this.caches !== null;
  }

  /** Never more than a fifth of what the browser grants this origin. */
  async fitToQuota(): Promise<void> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota) this.maxBytes = Math.min(this.maxBytes, Math.floor(estimate.quota / 5));
    } catch {
      // No estimate: keep the configured budget.
    }
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const meta = this.index[key];
    if (!meta) { this.misses += 1; return null; }
    try {
      const cache = await this.open();
      const response = await cache?.match(key);
      if (!response) {
        // The browser evicted it behind our back.
        this.forget(key);
        this.misses += 1;
        return null;
      }
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== meta.bytes) {
        // Truncated or replaced: never hand out a file we cannot vouch for.
        void cache?.delete(key);
        this.forget(key);
        this.misses += 1;
        return null;
      }
      meta.lastUsed = this.now();
      this.saveIndex();
      this.hits += 1;
      return bytes;
    } catch {
      this.misses += 1;
      return null;
    }
  }

  /** Stores a copy in idle time; never blocks or fails the caller. */
  put(key: string, bytes: ArrayBuffer): void {
    if (!this.caches || this.index[key]) return;
    const size = bytes.byteLength;
    if (size < this.minEntryBytes || size > this.maxEntryBytes || size > this.maxBytes) return;
    const copy = bytes.slice(0);
    this.whenIdle(() => {
      this.writes = this.writes.then(async () => {
        try {
          const cache = await this.open();
          if (!cache) return;
          await this.makeRoom(cache, size);
          await cache.put(key, new Response(copy, { headers: { "content-type": "application/octet-stream" } }));
          this.index[key] = { bytes: size, lastUsed: this.now() };
          this.saveIndex();
        } catch {
          // Quota or private mode: this file stays network-only.
        }
      });
    });
  }

  /** Expired entries, entries over budget and orphans out; run once per session, idle. */
  async prune(): Promise<void> {
    try {
      const cache = await this.open();
      if (!cache) return;
      const cutoff = this.now() - this.maxAgeMs;
      for (const [key, meta] of Object.entries(this.index)) {
        if (meta.lastUsed < cutoff) { await cache.delete(key); delete this.index[key]; }
      }
      await this.makeRoom(cache, 0);
      // Cache entries the index does not know (an index lost with localStorage).
      for (const request of await cache.keys()) {
        if (!this.index[request.url]) await cache.delete(request);
      }
      this.saveIndex();
    } catch {
      // Best effort.
    }
  }

  /** Deletes everything this store owns. */
  async clear(): Promise<void> {
    this.index = {};
    this.saveIndex();
    try { await this.caches?.delete(this.cacheName); } catch { /* nothing to clear */ }
    this.cache = null;
  }

  stats(): { entries: number; bytes: number; maxBytes: number; hits: number; misses: number; available: boolean } {
    const entries = Object.values(this.index);
    return {
      entries: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      available: this.available,
    };
  }

  /** Settles once pending writes are done (tests, benchmarks). */
  flush(): Promise<void> {
    return this.writes;
  }

  // ---------------------------------------------------------------------------------------

  private open(): Promise<Cache | null> {
    if (!this.caches) return Promise.resolve(null);
    this.cache ??= this.caches.open(this.cacheName).catch(() => null);
    return this.cache;
  }

  private async makeRoom(cache: Cache, incoming: number): Promise<void> {
    let total = Object.values(this.index).reduce((sum, entry) => sum + entry.bytes, 0);
    if (total + incoming <= this.maxBytes) return;
    const oldestFirst = Object.entries(this.index).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, meta] of oldestFirst) {
      if (total + incoming <= this.maxBytes) break;
      await cache.delete(key);
      delete this.index[key];
      total -= meta.bytes;
    }
  }

  private forget(key: string): void {
    delete this.index[key];
    this.saveIndex();
  }

  private readIndex(): Record<string, IndexEntry> {
    try {
      const raw = this.indexStorage?.getItem(INDEX_KEY);
      const parsed = raw ? JSON.parse(raw) as unknown : null;
      if (!parsed || typeof parsed !== "object") return {};
      const index: Record<string, IndexEntry> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<IndexEntry>;
        if (typeof entry?.bytes === "number" && typeof entry.lastUsed === "number") index[key] = { bytes: entry.bytes, lastUsed: entry.lastUsed };
      }
      return index;
    } catch {
      return {};
    }
  }

  private saveIndex(): void {
    try {
      this.indexStorage?.setItem(INDEX_KEY, JSON.stringify(this.index));
    } catch {
      // Storage full: the cache still works this session; the next one re-learns it.
    }
  }
}

const safeLocalStorage = (): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const defaultWhenIdle = (callback: () => void): void => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (idle) idle(callback, { timeout: 4000 });
  else setTimeout(callback, 200);
};
