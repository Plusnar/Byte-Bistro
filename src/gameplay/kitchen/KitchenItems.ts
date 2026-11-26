import { localizedRecord, t } from "../../i18n";
import { BALANCE } from "../../data/balance";
import {
  BURN_GRACE_SECONDS,
  COOKWARE_CAPACITY,
  COOK_SECONDS,
  FIRE_DELAY_SECONDS,
  FOOD_STATE_LABEL,
  HEATED_COOKWARE,
  PLATE_CAPACITY,
  STATE_OF_VESSEL,
  cookableState,
  getFoodDefinition,
  isPlateableState,
  vesselsFor,
  type CookwareKind,
} from "../../data/kitchen";
import { getIngredient } from "../../data/ingredients";
import { CookingSystem } from "../../systems/CookingSystem";
import type { FoodState, RecipeComponent, RecipeData } from "../../types/game";
import { createUid } from "../../utils/math";

/** Stateless; one instance is enough for the whole kitchen. */
const COOKING = new CookingSystem();

/** Read through, never spread: each access gives the current language's text. */
const COOKWARE_LABEL: Readonly<Record<CookwareKind, string>> = localizedRecord(
  ["pan", "pot", "tray", "bowl"],
  "kitchen",
);

/**
 * Seconds for abandoned chop/wash progress to rewind to zero.
 *
 * A rewind rather than an instant reset: `slot.target` can flicker for a single frame when
 * a player brushes the edge of a station's reach, and throwing away two seconds of chopping
 * for one dropped frame would feel broken. At 0.45s this is visually the same snap-back.
 */
export const PROGRESS_RESET_SECONDS = 0.45;

/** Rewinds `progress` toward zero. */
export const decayProgress = (
  progress: number,
  deltaSeconds: number,
  resetSeconds: number = PROGRESS_RESET_SECONDS,
): number => (progress <= 0 ? 0 : Math.max(0, progress - deltaSeconds / resetSeconds));

export interface FoodItem {
  readonly kind: "food";
  readonly uid: string;
  readonly ingredientId: string;
  state: FoodState;
  /** 0..1 progress of held chopping; rewinds to zero when the chop is abandoned. */
  chopProgress: number;
  readonly createdAt: number;
  /**
   * How close to the ideal this was taken off the heat, 0..1. Undefined until it has
   * cooked at all, which reads as "nothing to judge" rather than as a bad cook — most
   * ingredients are never cooked, and those must not drag a plate's score down.
   *
   * This is what makes cooking well worth anything: `QualitySystem` weights it at .35, and
   * before it existed `deliverPlate` handed every dish the same default.
   */
  cookAccuracy?: number;
}

export interface PlateItem {
  readonly kind: "plate";
  readonly uid: string;
  dirty: boolean;
  readonly contents: FoodItem[];
}

export interface CookwareItem {
  readonly kind: CookwareKind;
  readonly uid: string;
  readonly contents: FoodItem[];
  /** Seconds spent on a lit stove since the current contents started cooking. */
  heat: number;
}

export interface ExtinguisherItem {
  readonly kind: "extinguisher";
  readonly uid: string;
}

export type KitchenItem = FoodItem | PlateItem | CookwareItem | ExtinguisherItem;

export const createFood = (ingredientId: string, now: number): FoodItem => ({
  kind: "food",
  uid: createUid(ingredientId),
  ingredientId,
  state: "raw",
  chopProgress: 0,
  createdAt: now,
});

export const createPlate = (dirty = false): PlateItem => ({
  kind: "plate",
  uid: createUid("plate"),
  dirty,
  contents: [],
});

export const createCookware = (kind: CookwareKind): CookwareItem => ({
  kind,
  uid: createUid(kind),
  contents: [],
  heat: 0,
});

export const createExtinguisher = (): ExtinguisherItem => ({
  kind: "extinguisher",
  uid: createUid("extinguisher"),
});

const COOKWARE_KINDS: ReadonlySet<string> = new Set<CookwareKind>(["pan", "pot", "tray", "bowl"]);

export const isCookware = (item: KitchenItem | null): item is CookwareItem =>
  item !== null && COOKWARE_KINDS.has(item.kind);

/** A vessel that cooks with heat, so it can be ready, overdone or on fire. */
export const isHeatedCookware = (item: KitchenItem | null): item is CookwareItem =>
  isCookware(item) && HEATED_COOKWARE.has(item.kind);

// ---------------------------------------------------------------------------
// Cookware

export const cookwareCapacity = (cookware: CookwareItem): number =>
  COOKWARE_CAPACITY[cookware.kind];

/** Batched vessels scale with how much they hold, like Overcooked soups. */
export const cookDuration = (cookware: CookwareItem): number => {
  const capacity = cookwareCapacity(cookware);
  if (capacity <= 1) return COOK_SECONDS[cookware.kind];
  return (COOK_SECONDS[cookware.kind] * Math.max(1, cookware.contents.length)) / capacity;
};

export const isCookwareBurnt = (cookware: CookwareItem): boolean =>
  cookware.contents.some((food) => food.state === "burnt");

export const isCookwareCooked = (cookware: CookwareItem): boolean =>
  cookware.contents.length > 0 &&
  cookware.contents.every((food) => food.state === STATE_OF_VESSEL[cookware.kind]);

/** Whether the bowl holds something still waiting to be beaten. */
export const bowlHasUnmixed = (bowl: CookwareItem): boolean =>
  bowl.contents.some((food) => food.state !== STATE_OF_VESSEL.bowl);

/**
 * Whether `food` may go into `cookware`: prepared (chopped when it needs the board), and an
 * ingredient some recipe wants out of this vessel. A bowl takes the same rule as a pan: it
 * beats each ingredient in it, and none of them turns into something else.
 */
export const canAddToCookware = (cookware: CookwareItem, food: FoodItem): boolean => {
  const definition = getFoodDefinition(food.ingredientId);
  if (!definition || !vesselsFor(food.ingredientId).has(cookware.kind)) return false;
  if (food.state !== cookableState(definition)) return false;
  if (isCookwareBurnt(cookware)) return false;
  return cookware.contents.length < cookwareCapacity(cookware);
};

export const addToCookware = (cookware: CookwareItem, food: FoodItem): void => {
  cookware.contents.push(food);
  // A bowl keeps what it is given exactly as it is: chopping something and then watching
  // the bowl un-chop it would be absurd, and nothing in a bowl is cooking anyway.
  if (cookware.kind === "bowl") return;
  // Overcooked rule: dropping another ingredient in restarts the whole pot. Anything
  // already cooked goes back to its raw-for-the-pot state and the timer returns to zero,
  // so a late addition costs you the batch's progress.
  cookware.heat = 0;
  for (const entry of cookware.contents) {
    const definition = getFoodDefinition(entry.ingredientId);
    if (definition) entry.state = cookableState(definition);
  }
};

export const emptyCookware = (cookware: CookwareItem): FoodItem[] => {
  const removed = cookware.contents.splice(0);
  cookware.heat = 0;
  return removed;
};

export type CookEvent = "cooked" | "burnt" | "ignite";

/** Advances cookware sitting on a stove; returns thresholds crossed this tick. */
export const tickCookware = (cookware: CookwareItem, deltaSeconds: number): CookEvent[] => {
  // A bowl has nothing lit under it. Without this it would "finish" at zero seconds and
  // catch fire moments later, wherever a cook happened to leave it.
  if (!HEATED_COOKWARE.has(cookware.kind)) return [];
  if (cookware.contents.length === 0) {
    cookware.heat = 0;
    return [];
  }
  const before = cookware.heat;
  cookware.heat += deltaSeconds;
  const cooked = cookDuration(cookware);
  const burnt = cooked + BURN_GRACE_SECONDS[cookware.kind];
  const ignite = burnt + FIRE_DELAY_SECONDS;
  const events: CookEvent[] = [];
  if (before < cooked && cookware.heat >= cooked) {
    const done = STATE_OF_VESSEL[cookware.kind];
    for (const food of cookware.contents) if (food.state !== "burnt") food.state = done;
    events.push("cooked");
  }
  if (before < burnt && cookware.heat >= burnt) {
    for (const food of cookware.contents) food.state = "burnt";
    events.push("burnt");
  }
  if (before < ignite && cookware.heat >= ignite) events.push("ignite");
  // Judged every tick, not only on the thresholds: what matters is where it was when the
  // cook came back for it, and that is whatever the last tick before the lift recorded.
  if (cookware.heat > 0) {
    const accuracy = cookAccuracyFor(cookware);
    for (const food of cookware.contents) food.cookAccuracy = accuracy;
  }
  return events;
};

/**
 * How well this cookware is doing right now, 0..1.
 *
 * Peaks at the moment the food is ready and falls off either side: pulled early it is
 * underdone, left on it dries out and then burns. `CookingSystem` owns that curve, driven
 * by `BALANCE.cooking`.
 */
export const cookAccuracyFor = (cookware: CookwareItem): number => {
  const duration = cookDuration(cookware);
  if (duration <= 0) return 0;
  // The span is stretched so that the moment the food is ready lands exactly on the peak
  // of CookingSystem's ideal band. Anything else rewards leaving it on past the point the
  // HUD calls done, which is the opposite of what the station is asking of the player.
  const span = duration / BALANCE.cooking.defaultIdealProgress;
  return COOKING.evaluate(cookware.heat, span, duration).accuracy;
};

export interface CookwareProgress {
  /** 0..1 while cooking. */
  readonly cook: number;
  /** 0..1 inside the burn grace window; > 0 means the dish is overcooking. */
  readonly burn: number;
}

export const getCookwareProgress = (cookware: CookwareItem): CookwareProgress => {
  if (cookware.contents.length === 0) return { cook: 0, burn: 0 };
  const cooked = cookDuration(cookware);
  const grace = BURN_GRACE_SECONDS[cookware.kind];
  return {
    cook: Math.min(1, cookware.heat / cooked),
    burn: Math.min(1, Math.max(0, (cookware.heat - cooked) / grace)),
  };
};

// ---------------------------------------------------------------------------
// Plates and recipes

const componentKey = (component: RecipeComponent): string =>
  `${component.ingredientId}:${component.state}`;

const countComponents = (components: readonly RecipeComponent[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const component of components) {
    const key = componentKey(component);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const isSubMultiset = (
  candidate: readonly RecipeComponent[],
  target: readonly RecipeComponent[],
): boolean => {
  const available = countComponents(target);
  for (const [key, count] of countComponents(candidate)) {
    if ((available.get(key) ?? 0) < count) return false;
  }
  return true;
};

export const findMatchingRecipe = (
  contents: readonly RecipeComponent[],
  recipes: readonly RecipeData[],
): RecipeData | null =>
  recipes.find(
    (recipe) =>
      recipe.components.length === contents.length &&
      isSubMultiset(contents, recipe.components),
  ) ?? null;

/**
 * Any correctly-processed ingredient may be plated, even one that completes no recipe.
 *
 * Overcooked plates are dumb: you can ruin one, and the only recovery is the bin. Refusing
 * the ingredient instead would remove a real failure mode from the game. Burnt food is
 * rejected by `isPlateableState`.
 */
export const plateCanAccept = (plate: PlateItem, foods: readonly FoodItem[]): boolean => {
  if (plate.dirty || foods.length === 0) return false;
  if (plate.contents.length + foods.length > PLATE_CAPACITY) return false;
  for (const food of foods) {
    const definition = getFoodDefinition(food.ingredientId);
    if (!definition || !isPlateableState(definition, food.state)) return false;
  }
  return true;
};

/**
 * How well a finished plate was actually made, for `QualitySystem` to score.
 *
 * Cooking accuracy is the average over the components that were cooked at all — an
 * ingredient that only needed chopping has no opinion about the heat, and counting it as
 * perfect would dilute a genuinely bad cook. Presentation reads the plate itself: a full
 * plate of properly prepared food presents well, and anything burnt on it does not.
 */
export const plateQuality = (
  plate: PlateItem,
): { readonly cookingAccuracy: number; readonly presentation: number } => {
  const cooked = plate.contents.filter((food) => food.cookAccuracy !== undefined);
  const cookingAccuracy = cooked.length === 0
    ? 1
    : cooked.reduce((sum, food) => sum + (food.cookAccuracy ?? 0), 0) / cooked.length;

  const burnt = plate.contents.some((food) => food.state === "burnt");
  const misplated = plate.contents.some((food) => {
    const definition = getFoodDefinition(food.ingredientId);
    return !definition || !isPlateableState(definition, food.state);
  });
  const presentation = burnt ? 0.2 : misplated ? 0.55 : 0.95;
  return { cookingAccuracy, presentation };
};

// ---------------------------------------------------------------------------
// Combining a held item with the item on a station (Overcooked hand rules)

export interface CombineResult {
  readonly held: KitchenItem | null;
  readonly target: KitchenItem | null;
}

export const combineItems = (
  held: KitchenItem,
  target: KitchenItem,
): CombineResult | null => {
  if (held.kind === "plate" && target.kind === "food" && plateCanAccept(held, [target])) {
    held.contents.push(target);
    return { held, target: null };
  }
  if (held.kind === "food" && target.kind === "plate" && plateCanAccept(target, [held])) {
    target.contents.push(held);
    return { held: null, target };
  }
  // Pouring a vessel onto a plate. `plateCanAccept` already insists every item is in a
  // state it may be plated in: a pan of raw food fails, a beaten bowl or a fried pan pours.
  if (held.kind === "plate" && isCookware(target) && plateCanAccept(held, target.contents)) {
    held.contents.push(...emptyCookware(target));
    return { held, target };
  }
  if (isCookware(held) && target.kind === "plate" && plateCanAccept(target, held.contents)) {
    target.contents.push(...emptyCookware(held));
    return { held, target };
  }
  if (held.kind === "food" && isCookware(target) && canAddToCookware(target, held)) {
    addToCookware(target, held);
    return { held: null, target };
  }
  if (isCookware(held) && target.kind === "food" && canAddToCookware(held, target)) {
    addToCookware(held, target);
    return { held, target: null };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Labels

export const describeFood = (food: FoodItem): string => {
  const name = getIngredient(food.ingredientId)?.displayName ?? food.ingredientId;
  return t("kitchen.foodLabel", { name, state: FOOD_STATE_LABEL[food.state] });
};

export const describeItem = (item: KitchenItem, recipes: readonly RecipeData[]): string => {
  switch (item.kind) {
    case "food":
      return describeFood(item);
    case "plate": {
      if (item.dirty) return t("kitchen.plateDirtyItem");
      if (item.contents.length === 0) return t("kitchen.plateCleanItem");
      const recipe = findMatchingRecipe(item.contents, recipes);
      return t("kitchen.plateWith", {
        contents: recipe ? recipe.displayName : item.contents.map(describeFood).join(" + "),
      });
    }
    case "pan":
    case "pot":
    case "tray":
    case "bowl": {
      const name = COOKWARE_LABEL[item.kind];
      if (item.contents.length === 0) return t("kitchen.cookwareEmpty", { name });
      const key = isCookwareBurnt(item)
        ? "kitchen.cookwareBurnt"
        : isCookwareCooked(item)
          ? "kitchen.cookwareReady"
          : "kitchen.cookwareCooking";
      return t(key, { name, count: item.contents.length, capacity: cookwareCapacity(item) });
    }
    case "extinguisher":
      return t("kitchen.extinguisher");
  }
};
