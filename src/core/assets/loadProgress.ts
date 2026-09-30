import type { AssetCache } from "./AssetCache";

/**
 * Turns the cache's byte counts into what the loading screen shows: one fraction and one
 * line of text. Pure, so the wording and weighting can be tested without a page.
 */

/** A labelled set of files; the loader names the first group that is still arriving. */
export interface LoadGroup {
  readonly status: string;
  readonly urls: readonly string[];
}

export interface LoadReport {
  readonly fraction: number;
  readonly status: string;
  /** Files in these groups that failed after every retry. */
  readonly failedUrls: readonly string[];
}

/**
 * Downloads are most of the wait, but not all of it: parsing and building the scene take
 * real time after the last byte lands. Reserving a slice of the bar for those steps stops it
 * from sitting at 100% while the page is still visibly working.
 */
export const BYTES_WEIGHT = 0.85;

const settled = (state: string): boolean => state === "loaded" || state === "failed";

export const describeProgress = (
  cache: Pick<AssetCache, "progress" | "state">,
  groups: readonly LoadGroup[],
  steps: { readonly done: number; readonly total: number },
  finishing: string,
): LoadReport => {
  const urls = [...new Set(groups.flatMap((group) => group.urls))];
  const bytes = urls.length ? cache.progress(urls).fraction : 1;
  const stepFraction = steps.total > 0 ? Math.min(1, steps.done / steps.total) : 1;
  const fraction = BYTES_WEIGHT * bytes + (1 - BYTES_WEIGHT) * stepFraction;
  const arriving = groups.find((group) => group.urls.some((url) => !settled(cache.state(url))));
  return {
    fraction: Math.min(1, Math.max(0, fraction)),
    status: arriving?.status ?? finishing,
    failedUrls: urls.filter((url) => cache.state(url) === "failed"),
  };
};

/** "…/assets/Knight-D2u64nEn.glb" → "Knight.glb", for error messages a person can read. */
export const readableAssetName = (url: string): string => {
  const file = decodeURIComponent(url.split(/[?#]/)[0]!.split("/").pop() ?? url);
  // Vite appends "-<8 char hash>" before the extension in production builds.
  return file.replace(/-[A-Za-z0-9_]{8}(\.[a-z0-9]+)$/i, "$1");
};
