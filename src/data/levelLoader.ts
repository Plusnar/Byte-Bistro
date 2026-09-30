import type { MapData } from "../editor/MapData";
import { sanitizeMapData } from "../editor/MapStore";

/**
 * Turns the JSON files exported from the editor into official levels.
 *
 * The flow is: build a map in game → Exportar → drop the `.json` into `src/data/levels/` →
 * it ships as a level. Nothing else needs touching, which is the whole point.
 *
 * Kept pure and separate from the `import.meta.glob` call so it can be tested with plain
 * objects; `officialLevels.ts` is the thin module that does the globbing.
 */

export interface OfficialLevel {
  /** Derived from the filename, so renaming the file renames the level id. */
  readonly id: string;
  readonly map: MapData;
}

/** `src/data/levels/rush-hour.bytebistro.json` → `rush-hour`. */
export const levelIdFromPath = (path: string): string => {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.bytebistro\.json$/i, "").replace(/\.json$/i, "");
};

const unwrap = (module: unknown): unknown =>
  typeof module === "object" && module !== null && "default" in module
    ? (module as { default: unknown }).default
    : module;

/**
 * Every file goes through `sanitizeMapData`, exactly like a map loaded from storage.
 *
 * A file that fails to parse is skipped with a warning rather than thrown: one malformed
 * level should cost that level, not the whole game's boot.
 */
export const parseOfficialLevels = (
  modules: Record<string, unknown>,
  warn: (message: string) => void = (message) => { console.warn(message); },
): OfficialLevel[] => {
  const levels: OfficialLevel[] = [];
  // Sorted by path so the level order is the filename order, not the bundler's.
  for (const path of Object.keys(modules).sort()) {
    const map = sanitizeMapData(unwrap(modules[path]));
    if (!map) {
      warn(`Nível oficial ignorado (JSON inválido): ${path}`);
      continue;
    }
    levels.push({ id: levelIdFromPath(path), map });
  }
  return levels;
};
