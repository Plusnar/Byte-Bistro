import type { NetworkResolver, NetworkTarget } from "./AssetCache";

/**
 * Where model files are downloaded from, and under which version.
 *
 * Files are always *named* by their URL on the game's own origin — that is the key the
 * caches and the loaders use. This only decides the request:
 *
 *   - Bundled files carry Vite's content hash in their name (`bundle/x-AbCd1234.glb`), so
 *     they are content-addressed as they are.
 *   - Files under `public/` do not; the build writes `asset-manifest.json` with a content
 *     hash for each, and the request becomes `...?v=<hash>`. A changed file gets a new URL,
 *     so no cache can serve the old one, and files of two builds never mix.
 *   - With `VITE_ASSET_ORIGIN` set (e.g. a Cloudflare R2 bucket on its own domain), model,
 *     buffer and texture files are fetched from there instead; code and the page stay on
 *     Pages. The bucket needs a CORS rule allowing GET from the game's origin (see
 *     docs/PERFORMANCE_ARCHITECTURE.md). No credential is ever needed client-side: the
 *     bucket is public-read.
 *
 * Without a manifest (development, or a failed download) files are requested as they are,
 * with normal HTTP revalidation, and are not kept in the persistent store.
 */
export interface AssetManifest {
  readonly version: string;
  /** Directory (relative to the base URL, ending in "/") → file name → content hash. */
  readonly dirs: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface DistributionOptions {
  /** The deploy base, `import.meta.env.BASE_URL`. */
  readonly baseUrl: string;
  /** The page's origin. */
  readonly pageOrigin: string;
  /** Optional CDN origin for model files, ending in "/" (or empty). */
  readonly assetOrigin?: string | null;
  /** Loads the manifest; resolves null when there is none. */
  readonly loadManifest: () => Promise<AssetManifest | null>;
  /** How long a request waits for the manifest before going unversioned. */
  readonly manifestTimeoutMs?: number;
}

/** Vite's hashed output: `bundle/<name>-<8 chars>.<ext>`. */
const HASHED_BUNDLE = /^bundle\/.+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;
/** What may come from the CDN: models, their buffers and textures. Never code or pages. */
const CDN_EXTENSIONS = /\.(glb|gltf|bin|png|jpe?g|webp|ktx2)$/i;

export const createNetworkResolver = (options: DistributionOptions): NetworkResolver => {
  const base = new URL(options.baseUrl, options.pageOrigin);
  const assetOrigin = options.assetOrigin ? new URL(options.assetOrigin) : null;
  let manifest: Promise<AssetManifest | null> | null = null;
  /** undefined while the manifest is still on its way. */
  let settled: AssetManifest | null | undefined;
  const timeout = options.manifestTimeoutMs ?? 4000;

  const getManifest = async (): Promise<AssetManifest | null> => {
    if (settled !== undefined) return settled;
    manifest ??= options.loadManifest().catch(() => null).then((loaded) => (settled = loaded));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeout); });
    try {
      return await Promise.race([manifest, late]);
    } finally {
      clearTimeout(timer);
    }
  };

  const onCdn = (url: URL, relative: string): string => {
    if (!assetOrigin || !CDN_EXTENSIONS.test(url.pathname)) return url.href;
    return new URL(relative + url.search, assetOrigin).href;
  };

  return async (requested: string): Promise<NetworkTarget> => {
    const url = new URL(requested);
    const plain: NetworkTarget = { url: requested, persistKey: null, cache: "default" };
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return plain;
    const relative = url.pathname.slice(base.pathname.length);
    if (HASHED_BUNDLE.test(relative)) {
      return { url: onCdn(url, relative), persistKey: url.href, cache: "default" };
    }
    const loaded = await getManifest();
    const decoded = decodeURIComponent(relative);
    const slash = decoded.lastIndexOf("/") + 1;
    const hash = loaded?.dirs[decoded.slice(0, slash)]?.[decoded.slice(slash)];
    if (!hash) return { ...plain, url: onCdn(url, relative) };
    url.searchParams.set("v", hash);
    return { url: onCdn(url, relative), persistKey: url.href, cache: "default" };
  };
};

/** Fetches the build's manifest; null in development or when it cannot be read. */
export const fetchAssetManifest = async (baseUrl: string): Promise<AssetManifest | null> => {
  const response = await fetch(`${baseUrl}asset-manifest.json`, { cache: "no-cache" });
  if (!response.ok) return null;
  const parsed = await response.json() as Partial<AssetManifest>;
  return parsed && typeof parsed.dirs === "object" ? parsed as AssetManifest : null;
};
