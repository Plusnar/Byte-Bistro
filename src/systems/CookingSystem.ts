import { BALANCE } from "../data/balance";
import { clamp } from "../utils/math";

export type CookingState = "UNDERCOOKED" | "IDEAL" | "COOKED" | "BURNED";

export interface CookingEvaluation {
  state: CookingState;
  progress: number;
  accuracy: number;
}

export class CookingSystem {
  evaluate(elapsed: number, duration: number, idealDuration?: number): CookingEvaluation {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Cooking duration must be greater than zero");
    }

    const safeElapsed = Math.max(0, elapsed);
    const progress = safeElapsed / duration;
    const {
      undercookedEnd,
      idealEnd,
      cookedEnd,
      defaultIdealProgress,
      idealEdgeAccuracy,
      cookedEndAccuracy,
      burnedAccuracyLossPerProgress,
    } = BALANCE.cooking;
    let state: CookingState;
    let accuracy: number;

    if (progress < undercookedEnd) {
      state = "UNDERCOOKED";
      accuracy = (progress / undercookedEnd) * idealEdgeAccuracy;
    } else if (progress <= idealEnd) {
      state = "IDEAL";
      const target = clamp(
        idealDuration === undefined ? defaultIdealProgress : idealDuration / duration,
        undercookedEnd,
        idealEnd,
      );
      const maximumDistance = Math.max(target - undercookedEnd, idealEnd - target);
      accuracy =
        1 - (Math.abs(progress - target) / maximumDistance) * (1 - idealEdgeAccuracy);
    } else if (progress <= cookedEnd) {
      state = "COOKED";
      accuracy =
        idealEdgeAccuracy -
        ((progress - idealEnd) / (cookedEnd - idealEnd)) *
          (idealEdgeAccuracy - cookedEndAccuracy);
    } else {
      state = "BURNED";
      accuracy =
        cookedEndAccuracy - (progress - cookedEnd) * burnedAccuracyLossPerProgress;
    }

    return { state, progress, accuracy: clamp(accuracy, 0, 1) };
  }
}
