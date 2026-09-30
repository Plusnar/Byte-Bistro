import "@babylonjs/loaders/glTF";
import { absoluteUrl, assetCache, type AssetPriority } from "./assets/AssetCache";
import { mainThreadQueue } from "./assets/MainThreadQueue";
import { gltfJsonToGlb, prefetchGltfDependencies, registerCachedGltfUris } from "./assets/cachedGltfUris";
import {
  AssetContainer,
  LoadAssetContainerAsync,
  Node,
  Scene,
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
    if (!container) {
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

    return {
      rootNodes: entries.rootNodes,
      animationGroups: entries.animationGroups,
      skeletons: entries.skeletons,
      dispose: () => {
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

  dispose(): void {
    for (const containerPromise of this.containers.values()) {
      void containerPromise.then((container) => container?.dispose());
    }
    this.containers.clear();
    this.loaded.clear();
    this.definitions.clear();
  }

  private loadContainer(id: string): Promise<AssetContainer | null> {
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
    const pending = (async (): Promise<AssetContainer> => {
      const bytes = await assetCache.fetch(url, priority);
      // Fetch what a .gltf points at before parsing, so the parse never waits on the network
      // while it holds the main-thread queue.
      if (isGltf) await prefetchGltfDependencies(bytes, url, priority);
      // Babylon only parses binary glTF from memory, so a .gltf is wrapped as a GLB first.
      const source = isGltf ? gltfJsonToGlb(bytes) : new Uint8Array(bytes);
      return mainThreadQueue.run(() => LoadAssetContainerAsync(source, this.scene, {
        rootUrl: url.slice(0, url.lastIndexOf("/") + 1),
        pluginExtension: ".glb",
        name: url.slice(url.lastIndexOf("/") + 1),
      }), priority);
    })()
      .then((container) => {
        this.loaded.set(id, container);
        return container;
      })
      .catch((error: unknown) => {
        this.containers.delete(id);
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
