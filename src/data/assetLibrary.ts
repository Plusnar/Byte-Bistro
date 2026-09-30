import manifest from "./assetLibrary.json";
import type { PlacedObjectCategory } from "../editor/MapData";

interface LibraryManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly label: string;
  readonly pack: string;
  readonly category: string;
  /** Placement scale from the pack's `pack.json`; absent means 1. */
  readonly scale?: { readonly x: number; readonly y: number; readonly z: number };
}

export const ASSET_LIBRARY = (manifest as readonly LibraryManifestEntry[]).map(entry => ({
  ...entry,
  url: `${import.meta.env.BASE_URL}${entry.path}`,
  category: entry.category as PlacedObjectCategory,
}));

export const libraryModelsFor = (ids: readonly string[]) => {
  const selected = new Set(ids);
  return ASSET_LIBRARY.filter(asset => selected.has(asset.id));
};
