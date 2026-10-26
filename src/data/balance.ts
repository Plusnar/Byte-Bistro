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
  /**
   * How a thrown ingredient flies. Kept here rather than in the scene so the aiming arc
   * and the flight itself can never be drawn from different numbers.
   */
  throw: {
    gravity: 18,
    /** How much speed a bounce keeps. */
    restitution: 0.42,
    /** How much sideways speed sliding on a surface keeps. */
    friction: 0.86,
    angularDamping: 0.94,
    /** How close to a cook the item has to land to hit them. */
    impactRadius: 1.05,
    launchSpeed: 9.5,
    verticalKick: 3.2,
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
    slackMultiplier: 2.25,
    roundToSeconds: 5,
    minDurationSeconds: 45,
    maxDurationSeconds: 140,
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
  /**
   * Tips, Overcooked style: the dish itself pays (see `score`), and serving it promptly
   * and in a row pays on top. See `src/systems/TipSystem.ts`.
   */
  tip: {
    /**
     * A streak survives this long without a delivery. Without a window the streak only
     * ever broke on a mistake, so it never actually fell during a bad patch.
     */
    comboWindowSeconds: 12,
    /** Tip per consecutive on-time delivery, the last entry repeating from then on. */
    streakTips: [0, 40, 80, 140, 200],
    /**
     * Promptness pays in steps, by how much of the ticket's own deadline is left. Highest
     * threshold first; a ticket served below them all pays nothing extra.
     */
    promptTiers: [
      { minimumRemaining: 0.6, tip: 60 },
      { minimumRemaining: 0.35, tip: 30 },
    ],
    /** A dish nobody ordered: no tip, and the streak ends. */
    wrongDishPenalty: 50,
    /** A ticket that runs out. */
    failedOrderPenalty: 30,
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
    standardDurationSeconds: 195,
    developmentDurationSeconds: 195,
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
