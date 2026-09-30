/**
 * The one place every model, texture and data file is downloaded from.
 *
 * Babylon binds an `AssetContainer` to a single scene, so the menu preview, the kitchen and
 * the editor each parse their own copy of a model — that part cannot be shared. The
 * download can. Before this existed, every scene fetched its own bytes: the six cooks and
 * both animation packs were downloaded twice at boot, and the KayKit texture atlas 35 times,
 * once per `.gltf` that references it.
 *
 * This cache owns the bytes, keyed by absolute URL, and a priority queue in front of the
 * network so the menu's assets never share bandwidth with gameplay assets it does not need
 * yet. It is Babylon-free and DOM-free, so it can be unit tested with a fake `fetch`.
 */

/**
 * - `critical`   — needed to show the current screen. Nothing else downloads while any is
 *                  pending, so the screen the player is looking at gets the whole pipe.
 * - `gameplay`   — needed to start the next match. Runs while the player is in the menu.
 * - `background` — nice to have (other cooks, other levels). Only starts when the queue is
 *                  otherwise empty and the browser reports idle time.
 */
export type AssetPriority = "critical" | "gameplay" | "background";

export type AssetState = "queued" | "loading" | "loaded" | "failed";

const RANK: Readonly<Record<AssetPriority, number>> = { critical: 0, gameplay: 1, background: 2 };

/** A download that receives nothing for this long is aborted and retried. */
const STALL_TIMEOUT_MS = 30_000;

export const higherPriority = (a: AssetPriority, b: AssetPriority): AssetPriority =>
  RANK[a] <= RANK[b] ? a : b;

export class AssetLoadError extends Error {
  constructor(
    readonly url: string,
    readonly status: number | null,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "AssetLoadError";
  }
}

interface Entry {
  readonly url: string;
  priority: AssetPriority;
  state: AssetState;
  readonly promise: Promise<ArrayBuffer>;
  readonly resolve: (buffer: ArrayBuffer) => void;
  readonly reject: (error: unknown) => void;
  /** Bytes received so far. */
  loaded: number;
  /** From Content-Length when the server sends it; null until the headers arrive. */
  total: number | null;
  attempts: number;
  sequence: number;
  buffer: ArrayBuffer | null;
  error: unknown;
  /** Backoff: a failed attempt is not retried before this timestamp. */
  retryAt: number;
}

export interface AssetProgress {
  /** 0..1, byte-weighted. Files whose size is not known yet count as an average file. */
  readonly fraction: number;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  readonly done: number;
  readonly failed: number;
  readonly count: number;
}

export interface AssetCacheOptions {
  readonly fetch?: typeof fetch;
  /** Parallel downloads. Browsers cap HTTP/1.1 at six per host anyway. */
  readonly concurrency?: number;
  /** Extra attempts after the first for network errors and 5xx responses. */
  readonly retries?: number;
  readonly retryDelayMs?: number;
  /** Runs `callback` when the main thread is idle; defaults to requestIdleCallback. */
  readonly whenIdle?: (callback: () => void) => void;
}

/** Size assumed for a file whose headers have not arrived yet, for progress weighting. */
const UNKNOWN_SIZE_GUESS = 256 * 1024;

const defaultWhenIdle = (callback: () => void): void => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (idle) idle(callback, { timeout: 1500 });
  else setTimeout(callback, 60);
};

export class AssetCache {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly whenIdle: (callback: () => void) => void;
  private active = 0;
  private sequence = 0;
  private idleScheduled = false;
  private notifyScheduled = false;

  constructor(options: AssetCacheOptions = {}) {
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.retries = Math.max(0, options.retries ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    this.whenIdle = options.whenIdle ?? defaultWhenIdle;
  }

  /**
   * Resolves with the file's bytes. Asking again for a URL that is already queued, loading or
   * loaded returns the same promise — a file is never downloaded twice. Asking with a higher
   * priority than before promotes it.
   */
  fetch(url: string, priority: AssetPriority = "gameplay"): Promise<ArrayBuffer> {
    const existing = this.entries.get(url);
    if (existing) {
      // A later request for a failed file is an explicit retry.
      if (existing.state === "failed") return this.requeue(existing, higherPriority(existing.priority, priority));
      this.promote(existing, priority);
      return existing.promise;
    }

    let resolve!: (buffer: ArrayBuffer) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ArrayBuffer>((res, rej) => { resolve = res; reject = rej; });
    // Callers that only prefetch never attach a handler; the failure is reported through
    // state() and the console instead of as an unhandled rejection.
    promise.catch(() => undefined);
    const entry: Entry = {
      url, priority, state: "queued", promise, resolve, reject,
      loaded: 0, total: null, attempts: 0, sequence: this.sequence++, buffer: null, error: null,
      retryAt: 0,
    };
    this.entries.set(url, entry);
    this.changed();
    this.pump();
    return promise;
  }

  /** Fire-and-forget download, for warming the cache ahead of need. */
  prefetch(url: string, priority: AssetPriority = "background"): void {
    void this.fetch(url, priority).catch(() => undefined);
  }

  /** Raises every queued or loading entry at `from` or below to `to`. */
  promoteAll(from: AssetPriority, to: AssetPriority): void {
    let moved = false;
    for (const entry of this.entries.values()) {
      if ((entry.state === "queued" || entry.state === "loading")
        && RANK[entry.priority] >= RANK[from] && RANK[to] < RANK[entry.priority]) {
        entry.priority = to;
        moved = true;
      }
    }
    if (moved) { this.changed(); this.pump(); }
  }

  state(url: string): AssetState | "unknown" {
    return this.entries.get(url)?.state ?? "unknown";
  }

  isLoaded(url: string): boolean {
    return this.entries.get(url)?.state === "loaded";
  }

  /** The bytes, when already downloaded. */
  get(url: string): ArrayBuffer | undefined {
    return this.entries.get(url)?.buffer ?? undefined;
  }

  errorOf(url: string): unknown {
    return this.entries.get(url)?.error;
  }

  /** Every URL that is known to the cache, with its state. For the debug overlay and tests. */
  snapshot(): { url: string; state: AssetState; priority: AssetPriority; loaded: number; total: number | null }[] {
    return [...this.entries.values()].map(({ url, state, priority, loaded, total }) =>
      ({ url, state, priority, loaded, total }));
  }

  /**
   * Byte-weighted progress over a set of URLs, or over every entry matching `filter`.
   *
   * URLs never requested count as zero bytes of an average-sized file, so a tracker that is
   * set up before its downloads start does not jump straight to 100%.
   */
  progress(urls?: readonly string[] | ((url: string, priority: AssetPriority) => boolean)): AssetProgress {
    const selected: (Entry | null)[] = Array.isArray(urls)
      ? urls.map((url) => this.entries.get(url) ?? null)
      : [...this.entries.values()].filter((entry) =>
        typeof urls === "function" ? urls(entry.url, entry.priority) : true);
    const known = selected.filter((entry): entry is Entry => entry !== null && entry.total !== null);
    const average = known.length
      ? known.reduce((sum, entry) => sum + (entry.total ?? 0), 0) / known.length
      : UNKNOWN_SIZE_GUESS;
    let loadedBytes = 0;
    let totalBytes = 0;
    let done = 0;
    let failed = 0;
    for (const entry of selected) {
      if (!entry) { totalBytes += average; continue; }
      const size = entry.state === "loaded"
        ? Math.max(entry.loaded, 1)
        : Math.max(entry.total ?? average, entry.loaded);
      totalBytes += size;
      if (entry.state === "loaded") { loadedBytes += size; done += 1; }
      else if (entry.state === "failed") { loadedBytes += size; failed += 1; }
      else loadedBytes += Math.min(entry.loaded, size);
    }
    return {
      fraction: totalBytes > 0 ? Math.min(1, loadedBytes / totalBytes) : 1,
      loadedBytes,
      totalBytes,
      done,
      failed,
      count: selected.length,
    };
  }

  /** Re-queues every failed download. */
  retryFailed(): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.state === "failed") void this.requeue(entry, entry.priority).catch(() => undefined);
    }
  }

  /**
   * Drops the bytes of downloads nobody needs any more. The next `fetch` downloads again;
   * containers already parsed from them are unaffected.
   */
  release(predicate: (url: string) => boolean): number {
    let released = 0;
    for (const [url, entry] of this.entries) {
      if (entry.state !== "loaded" || !predicate(url)) continue;
      this.entries.delete(url);
      released += entry.loaded;
    }
    if (released) this.changed();
    return released;
  }

  /** Called at most once per microtask burst whenever any state or progress changes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------------------------------

  private promote(entry: Entry, priority: AssetPriority): void {
    if (RANK[priority] >= RANK[entry.priority]) return;
    entry.priority = priority;
    this.changed();
    this.pump();
  }

  private requeue(entry: Entry, priority: AssetPriority): Promise<ArrayBuffer> {
    // The original promise was already rejected and cannot settle again. Replace the entry,
    // so new callers get a fresh promise while earlier callers keep their rejection.
    this.entries.delete(entry.url);
    return this.fetch(entry.url, priority);
  }

  private hasPendingAt(priority: AssetPriority): boolean {
    for (const entry of this.entries.values()) {
      if (entry.priority === priority && (entry.state === "queued" || entry.state === "loading")) {
        return true;
      }
    }
    return false;
  }

  /** The next entry allowed to start, honouring the gating between tiers. */
  private next(): Entry | null {
    const criticalPending = this.hasPendingAt("critical");
    const gameplayPending = criticalPending || this.hasPendingAt("gameplay");
    let best: Entry | null = null;
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.state !== "queued" || entry.retryAt > now) continue;
      // Critical assets get the whole pipe: a gameplay file started now would split the
      // bandwidth with the screen the player is actually waiting on.
      if (entry.priority === "gameplay" && criticalPending) continue;
      if (entry.priority === "background" && gameplayPending) continue;
      if (!best || RANK[entry.priority] < RANK[best.priority]
        || (entry.priority === best.priority && entry.sequence < best.sequence)) {
        best = entry;
      }
    }
    return best;
  }

  private pump(): void {
    while (this.active < this.concurrency) {
      const entry = this.next();
      if (!entry) return;
      if (entry.priority === "background") {
        // Background work waits for an idle slice so it never costs a menu frame.
        if (!this.idleScheduled) {
          this.idleScheduled = true;
          this.whenIdle(() => {
            this.idleScheduled = false;
            const candidate = this.next();
            if (candidate && candidate.priority === "background" && this.active < this.concurrency) {
              void this.start(candidate);
            }
            this.pump();
          });
        }
        return;
      }
      void this.start(entry);
    }
  }

  private async start(entry: Entry): Promise<void> {
    entry.state = "loading";
    entry.attempts += 1;
    this.active += 1;
    this.changed();
    try {
      const buffer = await this.download(entry);
      entry.buffer = buffer;
      entry.loaded = buffer.byteLength;
      entry.total = Math.max(entry.total ?? 0, buffer.byteLength);
      entry.state = "loaded";
      entry.resolve(buffer);
    } catch (error: unknown) {
      const retryable = !(error instanceof AssetLoadError) || error.retryable;
      if (retryable && entry.attempts <= this.retries) {
        const delay = this.retryDelayMs * entry.attempts;
        console.warn(`[assets] Tentativa ${entry.attempts} falhou, repetindo em ${delay} ms: ${entry.url}`);
        entry.state = "queued";
        entry.loaded = 0;
        entry.retryAt = Date.now() + delay;
        this.active -= 1;
        this.changed();
        setTimeout(() => this.pump(), delay);
        this.pump();
        return;
      }
      entry.state = "failed";
      entry.error = error;
      console.error(`[assets] Falha ao carregar ${entry.url}`, error);
      entry.reject(error);
    }
    this.active -= 1;
    this.changed();
    this.pump();
  }

  private async download(entry: Entry): Promise<ArrayBuffer> {
    // A connection that stalls half-way never errors on its own: it would hold its download
    // slot and keep the match loader up forever. Abort after a stretch with no bytes at all —
    // not a total-time limit, so a large file on a slow line still gets through.
    const controller = new AbortController();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStallTimer = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
    };
    armStallTimer();
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(entry.url, { signal: controller.signal });
      } catch (error: unknown) {
        throw new AssetLoadError(entry.url, null, true, controller.signal.aborted
          ? `Sem resposta por ${STALL_TIMEOUT_MS / 1_000} s`
          : `Rede indisponível: ${String(error)}`);
      }
      if (!response.ok) {
        // 404 will not fix itself; 5xx and 429 might.
        const retryable = response.status >= 500 || response.status === 429;
        throw new AssetLoadError(entry.url, response.status, retryable, `HTTP ${response.status}`);
      }
      const header = Number(response.headers.get("content-length"));
      entry.total = Number.isFinite(header) && header > 0 ? header : null;
      const body = response.body;
      if (!body) return await response.arrayBuffer();

      // Stream it, so progress moves during a large file instead of jumping at the end.
      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error: unknown) {
          throw new AssetLoadError(entry.url, null, true, controller.signal.aborted
            ? `Download parado por ${STALL_TIMEOUT_MS / 1_000} s`
            : `Download interrompido: ${String(error)}`);
        }
        const { done, value } = chunk;
        if (done) break;
        armStallTimer();
        chunks.push(value);
        received += value.byteLength;
        entry.loaded = received;
        // A gzip-encoded response reports its compressed length; never let loaded pass total.
        if (entry.total !== null && received > entry.total) entry.total = received;
        this.changed();
      }
      const joined = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      return joined.buffer;
    } finally {
      clearTimeout(stallTimer);
    }
  }

  private changed(): void {
    if (this.notifyScheduled || this.listeners.size === 0) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }
}

/** The game's single cache. Scenes share it; see the class comment for why. */
export const assetCache = new AssetCache();

/** Resolves a possibly relative URL against the page, so every key in the cache is absolute. */
export const absoluteUrl = (url: string, base?: string): string => {
  const pageBase = typeof document !== "undefined" ? document.baseURI : "http://localhost/";
  return new URL(url, base ? new URL(base, pageBase) : pageBase).href;
};
