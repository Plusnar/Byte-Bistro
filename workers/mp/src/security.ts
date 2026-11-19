/** Tokens, hashing, origin checks and rate limiting for the multiplayer backend. */

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 32 random bytes, base64url (43 characters): unguessable session tokens. */
export const newToken = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/** "p" + 10 base64url characters. Public within a room, never an authenticator. */
export const newPlayerId = (): string => `p${toBase64Url(crypto.getRandomValues(new Uint8Array(8))).slice(0, 10)}`;

export const randomCode = (alphabet: string, length: number): string => {
  // Rejection sampling: a plain modulo would favour the first letters of the alphabet.
  const out: string[] = [];
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out.push(alphabet[byte % alphabet.length]!);
    }
  }
  return out.join("");
};

/** Tokens are stored only as SHA-256 hashes: a storage leak does not hand out sessions. */
export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Constant-time comparison of two equal-length hex digests. */
export const sameDigest = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

/**
 * Whether a browser origin may use the API. The page's own origin always may (the Pages
 * Function runs on it); others must be listed. `https://*.example.pages.dev` matches the
 * preview deployments of a project.
 */
export const originAllowed = (origin: string | null, requestUrl: string, allowed: readonly string[]): boolean => {
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.origin === new URL(requestUrl).origin) return true;
  return allowed.some((entry) => {
    if (entry === parsed.origin) return true;
    const wildcard = /^(https?):\/\/\*\.(.+)$/.exec(entry);
    return Boolean(wildcard && parsed.protocol === `${wildcard[1]}:` && parsed.hostname.endsWith(`.${wildcard[2]}`));
  });
};

/** Token bucket: `rate` tokens per second, up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  /** Requests refused since the last refill to full, to spot sustained abuse. */
  refused = 0;

  constructor(private readonly rate: number, private readonly burst: number, now = Date.now()) {
    this.tokens = burst;
    this.last = now;
  }

  take(now = Date.now(), cost = 1): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1_000) * this.rate);
    this.last = now;
    if (this.tokens >= cost) {
      this.tokens -= cost;
      if (this.tokens >= this.burst - 1) this.refused = 0;
      return true;
    }
    this.refused += 1;
    return false;
  }
}

/**
 * Best-effort per-key limiter (fixed windows) held in an isolate's memory. Isolates come
 * and go, so it only slows abuse down; the quota object is the hard global guard.
 */
export class WindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly maxKeys = 5_000) {}

  allow(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) {
        for (const [stale, value] of this.hits) if (value.resetAt <= now) this.hits.delete(stale);
        if (this.hits.size >= this.maxKeys) this.hits.clear();
      }
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
