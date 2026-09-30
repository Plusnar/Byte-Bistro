import { BALANCE } from "../data/balance";
import type { DishQualityBreakdown, IngredientInstance, QualityLabel } from "../types/game";
import { clamp } from "../utils/math";

export interface QualityInput {
  ingredientQuality: number;
  cookingAccuracy: number;
  freshness: number;
  presentation: number;
  corruption: number;
}

const getQualityLabel = (quality: number): QualityLabel => {
  const match = BALANCE.quality.labels.find((entry) => quality >= entry.minimum);
  return match?.label ?? "CORRUPTED";
};

export class QualitySystem {
  calculate(input: QualityInput): DishQualityBreakdown {
    const ingredientQuality = clamp(input.ingredientQuality, 0, 1);
    const cookingAccuracy = clamp(input.cookingAccuracy, 0, 1);
    const freshness = clamp(input.freshness, 0, 1);
    const presentation = clamp(input.presentation, 0, 1);
    const corruptionPenalty =
      clamp(input.corruption, 0, 1) * BALANCE.quality.corruptionPenaltyMultiplier;
    const weights = BALANCE.quality.weights;
    const total = clamp(
      ingredientQuality * weights.ingredientQuality +
        cookingAccuracy * weights.cookingAccuracy +
        freshness * weights.freshness +
        presentation * weights.presentation -
        corruptionPenalty,
      0,
      1,
    );

    return {
      ingredientQuality,
      cookingAccuracy,
      freshness,
      presentation,
      corruptionPenalty,
      total,
      label: getQualityLabel(total),
    };
  }

  fromItem(item: IngredientInstance, now: number = Date.now()): DishQualityBreakdown {
    const age = Math.max(0, now - item.createdAt);
    const freshness = 1 - age / BALANCE.quality.freshnessLifetimeMs;
    return this.calculate({
      ingredientQuality: item.process.ingredientQuality,
      cookingAccuracy: item.process.cookingAccuracy,
      freshness,
      presentation: item.process.presentation,
      corruption: item.corruption,
    });
  }

  averageIngredientQuality(items: readonly IngredientInstance[]): number {
    if (items.length === 0) {
      return 0;
    }
    return items.reduce((sum, item) => sum + item.quality, 0) / items.length;
  }
}
