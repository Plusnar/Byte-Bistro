import type {
  AIState,
  DishQualityBreakdown,
  IngredientInstance,
  MiraExpression,
  Order,
  ShiftResult,
  StationId,
} from "./game";

export interface GameEvents {
  "ingredient:picked": IngredientInstance;
  "ingredient:dropped": IngredientInstance;
  "station:started": { stationId: StationId; transformationId: string };
  "station:progress": { stationId: StationId; progress: number; label: string };
  "station:completed": { stationId: StationId; output: IngredientInstance };
  "dish:created": IngredientInstance;
  "dish:served": {
    dish: IngredientInstance;
    recipeId: string;
    quality: DishQualityBreakdown;
  };
  "order:created": Order;
  "order:completed": { order: Order; reward: number };
  "order:failed": Order;
  /** Fires once per order, when its countdown crosses the warning threshold. */
  "order:expiring": { order: Order; secondsRemaining: number };
  /** Snapshot of the whole queue, for anything that cares about the backlog as a whole. */
  "orders:changed": { active: readonly Order[]; maxConcurrent: number };
  "ai:stateChanged": AIState;
  "ai:critical": { key: keyof AIState; message: string };
  "score:changed": { score: number; delta: number; reason: string };
  "shift:started": { duration: number };
  "shift:ended": ShiftResult;
  "notification": { message: string; tone: "info" | "success" | "warning" | "error" };
  "dialogue": { text: string; expression: MiraExpression };
  "pause:changed": { paused: boolean };
}
