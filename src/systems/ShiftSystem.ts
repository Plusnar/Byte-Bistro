import { BALANCE } from "../data/balance";
import { starsForCoins } from "../data/levelGoals";
import type { RuntimeGameState, ShiftRank, ShiftResult, StarThresholds } from "../types/game";
import { clamp } from "../utils/math";
import { ScoreSystem } from "./ScoreSystem";

/** A level that set no targets: reported as-is, and no coin total earns a star. */
const NO_STAR_THRESHOLDS: StarThresholds = {
  one: Number.POSITIVE_INFINITY,
  two: Number.POSITIVE_INFINITY,
  three: Number.POSITIVE_INFINITY,
};

export class ShiftSystem {
  constructor(private readonly scoreSystem: ScoreSystem = new ScoreSystem()) {}

  start(
    state: RuntimeGameState,
    durationSeconds: number = BALANCE.shift.standardDurationSeconds,
  ): RuntimeGameState {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error("Shift duration must be greater than zero");
    }
    return {
      ...state,
      shiftDuration: durationSeconds,
      shiftTimeRemaining: durationSeconds,
      score: 0,
      activeOrders: [],
      completedOrders: 0,
      failedOrders: 0,
      combo: 0,
      maxCombo: 0,
      meltdowns: 0,
      componentsThrown: 0,
      servedDishes: [],
      paused: false,
      shiftEnded: false,
    };
  }

  tick(state: RuntimeGameState, deltaSeconds: number): RuntimeGameState {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new Error("Shift delta must be a finite non-negative value");
    }
    if (state.paused || state.shiftEnded || deltaSeconds === 0) {
      return state;
    }
    const remaining = Math.max(0, state.shiftTimeRemaining - deltaSeconds);
    if (remaining > 0) {
      return { ...state, shiftTimeRemaining: remaining };
    }
    // Every outstanding ticket is lost at the buzzer. They stay in the array, marked failed,
    // so the caller can diff against its pre-tick snapshot and emit one event per order.
    const outstanding = state.activeOrders.filter((order) => order.status === "active");
    return {
      ...state,
      shiftTimeRemaining: 0,
      shiftEnded: true,
      failedOrders: state.failedOrders + outstanding.length,
      activeOrders: state.activeOrders.map((order) =>
        order.status === "active" ? { ...order, status: "failed" as const } : order,
      ),
    };
  }

  /**
   * @param starThresholds what this level asks for, from `src/data/levelGoals.ts`. Left
   * out, the result still reports its coins and simply earns no stars.
   */
  createResult(state: RuntimeGameState, starThresholds?: StarThresholds): ShiftResult {
    const averageDishQuality =
      state.servedDishes.length === 0
        ? 0
        : state.servedDishes.reduce((sum, dish) => sum + dish.quality, 0) /
          state.servedDishes.length;
    const cookingScore = this.scoreSystem.calculateShiftScore({
      baseScore: state.score,
      completedOrders: state.completedOrders,
      failedOrders: state.failedOrders,
      finalAIState: state.aiState,
    });
    const performance = this.calculatePerformance(
      state.completedOrders,
      state.failedOrders,
      averageDishQuality,
      cookingScore,
      this.scoreSystem.calculateAICondition(state.aiState),
    );
    return {
      ordersCompleted: state.completedOrders,
      ordersFailed: state.failedOrders,
      averageDishQuality,
      miraStability: state.aiState.stability,
      maxCombo: state.maxCombo,
      meltdowns: state.meltdowns,
      componentsThrown: state.componentsThrown,
      teamSynchronization: clamp(
        58 + state.maxCombo * 8 + Math.min(18, state.componentsThrown * 1.5) -
          state.failedOrders * 4 - state.meltdowns * 8,
        0,
        100,
      ),
      cookingScore,
      creditsEarned: Math.round(cookingScore * BALANCE.shift.creditsPerScore),
      rank: this.getRank(performance),
      // Coins are what the shift actually paid out; stars are what this level wanted for
      // it. The rank above stays the note on execution — the two answer different questions.
      coins: cookingScore,
      stars: starThresholds ? starsForCoins(cookingScore, starThresholds) : 0,
      starThresholds: starThresholds ?? NO_STAR_THRESHOLDS,
    };
  }

  calculatePerformance(
    completedOrders: number,
    failedOrders: number,
    averageQuality: number,
    cookingScore: number,
    aiCondition: number,
  ): number {
    const totalOrders = Math.max(0, completedOrders) + Math.max(0, failedOrders);
    const completion = totalOrders === 0 ? 0 : Math.max(0, completedOrders) / totalOrders;
    const targetScore = Math.max(1, totalOrders * BALANCE.shift.targetScorePerOrder);
    const scoreEfficiency = clamp(cookingScore / targetScore, 0, 1);
    const weights = BALANCE.shift.resultWeights;
    return (
      completion * weights.completion +
      clamp(averageQuality, 0, 1) * weights.quality +
      clamp(aiCondition / BALANCE.ai.maximum, 0, 1) * weights.aiCondition +
      scoreEfficiency * weights.scoreEfficiency
    ) * BALANCE.ai.maximum;
  }

  getRank(performance: number): ShiftRank {
    const thresholds = BALANCE.shift.rankThresholds;
    if (performance >= thresholds.S) return "S";
    if (performance >= thresholds.A) return "A";
    if (performance >= thresholds.B) return "B";
    if (performance >= thresholds.C) return "C";
    return "D";
  }
}
