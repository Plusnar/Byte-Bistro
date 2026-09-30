import "@babylonjs/loaders/glTF";
import {
  AbstractMesh, ArcRotateCamera, Color3, Color4, DirectionalLight, Engine,
  HemisphericLight, LoadAssetContainerAsync, Scene, TransformNode, Vector3,
  type AssetContainer,
} from "@babylonjs/core";
import { ASSET_LIBRARY } from "../data/assetLibrary";
import { SCENARIO_ASSETS } from "../data/scenarioAssets";
import { createBuildingMesh } from "./building";
import type { EditorAssetEntry } from "./catalog";

/** One offscreen renderer, used serially for the visible catalog objects. */
export class CatalogThumbnails {
  private readonly urls = new Map([...SCENARIO_ASSETS, ...ASSET_LIBRARY].map(asset => [asset.id, asset.url]));
  private readonly cache = new Map<string, Promise<string | null>>();
  private readonly canvas = document.createElement("canvas");
  private engine: Engine | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor() {
    this.canvas.width = 192;
    this.canvas.height = 144;
  }

  get(entry: EditorAssetEntry, isNeeded: () => boolean): Promise<string | null> {
    const key = `${entry.assetId}:${entry.color ?? ""}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.queue.then(async () => {
      if (this.disposed || !isNeeded()) return null;
      return this.render(entry);
    }).catch(() => null);
    this.queue = pending;
    this.cache.set(key, pending);
    void pending.then(result => {
      if (!result) this.cache.delete(key);
      while (this.cache.size > 180) this.cache.delete(this.cache.keys().next().value!);
    });
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    void this.queue.finally(() => { this.engine?.dispose(); this.engine = null; });
  }

  private async render(entry: EditorAssetEntry): Promise<string | null> {
    this.engine ??= new Engine(this.canvas, true, { preserveDrawingBuffer: true, alpha: true, stencil: false });
    const scene = new Scene(this.engine);
    scene.clearColor = new Color4(0, 0, 0, 0);
    let container: AssetContainer | null = null;
    try {
      const root = new TransformNode("thumbnail-root", scene);
      const building = createBuildingMesh(entry.assetId, scene, root, entry.color);
      if (!building) {
        const url = this.urls.get(entry.assetId);
        if (!url) return null;
        container = await LoadAssetContainerAsync(url, scene);
        if (this.disposed) return null;
        container.addAllToScene();
        for (const group of container.animationGroups) group.stop();
      }
      const ambient = new HemisphericLight("thumbnail-ambient", Vector3.Up(), scene);
      ambient.intensity = 1.2;
      ambient.groundColor = new Color3(0.35, 0.35, 0.35);
      const light = new DirectionalLight("thumbnail-key", new Vector3(-1, -2, 1), scene);
      light.intensity = 1.4;
      let min = new Vector3(Infinity, Infinity, Infinity);
      let max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (const mesh of scene.meshes) {
        if (!(mesh instanceof AbstractMesh) || !mesh.getTotalVertices()) continue;
        mesh.computeWorldMatrix(true);
        const box = mesh.getBoundingInfo().boundingBox;
        min = Vector3.Minimize(min, box.minimumWorld);
        max = Vector3.Maximize(max, box.maximumWorld);
      }
      const size = max.subtract(min).length();
      if (!Number.isFinite(size) || size <= 0) return null;
      const radius = size * 1.65;
      const camera = new ArcRotateCamera("thumbnail-camera", -Math.PI / 3, Math.PI / 3,
        radius, min.add(max).scale(0.5), scene);
      camera.fov = 0.8;
      camera.minZ = Math.max(0.001, radius / 1000);
      camera.maxZ = Math.max(100, radius * 10);
      scene.activeCamera = camera;
      await scene.whenReadyAsync();
      if (this.disposed) return null;
      scene.render();
      return this.canvas.toDataURL("image/png");
    } finally {
      container?.dispose();
      scene.dispose();
    }
  }
}
