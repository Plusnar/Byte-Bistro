import type { MessageKey } from "../i18n";

/**
 * What each account API error tells the player: on the TV's account dialog and on player
 * 1's phone when they type there (kept apart so the controller page does not pull in the
 * account panel).
 */
export const ACCOUNT_ERROR_TEXT: Readonly<Record<string, MessageKey>> = {
  "wrong-login": "account.wrongLogin",
  "username-taken": "account.usernameTaken",
  locked: "account.tooManyAttempts",
  "rate-limited": "account.tooManyAttempts",
  "bad-request": "account.invalidDetails",
  "not-configured": "account.unavailable",
};

export const accountErrorText = (code: string): MessageKey => ACCOUNT_ERROR_TEXT[code] ?? "account.failed";
