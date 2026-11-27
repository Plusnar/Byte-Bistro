import { t } from "../i18n";
import type { MapData, MapPlacedObject, MapSlotSummary } from "../editor/MapData";
import type { OfficialLevel } from "./levelLoader";
import { summarizeStations } from "../editor/MapData";
import { getDifficulty } from "./difficulty";
import { getScenario, type ScenarioDefinition } from "./scenarios";

/**
 * The level picker lists two kinds of thing side by side: the scenarios that ship with the
 * game, and the maps the player built in the editor. This builds that merged list.
 *
 * Kept pure so it can be unit tested — the picker itself is DOM and there is no jsdom here.
 */

export interface LevelEntry {
  /** Stable id for selection; `scenario:<id>` or `slot:<id>`. */
  readonly key: string;
  readonly kind: "scenario" | "official" | "saved";
  readonly scenarioId: string;
  readonly title: string;
  readonly description: string;
  readonly difficultyLabel: string;
  readonly shiftDurationSeconds: number;
  /** Only set for saved maps; the slot to load. */
  readonly slotId?: string;
  /** Set for official levels and for scenarios that play one; the map is bundled, not stored. */
  readonly map?: MapData;
  /** Short line under the title for saved maps ("12 objetos · 6 estações"). */
  readonly summary?: string;
  readonly thumbnailUrl?: string;
}

const scenarioEntry = (scenario: ScenarioDefinition): LevelEntry => ({
  key: `scenario:${scenario.id}`,
  kind: "scenario",
  scenarioId: scenario.id,
  title: scenario.displayName,
  description: scenario.description,
  difficultyLabel: getDifficulty(scenario.difficultyId).label,
  shiftDurationSeconds: scenario.shiftDurationSeconds,
  thumbnailUrl: scenario.thumbnailUrl,
});

const contentsSummary = (objects: readonly MapPlacedObject[]): string => {
  const { stations, dispensers } = summarizeStations(objects);
  return t("level.summary", { objects: objects.length, stations, dispensers });
};

const officialEntry = (level: OfficialLevel): LevelEntry => {
  const scenario = getScenario(level.map.scenarioId);
  return {
    key: `official:${level.id}`,
    kind: "official",
    scenarioId: scenario.id,
    title: level.map.name,
    description: level.map.meta?.description ?? scenario.description,
    difficultyLabel: getDifficulty(level.map.meta?.difficultyId ?? scenario.difficultyId).label,
    shiftDurationSeconds: level.map.meta?.shiftDurationSeconds ?? scenario.shiftDurationSeconds,
    map: level.map,
    summary: contentsSummary(level.map.objects),
    thumbnailUrl: scenario.thumbnailUrl,
  };
};

const savedEntry = (slot: MapSlotSummary): LevelEntry => {
  const scenario = getScenario(slot.scenarioId);
  return {
    key: `slot:${slot.slotId}`,
    kind: "saved",
    scenarioId: scenario.id,
    title: slot.name,
    description: slot.description,
    difficultyLabel: getDifficulty(slot.difficultyId).label,
    shiftDurationSeconds: slot.shiftDurationSeconds,
    slotId: slot.slotId,
    summary: t("level.summary", { objects: slot.objectCount, stations: slot.stations, dispensers: slot.dispensers }),
  };
};

/**
 * Built-in scenarios first in their declared order, then the levels shipped in
 * `src/data/levels`, then the player's own saved maps newest first.
 *
 * A saved map whose scenario no longer exists falls back to the default rather than being
 * hidden — losing a level because a scenario was renamed would be worse than playing it
 * under the default rules.
 */
export const buildLevelCatalog = (
  scenarios: readonly ScenarioDefinition[],
  slots: readonly MapSlotSummary[],
  official: readonly OfficialLevel[] = [],
): LevelEntry[] => {
  // A scenario that plays a shipped level is that level: one entry, under the scenario's
  // name and key (so its best rank carries over), with the level's map.
  const played = new Set<string>();
  const scenarioEntries = scenarios.map((scenario): LevelEntry => {
    const level = official.find((candidate) => candidate.id === scenario.levelId);
    if (!level) return scenarioEntry(scenario);
    played.add(level.id);
    return {
      ...scenarioEntry(scenario),
      map: level.map,
      summary: contentsSummary(level.map.objects),
      difficultyLabel: getDifficulty(level.map.meta?.difficultyId ?? scenario.difficultyId).label,
      shiftDurationSeconds: level.map.meta?.shiftDurationSeconds ?? scenario.shiftDurationSeconds,
    };
  });
  return [
    ...scenarioEntries,
    ...official.filter((level) => !played.has(level.id)).map(officialEntry),
    ...[...slots].sort((a, b) => b.updatedAt - a.updatedAt).map(savedEntry),
  ];
};

/** Formats a shift duration the way the picker shows it. */
export const formatShiftDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return rest === 0 ? t("common.minutes", { minutes }) : `${minutes}:${rest.toString().padStart(2, "0")}`;
};
