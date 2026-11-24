/**
 * How many people can cook together, and how each one is shown. One phone is one player;
 * the kitchen, the menus and the HUD all size themselves from `MAX_PLAYERS`.
 */
export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 1;

/**
 * One colour per player, everywhere: phone, HUD, cursor, ticket, station highlight and the
 * tag over each cook. Green, blue, red, yellow, in the order players join, so two cooks in
 * the same outfit are still told apart at a glance.
 */
export const PLAYER_COLORS: readonly string[] = ["#4FD96B", "#4A9DFF", "#FF5A5F", "#FFC93C"];

export const playerLabel = (index: number): string => `P${index + 1}`;

export const clampPlayerCount = (count: number): number =>
  Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.round(Number.isFinite(count) ? count : MIN_PLAYERS)));
