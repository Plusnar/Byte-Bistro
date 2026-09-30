import type { RecipeData } from "../types/game";

/**
 * Overcooked-style recipes: every dish is a plate holding an exact set of
 * processed components (chopped on a board, cooked in a pan or pot, or raw).
 */
export const RECIPES: readonly RecipeData[] = [
  {
    id: "ram_cake",
    displayName: "Bolo de memória RAM",
    shortName: "RAM CAKE",
    description: "Uma pilha de memória grelhada com creme de cache e açúcar binário.",
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
      { stationId: "cutting_board", description: "Corte o RAM Module e o Cache Cream na tábua." },
      { stationId: "stove", description: "Frite o RAM Module picado na frigideira. Não deixe queimar!" },
      { stationId: "plate_rack", description: "Monte no prato: RAM frito, Cache Cream picado e Binary Sugar." },
      { stationId: "delivery", description: "Entregue o prato no balcão de entrega." },
    ],
    effects: { memory: 30, creativity: 5, temperature: 4 },
    reward: 300,
    color: "#55d9ff",
  },
  {
    id: "cache_cookies",
    displayName: "Cookies de cache",
    shortName: "CACHE COOKIES",
    description: "Três fragmentos de cache cozidos juntos na panela.",
    finalItemId: "cache_cookies",
    components: [
      { ingredientId: "cache_fragment", state: "cooked" },
      { ingredientId: "cache_fragment", state: "cooked" },
      { ingredientId: "cache_fragment", state: "cooked" },
    ],
    ingredients: [{ ingredientId: "cache_fragment", quantity: 3 }],
    steps: [
      { stationId: "cutting_board", description: "Corte três Cache Fragments." },
      { stationId: "stove", description: "Coloque os três na panela e espere cozinhar." },
      { stationId: "plate_rack", description: "Despeje a panela em um prato limpo." },
      { stationId: "delivery", description: "Entregue o prato no balcão de entrega." },
    ],
    effects: { processing: 15, energy: 10 },
    reward: 240,
    color: "#ffc857",
  },
  {
    id: "cooling_gelato",
    displayName: "Gelato refrigerante",
    shortName: "COOLING GELATO",
    description: "Fluido refrigerante e creme de dados picados, servidos frios.",
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
      { stationId: "cutting_board", description: "Corte o Cooling Fluid e o Data Cream." },
      { stationId: "plate_rack", description: "Coloque os dois picados em um prato." },
      { stationId: "delivery", description: "Entregue o prato no balcão de entrega." },
    ],
    effects: { temperature: -25, stability: 8 },
    reward: 260,
    color: "#69fff0",
  },
];

export const getRecipeById = (recipeId: string): RecipeData | undefined =>
  RECIPES.find((recipe) => recipe.id === recipeId);
