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
 * Overcooked-style recipes: every dish is a plate holding an exact set of
 * processed components (chopped on a board, cooked in a pan or pot, or raw).
 */
export const RECIPES: readonly RecipeData[] = [
  recipe({
    id: "ram_cake",
    finalItemId: "ram_cake",
    components: [
      { ingredientId: "ram_module", state: "cooked" },
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
      { ingredientId: "cache_fragment", state: "cooked" },
      { ingredientId: "cache_fragment", state: "cooked" },
      { ingredientId: "cache_fragment", state: "cooked" },
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

  /*
   * The long menu: the mixer makes a prepared ingredient out of a bowlful, and for two of
   * them the oven then bakes it. A prepared ingredient is an ordinary ingredient from
   * there on, which is why none of this needed a new matching rule.
   */
  recipe({
    id: "ram_pizza",
    finalItemId: "ram_pizza",
    components: [
      { ingredientId: "ram_dough", state: "cooked" },
      { ingredientId: "cache_cream", state: "chopped" },
    ],
    ingredients: [
      { ingredientId: "ram_module", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 1 },
      { ingredientId: "cache_cream", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "mixer", step: 2 },
      { stationId: "oven", step: 3 },
      { stationId: "plate_rack", step: 4 },
      { stationId: "delivery", step: 5 },
    ],
    effects: { memory: 34, creativity: 10, temperature: 6 },
    reward: 460,
    color: "#7ab8ff",
  }),
  recipe({
    id: "cache_donuts",
    finalItemId: "cache_donuts",
    components: [
      { ingredientId: "donut_dough", state: "cooked" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "cache_fragment", quantity: 1 },
      { ingredientId: "binary_sugar", quantity: 2 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "mixer", step: 2 },
      { stationId: "oven", step: 3 },
      { stationId: "plate_rack", step: 4 },
      { stationId: "delivery", step: 5 },
    ],
    effects: { processing: 22, energy: 14 },
    reward: 420,
    color: "#ffb347",
  }),
  recipe({
    id: "gelato_parfait",
    finalItemId: "gelato_parfait",
    components: [
      { ingredientId: "gelato_mix", state: "raw" },
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

  /*
   * The Schlachtfest menu: a fried cutlet and a draught. Both start at the mixer, the
   * cutlet also needs the oven and the stove.
   */
  recipe({
    id: "ssd_schnitzel",
    finalItemId: "ssd_schnitzel",
    components: [
      { ingredientId: "ram_dough", state: "cooked" },
      { ingredientId: "ram_module", state: "cooked" },
      { ingredientId: "data_cream", state: "chopped" },
    ],
    ingredients: [
      { ingredientId: "ram_module", quantity: 2 },
      { ingredientId: "binary_sugar", quantity: 1 },
      { ingredientId: "data_cream", quantity: 1 },
    ],
    steps: [
      { stationId: "cutting_board", step: 1 },
      { stationId: "mixer", step: 2 },
      { stationId: "oven", step: 3 },
      { stationId: "stove", step: 4 },
      { stationId: "plate_rack", step: 5 },
      { stationId: "delivery", step: 6 },
    ],
    effects: { memory: 30, energy: 12, temperature: 8 },
    reward: 480,
    color: "#e8a33a",
  }),
  recipe({
    id: "thermal_paste_beer",
    finalItemId: "thermal_paste_beer",
    components: [
      { ingredientId: "gelato_mix", state: "raw" },
      { ingredientId: "cooling_fluid", state: "chopped" },
      { ingredientId: "binary_sugar", state: "raw" },
    ],
    ingredients: [
      { ingredientId: "cooling_fluid", quantity: 2 },
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
];

export const getRecipeById = (recipeId: string): RecipeData | undefined =>
  RECIPES.find((recipe) => recipe.id === recipeId);
