import { BALANCE } from "../data/balance";
import type { AIState, DishQualityBreakdown, Order } from "../types/game";
import { clamp } from "../utils/math";

export interface DishScoreInput {
  order: Order;
  quality: number | DishQualityBreakdown;
  servedAt?: number;
  matchedOrder: boolean;
  addressesCriticalNeed?: boolean;
}

export interface ShiftScoreInput {
  baseScore: number;
  completedOrders: number;
  failedOrders: number;
  finalAIState: AIState;
}

const QUALITY_KEYS: readonly (keyof AIState)[] = [
  "memory",
  "processing",
  "creativity",
  "stability",
  "energy",
  "mood",
];

export class ScoreSystem {
  calculateDishScore(input: DishScoreInput): number {
    const quality = clamp(
      typeof input.quality === "number" ? input.quality : input.quality.total,
      0,
      1,
    );
    const duration = Math.max(1, input.order.expiresAt - input.order.createdAt);
    const servedAt = input.servedAt ?? Date.now();
    const speed = clamp((input.order.expiresAt - servedAt) / duration, 0, 1);
    const scoreBalance = BALANCE.score;
    const multiplier =
      scoreBalance.completionShare +
      quality * scoreBalance.qualityShare +
      speed * scoreBalance.speedShare +
      (input.addressesCriticalNeed === true ? scoreBalance.criticalNeedShare : 0);
    const matchMultiplier = input.matchedOrder ? 1 : scoreBalance.unmatchedDishMultiplier;
    return Math.max(0, Math.round(input.order.reward * multiplier * matchMultiplier));
  }

  calculateAICondition(state: AIState): number {
    const positiveAttributes = QUALITY_KEYS.reduce((sum, key) => sum + state[key], 0);
    const thermalSafety = BALANCE.ai.maximum - state.temperature;
    return clamp(
      (positiveAttributes + thermalSafety) / (QUALITY_KEYS.length + 1),
      BALANCE.ai.minimum,
      BALANCE.ai.maximum,
    );
  }

  calculateShiftScore(input: ShiftScoreInput): number {
    const completionBonus =
      Math.max(0, input.completedOrders) * BALANCE.score.completedOrderBonus;
    const failedPenalty = Math.max(0, input.failedOrders) * BALANCE.score.failedOrderPenalty;
    const stabilityBonus =
      (this.calculateAICondition(input.finalAIState) / BALANCE.ai.maximum) *
      BALANCE.score.stabilityBonusMaximum;
    return Math.max(
      0,
      Math.round(Math.max(0, input.baseScore) + completionBonus + stabilityBonus - failedPenalty),
    );
  }
}
