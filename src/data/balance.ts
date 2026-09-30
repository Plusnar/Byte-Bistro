export const BALANCE = {
  quality: {
    weights: {
      ingredientQuality: 0.35,
      cookingAccuracy: 0.35,
      freshness: 0.15,
      presentation: 0.15,
    },
    corruptionPenaltyMultiplier: 0.6,
    freshnessLifetimeMs: 180_000,
    labels: [
      { minimum: 0.95, label: "PERFECT COMPILE" },
      { minimum: 0.8, label: "EXCELLENT" },
      { minimum: 0.65, label: "GOOD" },
      { minimum: 0.4, label: "ACCEPTABLE" },
      { minimum: 0.2, label: "POOR" },
      { minimum: 0, label: "CORRUPTED" },
    ],
  },
  cooking: {
    undercookedEnd: 0.55,
    idealEnd: 0.9,
    cookedEnd: 1.1,
    defaultIdealProgress: 0.75,
    idealEdgeAccuracy: 0.85,
    cookedEndAccuracy: 0.4,
    burnedAccuracyLossPerProgress: 2,
  },
  transformation: {
    qualityRetention: 0.98,
    stationTemperatureInfluence: 0.25,
  },
  ai: {
    minimum: 0,
    maximum: 100,
    initialState: {
      memory: 42,
      processing: 54,
      creativity: 38,
      stability: 78,
      temperature: 48,
      energy: 62,
      mood: 55,
    },
    critical: {
      memoryBelow: 25,
      temperatureAbove: 80,
      stabilityBelow: 30,
      energyBelow: 20,
    },
    mood: {
      angryBelow: 25,
      happyAtOrAbove: 70,
    },
  },
  order: {
    /** Fallback for objective orders; recipe orders derive their deadline from the work. */
    defaultDurationMs: 150_000,
    objectiveReward: 350,
    // --- per-recipe deadline derivation (see data/recipeTiming.ts) ---
    /** Grabbing a clean plate and walking the pass to delivery. */
    baseSeconds: 16,
    /** One crate round-trip per component, ~12m at the player's walk speed. */
    perComponentFetchSeconds: 7,
    /** Co-op reality (walking, collisions, mistakes) versus the single-cook ideal path. */
    slackMultiplier: 1.9,
    roundToSeconds: 5,
    minDurationSeconds: 45,
    maxDurationSeconds: 120,
    /** Fires `order:expiring` and flips the HUD ticket to critical. */
    expiringWarningSeconds: 15,
    // --- spawn cadence (see systems/OrderQueue.ts) ---
    concurrencyRamp: [
      { progress: 0, max: 2 },
      { progress: 0.35, max: 3 },
      { progress: 0.7, max: 4 },
    ],
    spawnIntervalSeconds: { start: 34, end: 22 },
    /** No new tickets in the last stretch; they could not be finished in time. */
    noSpawnTailSeconds: 25,
    /** Bonus for delivering an order that had almost run out. */
    rescueBonus: 60,
    rescueThreshold: 0.2,
  },
  score: {
    completionShare: 0.35,
    qualityShare: 0.4,
    speedShare: 0.15,
    criticalNeedShare: 0.1,
    unmatchedDishMultiplier: 0.1,
    failedOrderPenalty: 100,
    completedOrderBonus: 25,
    stabilityBonusMaximum: 100,
  },
  shift: {
    standardDurationSeconds: 240,
    developmentDurationSeconds: 240,
    creditsPerScore: 0.1,
    targetScorePerOrder: 300,
    resultWeights: {
      completion: 0.3,
      quality: 0.4,
      aiCondition: 0.2,
      scoreEfficiency: 0.1,
    },
    rankThresholds: {
      S: 90,
      A: 78,
      B: 65,
      C: 50,
    },
  },
} as const;

export type BalanceConfig = typeof BALANCE;
