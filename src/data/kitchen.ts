import type { FoodState, KitchenStationKind } from "../types/game";
import {
  INGREDIENT_IDS,
  ingredientCrateModelId,
  ingredientModelId,
} from "./ingredientAssets";

/** Side of one kitchen grid tile in world units; every station occupies one tile. */
export const KITCHEN_TILE = 1.2;
/** Height of a counter top; items resting on stations sit here. */
export const COUNTER_HEIGHT = 0.9;

export type CookwareKind = "pan" | "pot";

export interface ModelVisual {
  readonly assetId: string;
  readonly scale: number;
  readonly y?: number;
  /** Multiplied into the instantiated materials; carries state feedback on a shared model. */
  readonly tint?: string;
  /**
   * Target size in metres across the model's largest axis. When set, the instantiated model
   * is measured and normalised to it, and `scale` becomes a multiplier on that target. Use
   * it for hand-authored art whose authored scale cannot be relied on.
   */
  readonly fitToSize?: number;
}

export interface FoodDefinition {
  readonly ingredientId: string;
  /** Needs a cutting board before it can be cooked or plated. */
  readonly chop: boolean;
  /** Cookware that turns the prepared food into its cooked state. */
  readonly cook: CookwareKind | null;
  readonly visuals: Readonly<Partial<Record<FoodState, ModelVisual>>>;
}

// Paths match the editor asset library so both share asset ids ("library:<path>").
const RESTAURANT_BASE =
  "Scenario/KayKit_Restaurant_Bits_1.0_FREE/KayKit_Restaurant_Bits_1.0_FREE/Assets/gltf";
const PROTOTYPE_BASE =
  "Scenario/KayKit_Prototype_Bits_1.1_FREE/KayKit_Prototype_Bits_1.1_FREE/Assets/gltf";

/**
 * KayKit models the kitchen actually instantiates. `preloadAll` fetches every one of these
 * before a shift, so an unused name here is a download nobody sees — the 15
 * `food_ingredient_*` placeholders and the themed crates were dropped once the bespoke
 * ingredient art replaced them. The type below keeps this honest: removing a name that is
 * still used is a compile error.
 */
const RESTAURANT_MODELS = [
  "kitchencounter_straight_A",
  "kitchencounter_straight_B",
  "kitchencounter_sink",
  "stove_single",
  "cuttingboard",
  "knife",
  "plate",
  "plate_dirty",
  "pan_A",
  "pot_A",
  "pot_A_stew",
  "crate",
] as const;

export type KitchenModelName = (typeof RESTAURANT_MODELS)[number] | "barrel";

const modelPath = (name: KitchenModelName): string =>
  name === "barrel" ? `${PROTOTYPE_BASE}/Barrel_A.gltf` : `${RESTAURANT_BASE}/${name}.gltf`;

export const kitchenAssetId = (name: KitchenModelName): string => `library:${modelPath(name)}`;

/** AssetManager definitions for every model the kitchen gameplay can spawn. */
export const KITCHEN_ASSETS: readonly { id: string; url: string; required: boolean }[] = [
  ...RESTAURANT_MODELS,
  "barrel" as const,
].map((name) => ({
  id: kitchenAssetId(name),
  url: `${import.meta.env.BASE_URL}asset-library/${modelPath(name)}`,
  required: true,
}));

/**
 * A single-unit ingredient model from the bespoke art set.
 *
 * The authored sizes disagree by 5x across the set, so these are normalised at runtime
 * rather than trusted; `scale` is a per-state multiplier on the normalised size.
 */
const INGREDIENT_ITEM_SIZE = 0.34;

const ingredientVisual = (id: string, scale: number): ModelVisual => ({
  assetId: ingredientModelId(id),
  scale,
  fitToSize: INGREDIENT_ITEM_SIZE,
});

export const FOOD_DEFINITIONS: Readonly<Record<string, FoodDefinition>> = {
  ram_module: {
    ingredientId: "ram_module",
    chop: true,
    cook: "pan",
    visuals: { raw: ingredientVisual("ram_module", 0.85) },
  },
  binary_sugar: {
    ingredientId: "binary_sugar",
    chop: false,
    cook: null,
    visuals: { raw: ingredientVisual("binary_sugar", 0.85) },
  },
  cache_cream: {
    ingredientId: "cache_cream",
    chop: true,
    cook: null,
    visuals: { raw: ingredientVisual("cache_cream", 0.85) },
  },
  cache_fragment: {
    ingredientId: "cache_fragment",
    chop: true,
    cook: "pot",
    visuals: { raw: ingredientVisual("cache_fragment", 0.85) },
  },
  cooling_fluid: {
    ingredientId: "cooling_fluid",
    chop: true,
    cook: null,
    visuals: { raw: ingredientVisual("cooling_fluid", 0.85) },
  },
  data_cream: {
    ingredientId: "data_cream",
    chop: true,
    cook: null,
    visuals: { raw: ingredientVisual("data_cream", 0.85) },
  },
};

/**
 * How each preparation state reads on the shared per-ingredient model.
 *
 * The bespoke art ships one model per ingredient, but state is load-bearing gameplay
 * information — a burnt fragment must look burnt. Tint and scale carry that instead of
 * mixing in props from a different art set.
 */
export const STATE_PRESENTATION: Readonly<Record<FoodState, { tint: string; stateScale: number }>> = {
  raw: { tint: "#FFFFFF", stateScale: 1 },
  chopped: { tint: "#DCEEF5", stateScale: 0.74 },
  cooked: { tint: "#FFC98A", stateScale: 0.92 },
  burnt: { tint: "#4A4038", stateScale: 0.88 },
};

/**
 * The visual for `state`, synthesised from the ingredient's single model when that state
 * has no art of its own.
 */
export const foodVisualFor = (
  definition: FoodDefinition,
  state: FoodState,
): ModelVisual | undefined => {
  const explicit = definition.visuals[state];
  if (explicit) return explicit;
  const base = definition.visuals.raw;
  if (!base) return undefined;
  const presentation = STATE_PRESENTATION[state];
  return {
    assetId: base.assetId,
    scale: base.scale * presentation.stateScale,
    y: base.y,
    tint: presentation.tint,
  };
};

/** The bulk model that forms the body of each ingredient crate. */
export const CRATE_MODEL_BY_INGREDIENT: Readonly<Record<string, string>> = Object.fromEntries(
  INGREDIENT_IDS.map((id) => [id, ingredientCrateModelId(id)]),
);

export const getFoodDefinition = (ingredientId: string): FoodDefinition | undefined =>
  FOOD_DEFINITIONS[ingredientId];

/** The one state in which an ingredient may be plated (Overcooked rule). */
export const plateableState = (definition: FoodDefinition): FoodState =>
  definition.cook ? "cooked" : definition.chop ? "chopped" : "raw";

/** The state an ingredient must be in before it enters cookware. */
export const cookableState = (definition: FoodDefinition): FoodState =>
  definition.chop ? "chopped" : "raw";

export const FOOD_STATE_LABEL: Readonly<Record<FoodState, string>> = {
  raw: "cru",
  chopped: "picado",
  cooked: "cozido",
  burnt: "queimado",
};

export const STATION_KIND_LABEL: Readonly<Record<KitchenStationKind, string>> = {
  crate: "Caixa de ingredientes",
  counter: "Bancada",
  cutting_board: "Tábua de corte",
  stove: "Fogão",
  sink: "Pia",
  plate_rack: "Pratos limpos",
  dirty_return: "Pratos sujos",
  trash: "Lixo",
  delivery: "Entrega",
  extinguisher_stand: "Extintor",
};

/** Seconds of held chopping to turn a raw ingredient into its chopped state. */
export const CHOP_SECONDS = 2.2;
/** Seconds of held washing per dirty plate. */
export const WASH_SECONDS = 2.4;
export const COOK_SECONDS: Readonly<Record<CookwareKind, number>> = { pan: 6, pot: 9 };
/** Grace window after cooking completes before the food burns. */
export const BURN_GRACE_SECONDS: Readonly<Record<CookwareKind, number>> = { pan: 6, pot: 8 };
/** Burnt food keeps heating; after this the stove catches fire. */
export const FIRE_DELAY_SECONDS = 2.5;
export const FIRE_SPREAD_SECONDS = 5;
export const EXTINGUISH_SECONDS = 1.1;
export const POT_CAPACITY = 3;
export const PLATE_CAPACITY = 4;
export const DIRTY_PLATE_RETURN_SECONDS = 7;
export const STARTING_CLEAN_PLATES = 4;
