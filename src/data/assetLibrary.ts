import { getLanguage } from "../i18n";
import { portugueseAssetName } from "../i18n/assetNames";
import manifest from "./assetLibrary.json";
import type { PlacedObjectCategory } from "../editor/MapData";

interface LibraryManifestEntry {
  readonly id: string;
  readonly path: string;
  /** As authored: Portuguese for the local packs, the file's English name for the rest. */
  readonly label: string;
  /** English name, for the packs labelled in Portuguese. */
  readonly labelEn?: string;
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

/** Library entries by id, for looking a placed model's names up in both languages. */
export const ASSET_LIBRARY_BY_ID = new Map(ASSET_LIBRARY.map((entry) => [entry.id, entry] as const));

const portugueseNames = new Map<string, string>();

/** A library model's name in the current language. */
export const libraryLabel = (entry: { readonly label: string; readonly labelEn?: string }): string => {
  if (getLanguage() === "en") return entry.labelEn ?? entry.label;
  if (entry.labelEn) return entry.label;
  let name = portugueseNames.get(entry.label);
  if (!name) {
    name = portugueseAssetName(entry.label);
    portugueseNames.set(entry.label, name);
  }
  return name;
};

export const libraryModelsFor = (ids: readonly string[]) => {
  const selected = new Set(ids);
  return ASSET_LIBRARY.filter(asset => selected.has(asset.id));
};
