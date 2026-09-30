import { publicUrl } from "../utils/assetUrl";

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
  ram_module: new URL("../assets/ingredients/ram_module_item.glb", import.meta.url).href,
  binary_sugar: new URL("../assets/ingredients/binary_sugar_item.glb", import.meta.url).href,
  cache_cream: new URL("../assets/ingredients/cache_cream_item.glb", import.meta.url).href,
  cache_fragment: new URL("../assets/ingredients/cache_fragment_item.glb", import.meta.url).href,
  cooling_fluid: new URL("../assets/ingredients/cooling_fluid_item.glb", import.meta.url).href,
  data_cream: new URL("../assets/ingredients/data_cream_item.glb", import.meta.url).href,
};

const crateUrl: Readonly<Record<IngredientAssetId, string>> = {
  ram_module: new URL("../assets/ingredients/ram_module.glb", import.meta.url).href,
  binary_sugar: new URL("../assets/ingredients/binary_sugar.glb", import.meta.url).href,
  cache_cream: new URL("../assets/ingredients/cache_cream.glb", import.meta.url).href,
  cache_fragment: new URL("../assets/ingredients/cache_fragment.glb", import.meta.url).href,
  cooling_fluid: new URL("../assets/ingredients/cooling_fluid.glb", import.meta.url).href,
  data_cream: new URL("../assets/ingredients/data_cream.glb", import.meta.url).href,
};

export const INGREDIENT_ASSETS: readonly { id: string; url: string; required: boolean }[] =
  INGREDIENT_IDS.flatMap((id) => [
    { id: ingredientModelId(id), url: itemUrl[id], required: true },
    { id: ingredientCrateModelId(id), url: crateUrl[id], required: true },
  ]);

/** Every asset id this module declares, for the manifest-resolution test. */
export const INGREDIENT_ASSET_IDS: ReadonlySet<string> = new Set(
  INGREDIENT_ASSETS.map((asset) => asset.id),
);
