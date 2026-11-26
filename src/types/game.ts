import type { Language } from "../i18n";
export type IngredientCategory =
  | "component"
  | "sweetener"
  | "cream"
  | "coolant"
  | "mixture"
  | "prepared"
  | "dish";

export interface IngredientData {
  id: string;
  displayName: string;
  shortName: string;
  category: IngredientCategory;
  baseQuality: number;
  baseCorruption: number;
  baseTemperature: number;
  color: string;
  emissiveColor: string;
  shape: "box" | "sphere" | "cylinder" | "disc";
}

export interface ItemProcessData {
  cookingAccuracy: number;
  presentation: number;
  ingredientQuality: number;
}

export interface IngredientInstance {
  uid: string;
  ingredientId: string;
  quality: number;
  corruption: number;
  temperature: number;
  createdAt: number;
  process: ItemProcessData;
}

export type StationId =
  | "ingredient_dispenser"
  | "bit_crusher"
  | "data_mixer"
  | "compiler_oven"
  | "cache_freezer"
  | "plating_station"
  | "serving_terminal"
  | KitchenStationKind;

/** Overcooked-style tile stations used by the kitchen gameplay. */
export type KitchenStationKind =
  | "crate"
  | "counter"
  | "cutting_board"
  | "stove"
  /** Bakes a tray unattended, with a tight window before it burns. */
  | "oven"
  /** Combines a bowlful of ingredients into one prepared ingredient. */
  | "mixer"
  | "sink"
  | "plate_rack"
  | "dirty_return"
  | "trash"
  | "delivery"
  | "extinguisher_stand";

/**
 * Where an ingredient is in its preparation. Every process keeps the ingredient itself and
 * only changes its state: the board chops, the bowl on the mixer beats, the pan fries, the
 * pot boils and the oven's tray bakes. Nothing ever turns into a different ingredient.
 */
export type FoodState = "raw" | "chopped" | "mixed" | "fried" | "boiled" | "baked" | "burnt";

export interface RecipeComponent {
  readonly ingredientId: string;
  readonly state: FoodState;
}

export interface AIState {
  memory: number;
  processing: number;
  creativity: number;
  stability: number;
  temperature: number;
  energy: number;
  mood: number;
}

export type AIStateKey = keyof AIState;
export type AIStateEffects = Partial<Record<AIStateKey, number>>;

export interface RecipeStep {
  stationId: StationId;
  description: string;
}

export interface RecipeData {
  id: string;
  displayName: string;
  shortName: string;
  description: string;
  finalItemId: string;
  /** Exact plate contents that complete the dish (multiset). */
  components: readonly RecipeComponent[];
  ingredients: Array<{ ingredientId: string; quantity: number }>;
  steps: RecipeStep[];
  effects: AIStateEffects;
  reward: number;
  color: string;
}

export type OrderStatus = "active" | "completed" | "failed";
export type OrderType = "recipe" | "objective";

export interface ObjectiveConstraint {
  attribute: AIStateKey;
  operator: "increase" | "decrease" | "above" | "below";
  value: number;
}

export interface Order {
  id: string;
  type: OrderType;
  requestedRecipeId?: string;
  objectives?: ObjectiveConstraint[];
  createdAt: number;
  expiresAt: number;
  reward: number;
  status: OrderStatus;
}

export interface DishQualityBreakdown {
  ingredientQuality: number;
  cookingAccuracy: number;
  freshness: number;
  presentation: number;
  corruptionPenalty: number;
  total: number;
  label: QualityLabel;
}

export type QualityLabel =
  | "PERFECT COMPILE"
  | "EXCELLENT"
  | "GOOD"
  | "ACCEPTABLE"
  | "POOR"
  | "CORRUPTED";

export interface ServedDishRecord {
  recipeId: string;
  quality: number;
  servedAt: number;
  matchedOrder: boolean;
  scoreAwarded: number;
}

export interface RuntimeGameState {
  shiftTimeRemaining: number;
  shiftDuration: number;
  score: number;
  /** Outstanding orders, kept sorted soonest-expiry-first by systems/OrderQueue. */
  activeOrders: readonly Order[];
  completedOrders: number;
  failedOrders: number;
  combo: number;
  maxCombo: number;
  meltdowns: number;
  componentsThrown: number;
  aiState: AIState;
  servedDishes: ServedDishRecord[];
  paused: boolean;
  shiftEnded: boolean;
}

export interface GameSettings {
  masterVolume: number;
  reducedMotion: boolean;
  showDebug: boolean;
  /** Chosen in the menu or the pause card; null until then, which follows the browser. */
  language: Language | null;
}

export interface PersistentGameState {
  version: number;
  credits: number;
  unlockedRecipes: string[];
  discoveries?: string[];
  lifetimeOrders?: number;
  unlockedStations: StationId[];
  highestRank: ShiftRank | null;
  /** Best rank reached on each level, keyed by the level picker's entry key. */
  levelRanks: Record<string, ShiftRank>;
  /**
   * Best stars earned on each level, same keys. Stars come from coins (see
   * `src/data/levelGoals.ts`); a save written before that existed has them seeded from
   * `levelRanks`, so nobody loses a star to the upgrade.
   */
  levelStars: Record<string, number>;
  /** Best coin total on each level, for showing how far off the next star is. */
  levelBestScore: Record<string, number>;
  settings: GameSettings;
  chapter: number;
  upgrades: Record<string, number>;
}

export type ShiftRank = "S" | "A" | "B" | "C" | "D";

export interface ShiftResult {
  ordersCompleted: number;
  ordersFailed: number;
  averageDishQuality: number;
  miraStability: number;
  maxCombo: number;
  /** Fires left burning long enough to count; see `KitchenScene.updateMeltdowns`. */
  meltdowns: number;
  componentsThrown: number;
  teamSynchronization: number;
  cookingScore: number;
  creditsEarned: number;
  rank: ShiftRank;
  /** Coins taken home, and what this level asked for. */
  coins: number;
  stars: 0 | 1 | 2 | 3;
  starThresholds: StarThresholds;
}

/** Coin targets for one, two and three stars. Mirrors `src/data/levelGoals.ts`. */
export interface StarThresholds {
  readonly one: number;
  readonly two: number;
  readonly three: number;
}

export type MiraExpression =
  | "neutral"
  | "happy"
  | "processing"
  | "worried"
  | "angry"
  | "overheated";

export interface DialogueLine {
  id: string;
  trigger: string;
  chapter: number;
  text: string;
  expression: MiraExpression;
  priority: number;
}

export interface TemporaryGameEvent {
  id: string;
  displayName: string;
  duration: number;
  modifiers: Partial<{
    machineSpeed: number;
    movementSpeed: number;
    corruptionRate: number;
  }>;
}
