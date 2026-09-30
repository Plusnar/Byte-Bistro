import { registerGLTFExtension } from "@babylonjs/loaders/glTF/2.0";
import type { GLTFLoader } from "@babylonjs/loaders/glTF/2.0";
import { absoluteUrl, assetCache, type AssetPriority } from "./AssetCache";

/**
 * Routes every file a glTF references — `.bin` buffers and texture images — through the
 * shared `AssetCache` instead of Babylon's own per-load requests.
 *
 * This is what fixes the KayKit texture atlas being downloaded 35 times: each of the 35
 * `.gltf` kitchen models points at the same `restaurantbits_texture.png`, and Babylon loads
 * a model's dependencies independently of every other model. Keyed by absolute URL in the
 * cache, the atlas is fetched once and handed to all 35.
 *
 * It uses the loader's extension hook (`_loadUriAsync`), the same mechanism Babylon's own
 * glTF extensions use, registered as a non-glTF extension so it applies to every file.
 */

const EXTENSION_NAME = "byte_bistro_cached_uris";

let registered = false;

/** Idempotent; the AssetManager calls it before its first load. */
export const registerCachedGltfUris = (): void => {
  if (registered) return;
  registered = true;
  registerGLTFExtension(EXTENSION_NAME, false, (loader: GLTFLoader) => ({
    name: EXTENSION_NAME,
    enabled: true,
    dispose: () => undefined,
    _loadUriAsync: (_context: string, _property: unknown, uri: string) => {
      // Embedded data needs no network, and blob URLs are already local.
      if (uri.startsWith("data:") || uri.startsWith("blob:")) return null;
      const url = absoluteUrl(uri, loader.rootUrl ?? undefined);
      return assetCache.fetch(url, "gameplay").then((buffer) => new Uint8Array(buffer));
    },
  }));
};

/**
 * The files a `.gltf` JSON document points at, as absolute URLs.
 *
 * Prefetching these before the parse starts means the parse itself never waits on the
 * network — which matters, because parses run one at a time on the main thread.
 */
export const gltfDependencies = (bytes: ArrayBuffer, fileUrl: string): string[] => {
  let json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as typeof json;
  } catch {
    return [];
  }
  const directory = fileUrl.slice(0, fileUrl.lastIndexOf("/") + 1);
  const uris = [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((entry) => entry.uri)
    .filter((uri): uri is string => typeof uri === "string" && !uri.startsWith("data:"));
  return [...new Set(uris.map((uri) => absoluteUrl(uri, directory)))];
};

/**
 * Wraps a `.gltf` JSON document in a GLB container, in memory.
 *
 * Babylon only accepts in-memory bytes for binary glTF — handing it a JSON `.gltf` as an
 * ArrayBufferView fails with "plugins that don't support binary loading". A GLB with only a
 * JSON chunk and external buffers is valid per the glTF 2.0 spec: its `.bin` and textures
 * keep their relative URIs and still resolve through `_loadUriAsync`, i.e. through the cache.
 */
export const gltfJsonToGlb = (json: ArrayBuffer): Uint8Array => {
  const source = new Uint8Array(json);
  const padded = (source.byteLength + 3) & ~3;
  const glb = new Uint8Array(12 + 8 + padded);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(source, 20);
  // The spec pads the JSON chunk with spaces, not zeros.
  glb.fill(0x20, 20 + source.byteLength);
  return glb;
};

export const prefetchGltfDependencies = async (
  bytes: ArrayBuffer,
  fileUrl: string,
  priority: AssetPriority,
): Promise<void> => {
  await Promise.all(gltfDependencies(bytes, fileUrl).map((url) => assetCache.fetch(url, priority)));
};
