import { publicUrl } from "../utils/assetUrl";
import { bundledModelUrl } from "../core/assets/assetRegistry";

/**
 * Bespoke art for the six base ingredients: a bulk model for the crate, a single-unit model
 * for the carried/plated item, and a 2D icon for the HUD.
 *
 * The GLBs are bundled from `src/assets/` (hashed by Vite, same convention as
 * `scenarioAssets.ts`). The icons live in `public/` because the HUD resolves them at
 * runtime from a string id, which a bundled URL cannot express.
 */

export const INGREDIENT_IDS = [
  "ram_module",
  "binary_sugar",
  "cache_cream",
  "cache_fragment",
  "cooling_fluid",
  "data_cream",
] as const;

export type IngredientAssetId = (typeof INGREDIENT_IDS)[number];

/** Asset id for the single-unit model — what a chef carries and what sits on a plate. */
export const ingredientModelId = (id: string): string => `ingredient:${id}`;
/** Asset id for the bulk model — the body of the crate that dispenses it. */
export const ingredientCrateModelId = (id: string): string => `ingredient-crate:${id}`;
/** HUD icon for the order tickets. */
export const ingredientIconUrl = (id: string): string => publicUrl(`images/ingredients/${id}.png`);

const itemUrl: Readonly<Record<IngredientAssetId, string>> = {
  ram_module: bundledModelUrl("src/assets/ingredients/ram_module_item.glb"),
  binary_sugar: bundledModelUrl("src/assets/ingredients/binary_sugar_item.glb"),
  cache_cream: bundledModelUrl("src/assets/ingredients/cache_cream_item.glb"),
  cache_fragment: bundledModelUrl("src/assets/ingredients/cache_fragment_item.glb"),
  cooling_fluid: bundledModelUrl("src/assets/ingredients/cooling_fluid_item.glb"),
  data_cream: bundledModelUrl("src/assets/ingredients/data_cream_item.glb"),
};

const crateUrl: Readonly<Record<IngredientAssetId, string>> = {
  ram_module: bundledModelUrl("src/assets/ingredients/ram_module.glb"),
  binary_sugar: bundledModelUrl("src/assets/ingredients/binary_sugar.glb"),
  cache_cream: bundledModelUrl("src/assets/ingredients/cache_cream.glb"),
  cache_fragment: bundledModelUrl("src/assets/ingredients/cache_fragment.glb"),
  cooling_fluid: bundledModelUrl("src/assets/ingredients/cooling_fluid.glb"),
  data_cream: bundledModelUrl("src/assets/ingredients/data_cream.glb"),
};

const preparedItems = {
  ram_pizza: bundledModelUrl("src/assets/ingredients/ram_pizza.glb"),
  cache_donuts: bundledModelUrl("src/assets/ingredients/cache_donuts.glb"),
  gelato_parfait: bundledModelUrl("src/assets/ingredients/gelato_parfait.glb"),
  ssd_schnitzel: bundledModelUrl("src/assets/ingredients/ssd_schnitzel.glb"),
  thermal_paste_beer: bundledModelUrl("src/assets/ingredients/thermal_paste_beer.glb"),
  x_salada: bundledModelUrl("src/assets/ingredients/x_salada.glb"),
  drink_404: bundledModelUrl("src/assets/ingredients/drink_404.glb"),
  cyber_soda: bundledModelUrl("src/assets/ingredients/cyber_soda.glb"),
  pixel_punch: bundledModelUrl("src/assets/ingredients/pixel_punch.glb"),
} as const;

export const OVEN_TRAY_ASSET_ID = "cookware:oven-tray";
export const OVEN_TRAY_ASSET = {
  id: OVEN_TRAY_ASSET_ID,
  url: bundledModelUrl("src/assets/ingredients/oven_tray.glb"),
  required: true,
};

export const INGREDIENT_ASSETS: readonly { id: string; url: string; required: boolean }[] = [
  ...INGREDIENT_IDS.flatMap((id) => [
    { id: ingredientModelId(id), url: itemUrl[id], required: true },
    { id: ingredientCrateModelId(id), url: crateUrl[id], required: true },
  ]),
  ...Object.entries(preparedItems).map(([id, url]) => ({ id: ingredientModelId(id), url, required: true })),
];

/** Every asset id this module declares, for the manifest-resolution test. */
export const INGREDIENT_ASSET_IDS: ReadonlySet<string> = new Set(
  INGREDIENT_ASSETS.map((asset) => asset.id),
);
