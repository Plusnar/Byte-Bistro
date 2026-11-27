import "@babylonjs/loaders/glTF";
import { absoluteUrl, assetCache, type AssetPriority } from "./assets/AssetCache";
import { mainThreadQueue } from "./assets/MainThreadQueue";
import { gltfJsonToGlb, prefetchGltfDependencies, registerCachedGltfUris } from "./assets/cachedGltfUris";
import {
  AssetContainer,
  LoadAssetContainerAsync,
  Node,
  Scene,
  Texture,
  type AnimationGroup,
  type Skeleton,
} from "@babylonjs/core";

export interface ModelAssetDefinition {
  id: string;
  url: string;
  required?: boolean;
  /** Download tier; see `AssetPriority`. Defaults to `gameplay`. */
  priority?: AssetPriority;
  /**
   * Skipped by `preloadAll`: loaded only when something actually instantiates it — the four
   * cooks nobody picked, the animation pack only some robots use.
   */
  lazy?: boolean;
}

export interface ModelInstantiationOptions {
  namePrefix?: string;
  parent?: Node | null;
  cloneMaterials?: boolean;
}

export interface ModelInstance {
  readonly rootNodes: readonly Node[];
  readonly animationGroups: readonly AnimationGroup[];
  readonly skeletons: readonly Skeleton[];
  dispose(): void;
}

/**
 * Per-scene model registry and parser.
 *
 * Babylon binds an AssetContainer to one scene, so each scene keeps its own parsed copy. The
 * bytes, however, come from the shared `assetCache`: a model used by both the menu preview
 * and the kitchen is downloaded once. Parsing goes through `mainThreadQueue`, one file per
 * frame, so a burst of arrivals cannot freeze the page.
 *
 * Empty manifests are valid, so placeholder-only builds do not perform requests or fail
 * while final art is unavailable.
 */
export class AssetManager {
  private readonly definitions = new Map<string, ModelAssetDefinition>();
  private readonly containers = new Map<string, Promise<AssetContainer | null>>();
  private readonly loaded = new Map<string, AssetContainer>();
  /**
   * Live instances per model. A container's meshes, materials and textures are shared by
   * every instance made from it, so it may only be released when this reaches zero.
   */
  private readonly liveInstances = new Map<string, number>();

  private disposed = false;

  constructor(
    private readonly scene: Scene,
    definitions: readonly ModelAssetDefinition[] = [],
  ) {
    for (const definition of definitions) {
      this.registerModel(definition);
    }
  }

  registerModel(definition: ModelAssetDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`Model asset already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, { ...definition });
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  isLoaded(id: string): boolean {
    return this.containers.has(id);
  }

  async preload(id: string): Promise<boolean> {
    return (await this.loadContainer(id)) !== null;
  }

  /** Loads every non-lazy model. Lazy ones wait until something instantiates them. */
  async preloadAll(): Promise<void> {
    await Promise.all(
      [...this.definitions.values()]
        .filter((definition) => !definition.lazy)
        .map((definition) => this.preload(definition.id)),
    );
  }

  /** The absolute URLs `preloadAll` would fetch, for progress tracking. */
  eagerUrls(): string[] {
    return [...this.definitions.values()]
      .filter((definition) => !definition.lazy)
      .map((definition) => absoluteUrl(definition.url));
  }

  urlOf(id: string): string | null {
    const definition = this.definitions.get(id);
    return definition ? absoluteUrl(definition.url) : null;
  }

  /**
   * Raises a model's download tier — e.g. the player just picked a cook the menu has not
   * shown yet, so it goes from background to critical.
   */
  prioritize(id: string, priority: AssetPriority): void {
    const url = this.urlOf(id);
    if (url) assetCache.prefetch(url, priority);
  }

  async instantiateModel(
    id: string,
    options: ModelInstantiationOptions = {},
  ): Promise<ModelInstance | null> {
    const container = await this.loadContainer(id);
    if (!container || this.disposed || this.scene.isDisposed) {
      return null;
    }
    return this.instantiateFrom(container, id, options);
  }

  /**
   * Synchronous variant for models that were already preloaded; returns null
   * (and starts loading) otherwise. Used by per-frame item visuals.
   */
  instantiateLoaded(
    id: string,
    options: ModelInstantiationOptions = {},
  ): ModelInstance | null {
    const container = this.loaded.get(id);
    if (!container) {
      void this.loadContainer(id).catch(() => undefined);
      return null;
    }
    return this.instantiateFrom(container, id, options);
  }

  private instantiateFrom(
    container: AssetContainer,
    id: string,
    options: ModelInstantiationOptions,
  ): ModelInstance {
    const prefix = options.namePrefix ?? `${id}-`;
    const entries = container.instantiateModelsToScene(
      (sourceName) => `${prefix}${sourceName}`,
      options.cloneMaterials ?? false,
    );

    if (options.parent !== undefined) {
      for (const node of entries.rootNodes) {
        node.parent = options.parent;
      }
    }

    this.liveInstances.set(id, (this.liveInstances.get(id) ?? 0) + 1);
    let disposed = false;
    return {
      rootNodes: entries.rootNodes,
      animationGroups: entries.animationGroups,
      skeletons: entries.skeletons,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.liveInstances.set(id, Math.max(0, (this.liveInstances.get(id) ?? 1) - 1));
        for (const animationGroup of entries.animationGroups) {
          animationGroup.dispose();
        }
        for (const rootNode of entries.rootNodes) {
          rootNode.dispose(false, false);
        }
        for (const skeleton of entries.skeletons) {
          skeleton.dispose();
        }
      },
    };
  }

  /**
   * A texture whose image comes through the shared cache (one download, priorities,
   * retries, the persistent store) instead of Babylon's own request. Returned at once and
   * filled in when the bytes arrive; a material using it waits for it, as it would for a
   * texture loading from a URL.
   */
  createTexture(url: string, options: { hasAlpha?: boolean; priority?: AssetPriority } = {}): Texture {
    const absolute = absoluteUrl(url);
    const texture = new Texture(null, this.scene);
    texture.name = absolute.slice(absolute.lastIndexOf("/") + 1);
    if (options.hasAlpha) texture.hasAlpha = true;
    let disposed = false;
    texture.onDisposeObservable.addOnce(() => { disposed = true; });
    void assetCache.fetch(absolute, options.priority ?? "gameplay")
      .then((bytes) => { if (!disposed) texture.updateURL(absolute, new Uint8Array(bytes)); })
      .catch((error: unknown) => console.warn(`Texture could not be loaded: ${absolute}`, error));
    return texture;
  }

  /**
   * Frees the parsed copies (geometry, materials, textures on the GPU) of models with no
   * live instance left, among those `filter` accepts. The downloaded bytes stay in the
   * shared cache, so using one again re-parses without a download. Returns how many went.
   */
  releaseUnused(filter: (id: string) => boolean = () => true): number {
    let released = 0;
    for (const [id, container] of this.loaded) {
      if ((this.liveInstances.get(id) ?? 0) > 0 || !filter(id)) continue;
      container.dispose();
      this.loaded.delete(id);
      this.containers.delete(id);
      this.liveInstances.delete(id);
      released += 1;
    }
    return released;
  }

  /** Parsed models and their live instances, for the perf report and leak tests. */
  stats(): { containers: number; liveInstances: number; pending: number } {
    let live = 0;
    for (const count of this.liveInstances.values()) live += count;
    return { containers: this.loaded.size, liveInstances: live, pending: this.containers.size - this.loaded.size };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const container of this.loaded.values()) container.dispose();
    this.containers.clear();
    this.loaded.clear();
    this.liveInstances.clear();
    this.definitions.clear();
  }

  private loadContainer(id: string): Promise<AssetContainer | null> {
    if (this.disposed || this.scene.isDisposed) return Promise.resolve(null);
    const cached = this.containers.get(id);
    if (cached) {
      return cached;
    }

    const definition = this.definitions.get(id);
    if (!definition) {
      return Promise.resolve(null);
    }

    registerCachedGltfUris();
    const url = absoluteUrl(definition.url);
    const priority = definition.priority ?? "gameplay";
    const isGltf = /\.gltf(?:[?#]|$)/i.test(url);
    const pending = (async (): Promise<AssetContainer | null> => {
      const bytes = await assetCache.fetch(url, priority);
      if (this.disposed || this.scene.isDisposed) return null;
      // Fetch what a .gltf points at before parsing, so the parse never waits on the network
      // while it holds the main-thread queue.
      if (isGltf) await prefetchGltfDependencies(bytes, url, priority);
      // Babylon only parses binary glTF from memory, so a .gltf is wrapped as a GLB first.
      const source = isGltf ? gltfJsonToGlb(bytes) : new Uint8Array(bytes);
      return mainThreadQueue.run(() => this.disposed || this.scene.isDisposed
        ? Promise.resolve(null)
        : LoadAssetContainerAsync(source, this.scene, {
        rootUrl: url.slice(0, url.lastIndexOf("/") + 1),
        pluginExtension: ".glb",
        name: url.slice(url.lastIndexOf("/") + 1),
      }), priority);
    })()
      .then((container) => {
        if (!container || this.disposed || this.scene.isDisposed) {
          container?.dispose();
          return null;
        }
        // The glTF loader starts each file's first clip on load. In a container that clip
        // animates the template, which is never on screen — instances get their own
        // groups — yet it was evaluated every frame: ~320 bone animations in the kitchen
        // (Death_A, Running, ...) for nothing.
        for (const group of container.animationGroups) group.stop();
        this.loaded.set(id, container);
        return container;
      })
      .catch((error: unknown) => {
        this.containers.delete(id);
        if (this.disposed || this.scene.isDisposed) return null;
        if (definition.required) {
          throw error;
        }
        console.warn(`Optional model could not be loaded: ${definition.url}`, error);
        return null;
      });

    this.containers.set(id, pending);
    return pending;
  }
}
