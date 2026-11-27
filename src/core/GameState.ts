import type { PersistentGameState, RuntimeGameState } from "../types/game";

/**
 * Bump this whenever a save needs work on the way in, and handle the older shape in
 * `SaveSystem`. 2 added `levelStars` and `levelBestScore`.
 */
export const SAVE_VERSION = 2;

export const createInitialRuntimeState = (shiftDuration: number): RuntimeGameState => ({
  shiftTimeRemaining: shiftDuration,
  shiftDuration,
  score: 0,
  activeOrders: [],
  completedOrders: 0,
  failedOrders: 0,
  combo: 0,
  maxCombo: 0,
  meltdowns: 0,
  componentsThrown: 0,
  aiState: {
    memory: 42,
    processing: 54,
    creativity: 38,
    stability: 78,
    temperature: 48,
    energy: 62,
    mood: 55,
  },
  servedDishes: [],
  paused: false,
  shiftEnded: false,
});

export const createDefaultPersistentState = (): PersistentGameState => ({
  version: SAVE_VERSION,
  credits: 0,
  unlockedRecipes: ["ram_cake", "cache_cookies", "cooling_gelato"],
  unlockedStations: [
    "ingredient_dispenser",
    "bit_crusher",
    "data_mixer",
    "compiler_oven",
    "cache_freezer",
    "plating_station",
    "serving_terminal",
  ],
  highestRank: null,
  levelRanks: {},
  levelStars: {},
  levelBestScore: {},
  settings: {
    masterVolume: 0.7,
    musicMuted: false,
    reducedMotion: false,
    showDebug: false,
    language: null,
  },
  chapter: 1,
  upgrades: {},
});
