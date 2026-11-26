import type { RecipeData } from "../types/game";
import { BALANCE } from "./balance";
import { STANDARD_DIFFICULTY, type DifficultyTuning } from "./difficulty";
import { CHOP_SECONDS, COOKWARE_CAPACITY, COOK_SECONDS, FOOD_DEFINITIONS, type CookwareKind, vesselForState } from "./kitchen";

/**
 * Derives each order's deadline from the real work its recipe demands instead of a flat
 * timer, so a two-chop gelato is not given the same window as a three-batch cookie plate.
 */
export interface RecipeWorkload {
  /** Fetching a clean plate and walking the finished dish to delivery. */
  readonly baseSeconds: number;
  /** One crate round-trip per component. */
  readonly fetchSeconds: number;
  /** Time on the cutting board. */
  readonly chopSeconds: number;
  /** Time on the stove, batched exactly as the kitchen simulates it. */
  readonly cookSeconds: number;
  /** The four above summed: a perfect single-cook run with no walking mistakes. */
  readonly idealSeconds: number;
}

/**
 * Mirrors `cookDuration` in gameplay/kitchen/KitchenItems.ts. A pan holds one item at a
 * time, while a batched vessel cooks a whole load for the price of one — three fragments
 * in a pot cost 9s, not 27s.
 */
const cookSecondsFor = (kind: CookwareKind, count: number): number => {
  if (count <= 0) return 0;
  const capacity = COOKWARE_CAPACITY[kind];
  const seconds = COOK_SECONDS[kind];
  if (capacity <= 1) return count * seconds;
  const fullBatches = Math.floor(count / capacity);
  const remainder = count % capacity;
  return fullBatches * seconds + (remainder * seconds) / capacity;
};

export const recipeWorkload = (recipe: RecipeData): RecipeWorkload => {
  const order = BALANCE.order;
  let chopSeconds = 0;
  const cookCounts: Record<CookwareKind, number> = { pan: 0, pot: 0, tray: 0, bowl: 0 };

  for (const component of recipe.components) {
    const definition = FOOD_DEFINITIONS[component.ingredientId];
    if (!definition) continue;
    if (definition.chop && component.state !== "raw") chopSeconds += CHOP_SECONDS;
    const vessel = vesselForState(component.state);
    if (vessel) cookCounts[vessel] += 1;
  }

  const cookSeconds = (Object.keys(cookCounts) as CookwareKind[])
    .reduce((sum, kind) => sum + cookSecondsFor(kind, cookCounts[kind]), 0);
  const fetchSeconds = recipe.components.length * order.perComponentFetchSeconds;
  const baseSeconds = order.baseSeconds;

  return {
    baseSeconds,
    fetchSeconds,
    chopSeconds,
    cookSeconds,
    idealSeconds: baseSeconds + fetchSeconds + chopSeconds + cookSeconds,
  };
};

/** The countdown an order for `recipe` starts with, rounded and clamped for readability. */
export const recipeOrderDurationSeconds = (
  recipe: RecipeData,
  tuning: DifficultyTuning = STANDARD_DIFFICULTY,
): number => {
  const order = BALANCE.order;
  const padded =
    recipeWorkload(recipe).idealSeconds * order.slackMultiplier * tuning.orderDurationMultiplier;
  const rounded = Math.round(padded / order.roundToSeconds) * order.roundToSeconds;
  return Math.min(order.maxDurationSeconds, Math.max(order.minDurationSeconds, rounded));
};

export const recipeOrderDurationMs = (
  recipe: RecipeData,
  tuning: DifficultyTuning = STANDARD_DIFFICULTY,
): number => recipeOrderDurationSeconds(recipe, tuning) * 1_000;
