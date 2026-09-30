import type { Order, RecipeData } from "../types/game";
import { STANDARD_DIFFICULTY, type DifficultyTuning } from "../data/difficulty";

/**
 * Pure decision logic for a queue of simultaneous orders: how many may be outstanding, how
 * often a new one arrives, and which one a finished dish should be credited to.
 *
 * Kept free of scene state so it can be unit tested — KitchenScene needs a Babylon engine
 * and cannot be.
 */

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * How many orders may be outstanding at once, ramping up as the shift progresses so the
 * opening acts as a tutorial and the last stretch is the pressure peak.
 */
export const maxConcurrentOrders = (
  shiftProgress: number,
  tuning: DifficultyTuning = STANDARD_DIFFICULTY,
): number => {
  const progress = clamp01(shiftProgress);
  const ramp: readonly { progress: number; max: number }[] = tuning.concurrencyRamp;
  let max = ramp[0]?.max ?? 1;
  for (const step of ramp) {
    if (progress >= step.progress) max = step.max;
  }
  return max;
};

/** Seconds between spawn attempts, tightening linearly over the shift. */
export const spawnIntervalSeconds = (
  shiftProgress: number,
  tuning: DifficultyTuning = STANDARD_DIFFICULTY,
): number => {
  const { start, end } = tuning.spawnIntervalSeconds;
  return start + (end - start) * clamp01(shiftProgress);
};

/**
 * Soonest deadline first. The whole queue keeps this order, which is what lets the HUD, the
 * task guide and the serve matcher all treat index 0 as "the most urgent ticket".
 */
export const sortByUrgency = (orders: readonly Order[]): Order[] =>
  [...orders].sort(
    (a, b) => a.expiresAt - b.expiresAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );

/**
 * Which outstanding order a dish of `recipeId` should close.
 *
 * Picks the one closest to expiry rather than the most valuable: with duplicate recipes in
 * the queue, "highest reward" would be farmable by sitting on a finished dish until a
 * fresher ticket for the same recipe appears and paying out its larger speed bonus.
 */
export const selectServeTarget = (
  orders: readonly Order[],
  recipeId: string,
  now: number,
): Order | null => {
  const candidates = orders.filter(
    (order) =>
      order.status === "active" &&
      order.expiresAt > now &&
      order.requestedRecipeId === recipeId,
  );
  return sortByUrgency(candidates)[0] ?? null;
};

/**
 * Recipe for the next ticket. Biases away from what the queue already holds so the board
 * stays varied, but allows duplicates once every recipe is already queued.
 */
export const nextSpawnRecipeId = (
  orders: readonly Order[],
  recipes: readonly RecipeData[],
  random: () => number,
): string => {
  if (recipes.length === 0) throw new Error("Cannot pick a recipe without recipes");
  const queued = new Set(
    orders.filter((o) => o.status === "active").map((o) => o.requestedRecipeId),
  );
  const fresh = recipes.filter((recipe) => !queued.has(recipe.id));
  const pool = fresh.length > 0 ? fresh : recipes;
  const roll = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return pool[Math.floor(roll * pool.length)]!.id;
};
