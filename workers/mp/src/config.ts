/**
 * Every knob of the multiplayer backend, read from the Worker's environment
 * (`wrangler.toml` [vars] and secrets). Defaults are the safe ones: STRICT_FREE_MODE,
 * budgets at 60% of the Workers Free daily quotas, TURN off.
 *
 * Quotas checked 2026-11-19 against developers.cloudflare.com:
 *  - Workers Free: 100,000 requests/day (Pages Functions count here too).
 *  - Durable Objects on Workers Free: SQLite backend only; 100,000 requests/day,
 *    13,000 GB-s/day, 5M rows read/day, 100k rows written/day, 5 GB stored.
 *    Incoming WebSocket messages are billed 20:1; outgoing messages are free.
 *    Exceeding a Free limit makes operations fail; the Free plan is never billed.
 *  - Realtime TURN: first 1,000 GB/month free, then US$0.05/GB, with NO hard cap the
 *    account can set. That is why TURN cannot be part of STRICT_FREE_MODE.
 *  - STUN at stun.cloudflare.com: free and unlimited.
 */
import { DEFAULT_MAX_PLAYERS, MAX_PLAYERS_LIMIT, type IceServerConfig } from "../../../src/net/mp/protocol";

export interface MpEnv {
  readonly ROOMS: DurableObjectNamespace;
  readonly QUOTA: DurableObjectNamespace;
  readonly MP_MODE?: string;
  readonly ALLOWED_ORIGINS?: string;
  readonly MP_MAX_PLAYERS?: string;
  readonly SAFETY_RATIO?: string;
  readonly DAILY_WORKER_REQUESTS?: string;
  readonly DAILY_DO_REQUESTS?: string;
  readonly DAILY_DO_GB_SECONDS?: string;
  readonly MAX_ROOMS_PER_DAY?: string;
  readonly RELAY_ENABLED?: string;
  readonly HTTPS_FALLBACK_ENABLED?: string;
  readonly TURN_KEY_ID?: string;
  readonly TURN_KEY_API_TOKEN?: string;
  readonly TURN_ACK_NO_HARD_CAP?: string;
  readonly TURN_MONTHLY_GB_BUDGET?: string;
  readonly TURN_PLANNED_MB_PER_SESSION?: string;
  readonly TURN_MAX_SESSIONS_PER_DAY?: string;
  readonly TURN_CREDENTIAL_TTL_SECONDS?: string;
}

const num = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const flag = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined || value === "" ? fallback : value === "true" || value === "1";

export interface MpConfig {
  readonly mode: "STRICT_FREE_MODE" | "TURN_FREE_TIER";
  readonly allowedOrigins: readonly string[];
  readonly maxPlayers: number;
  readonly budget: {
    /** Fraction of each daily quota this app allows itself (the rest is safety margin). */
    readonly safety: number;
    readonly workerRequests: number;
    readonly doRequests: number;
    readonly doGbSeconds: number;
    readonly roomsPerDay: number;
  };
  readonly relayEnabled: boolean;
  readonly httpsEnabled: boolean;
  readonly turn: {
    /** True only in TURN_FREE_TIER with keys and the explicit no-hard-cap acknowledgement. */
    readonly enabled: boolean;
    readonly keyId: string;
    readonly apiToken: string;
    readonly monthlyGbBudget: number;
    readonly plannedMbPerSession: number;
    readonly maxSessionsPerDay: number;
    readonly ttlSeconds: number;
  };
}

export const readConfig = (env: MpEnv): MpConfig => {
  const mode = env.MP_MODE === "TURN_FREE_TIER" ? "TURN_FREE_TIER" : "STRICT_FREE_MODE";
  const safety = num(env.SAFETY_RATIO, 0.6, 0.05, 0.9);
  const turnKeys = Boolean(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN);
  return {
    mode,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean),
    maxPlayers: Math.round(num(env.MP_MAX_PLAYERS, DEFAULT_MAX_PLAYERS, 1, MAX_PLAYERS_LIMIT)),
    budget: {
      safety,
      workerRequests: num(env.DAILY_WORKER_REQUESTS, 100_000, 0, 1e9) * safety,
      doRequests: num(env.DAILY_DO_REQUESTS, 100_000, 0, 1e9) * safety,
      doGbSeconds: num(env.DAILY_DO_GB_SECONDS, 13_000, 0, 1e9) * safety,
      roomsPerDay: Math.round(num(env.MAX_ROOMS_PER_DAY, 400, 0, 1e6)),
    },
    relayEnabled: flag(env.RELAY_ENABLED, true),
    httpsEnabled: flag(env.HTTPS_FALLBACK_ENABLED, true),
    turn: {
      enabled: mode === "TURN_FREE_TIER" && turnKeys && env.TURN_ACK_NO_HARD_CAP === "yes",
      keyId: env.TURN_KEY_ID ?? "",
      apiToken: env.TURN_KEY_API_TOKEN ?? "",
      // Far below the 1,000 GB free tier: other Realtime use on the account shares it.
      monthlyGbBudget: num(env.TURN_MONTHLY_GB_BUDGET, 50, 0, 900),
      plannedMbPerSession: num(env.TURN_PLANNED_MB_PER_SESSION, 200, 1, 1e6),
      maxSessionsPerDay: Math.round(num(env.TURN_MAX_SESSIONS_PER_DAY, 40, 0, 1e5)),
      ttlSeconds: Math.round(num(env.TURN_CREDENTIAL_TTL_SECONDS, 3_600, 300, 48 * 3_600)),
    },
  };
};

/** Free and unlimited (Cloudflare Realtime FAQ). The only ICE server STRICT mode uses. */
export const STUN_SERVERS: readonly IceServerConfig[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

/** How many billed units each operation costs, for the quota estimate. */
export const COST = {
  /** One HTTP call through the Pages Function (or Worker) into a room. */
  apiCall: { worker: 1, durableObject: 1 },
  /** WebSocket upgrade: one Worker request + one DO request. */
  wsConnect: { worker: 1, durableObject: 1 },
  /** Incoming WebSocket messages are billed at 20:1. */
  wsMessage: { worker: 0, durableObject: 1 / 20 },
  /** A report or reservation sent to the quota object. */
  quotaCall: { worker: 0, durableObject: 1 },
  /** Memory a Durable Object is billed for, in GB (128 MB). */
  doMemoryGb: 0.125,
} as const;

/** Room timings. */
export const ROOM_TIMING = {
  maxAgeMs: 6 * 3_600_000,
  /** The host may reload the page and come back within this window. */
  hostGraceMs: 120_000,
  /** A room nobody hosts is dropped after this long. */
  unclaimedMs: 10 * 60_000,
  /** Periodic check while a host is connected. */
  checkEveryMs: 15 * 60_000,
  /** An HTTPS-polling phone that stops polling counts as disconnected. */
  httpsStaleMs: 12_000,
  /** Gap between relayed messages that still counts as the object staying awake. */
  awakeGapMs: 10_000,
} as const;
