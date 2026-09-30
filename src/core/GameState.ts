import type { PersistentGameState, RuntimeGameState } from "../types/game";

export const createInitialRuntimeState = (shiftDuration: number): RuntimeGameState => ({
  shiftTimeRemaining: shiftDuration,
  shiftDuration,
  score: 0,
  activeOrders: [],
  completedOrders: 0,
  failedOrders: 0,
  coreHunger: 25,
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
  version: 1,
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
  settings: {
    masterVolume: 0.7,
    reducedMotion: false,
    showDebug: false,
  },
  chapter: 1,
  upgrades: {},
});
