/**
 * HTTP routing for `/api/auth/*`: Byte Bistro accounts on Cloudflare D1.
 *
 * Shared by the Pages Function (`functions/api/auth/[[path]].ts`, production, on the game's
 * own origin) and the local development Worker (`index.ts`). Username + password, no email:
 * a forgotten password cannot be recovered (the panel says so at sign-up).
 *
 * Sessions are random 32-byte tokens in an HttpOnly, SameSite=Strict cookie scoped to this
 * API; only their SHA-256 is stored. Every write also checks the Origin header, so another
 * site cannot act with a player's session. Passwords are PBKDF2 (passwords.ts).
 */
import { WindowLimiter, hashToken, newToken, originAllowed } from "../../mp/src/security";
import { PBKDF2_ITERATIONS, decoyHash, hashPassword, verifyPassword, type PasswordHash } from "./passwords";
import { cleanUsername, validPassword } from "./rules";

export interface AccountsEnv {
  /** The D1 database (byte-bistro-accounts). Missing: every route answers not-configured. */
  readonly ACCOUNTS?: D1Database;
  /** Extra browser origins allowed to write, comma separated (dev servers, previews). */
  readonly ALLOWED_ORIGINS?: string;
}

export type AccountError =
  | "not-configured" | "not-found" | "bad-request" | "forbidden-origin" | "rate-limited"
  | "unauthorized" | "wrong-login" | "username-taken" | "locked" | "conflict" | "too-large";

const STATUS: Readonly<Record<AccountError, number>> = {
  "not-configured": 503, "not-found": 404, "bad-request": 400, "forbidden-origin": 403,
  "rate-limited": 429, unauthorized: 401, "wrong-login": 401, "username-taken": 409,
  locked: 429, conflict: 409, "too-large": 413,
};

export const SESSION_COOKIE = "bb_session";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60_000;
const MAX_BODY_BYTES = 4_096;
/** A save is the game's snapshot plus a little envelope; the column holds 128 KiB. */
export const MAX_SNAPSHOT_BYTES = 131_072;
const MAX_SAVE_BODY_BYTES = MAX_SNAPSHOT_BYTES + 1_024;

/** Wrong passwords in a row before an account locks, and the lock that follows. */
export const LOCK_AFTER = 5;
const LOCK_BASE_MS = 60_000;
const LOCK_MAX_MS = 60 * 60_000;

const registerLimiter = new WindowLimiter(6, 60 * 60_000);
const loginLimiter = new WindowLimiter(30, 10 * 60_000);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

const fail = (error: AccountError): Response => json({ error }, STATUS[error]);

const readBody = async (request: Request, limit = MAX_BODY_BYTES): Promise<Record<string, unknown> | null> => {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) return null;
  const text = await request.text().catch(() => "");
  if (text.length > limit) return null;
  try {
    const value = JSON.parse(text || "{}") as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const readCookie = (request: Request, name: string): string | null => {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
};

/** The session cookie: HttpOnly, only sent to this API, never to other sites. */
export const sessionCookie = (token: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE}=${token}; Path=/api/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;

const clearCookie = (): string => sessionCookie("", 0);

interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly pass_hash: string;
  readonly pass_salt: string;
  readonly pass_iter: number;
  readonly failed_logins: number;
  readonly locked_until: number;
}

const storedHash = (row: UserRow): PasswordHash => ({ hash: row.pass_hash, salt: row.pass_salt, iterations: row.pass_iter });

const publicUser = (row: Pick<UserRow, "id" | "username">) => ({ id: row.id, username: row.username });

/** Opens a session for `userId` and returns the Set-Cookie header for it. */
const openSession = async (db: D1Database, userId: string, now: number): Promise<string> => {
  const token = newToken();
  await db.batch([
    // Old sessions of this player are swept as a new one opens: no cron needed.
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(userId, now),
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await hashToken(token), userId, now, now + SESSION_MS),
  ]);
  return sessionCookie(token, Math.floor(SESSION_MS / 1000));
};

/** The signed-in user, from the session cookie; null when there is none or it expired. */
const currentUser = async (db: D1Database, request: Request, now: number): Promise<UserRow | null> => {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  return db.prepare(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(await hashToken(token), now).first<UserRow>();
};

const lockFor = (failures: number): number =>
  Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** Math.max(0, failures - LOCK_AFTER));

/** Handles a request under `/api/auth/`; returns null for any other path. */
export const handleAccounts = async (request: Request, env: AccountsEnv, now = Date.now()): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/")) return null;
  const db = env.ACCOUNTS;
  if (!db) return fail("not-configured");
  const route = url.pathname.slice("/api/auth/".length).replace(/\/+$/, "");
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";

  if (request.method !== "GET") {
    // Writes only from the game itself: the same origin, or one listed for development.
    const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    if (!originAllowed(request.headers.get("Origin"), request.url, allowed)) return fail("forbidden-origin");
  }

  if (route === "me" && request.method === "GET") {
    const user = await currentUser(db, request, now);
    return user ? json({ user: publicUser(user) }) : fail("unauthorized");
  }

  if (route === "register" && request.method === "POST") {
    if (!registerLimiter.allow(ip, now)) return fail("rate-limited");
    const body = await readBody(request);
    const username = cleanUsername(body?.username);
    if (!username || !validPassword(body?.password)) return fail("bad-request");
    const taken = await db.prepare("SELECT 1 AS taken FROM users WHERE username = ?").bind(username).first();
    if (taken) return fail("username-taken");
    const password = await hashPassword(body!.password as string);
    const id = crypto.randomUUID();
    try {
      await db.prepare(
        "INSERT INTO users (id, username, pass_hash, pass_salt, pass_iter, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(id, username, password.hash, password.salt, password.iterations, now).run();
    } catch {
      // Two sign-ups racing for the same name: the UNIQUE index lets only one in.
      return fail("username-taken");
    }
    const cookie = await openSession(db, id, now);
    return json({ user: { id, username } }, 201, { "Set-Cookie": cookie });
  }

  if (route === "login" && request.method === "POST") {
    if (!loginLimiter.allow(ip, now)) return fail("rate-limited");
    const body = await readBody(request);
    const username = cleanUsername(body?.username);
    const password = typeof body?.password === "string" ? body.password : null;
    if (!username || password === null || password.length > 128) return fail("bad-request");
    const user = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
    if (!user) {
      await verifyPassword(password, await decoyHash());
      return fail("wrong-login");
    }
    if (user.locked_until > now) return fail("locked");
    if (!(await verifyPassword(password, storedHash(user)))) {
      const failures = user.failed_logins + 1;
      const lockedUntil = failures >= LOCK_AFTER ? now + lockFor(failures) : 0;
      await db.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?")
        .bind(failures, lockedUntil, user.id).run();
      return fail(lockedUntil ? "locked" : "wrong-login");
    }
    // A hash made with an older, cheaper cost is upgraded now that the password is known.
    const upgrade = user.pass_iter < PBKDF2_ITERATIONS ? await hashPassword(password) : null;
    await (upgrade
      ? db.prepare("UPDATE users SET failed_logins = 0, locked_until = 0, pass_hash = ?, pass_salt = ?, pass_iter = ? WHERE id = ?")
        .bind(upgrade.hash, upgrade.salt, upgrade.iterations, user.id)
      : db.prepare("UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?").bind(user.id)
    ).run();
    const cookie = await openSession(db, user.id, now);
    return json({ user: publicUser(user) }, 200, { "Set-Cookie": cookie });
  }

  if (route === "logout" && request.method === "POST") {
    const token = readCookie(request, SESSION_COOKIE);
    if (token && token.length <= 100) {
      await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await hashToken(token)).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  if (route === "password" && request.method === "POST") {
    const user = await currentUser(db, request, now);
    if (!user) return fail("unauthorized");
    const body = await readBody(request);
    if (typeof body?.current !== "string" || !validPassword(body?.next)) return fail("bad-request");
    if (!(await verifyPassword(body.current, storedHash(user)))) return fail("wrong-login");
    const next = await hashPassword(body.next as string);
    // Every other session ends: a changed password is how a player locks out a lost device.
    await db.batch([
      db.prepare("UPDATE users SET pass_hash = ?, pass_salt = ?, pass_iter = ? WHERE id = ?")
        .bind(next.hash, next.salt, next.iterations, user.id),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    ]);
    const cookie = await openSession(db, user.id, now);
    return json({ ok: true }, 200, { "Set-Cookie": cookie });
  }

  if (route === "delete" && request.method === "POST") {
    const user = await currentUser(db, request, now);
    if (!user) return fail("unauthorized");
    const body = await readBody(request);
    if (typeof body?.password !== "string") return fail("bad-request");
    if (!(await verifyPassword(body.password, storedHash(user)))) return fail("wrong-login");
    await db.batch([
      db.prepare("DELETE FROM saves WHERE user_id = ?").bind(user.id),
      db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
      db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  }

  if (route === "save") {
    const user = await currentUser(db, request, now);
    if (!user) return fail("unauthorized");
    if (request.method === "GET") {
      const row = await db.prepare("SELECT snapshot, revision FROM saves WHERE user_id = ?")
        .bind(user.id).first<{ snapshot: string; revision: number }>();
      return json(row ? { snapshot: JSON.parse(row.snapshot) as unknown, revision: row.revision } : { snapshot: null, revision: null });
    }
    if (request.method === "PUT") {
      const body = await readBody(request, MAX_SAVE_BODY_BYTES);
      if (!body) return fail("too-large");
      const snapshot = body.snapshot;
      const expected = body.revision;
      if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) return fail("bad-request");
      if (expected !== null && !(typeof expected === "number" && Number.isInteger(expected) && expected >= 0)) {
        return fail("bad-request");
      }
      const text = JSON.stringify(snapshot);
      if (new TextEncoder().encode(text).length > MAX_SNAPSHOT_BYTES) return fail("too-large");
      if (expected === null) {
        // First save: only when there is none yet (another device may have just made it).
        const inserted = await db.prepare(
          "INSERT INTO saves (user_id, snapshot, revision, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(user_id) DO NOTHING",
        ).bind(user.id, text, now).run();
        return inserted.meta.changes === 1 ? json({ revision: 0 }) : fail("conflict");
      }
      // Only on top of the revision the client read: a newer one means merge and try again.
      const updated = await db.prepare(
        "UPDATE saves SET snapshot = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?",
      ).bind(text, now, user.id, expected).run();
      return updated.meta.changes === 1 ? json({ revision: expected + 1 }) : fail("conflict");
    }
  }

  return fail("not-found");
};
