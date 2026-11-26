import type { RecipeData, RecipeStep, StationId } from "../types/game";
import { translate } from "../i18n";

type RecipeFields = Omit<RecipeData, "displayName" | "shortName" | "description" | "steps"> & {
  steps: readonly { stationId: StationId; step: number }[];
};

/**
 * Names, descriptions and steps come from the catalogues (`recipes.<id>`), read each time,
 * so the recipe book and the tickets follow the language.
 */
const recipe = ({ steps, ...data }: RecipeFields): RecipeData => ({
  ...data,
  get displayName() { return translate(`recipes.${data.id}.name`); },
  get shortName() { return translate(`recipes.${data.id}.short`); },
  get description() { return translate(`recipes.${data.id}.description`); },
  steps: steps.map(({ stationId, step }): RecipeStep => ({
    stationId,
    get description() { return translate(`recipes.${data.id}.step${step}`); },
  })),
});

/**
 * Overcooked-style recipes: every dish is a plate holding an exact set of ingredients, each
 * in the state one process left it in (chopped on a board, beaten in the mixer's bowl,
 * fried in a pan, boiled in a pot, baked on the oven's tray, or raw). No ingredient is
 * ever made out of others: what comes out of a crate is what goes on the plate.
 */
export const RECIPES: readonly RecipeData[] = [
  // ------------------------------------------------------------------ the wedding
  recipe({
    id: "ram_cake",
    finalItemId: "ram_cake",
    components: [
      { ingredientId: "ram_module", state: "fried" },
      { ingredientId: "cache_cream", state: "chopped" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "ram_module", quantity: 1 },
      { ingredientId: "cache_cream", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "stove", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { memory: 30, creativity: 5, temperature: 4 },
    reward: 300,
    color: "#55d9ff",
  }),
  recipe({
    id: "cache_cookies",
    finalItemId: "cache_cookies",
    components: [
      { ingredientId: "cache_fragment", state: "boiled" },
      { ingredientId: "cache_fragment", state: "boiled" },
      { ingredientId: "cache_fragment", state: "boiled" },
    ],
    ingredients: [{ ingredientId: "cache_fragment", quantity: 3 }],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "stove", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { processing: 15, energy: 10 },
    reward: 240,
    color: "#ffc857",
  }),
  recipe({
    id: "cooling_gelato",
    finalItemId: "cooling_gelato",
    components: [
      { ingredientId: "cooling_fluid", state: "chopped" },
      { ingredientId: "data_cream", state: "chopped" },
    ],
    ingredients: [
      { ingredientId: "cooling_fluid", quantity: 1 },
      { ingredientId: "data_cream", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "plate_rack", step: 2 },
      { stationId: "delivery", step: 3 },
    ],
    effects: { temperature: -25, stability: 8 },
    reward: 260,
    color: "#69fff0",
  }),

  // ------------------------------------------------------------------ oven and mixer
  recipe({
    id: "ram_pizza",
    finalItemId: "ram_pizza",
    components: [
      { ingredientId: "ram_module", state: "baked" },
      { ingredientId: "cache_cream", state: "chopped" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "ram_module", quantity: 1 },
      { ingredientId: "cache_cream", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "oven", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { memory: 34, creativity: 10, temperature: 6 },
    reward: 420,
    color: "#7ab8ff",
  }),
  recipe({
    id: "cache_donuts",
    finalItemId: "cache_donuts",
    components: [
      { ingredientId: "cache_fragment", state: "baked" },
      { ingredientId: "cache_cream", state: "mixed" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "cache_fragment", quantity: 1 },
      { ingredientId: "cache_cream", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "oven", step: 2 },
      { stationId: "mixer", step: 3 },
      { stationId: "plate_rack", step: 4 },
      { stationId: "delivery", step: 5 },
    ],
    effects: { processing: 22, energy: 14 },
    reward: 440,
    color: "#ffb347",
  }),
  recipe({
    id: "gelato_parfait",
    finalItemId: "gelato_parfait",
    components: [
      { ingredientId: "cooling_fluid", state: "mixed" },
      { ingredientId: "data_cream", state: "mixed" },
      { ingredientId: "cache_cream", state: "chopped" },
    ],
    ingredients: [
      { ingredientId: "cooling_fluid", quantity: 1 },
      { ingredientId: "data_cream", quantity: 1 },
      { ingredientId: "cache_cream", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "mixer", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { temperature: -30, stability: 12 },
    reward: 380,
    color: "#8ff6ef",
  }),

  // ------------------------------------------------------------------ the Schlachtfest
  recipe({
    id: "ssd_schnitzel",
    finalItemId: "ssd_schnitzel",
    components: [
      { ingredientId: "ram_module", state: "baked" },
      { ingredientId: "ram_module", state: "fried" },
      { ingredientId: "data_cream", state: "chopped" },
    ],
    ingredients: [
      { ingredientId: "ram_module", quantity: 2 },
      { ingredientId: "data_cream", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "oven", step: 2 },
      { stationId: "stove", step: 3 },
      { stationId: "plate_rack", step: 4 },
      { stationId: "delivery", step: 5 },
    ],
    effects: { memory: 30, energy: 12, temperature: 8 },
    reward: 480,
    color: "#e8a33a",
  }),
  recipe({
    id: "thermal_paste_beer",
    finalItemId: "thermal_paste_beer",
    components: [
      { ingredientId: "cooling_fluid", state: "mixed" },
      { ingredientId: "data_cream", state: "mixed" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "cooling_fluid", quantity: 1 },
      { ingredientId: "data_cream", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "mixer", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { temperature: -28, stability: 10 },
    reward: 360,
    color: "#2fd1b8",
  }),

  // ------------------------------------------------------------------ the Salão Pauli
  // Firsts here: a fragment fried in the pan, a fragment boiled into a drink, and a cream
  // beaten on its own.
  recipe({
    id: "x_salada",
    finalItemId: "x_salada",
    components: [
      { ingredientId: "ram_module", state: "baked" },
      { ingredientId: "cache_fragment", state: "fried" },
      { ingredientId: "cache_cream", state: "chopped" },
    ],
    ingredients: [
      { ingredientId: "ram_module", quantity: 1 },
      { ingredientId: "cache_fragment", quantity: 1 },
      { ingredientId: "cache_cream", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "oven", step: 2 },
      { stationId: "stove", step: 3 },
      { stationId: "plate_rack", step: 4 },
      { stationId: "delivery", step: 5 },
    ],
    effects: { memory: 28, processing: 14, energy: 10 },
    reward: 520,
    color: "#f2b544",
  }),
  recipe({
    id: "drink_404",
    finalItemId: "drink_404",
    components: [
      { ingredientId: "cache_fragment", state: "boiled" },
      { ingredientId: "cooling_fluid", state: "chopped" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "cache_fragment", quantity: 1 },
      { ingredientId: "cooling_fluid", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "stove", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { processing: 18, temperature: -12 },
    reward: 400,
    color: "#b04dff",
  }),
  recipe({
    id: "cyber_soda",
    finalItemId: "cyber_soda",
    components: [
      { ingredientId: "cooling_fluid", state: "mixed" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "cooling_fluid", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "mixer", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { energy: 16, temperature: -14 },
    reward: 260,
    color: "#29c6ff",
  }),
  recipe({
    id: "pixel_punch",
    finalItemId: "pixel_punch",
    components: [
      { ingredientId: "cache_cream", state: "mixed" },
      { ingredientId: "cooling_fluid", state: "chopped" },
      { ingredientId: "data_cream", state: "chopped" },
    ],
    ingredients: [
      { ingredientId: "cache_cream", quantity: 1 },
      { ingredientId: "cooling_fluid", quantity: 1 },
      { ingredientId: "data_cream", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "mixer", step: 2 },
      { stationId: "plate_rack", step: 3 },
      { stationId: "delivery", step: 4 },
    ],
    effects: { creativity: 14, stability: 8, temperature: -8 },
    reward: 320,
    color: "#ff6fae",
  }),
];

export const getRecipeById = (recipeId: string): RecipeData | undefined =>
  RECIPES.find((recipe) => recipe.id === recipeId);
