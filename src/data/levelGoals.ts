import { BALANCE } from "./balance";
import { STANDARD_DIFFICULTY, type DifficultyTuning } from "./difficulty";
import { recipeWorkload } from "./recipeTiming";
import type { RecipeData, StarThresholds } from "../types/game";

export type { StarThresholds };

/**
 * How many coins a level is worth one, two and three stars for.
 *
 * Overcooked grades a kitchen by what it paid out, not by a separate opinion of how it
 * was played, so the stars come from the score. The S–D rank stays as the report's note on
 * execution; the stars are the goal.
 *
 * The thresholds are *derived*, never written down per level: how long the shift runs, how
 * much work each recipe on its menu really takes (`recipeWorkload`, the same function the
 * deadlines come from) and what the difficulty pays. That way adding a recipe with an extra
 * step re-balances every level that serves it instead of silently making it unwinnable.
 */

export interface LevelGoalInput {
  readonly shiftDurationSeconds: number;
  /** The recipes on this level's menu. */
  readonly recipes: readonly RecipeData[];
  readonly tuning?: DifficultyTuning;
}

/**
 * Share of a flawless shift each star asks for. Three stars is deliberately short of a
 * perfect run: a kitchen that never drops a plate is not the bar.
 */
const STAR_SHARES: StarThresholds = { one: 0.3, two: 0.55, three: 0.78 };

/** Rounded to something a player can read off a meter. */
const roundCoins = (value: number): number => Math.max(1, Math.round(value / 50) * 50);

/**
 * What a pair that never wastes a second would take home.
 *
 * Two cooks working in parallel, each ticket costing its own ideal seconds and paying its
 * reward plus the dish score's own share, scaled by the difficulty's payout.
 */
export const flawlessScore = (input: LevelGoalInput): number => {
  const tuning = input.tuning ?? STANDARD_DIFFICULTY;
  const menu = input.recipes;
  if (menu.length === 0 || input.shiftDurationSeconds <= 0) return 0;

  const averageWork = menu.reduce((sum, recipe) => sum + recipeWorkload(recipe).idealSeconds, 0) /
    menu.length;
  const averageReward = menu.reduce((sum, recipe) => sum + recipe.reward, 0) / menu.length;
  if (averageWork <= 0) return 0;

  // Two cooks, so two tickets can be in flight at once — capped by how many the queue
  // would ever let them have.
  const hands = 2;
  const deliveries = (input.shiftDurationSeconds / averageWork) * hands;
  // A delivered dish pays its reward scaled by how well it scored; a flawless run is the
  // whole of it, plus the per-order bonus the shift score adds.
  const perDelivery = averageReward * tuning.rewardMultiplier + BALANCE.score.completedOrderBonus;
  return deliveries * perDelivery;
};

/** Coin thresholds for one, two and three stars on this level. */
export const starThresholdsFor = (input: LevelGoalInput): StarThresholds => {
  const flawless = flawlessScore(input);
  if (flawless <= 0) return { one: 1, two: 2, three: 3 };
  return {
    one: roundCoins(flawless * STAR_SHARES.one),
    two: roundCoins(flawless * STAR_SHARES.two),
    three: roundCoins(flawless * STAR_SHARES.three),
  };
};

/** How many stars `coins` earns against `thresholds`. */
export const starsForCoins = (coins: number, thresholds: StarThresholds): 0 | 1 | 2 | 3 => {
  if (coins >= thresholds.three) return 3;
  if (coins >= thresholds.two) return 2;
  if (coins >= thresholds.one) return 1;
  return 0;
};

/** The next star's threshold, or null once all three are earned. */
export const nextStarTarget = (coins: number, thresholds: StarThresholds): number | null => {
  if (coins < thresholds.one) return thresholds.one;
  if (coins < thresholds.two) return thresholds.two;
  if (coins < thresholds.three) return thresholds.three;
  return null;
};

/**
 * Keeps hand-written thresholds sane: ascending, positive and whole. A level that sets its
 * own targets (`MapMeta.starCoins`) still cannot ask for a star at zero coins or put two
 * stars below one.
 */
export const sanitizeStarThresholds = (value: unknown): StarThresholds | undefined => {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  // Refused, not rounded up: a target of zero is a mistake, and quietly turning it into
  // one coin would hand out a star for doing nothing.
  const targets = value.map((entry) =>
    typeof entry === "number" && Number.isFinite(entry) && entry >= 1 ? Math.round(entry) : 0,
  );
  const [one, two, three] = targets;
  if (!one || !two || !three) return undefined;
  if (!(one < two && two < three)) return undefined;
  return { one, two, three };
};
