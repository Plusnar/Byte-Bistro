/** What a username and a password may be. Shared by the API and the game's account panel. */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

const USERNAME_PATTERN = /^[a-z0-9_.]+$/i;

/** Trimmed username, or null when it breaks the rules. Case is kept for display. */
export const cleanUsername = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return null;
  if (!USERNAME_PATTERN.test(name)) return null;
  // Dots only between other characters: no ".chef" or "chef..x".
  if (/^\.|\.$|\.\./.test(name)) return null;
  return name;
};

export const validPassword = (value: unknown): value is string =>
  typeof value === "string" && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;
