import { parseOfficialLevels, type OfficialLevel } from "./levelLoader";

/**
 * Levels shipped with the game, built in the editor and exported to `src/data/levels/`.
 *
 * `eager` so they are bundled rather than fetched: a level is a few kilobytes of JSON and
 * the picker needs all of their names up front anyway.
 */
const modules = import.meta.glob("./levels/*.json", { eager: true });

export const OFFICIAL_LEVELS: readonly OfficialLevel[] = parseOfficialLevels(modules);

export const getOfficialLevel = (id: string): OfficialLevel | undefined =>
  OFFICIAL_LEVELS.find((level) => level.id === id);
