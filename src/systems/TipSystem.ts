import { BALANCE } from "../data/balance";

/**
 * Tips and the serving streak, Overcooked style.
 *
 * The dish itself is paid for by `ScoreSystem.calculateDishScore`; this sits on top and
 * pays for *how* it was served — promptly, and one after another. Keeping the two apart is
 * what lets a slow, perfect plate and a rushed, scrappy one differ in the right way.
 *
 * The streak has a window. Before it did not, so it only ever reset on a wrong dish or a
 * lost ticket and a cook could bank one early and keep it all shift; now a quiet stretch
 * lets it lapse on its own, which is what makes a run of deliveries worth chasing.
 *
 * Pure and clock-injected: `KitchenScene` cannot be unit tested, so none of this lives there.
 */

export interface StreakState {
  /** Consecutive on-time deliveries; 0 when there is no run going. */
  readonly streak: number;
  /** Kitchen-clock milliseconds of the last delivery that counted. */
  readonly lastServedAtMs: number;
}

export const NO_STREAK: StreakState = { streak: 0, lastServedAtMs: 0 };

export interface ServeOutcome {
  /** Whether a real ticket was closed, rather than a dish nobody asked for. */
  readonly matchedOrder: boolean;
  /** How much of that ticket's deadline was left, 0..1; null when there was no ticket. */
  readonly remainingFraction: number | null;
  /** Kitchen-clock milliseconds, the same pausable clock freshness is measured on. */
  readonly nowMs: number;
}

export interface TipBreakdown {
  /** For serving one after another. */
  readonly streakTip: number;
  /** For serving well inside the deadline. */
  readonly promptTip: number;
  /** Taken off for a dish nobody ordered. */
  readonly penalty: number;
  /** What the tip is worth in all; never below zero on its own. */
  readonly total: number;
  readonly streak: StreakState;
}

/** Whether a delivery at `nowMs` still continues the run `state` was on. */
export const streakIsAlive = (state: StreakState, nowMs: number): boolean =>
  state.streak > 0 && nowMs - state.lastServedAtMs <= BALANCE.tip.comboWindowSeconds * 1_000;

/** The tip paid for the `streak`-th delivery in a row, the table's last step repeating. */
export const streakTip = (streak: number): number => {
  const tips: readonly number[] = BALANCE.tip.streakTips;
  if (streak <= 0 || tips.length === 0) return 0;
  return tips[Math.min(streak, tips.length) - 1] ?? 0;
};

/** The tip paid for having `remaining` of the deadline left, 0..1. */
export const promptTip = (remaining: number | null): number => {
  if (remaining === null) return 0;
  for (const tier of BALANCE.tip.promptTiers) {
    if (remaining >= tier.minimumRemaining) return tier.tip;
  }
  return 0;
};

/**
 * What a delivery pays on top of the dish, and what it leaves the run at.
 *
 * A dish nobody ordered ends the run and costs the wrong-dish penalty; a real ticket
 * extends it, or starts a fresh one when the window has lapsed.
 */
export const serve = (state: StreakState, outcome: ServeOutcome): TipBreakdown => {
  if (!outcome.matchedOrder) {
    return {
      streakTip: 0,
      promptTip: 0,
      penalty: BALANCE.tip.wrongDishPenalty,
      total: -BALANCE.tip.wrongDishPenalty,
      streak: NO_STREAK,
    };
  }
  const streak = streakIsAlive(state, outcome.nowMs) ? state.streak + 1 : 1;
  const fromStreak = streakTip(streak);
  const fromPromptness = promptTip(outcome.remainingFraction);
  return {
    streakTip: fromStreak,
    promptTip: fromPromptness,
    penalty: 0,
    total: fromStreak + fromPromptness,
    streak: { streak, lastServedAtMs: outcome.nowMs },
  };
};

/** A lost ticket: the run ends and it costs. */
export const failOrder = (): { readonly penalty: number; readonly streak: StreakState } => ({
  penalty: BALANCE.tip.failedOrderPenalty,
  streak: NO_STREAK,
});

/**
 * Lets a run lapse once its window has passed. Called every frame, so it returns the same
 * object when nothing changed rather than allocating.
 */
export const expireStreak = (state: StreakState, nowMs: number): StreakState =>
  state.streak > 0 && !streakIsAlive(state, nowMs) ? NO_STREAK : state;

/** How much of the streak window is left, 1 right after a delivery and 0 once it lapses. */
export const streakWindowRemaining = (state: StreakState, nowMs: number): number => {
  if (state.streak <= 0) return 0;
  const window = BALANCE.tip.comboWindowSeconds * 1_000;
  if (window <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - (nowMs - state.lastServedAtMs) / window));
};
