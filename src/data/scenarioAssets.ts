import { ingredientModelId } from "./ingredientAssets";
import { bundledModelUrl } from "../core/assets/assetRegistry";
/** Curated Scenario assets used to build SERVER ROOM 01. */
export const SCENARIO_ASSETS = [
  {
    id: "scenario-room-wide",
    url: bundledModelUrl("src/assets/scenario/space-room-wide.glb"),
    required: true,
  },
  {
    id: "scenario-cables",
    url: bundledModelUrl("src/assets/scenario/space-cables.glb"),
    required: true,
  },
  {
    id: "scenario-machine",
    url: bundledModelUrl("src/assets/scenario/factory-machine.glb"),
    required: true,
  },
  {
    id: "scenario-machine-fortified",
    url: bundledModelUrl("src/assets/scenario/factory-machine-fortified.glb"),
    required: true,
  },
  {
    id: "scenario-machine-bed",
    url: bundledModelUrl("src/assets/scenario/factory-machine-bed.glb"),
    required: true,
  },
  {
    id: "scenario-hopper",
    url: bundledModelUrl("src/assets/scenario/factory-hopper-high-square.glb"),
    required: true,
  },
  {
    id: "scenario-scanner-low",
    url: bundledModelUrl("src/assets/scenario/factory-scanner-low.glb"),
    required: true,
  },
  {
    id: "scenario-screen-wide",
    url: bundledModelUrl("src/assets/scenario/factory-screen-wide.glb"),
    required: true,
  },
  {
    id: "scenario-conveyor-long",
    url: bundledModelUrl("src/assets/scenario/factory-conveyor-long-sides.glb"),
    required: true,
  },
  {
    id: "scenario-robot-arm",
    url: bundledModelUrl("src/assets/scenario/factory-robot-arm-a.glb"),
    required: true,
  },
  {
    id: "scenario-pipe-long",
    url: bundledModelUrl("src/assets/scenario/factory-pipe-large-long.glb"),
    required: true,
  },
  {
    id: "scenario-pipe-bend",
    url: bundledModelUrl("src/assets/scenario/factory-pipe-large-bend.glb"),
    required: true,
  },
  {
    id: "scenario-pipe-valve",
    url: bundledModelUrl("src/assets/scenario/factory-pipe-large-valve.glb"),
    required: true,
  },
  {
    id: "scenario-box-large",
    url: bundledModelUrl("src/assets/scenario/factory-box-large.glb"),
    required: true,
  },
  {
    id: "scenario-box-small",
    url: bundledModelUrl("src/assets/scenario/factory-box-small.glb"),
    required: true,
  },
  {
    id: "scenario-freezer-standing",
    url: bundledModelUrl("src/assets/scenario/market-freezers-standing.glb"),
    required: true,
  },
  {
    id: "scenario-shelf-boxes",
    url: bundledModelUrl("src/assets/scenario/market-shelf-boxes.glb"),
    required: true,
  },
  {
    id: "scenario-cash-register",
    url: bundledModelUrl("src/assets/scenario/market-cash-register.glb"),
    required: true,
  },
  {
    id: "food-chocolate",
    url: bundledModelUrl("src/assets/scenario/food-chocolate.glb"),
    required: true,
  },
  {
    id: "food-sugar",
    url: bundledModelUrl("src/assets/scenario/food-shaker-salt.glb"),
    required: true,
  },
  {
    id: "food-carton",
    url: bundledModelUrl("src/assets/scenario/food-carton-small.glb"),
    required: true,
  },
  {
    id: "food-candy-bar",
    url: bundledModelUrl("src/assets/scenario/food-candy-bar.glb"),
    required: true,
  },
  {
    id: "food-coolant",
    url: bundledModelUrl("src/assets/scenario/food-soda-bottle.glb"),
    required: true,
  },
  {
    id: "food-whipped-cream",
    url: bundledModelUrl("src/assets/scenario/food-whipped-cream.glb"),
    required: true,
  },
  {
    id: "food-bowl",
    url: bundledModelUrl("src/assets/scenario/food-bowl.glb"),
    required: true,
  },
  {
    id: "food-bread",
    url: bundledModelUrl("src/assets/scenario/food-bread.glb"),
    required: true,
  },
  {
    id: "food-cake",
    url: bundledModelUrl("src/assets/scenario/food-cake.glb"),
    required: true,
  },
  {
    id: "food-cake-finished",
    url: bundledModelUrl("src/assets/scenario/food-cake-birthday.glb"),
    required: true,
  },
  {
    id: "food-cookie",
    url: bundledModelUrl("src/assets/scenario/food-cookie-chocolate.glb"),
    required: true,
  },
  {
    id: "food-gelato",
    url: bundledModelUrl("src/assets/scenario/food-ice-cream-cup.glb"),
    required: true,
  },
] as const;

/**
 * SCENARIO_ASSETS for a kitchen whose level places `placedAssetIds`.
 *
 * The `food-*` models are prepared dishes: any shift can need them, so they load with the
 * match. The rest are the old server room's machines and shell, which only the editor's
 * catalogue still offers — downloading and parsing all eighteen before every shift of a
 * level that places none of them was pure waste. They load on demand instead; a level
 * that does place one gets it with the match, as before.
 */
export const scenarioAssetsFor = (placedAssetIds: Iterable<string>) => {
  const placed = new Set(placedAssetIds);
  return SCENARIO_ASSETS.map((asset) =>
    asset.id.startsWith("food-") || placed.has(asset.id) ? asset : { ...asset, lazy: true });
};

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
  ram_dough: { assetId: ingredientModelId("ram_dough"), scale: 0.32 },
  ram_cake_base: { assetId: "food-cake", scale: 0.5 },
  ram_cake: { assetId: "food-cake-finished", scale: 0.5 },
  donut_dough: { assetId: ingredientModelId("donut_dough"), scale: 0.32 },
  cache_cookies: { assetId: "food-cookie", scale: 2.7 },
  gelato_mix: { assetId: ingredientModelId("gelato_mix"), scale: 0.32 },
  ram_pizza: { assetId: ingredientModelId("ram_pizza"), scale: 0.51 },
  cache_donuts: { assetId: ingredientModelId("cache_donuts"), scale: 0.46 },
  gelato_parfait: { assetId: ingredientModelId("gelato_parfait"), scale: 0.49 },
  ssd_schnitzel: { assetId: ingredientModelId("ssd_schnitzel"), scale: 0.5 },
  thermal_paste_beer: { assetId: ingredientModelId("thermal_paste_beer"), scale: 0.48 },
  cooling_gelato: { assetId: "food-gelato", scale: 1.7 },
};
