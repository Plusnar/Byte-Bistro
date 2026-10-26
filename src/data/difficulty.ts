import { translate } from "../i18n";
import { BALANCE } from "./balance";

/**
 * Difficulty profiles for a scenario or a saved map.
 *
 * These are injected as an explicit parameter wherever they are used — never read from a
 * global — so a scenario can pick its own tuning without any module-level state, and so the
 * existing balance tests keep passing against `STANDARD_DIFFICULTY` unchanged.
 */

export type DifficultyId = "relaxed" | "standard" | "intense" | "meltdown";

export interface ConcurrencyStep {
  readonly progress: number;
  readonly max: number;
}

export interface DifficultyTuning {
  readonly id: DifficultyId;
  readonly label: string;
  /** Multiplies every order's derived deadline. Below 1 is harder. */
  readonly orderDurationMultiplier: number;
  /** How many orders may be outstanding, ramping over the shift. */
  readonly concurrencyRamp: readonly ConcurrencyStep[];
  /** Seconds between spawn attempts, tightening over the shift. */
  readonly spawnIntervalSeconds: { readonly start: number; readonly end: number };
  /** Scales the payout, so a harder map is worth more. */
  readonly rewardMultiplier: number;
}

/**
 * Reproduces `BALANCE.order` exactly. `difficulty.test.ts` asserts that equality, so this
 * profile can never silently drift away from the values the rest of the game was tuned at.
 */
export const STANDARD_DIFFICULTY: DifficultyTuning = {
  id: "standard",
  get label() { return translate("difficulty.standard"); },
  orderDurationMultiplier: 1,
  concurrencyRamp: BALANCE.order.concurrencyRamp,
  spawnIntervalSeconds: BALANCE.order.spawnIntervalSeconds,
  rewardMultiplier: 1,
};

export const DIFFICULTY_PROFILES: Readonly<Record<DifficultyId, DifficultyTuning>> = {
  relaxed: {
    id: "relaxed",
    get label() { return translate("difficulty.relaxed"); },
    orderDurationMultiplier: 1.35,
    concurrencyRamp: [
      { progress: 0, max: 1 },
      { progress: 0.5, max: 2 },
      { progress: 0.8, max: 3 },
    ],
    spawnIntervalSeconds: { start: 44, end: 34 },
    rewardMultiplier: 0.8,
  },
  standard: STANDARD_DIFFICULTY,
  intense: {
    id: "intense",
    get label() { return translate("difficulty.intense"); },
    orderDurationMultiplier: 0.82,
    concurrencyRamp: [
      { progress: 0, max: 3 },
      { progress: 0.3, max: 4 },
      { progress: 0.65, max: 5 },
    ],
    spawnIntervalSeconds: { start: 26, end: 16 },
    rewardMultiplier: 1.25,
  },
  meltdown: {
    id: "meltdown",
    get label() { return translate("difficulty.meltdown"); },
    orderDurationMultiplier: 0.68,
    concurrencyRamp: [
      { progress: 0, max: 4 },
      { progress: 0.25, max: 5 },
      { progress: 0.6, max: 6 },
    ],
    spawnIntervalSeconds: { start: 20, end: 12 },
    rewardMultiplier: 1.6,
  },
};

export const DIFFICULTY_IDS = Object.keys(DIFFICULTY_PROFILES) as readonly DifficultyId[];

export const isDifficultyId = (value: unknown): value is DifficultyId =>
  typeof value === "string" && value in DIFFICULTY_PROFILES;

export const getDifficulty = (id: string | undefined): DifficultyTuning =>
  isDifficultyId(id) ? DIFFICULTY_PROFILES[id] : STANDARD_DIFFICULTY;
