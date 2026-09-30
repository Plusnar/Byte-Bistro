import { ingredientModelId } from "./ingredientAssets";
/** Curated Scenario assets used to build SERVER ROOM 01. */
export const SCENARIO_ASSETS = [
  {
    id: "scenario-room-wide",
    url: new URL(
      "../assets/scenario/space-room-wide.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-cables",
    url: new URL(
      "../assets/scenario/space-cables.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-machine",
    url: new URL(
      "../assets/scenario/factory-machine.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-machine-fortified",
    url: new URL(
      "../assets/scenario/factory-machine-fortified.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-machine-bed",
    url: new URL(
      "../assets/scenario/factory-machine-bed.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-hopper",
    url: new URL(
      "../assets/scenario/factory-hopper-high-square.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-scanner-low",
    url: new URL(
      "../assets/scenario/factory-scanner-low.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-screen-wide",
    url: new URL(
      "../assets/scenario/factory-screen-wide.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-conveyor-long",
    url: new URL(
      "../assets/scenario/factory-conveyor-long-sides.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-robot-arm",
    url: new URL(
      "../assets/scenario/factory-robot-arm-a.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-pipe-long",
    url: new URL(
      "../assets/scenario/factory-pipe-large-long.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-pipe-bend",
    url: new URL(
      "../assets/scenario/factory-pipe-large-bend.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-pipe-valve",
    url: new URL(
      "../assets/scenario/factory-pipe-large-valve.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-box-large",
    url: new URL(
      "../assets/scenario/factory-box-large.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-box-small",
    url: new URL(
      "../assets/scenario/factory-box-small.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-freezer-standing",
    url: new URL(
      "../assets/scenario/market-freezers-standing.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-shelf-boxes",
    url: new URL(
      "../assets/scenario/market-shelf-boxes.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "scenario-cash-register",
    url: new URL(
      "../assets/scenario/market-cash-register.glb",
      import.meta.url,
    ).href,
    required: true,
  },
  {
    id: "food-chocolate",
    url: new URL("../assets/scenario/food-chocolate.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-sugar",
    url: new URL("../assets/scenario/food-shaker-salt.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-carton",
    url: new URL("../assets/scenario/food-carton-small.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-candy-bar",
    url: new URL("../assets/scenario/food-candy-bar.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-coolant",
    url: new URL("../assets/scenario/food-soda-bottle.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-whipped-cream",
    url: new URL("../assets/scenario/food-whipped-cream.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-bowl",
    url: new URL("../assets/scenario/food-bowl.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-bread",
    url: new URL("../assets/scenario/food-bread.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-cake",
    url: new URL("../assets/scenario/food-cake.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-cake-finished",
    url: new URL("../assets/scenario/food-cake-birthday.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-cookie",
    url: new URL("../assets/scenario/food-cookie-chocolate.glb", import.meta.url).href,
    required: true,
  },
  {
    id: "food-gelato",
    url: new URL("../assets/scenario/food-ice-cream-cup.glb", import.meta.url).href,
    required: true,
  },
] as const;

export interface IngredientScenarioVisual {
  /** A SCENARIO_ASSETS id, or a bespoke ingredient asset id. */
  readonly assetId: string;
  readonly scale: number;
  readonly yOffset?: number;
}

export const INGREDIENT_SCENARIO_VISUALS: Readonly<Record<string, IngredientScenarioVisual>> = {
  ram_module: { assetId: ingredientModelId("ram_module"), scale: 1 },
  binary_sugar: { assetId: ingredientModelId("binary_sugar"), scale: 1 },
  cache_cream: { assetId: ingredientModelId("cache_cream"), scale: 1 },
  cache_fragment: { assetId: ingredientModelId("cache_fragment"), scale: 1 },
  cooling_fluid: { assetId: ingredientModelId("cooling_fluid"), scale: 1 },
  data_cream: { assetId: ingredientModelId("data_cream"), scale: 1 },
  ram_powder: { assetId: "food-bowl", scale: 0.8 },
  ram_dough: { assetId: "food-bread", scale: 0.7 },
  ram_cake_base: { assetId: "food-cake", scale: 0.5 },
  ram_cake: { assetId: "food-cake-finished", scale: 0.5 },
  cookie_dough: { assetId: "food-bowl", scale: 0.8 },
  cache_cookies: { assetId: "food-cookie", scale: 2.7 },
  gelato_mix: { assetId: "food-bowl", scale: 0.8 },
  cooling_gelato: { assetId: "food-gelato", scale: 1.7 },
};
