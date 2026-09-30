import type { RecipeData } from "../types/game";
import { BALANCE } from "./balance";
import { STANDARD_DIFFICULTY, type DifficultyTuning } from "./difficulty";
import { CHOP_SECONDS, COOK_SECONDS, FOOD_DEFINITIONS, POT_CAPACITY } from "./kitchen";

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
 * time, while a pot cooks a whole batch of POT_CAPACITY for the price of one — three
 * fragments in a pot cost 9s, not 27s.
 */
const cookSecondsFor = (kind: "pan" | "pot", count: number): number => {
  if (count <= 0) return 0;
  if (kind === "pan") return count * COOK_SECONDS.pan;
  const fullBatches = Math.floor(count / POT_CAPACITY);
  const remainder = count % POT_CAPACITY;
  return fullBatches * COOK_SECONDS.pot + (remainder * COOK_SECONDS.pot) / POT_CAPACITY;
};

export const recipeWorkload = (recipe: RecipeData): RecipeWorkload => {
  const order = BALANCE.order;
  let chopSeconds = 0;
  const cookCounts: Record<"pan" | "pot", number> = { pan: 0, pot: 0 };

  for (const component of recipe.components) {
    const definition = FOOD_DEFINITIONS[component.ingredientId];
    if (!definition) continue;
    if (definition.chop && component.state !== "raw") chopSeconds += CHOP_SECONDS;
    if (definition.cook && component.state === "cooked") cookCounts[definition.cook] += 1;
  }

  const cookSeconds =
    cookSecondsFor("pan", cookCounts.pan) + cookSecondsFor("pot", cookCounts.pot);
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
