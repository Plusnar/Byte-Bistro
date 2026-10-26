import type { Scene } from "@babylonjs/core";
import { AssetManager, type ModelAssetDefinition } from "../AssetManager";
import { absoluteUrl, assetCache, type AssetCache, type AssetPriority, type AssetProgress } from "./AssetCache";
import { mainThreadQueue, type MainThreadQueue } from "./MainThreadQueue";
import { createNetworkResolver, fetchAssetManifest } from "./distribution";
import { PersistentAssetStore } from "./PersistentAssetStore";
import "./assetRegistry";

/**
 * The one way the game loads assets. Every scene's models, every prefetch and every
 * group of files goes through here; `npm run check:perf` fails the build on any loader
 * call outside src/core/assets and src/core/AssetManager.ts.
 *
 * The life of an asset, and who owns each step:
 *
 *   request ── AssetStreamingManager (groups, priorities, pins, cancellation)
 *   download ─ AssetCache: one download per URL, priority tiers (critical > gameplay >
 *              background), parallelism cap, retry with backoff, stall timeout,
 *              cancellation, an LRU byte budget; below it the PersistentAssetStore (files
 *              kept across sessions) and the distribution resolver (CDN origin, version)
 *   decode ─── MainThreadQueue: one parse per frame, most urgent first, so arrivals
 *              never stack into a freeze
 *   instance ─ AssetManager (one per Babylon scene: a container belongs to one scene):
 *              shared containers, instances counted per model
 *   release ── AssetManager.releaseUnused frees GPU copies with no instance left;
 *              the byte budget frees memory; pinned groups are exempt from both
 *
 * Babylon's AssetContainer is the unit of sharing: instantiating from it never re-parses,
 * and instances share geometry, materials and textures.
 */
export interface AssetGroupStatus {
  readonly name: string;
  readonly urls: readonly string[];
  readonly progress: AssetProgress;
  readonly pinned: boolean;
}

export class AssetStreamingManager {
  private readonly sceneAssets = new Set<AssetManager>();
  private readonly groups = new Map<string, readonly string[]>();
  private readonly pins = new Map<string, () => void>();
  readonly persistent: PersistentAssetStore | null;

  constructor(
    readonly bytes: AssetCache = assetCache,
    readonly decoder: MainThreadQueue = mainThreadQueue,
    options: { persistent?: PersistentAssetStore | null } = {},
  ) {
    this.persistent = options.persistent ?? null;
  }

  /**
   * The asset manager for a Babylon scene. It is tracked for reporting and released with
   * the scene; the scene's owner still calls `dispose()` on it as before.
   */
  createSceneAssets(scene: Scene, definitions: readonly ModelAssetDefinition[] = []): AssetManager {
    const assets = new AssetManager(scene, definitions);
    this.sceneAssets.add(assets);
    scene.onDisposeObservable.addOnce(() => this.sceneAssets.delete(assets));
    return assets;
  }

  /**
   * Names a set of files that are needed together (the menu, a level, the editor), so
   * they can be preloaded, tracked and kept as one. Relative URLs are made absolute.
   */
  defineGroup(name: string, urls: Iterable<string>): void {
    this.groups.set(name, [...new Set([...urls].map((url) => absoluteUrl(url)))]);
  }

  /**
   * Starts downloading a group ahead of need — the next level while the players are still
   * choosing cooks. With a signal, abandoning the transition cancels whatever has not
   * started yet.
   */
  preloadGroup(name: string, priority: AssetPriority = "background", signal?: AbortSignal): void {
    for (const url of this.groups.get(name) ?? []) this.bytes.prefetch(url, priority, signal);
  }

  /** Keeps a group's bytes in memory (exempt from the byte budget) until unpinned. */
  pinGroup(name: string): void {
    if (this.pins.has(name)) return;
    this.pins.set(name, this.bytes.pin(this.groups.get(name) ?? []));
  }

  unpinGroup(name: string): void {
    this.pins.get(name)?.();
    this.pins.delete(name);
  }

  groupStatus(name: string): AssetGroupStatus | null {
    const urls = this.groups.get(name);
    if (!urls) return null;
    return { name, urls, progress: this.bytes.progress(urls), pinned: this.pins.has(name) };
  }

  /** Frees GPU copies of every model no scene is showing; returns how many went. */
  releaseUnusedModels(filter?: (id: string) => boolean): number {
    let released = 0;
    for (const assets of this.sceneAssets) released += assets.releaseUnused(filter);
    return released;
  }

  /** Everything the perf overlay and the leak tests look at. */
  snapshot(): {
    scenes: number;
    containers: number;
    liveInstances: number;
    pendingParses: number;
    bytes: ReturnType<AssetCache["stats"]>;
    persistent: ReturnType<PersistentAssetStore["stats"]> | null;
    groups: { name: string; fraction: number; pinned: boolean }[];
  } {
    let containers = 0;
    let liveInstances = 0;
    for (const assets of this.sceneAssets) {
      const stats = assets.stats();
      containers += stats.containers;
      liveInstances += stats.liveInstances;
    }
    return {
      scenes: this.sceneAssets.size,
      containers,
      liveInstances,
      pendingParses: this.decoder.pending,
      bytes: this.bytes.stats(),
      persistent: this.persistent?.stats() ?? null,
      groups: [...this.groups.keys()].map((name) => ({
        name,
        fraction: this.bytes.progress(this.groups.get(name)).fraction,
        pinned: this.pins.has(name),
      })),
    };
  }
}

/**
 * Installs persistence and distribution on the shared byte cache. `?cache=off` in the URL
 * leaves the persistent store out (troubleshooting, and the benchmark's cold runs).
 */
const createDefault = (): AssetStreamingManager => {
  if (typeof window === "undefined") return new AssetStreamingManager();
  const params = new URLSearchParams(window.location.search);
  const baseUrl = import.meta.env.BASE_URL;
  assetCache.setNetworkResolver(createNetworkResolver({
    baseUrl,
    pageOrigin: window.location.origin,
    assetOrigin: (import.meta.env.VITE_ASSET_ORIGIN as string | undefined) || null,
    loadManifest: () => (import.meta.env.DEV ? Promise.resolve(null) : fetchAssetManifest(baseUrl)),
  }));
  const persistent = params.get("cache") === "off" || import.meta.env.DEV
    ? null
    : new PersistentAssetStore();
  if (persistent?.available) {
    assetCache.setPersistentStore(persistent);
    // Housekeeping off the boot path.
    setTimeout(() => { void persistent.fitToQuota().then(() => persistent.prune()); }, 15_000);
  }
  return new AssetStreamingManager(assetCache, mainThreadQueue, { persistent });
};

/** The game's single streaming manager. */
export const assetStreaming = createDefault();
