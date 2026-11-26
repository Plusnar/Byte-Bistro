import { translate } from "../i18n";
import type { MovementBounds } from "../entities/Player";
import { DEFAULT_KITCHEN_LAYOUT } from "./kitchenLayout";
import { STATION_KIND_LABEL } from "./kitchen";
import { INGREDIENT_IDS } from "./ingredientAssets";
import { getIngredient } from "./ingredients";
import type { DifficultyId } from "./difficulty";
import { publicUrl } from "../utils/assetUrl";

/**
 * A scenario is everything that makes one kitchen different from another: its room, its
 * lighting, which recipes are on the menu, how long a shift runs and how hard it pushes.
 *
 * Maps built in the editor reference a scenario by id and inherit its rules, so a designer
 * can ship a new level without touching code — see `src/data/levels`.
 */

export interface ScenarioLightSource {
  readonly direction: { x: number; y: number; z: number };
  readonly position?: { x: number; y: number; z: number };
  readonly colour: string;
  readonly intensity: number;
}

export interface ScenarioAccentLight {
  readonly position: { x: number; y: number; z: number };
  readonly colour: string;
  readonly intensity: number;
  readonly range: number;
}

export interface ScenarioLighting {
  /** Scene ambient colour. */
  readonly ambient: string;
  readonly hemispheric: ScenarioLightSource & { readonly groundColour: string };
  readonly key: ScenarioLightSource;
  readonly accents: readonly ScenarioAccentLight[];
}

/** One thing a map must contain, with the label the editor shows when it is missing. */
export interface ScenarioRequirement {
  readonly id: string;
  readonly label: string;
  /** How many have to be placed. Defaults to one. */
  readonly count?: number;
}

/** What a map must contain before it can be played under this scenario. */
export interface ScenarioRequirements {
  /** Station kinds that must be placed, matched against `stationId`. */
  readonly stations: readonly ScenarioRequirement[];
  /** Ingredient crates that must be placed, matched against `ingredientId`. */
  readonly ingredients: readonly ScenarioRequirement[];
  readonly requiresSpawns: boolean;
  readonly requiresFloor: boolean;
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly thumbnailUrl: string;
  readonly shiftDurationSeconds: number;
  readonly difficultyId: DifficultyId;
  readonly lighting: ScenarioLighting;
  /** Where the guest robots mill about; null means "derive it from the map bounds". */
  readonly receptionArea: MovementBounds | null;
  /** Recipes on this scenario's menu. */
  readonly recipeIds: readonly string[];
  readonly requirements: ScenarioRequirements;
  /**
   * The level shipped in `src/data/levels` that this scenario plays (its file name, as
   * `casamento` for `casamento.bytebistro.json`). Without one, or if the file is gone,
   * the scenario plays its built-in layout.
   */
  readonly levelId?: string;
}

/** Warm evening light for the wedding hall: golden over the arch, rosy over the cake. */
const WEDDING_LIGHTING: ScenarioLighting = {
  ambient: "#3A2F36",
  hemispheric: {
    direction: { x: 0.15, y: 1, z: -0.2 },
    colour: "#FFF1DE",
    groundColour: "#3B2C2A",
    intensity: 0.85,
  },
  key: {
    direction: { x: -0.32, y: -1, z: 0.42 },
    position: { x: 4, y: 11, z: -8 },
    colour: "#FFEBD2",
    intensity: 0.95,
  },
  accents: [
    { position: { x: 0, y: 3.2, z: 5.6 }, colour: "#FFC98A", intensity: 0.6, range: 8 },
    { position: { x: 8.4, y: 2.4, z: 4.6 }, colour: "#FF9FC2", intensity: 0.4, range: 5 },
  ],
};

/**
 * The kitchen a designer has to build before the level can be played.
 *
 * These are the real Overcooked-style tiles ("Cozinha // …" in the catalogue), matched against
 * `stationId`. Labels come from `STATION_KIND_LABEL` and crate names from the ingredient data,
 * so the checklist can never drift from what the catalogue calls the same thing.
 */
const WEDDING_REQUIREMENTS: ScenarioRequirements = {
  stations: [
    { id: "cutting_board", get label() { return STATION_KIND_LABEL.cutting_board; } },
    { id: "stove", get label() { return STATION_KIND_LABEL.stove; } },
    // A pot is not its own tile: `stationsFromMap` alternates pan/pot per stove, so the
    // second stove is what puts a pot in the kitchen. Recipes that boil need it.
    { id: "stove", get label() { return translate("stations.pot"); }, count: 2 },
    { id: "oven", get label() { return STATION_KIND_LABEL.oven; } },
    { id: "mixer", get label() { return STATION_KIND_LABEL.mixer; } },
    { id: "counter", get label() { return STATION_KIND_LABEL.counter; } },
    { id: "plate_rack", get label() { return STATION_KIND_LABEL.plate_rack; } },
    { id: "sink", get label() { return STATION_KIND_LABEL.sink; } },
    { id: "trash", get label() { return STATION_KIND_LABEL.trash; } },
    { id: "extinguisher_stand", get label() { return STATION_KIND_LABEL.extinguisher_stand; } },
    // Not on the requested list, but a shift with nowhere to serve cannot be won at all.
    { id: "delivery", get label() { return STATION_KIND_LABEL.delivery; } },
  ],
  ingredients: INGREDIENT_IDS.map((id) => ({
    id,
    get label() { return getIngredient(id)?.displayName ?? id; },
  })),
  requiresSpawns: true,
  requiresFloor: true,
};

/** What the wedding orders: only the first two dishes a new crew learns. */
export const WEDDING_MENU: readonly string[] = ["ram_cake", "cache_cookies"];

export const WEDDING_SCENARIO: ScenarioDefinition = {
  id: "wedding",
  get displayName() { return translate("scenarios.wedding.name"); },
  get description() { return translate("scenarios.wedding.description"); },
  thumbnailUrl: publicUrl("images/scenarios/wedding.png"),
  shiftDurationSeconds: 195,
  difficultyId: "standard",
  lighting: WEDDING_LIGHTING,
  receptionArea: DEFAULT_KITCHEN_LAYOUT.receptionArea,
  // The opening level stays easy: two dishes, board and stove only. The baked and mixed
  // recipes (pizza, donuts, parfait) wait for later levels; the oven and mixer are still
  // required so the hall is ready for them.
  recipeIds: WEDDING_MENU,
  requirements: WEDDING_REQUIREMENTS,
  // The official wedding: the hall as built in the editor.
  levelId: "casamento",
};

/** What the Schlachtfest serves: a cutlet from the oven and stove, and a draught. */
export const SCHLACHTFEST_MENU: readonly string[] = ["ssd_schnitzel", "thermal_paste_beer"];

/**
 * The town's Schlachtfest: the second official level. Same kitchen rules as the wedding,
 * its own menu, and the parades and partying robots of its map (src/data/levels).
 */
export const SCHLACHTFEST_SCENARIO: ScenarioDefinition = {
  id: "schlachtfest",
  get displayName() { return translate("scenarios.schlachtfest.name"); },
  get description() { return translate("scenarios.schlachtfest.description"); },
  thumbnailUrl: publicUrl("images/scenarios/wedding.png"),
  shiftDurationSeconds: 210,
  difficultyId: "standard",
  lighting: WEDDING_LIGHTING,
  receptionArea: null,
  recipeIds: SCHLACHTFEST_MENU,
  requirements: WEDDING_REQUIREMENTS,
  levelId: "schlachtfest",
};

/** What the Salão Pauli serves: a burger and three drinks for the dance floor. */
export const PAULI_MENU: readonly string[] = ["x_salada", "drink_404", "cyber_soda", "pixel_punch"];

/**
 * The Salão Pauli dance hall: the third official level, intense. A show on stage, a brawl
 * on the floor and bottles in the air while the crew serves four dishes.
 */
export const PAULI_SCENARIO: ScenarioDefinition = {
  id: "pauli",
  get displayName() { return translate("scenarios.pauli.name"); },
  get description() { return translate("scenarios.pauli.description"); },
  thumbnailUrl: publicUrl("images/scenarios/wedding.png"),
  shiftDurationSeconds: 195,
  difficultyId: "intense",
  lighting: WEDDING_LIGHTING,
  receptionArea: null,
  recipeIds: PAULI_MENU,
  requirements: WEDDING_REQUIREMENTS,
  levelId: "salao-pauli",
};

export const SCENARIOS: readonly ScenarioDefinition[] = [WEDDING_SCENARIO, SCHLACHTFEST_SCENARIO, PAULI_SCENARIO];

export const DEFAULT_SCENARIO_ID = WEDDING_SCENARIO.id;

export const getScenario = (id: string | undefined): ScenarioDefinition =>
  SCENARIOS.find((scenario) => scenario.id === id) ?? WEDDING_SCENARIO;

export const isScenarioId = (id: unknown): id is string =>
  typeof id === "string" && SCENARIOS.some((scenario) => scenario.id === id);
