import type { KitchenItem } from "../gameplay/kitchen/KitchenItems";
import type {
  AIState,
  DishQualityBreakdown,
  IngredientInstance,
  KitchenStationKind,
  MiraExpression,
  Order,
  RecipeData,
  ShiftResult,
} from "./game";

/** Which cook something happened to: 0 for player one, up to 3 for player four. */
export type PlayerIndex = 0 | 1 | 2 | 3;

/** What a cook is doing with their hands at a station. */
export type StationWorkKind = "chopping" | "mixing" | "washing" | "extinguishing";

export interface GameEvents {
  "ingredient:picked": { item: KitchenItem; playerIndex: PlayerIndex };
  "ingredient:dropped": { item: KitchenItem; playerIndex: PlayerIndex };
  "station:used": { stationKind: KitchenStationKind };
  "station:started": {
    stationKind: KitchenStationKind;
    work: StationWorkKind;
    playerIndex: PlayerIndex;
  };
  "station:progress": {
    stationKind: KitchenStationKind;
    work: StationWorkKind;
    progress: number;
    playerIndex: PlayerIndex;
  };
  /** A station finished something by itself: a chop landed, a pot cooked, a plate washed. */
  "station:completed": { stationKind: KitchenStationKind; outcome: string };
  /** A plate left the pass as a finished dish, whether or not a ticket asked for it. */
  "dish:created": { recipe: RecipeData; playerIndex: PlayerIndex };
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
