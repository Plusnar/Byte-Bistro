/**
 * How many people can cook together, and how each one is shown. One phone is one player;
 * the kitchen, the menus and the HUD all size themselves from `MAX_PLAYERS`.
 */
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 1;

/** One colour per player, everywhere: phone, HUD card, cursor, ticket, station highlight. */
export const PLAYER_COLORS: readonly string[] = ["#74F4FF", "#FFD166", "#FF7EB6", "#8CFF7A"];

export const playerLabel = (index: number): string => `P${index + 1}`;

export const clampPlayerCount = (count: number): number =>
  Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.round(Number.isFinite(count) ? count : MIN_PLAYERS)));
