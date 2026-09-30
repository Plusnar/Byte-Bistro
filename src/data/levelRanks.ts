import type { ShiftRank } from "../types/game";

/**
 * Best result per level, shown on the level map as one to three stars.
 *
 * The shift already grades itself S–D (see `ShiftSystem.getRank`); stars are a coarser,
 * friendlier view of that same grade, so no second scoring rule exists to drift from it.
 */

export type LevelRanks = Readonly<Record<string, ShiftRank>>;

/** Best first. */
export const RANK_ORDER: readonly ShiftRank[] = ["S", "A", "B", "C", "D"];

const RANKS: ReadonlySet<string> = new Set(RANK_ORDER);

/** Finishing a shift earns a star; A or better earns all three. */
export const starsForRank = (rank: ShiftRank | null | undefined): 0 | 1 | 2 | 3 => {
  switch (rank) {
    case "S":
    case "A":
      return 3;
    case "B":
      return 2;
    case "C":
    case "D":
      return 1;
    default:
      return 0;
  }
};

export const isBetterRank = (candidate: ShiftRank, current: ShiftRank | null | undefined): boolean =>
  !current || RANK_ORDER.indexOf(candidate) < RANK_ORDER.indexOf(current);

/** Keeps the best rank ever reached on `levelKey`; a worse run changes nothing. */
export const recordLevelRank = (ranks: LevelRanks, levelKey: string, rank: ShiftRank): LevelRanks => {
  if (!levelKey || !isBetterRank(rank, ranks[levelKey])) return ranks;
  return { ...ranks, [levelKey]: rank };
};

/** Drops anything that is not a `key → rank` pair, so a hand-edited save cannot break the map. */
export const sanitizeLevelRanks = (value: unknown): Record<string, ShiftRank> => {
  const ranks: Record<string, ShiftRank> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ranks;
  for (const [key, rank] of Object.entries(value)) {
    if (key && typeof rank === "string" && RANKS.has(rank)) ranks[key] = rank as ShiftRank;
  }
  return ranks;
};
