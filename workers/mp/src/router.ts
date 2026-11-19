/**
 * HTTP routing for `/api/mp/*`, shared by the standalone Worker (`index.ts`) and the Pages
 * Function (`functions/api/mp/[[path]].ts`), so the game can call the API on its own
 * origin. Only routing and coarse per-IP limits live here; every decision about a room is
 * made by the room's Durable Object, with the configuration of the Worker that owns it.
 */
import { CODE_ALPHABET, CODE_LENGTH, isRoomCode, normalizeRoomCode, type ApiErrorCode } from "../../../src/net/mp/protocol";
import type { MpEnv } from "./config";
import type { QuotaDO } from "./quota";
import type { CallerInfo, RoomDO } from "./room";
import { WindowLimiter, randomCode } from "./security";

/** The bindings the router needs: the room and quota namespaces of the room Worker. */
export type RouterEnv = Pick<MpEnv, "ROOMS" | "QUOTA">;

const MAX_BODY_BYTES = 4_096;
const createLimiter = new WindowLimiter(6, 10 * 60_000);
const joinLimiter = new WindowLimiter(30, 60_000);
const turnLimiter = new WindowLimiter(10, 10 * 60_000);

const STATUS: Readonly<Record<ApiErrorCode | "exists", number>> = {
  "not-found": 404, full: 409, locked: 423, kicked: 403, "rate-limited": 429, quota: 503,
  "bad-request": 400, "forbidden-origin": 403, unauthorized: 401, "not-configured": 503,
  "turn-disabled": 404, closed: 410, exists: 409,
};

const corsHeaders = (request: Request): Record<string, string> => {
  const origin = request.headers.get("Origin");
  // The room re-checks the origin for every operation; reflecting it here only lets the
  // browser read the answer (it carries no cookies: credentials are never sent).
  return origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
};

const json = (request: Request, body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(request) },
  });

const fail = (request: Request, error: ApiErrorCode | "exists"): Response => json(request, { error }, STATUS[error]);

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (length > MAX_BODY_BYTES) return null;
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY_BYTES) return null;
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const room = (env: RouterEnv, code: string): DurableObjectStub<RoomDO> =>
  env.ROOMS.get(env.ROOMS.idFromName(code)) as DurableObjectStub<RoomDO>;

const result = (request: Request, value: unknown): Response => {
  const error = (value as { error?: ApiErrorCode } | null)?.error;
  return error ? fail(request, error) : json(request, value);
};

/** Handles a request under `/api/mp/`; returns null for any other path. */
export const handleMultiplayer = async (request: Request, env: RouterEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/mp/")) return null;
  if (!env.ROOMS || !env.QUOTA) return fail(request, "not-configured");
  const path = url.pathname.slice("/api/mp/".length).split("/").filter(Boolean);
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const caller: CallerInfo = { origin: request.headers.get("Origin"), url: request.url };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(request),
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (path[0] === "status" && request.method === "GET") {
    const quota = env.QUOTA.get(env.QUOTA.idFromName("global")) as DurableObjectStub<QuotaDO>;
    return json(request, await quota.status());
  }

  if (path[0] !== "rooms") return fail(request, "not-found");

  if (path.length === 1 && request.method === "POST") {
    if (!createLimiter.allow(ip)) return fail(request, "rate-limited");
    // A code is free unless a live room holds it; collisions are rare (25^6 codes) and
    // simply retried with a new one.
    for (let attempt = 0; attempt < 4; attempt++) {
      const code = randomCode(CODE_ALPHABET, CODE_LENGTH);
      const created = await room(env, code).create({ ...caller, code });
      if ((created as { error?: string }).error !== "exists") return result(request, created);
    }
    return fail(request, "rate-limited");
  }

  const code = normalizeRoomCode(path[1] ?? "");
  if (!isRoomCode(code) || path.length !== 3) return fail(request, "not-found");
  const action = path[2];

  if (action === "ws" && request.method === "GET") {
    // The room authenticates the token from the subprotocol header and upgrades.
    return room(env, code).fetch(request);
  }
  if (request.method !== "POST") return fail(request, "not-found");
  const body = await readBody(request);
  if (!body) return fail(request, "bad-request");

  switch (action) {
    case "join":
      // Also slows down guessing codes: each IP gets a few tries a minute.
      if (!joinLimiter.allow(ip)) return fail(request, "rate-limited");
      return result(request, await room(env, code).join({ ...caller, name: body.name, resumeId: body.playerId, resumeToken: body.token }));
    case "poll":
      return result(request, await room(env, code).poll({
        ...caller,
        playerId: body.playerId,
        token: body.token,
        messages: body.messages,
        frames: body.frames,
        lobbyVersion: body.lobbyVersion,
      }));
    case "turn":
      if (!turnLimiter.allow(ip)) return fail(request, "rate-limited");
      return result(request, await room(env, code).turn({ ...caller, playerId: body.playerId, token: body.token }));
    default:
      return fail(request, "not-found");
  }
};
