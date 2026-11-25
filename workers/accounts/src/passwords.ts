/**
 * Password hashing for the accounts API: PBKDF2-SHA256 through WebCrypto, a random salt per
 * account, and the iteration count stored with each hash so it can be raised later (an
 * account is rehashed at its next login).
 *
 * The cost is bounded by the Workers CPU limit: PBKDF2_ITERATIONS was chosen by measuring
 * a login on Cloudflare (see the README, "Contas").
 */

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const fromBase64Url = (text: string): Uint8Array => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export interface PasswordHash {
  readonly hash: string;
  readonly salt: string;
  readonly iterations: number;
}

const derive = async (password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
};

export const hashPassword = async (password: string, iterations = PBKDF2_ITERATIONS): Promise<PasswordHash> => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return { hash: toBase64Url(hash), salt: toBase64Url(salt), iterations };
};

/** Constant-time comparison of two byte arrays of the same length. */
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
};

export const verifyPassword = async (password: string, stored: PasswordHash): Promise<boolean> => {
  const expected = fromBase64Url(stored.hash);
  const actual = await derive(password, fromBase64Url(stored.salt), stored.iterations);
  return sameBytes(actual, expected);
};

/**
 * A hash to check against when the username does not exist, so a wrong username takes as
 * long as a wrong password and the response time does not reveal which accounts exist.
 */
let decoy: Promise<PasswordHash> | null = null;
export const decoyHash = (): Promise<PasswordHash> => (decoy ??= hashPassword("decoy-password-never-matches"));
