import {
  BURN_GRACE_SECONDS,
  COOK_SECONDS,
  FIRE_DELAY_SECONDS,
  FOOD_STATE_LABEL,
  PLATE_CAPACITY,
  POT_CAPACITY,
  cookableState,
  getFoodDefinition,
  plateableState,
  type CookwareKind,
} from "../../data/kitchen";
import { getIngredient } from "../../data/ingredients";
import type { FoodState, RecipeComponent, RecipeData } from "../../types/game";
import { createUid } from "../../utils/math";

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

export const isCookware = (item: KitchenItem | null): item is CookwareItem =>
  item?.kind === "pan" || item?.kind === "pot";

// ---------------------------------------------------------------------------
// Cookware

export const cookwareCapacity = (cookware: CookwareItem): number =>
  cookware.kind === "pan" ? 1 : POT_CAPACITY;

/** Pots scale with how many ingredients they hold, like Overcooked soups. */
export const cookDuration = (cookware: CookwareItem): number =>
  cookware.kind === "pan"
    ? COOK_SECONDS.pan
    : (COOK_SECONDS.pot * Math.max(1, cookware.contents.length)) / POT_CAPACITY;

export const isCookwareBurnt = (cookware: CookwareItem): boolean =>
  cookware.contents.some((food) => food.state === "burnt");

export const isCookwareCooked = (cookware: CookwareItem): boolean =>
  cookware.contents.length > 0 && cookware.contents.every((food) => food.state === "cooked");

export const canAddToCookware = (cookware: CookwareItem, food: FoodItem): boolean => {
  const definition = getFoodDefinition(food.ingredientId);
  if (!definition || definition.cook !== cookware.kind) return false;
  if (food.state !== cookableState(definition)) return false;
  if (isCookwareBurnt(cookware)) return false;
  return cookware.contents.length < cookwareCapacity(cookware);
};

export const addToCookware = (cookware: CookwareItem, food: FoodItem): void => {
  cookware.contents.push(food);
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
    for (const food of cookware.contents) if (food.state !== "burnt") food.state = "cooked";
    events.push("cooked");
  }
  if (before < burnt && cookware.heat >= burnt) {
    for (const food of cookware.contents) food.state = "burnt";
    events.push("burnt");
  }
  if (before < ignite && cookware.heat >= ignite) events.push("ignite");
  return events;
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
 * the ingredient instead would remove a real failure mode from the game.
 *
 * Burnt food is still rejected, because `plateableState` only ever returns raw, chopped or
 * cooked — no extra guard needed.
 */
export const plateCanAccept = (plate: PlateItem, foods: readonly FoodItem[]): boolean => {
  if (plate.dirty || foods.length === 0) return false;
  if (plate.contents.length + foods.length > PLATE_CAPACITY) return false;
  for (const food of foods) {
    const definition = getFoodDefinition(food.ingredientId);
    if (!definition || food.state !== plateableState(definition)) return false;
  }
  return true;
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
  if (held.kind === "plate" && isCookware(target) && isCookwareCooked(target) &&
    plateCanAccept(held, target.contents)) {
    held.contents.push(...emptyCookware(target));
    return { held, target };
  }
  if (isCookware(held) && target.kind === "plate" && isCookwareCooked(held) &&
    plateCanAccept(target, held.contents)) {
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
  return `${name} (${FOOD_STATE_LABEL[food.state]})`;
};

export const describeItem = (item: KitchenItem, recipes: readonly RecipeData[]): string => {
  switch (item.kind) {
    case "food":
      return describeFood(item);
    case "plate": {
      if (item.dirty) return "Prato sujo";
      if (item.contents.length === 0) return "Prato limpo";
      const recipe = findMatchingRecipe(item.contents, recipes);
      return recipe
        ? `Prato: ${recipe.displayName}`
        : `Prato: ${item.contents.map(describeFood).join(" + ")}`;
    }
    case "pan":
    case "pot": {
      const name = item.kind === "pan" ? "Frigideira" : "Panela";
      if (item.contents.length === 0) return `${name} vazia`;
      const state = isCookwareBurnt(item)
        ? "queimada"
        : isCookwareCooked(item)
          ? "pronta"
          : "cozinhando";
      return `${name} ${state} (${item.contents.length}/${cookwareCapacity(item)})`;
    }
    case "extinguisher":
      return "Extintor";
  }
};
