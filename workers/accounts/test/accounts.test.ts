import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/passwords";
import { LOCK_AFTER, MAX_MAPS_PER_USER, SESSION_COOKIE, handleAccounts, type AccountsEnv } from "../src/router";
import { cleanUsername, validPassword } from "../src/rules";

/**
 * A stand-in for Cloudflare D1 backed by Node's SQLite, so the API runs its real SQL
 * (schema, UNIQUE NOCASE, ON CONFLICT, json_valid) in tests.
 */
class FakeD1 {
  readonly sql = new DatabaseSync(":memory:");

  constructor() {
    for (const file of ["0001_init.sql", "0002_maps.sql"]) {
      this.sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    this.sql.exec("PRAGMA foreign_keys = ON");
  }

  prepare(query: string) {
    const statement = this.sql.prepare(query);
    const make = (args: unknown[]) => ({
      bind: (...next: unknown[]) => make(next),
      first: async <T>() => (statement.get(...(args as never[])) ?? null) as T | null,
      all: async <T>() => ({ results: statement.all(...(args as never[])) as T[] }),
      run: async () => ({ meta: { changes: Number(statement.run(...(args as never[])).changes) } }),
    });
    return make([]);
  }

  async batch(statements: { run: () => Promise<unknown> }[]) {
    this.sql.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sql.exec("COMMIT");
      return results;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }
}

const ORIGIN = "https://byte-bistro.pages.dev";
/** Every call gets its own IP across all tests: the per-IP limiters live at module level. */
let ipCounter = 0;

const harness = () => {
  const db = new FakeD1();
  const env = { ACCOUNTS: db as unknown as D1Database } satisfies AccountsEnv;
  let cookie = "";
  const call = async (method: string, path: string, body?: unknown, options: { origin?: string; now?: number; keepIp?: boolean; account?: string } = {}) => {
    const headers: Record<string, string> = { "CF-Connecting-IP": `10.${Math.floor(++ipCounter / 250) % 250}.${ipCounter % 250}.1` };
    if (method !== "GET") headers.Origin = options.origin ?? ORIGIN;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (options.account) headers["X-Byte-Bistro-Account"] = options.account;
    if (cookie) headers.Cookie = `${SESSION_COOKIE}=${cookie}`;
    const response = await handleAccounts(
      new Request(`${ORIGIN}/api/auth/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      options.now,
    );
    const set = response!.headers.get("Set-Cookie");
    if (set) cookie = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(set)?.[1] ?? "";
    return { status: response!.status, body: await response!.json() as Record<string, unknown>, setCookie: set };
  };
  return { db, call, signOutLocally: () => { cookie = ""; } };
};

describe("account rules", () => {
  it("accepts simple usernames and keeps their case", () => {
    expect(cleanUsername("  Chef_Will ")).toBe("Chef_Will");
    expect(cleanUsername("a.b")).toBe("a.b");
  });

  it("refuses short, long, spaced, dotted-edge or odd usernames", () => {
    for (const bad of ["ab", "x".repeat(21), "chef will", ".chef", "chef.", "a..b", "çhef", 42, null]) {
      expect(cleanUsername(bad)).toBeNull();
    }
  });

  it("asks for a password of 8 to 128 characters", () => {
    expect(validPassword("12345678")).toBe(true);
    expect(validPassword("1234567")).toBe(false);
    expect(validPassword("x".repeat(129))).toBe(false);
  });
});

describe("passwords", () => {
  it("salts every hash and only verifies the right password", async () => {
    const a = await hashPassword("correct horse", 1_000);
    const b = await hashPassword("correct horse", 1_000);
    expect(a.hash).not.toBe(b.hash);
    expect(await verifyPassword("correct horse", a)).toBe(true);
    expect(await verifyPassword("wrong horse", a)).toBe(false);
  });
});

describe("accounts API", () => {
  it("signs up, stays signed in, signs out", async () => {
    const { call } = harness();
    const created = await call("POST", "register", { username: "Chef", password: "segredo123" });
    expect(created.status).toBe(201);
    expect(created.setCookie).toMatch(/HttpOnly/);
    expect(created.setCookie).toMatch(/SameSite=Strict/);
    expect((await call("GET", "me")).body).toEqual({ user: { id: created.body.user && (created.body.user as { id: string }).id, username: "Chef" } });
    await call("POST", "logout", {});
    expect((await call("GET", "me")).status).toBe(401);
  });

  it("refuses a username already taken, whatever its case", async () => {
    const { call, signOutLocally } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    signOutLocally();
    expect((await call("POST", "register", { username: "chef", password: "outrasenha1" })).body.error).toBe("username-taken");
  });

  it("logs in with the right password only, and locks after repeated failures", async () => {
    const { call, signOutLocally } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    signOutLocally();
    expect((await call("POST", "login", { username: "nobody", password: "segredo123" })).body.error).toBe("wrong-login");
    for (let attempt = 1; attempt < LOCK_AFTER; attempt++) {
      expect((await call("POST", "login", { username: "chef", password: "errada123" })).body.error).toBe("wrong-login");
    }
    expect((await call("POST", "login", { username: "chef", password: "errada123" })).body.error).toBe("locked");
    // Even the right password waits out the lock.
    expect((await call("POST", "login", { username: "chef", password: "segredo123" })).body.error).toBe("locked");
    const later = Date.now() + 2 * 60 * 60_000;
    expect((await call("POST", "login", { username: "chef", password: "segredo123" }, { now: later })).status).toBe(200);
  });

  it("refuses writes from another site", async () => {
    const { call } = harness();
    const response = await call("POST", "register", { username: "Chef", password: "segredo123" }, { origin: "https://evil.example" });
    expect(response.body.error).toBe("forbidden-origin");
  });

  it("saves with revisions and refuses a write over a newer one", async () => {
    const { call } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    expect((await call("GET", "save")).body).toEqual({ snapshot: null, revision: null });
    expect((await call("PUT", "save", { snapshot: { stars: 1 }, revision: null })).body).toEqual({ revision: 0 });
    // A second "first save" (another device) must merge instead.
    expect((await call("PUT", "save", { snapshot: { stars: 9 }, revision: null })).body.error).toBe("conflict");
    expect((await call("PUT", "save", { snapshot: { stars: 2 }, revision: 0 })).body).toEqual({ revision: 1 });
    expect((await call("PUT", "save", { snapshot: { stars: 3 }, revision: 0 })).body.error).toBe("conflict");
    expect((await call("GET", "save")).body).toEqual({ snapshot: { stars: 2 }, revision: 1 });
  });

  it("needs a session to read or write a save", async () => {
    const { call } = harness();
    expect((await call("GET", "save")).status).toBe(401);
    expect((await call("PUT", "save", { snapshot: {}, revision: null })).status).toBe(401);
  });

  it("changes the password and ends every other session", async () => {
    const { call, signOutLocally } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    expect((await call("POST", "password", { current: "errada123", next: "novasenha1" })).body.error).toBe("wrong-login");
    expect((await call("POST", "password", { current: "segredo123", next: "novasenha1" })).status).toBe(200);
    expect((await call("GET", "me")).status).toBe(200);
    signOutLocally();
    expect((await call("POST", "login", { username: "Chef", password: "segredo123" })).body.error).toBe("wrong-login");
    expect((await call("POST", "login", { username: "Chef", password: "novasenha1" })).status).toBe(200);
  });

  it("deletes the account with its save, after the password", async () => {
    const { call, db } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    await call("PUT", "save", { snapshot: { stars: 1 }, revision: null });
    expect((await call("POST", "delete", { password: "errada123" })).body.error).toBe("wrong-login");
    expect((await call("POST", "delete", { password: "segredo123" })).status).toBe(200);
    expect((await call("GET", "me")).status).toBe(401);
    expect(db.sql.prepare("SELECT count(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(db.sql.prepare("SELECT count(*) AS n FROM saves").get()).toEqual({ n: 0 });
  });

  it("saves, lists, loads and deletes a player's maps", async () => {
    const { call } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    const map = { version: 1, name: "Minha cozinha", objects: [{ id: "a" }] };
    expect((await call("PUT", "maps/slot-abc-1", { map })).status).toBe(200);
    expect((await call("PUT", "maps/slot-abc-1", { map: { ...map, name: "Renomeada" } })).status).toBe(200);
    const list = await call("GET", "maps");
    expect((list.body.maps as { name: string }[]).map((entry) => entry.name)).toEqual(["Renomeada"]);
    expect((await call("GET", "maps/slot-abc-1")).body.map).toEqual({ ...map, name: "Renomeada" });
    expect((await call("DELETE", "maps/slot-abc-1")).status).toBe(200);
    expect((await call("GET", "maps/slot-abc-1")).status).toBe(404);
  });

  it("refuses odd map ids and anything that is not an editor map", async () => {
    const { call } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    expect((await call("PUT", "maps/evil%2Fpath", { map: { version: 1, objects: [] } })).status).toBe(400);
    expect((await call("PUT", "maps/slot-x", { map: { version: 2, objects: [] } })).status).toBe(400);
    expect((await call("PUT", "maps/slot-x", { map: "nope" })).status).toBe(400);
  });

  it("atomically refuses stale writes and deletes from a second device", async () => {
    const { call } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    const slot = "maps/slot-shared";
    const map = { version: 1, name: "Original", objects: [] };
    const created = await call("PUT", slot, { map, expected: null });
    expect(created.status).toBe(200);
    const { updatedAt } = created.body;
    expect((await call("GET", slot)).body.updatedAt).toBe(updatedAt);
    const attempts = await Promise.all(["From device one", "From device two"].map(name =>
      call("PUT", slot, { map: { ...map, name }, expected: updatedAt })));
    expect(attempts.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await call("PUT", slot, { map, expected: null })).status).toBe(409);
    expect((await call("DELETE", slot + "?expected=" + updatedAt)).status).toBe(409);
    const current = await call("GET", slot);
    expect(current.body.map).not.toEqual(map);
    expect((await call("DELETE", slot + "?expected=" + current.body.updatedAt)).status).toBe(200);
  });

  it("refuses to sync a tab bound to a different account", async () => {
    const { call } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    const result = await call("PUT", "maps/slot-other", {
      map: { version: 1, objects: [] }, expected: null,
    }, { account: "different-user" });
    expect(result.status).toBe(401);
    expect((await call("GET", "maps")).body.maps).toEqual([]);
  });

  it("caps how many maps one account keeps", async () => {
    const { call } = harness();
    await call("POST", "register", { username: "Chef", password: "segredo123" });
    for (let index = 0; index < MAX_MAPS_PER_USER; index++) {
      expect((await call("PUT", `maps/slot-${index}`, { map: { version: 1, objects: [] } })).status).toBe(200);
    }
    expect((await call("PUT", "maps/slot-extra", { map: { version: 1, objects: [] } })).body.error).toBe("too-many");
    // Overwriting an existing one is still fine at the cap.
    expect((await call("PUT", "maps/slot-0", { map: { version: 1, objects: [] } })).status).toBe(200);
  });

  it("keeps each player's maps to themselves", async () => {
    const { call, signOutLocally } = harness();
    await call("POST", "register", { username: "Ana", password: "segredo123" });
    await call("PUT", "maps/slot-secret", { map: { version: 1, name: "Da Ana", objects: [] } });
    signOutLocally();
    await call("POST", "register", { username: "Beto", password: "segredo123" });
    expect((await call("GET", "maps/slot-secret")).status).toBe(404);
    expect((await call("GET", "maps")).body.maps).toEqual([]);
  });

  it("renews a session past half its life, so a returning player stays signed in", async () => {
    const { call } = harness();
    const start = Date.now();
    await call("POST", "register", { username: "Chef", password: "segredo123" }, { now: start });
    expect((await call("GET", "me", undefined, { now: start + 60_000 })).setCookie).toBeNull();
    const later = start + 20 * 24 * 60 * 60_000;
    const renewed = await call("GET", "me", undefined, { now: later });
    expect(renewed.status).toBe(200);
    expect(renewed.setCookie).toMatch(/Max-Age=2592000/);
    // The new session lasts 30 days from the renewal, well past the old one's end.
    expect((await call("GET", "me", undefined, { now: later + 25 * 24 * 60 * 60_000 })).status).toBe(200);
  });

  it("answers not-configured without a database", async () => {
    const response = await handleAccounts(new Request(`${ORIGIN}/api/auth/me`), {});
    expect(response!.status).toBe(503);
  });
});
