/**
 * HTTP side of the multiplayer API, and where it lives.
 *
 * Same origin by default (`/api/mp`, served by the Pages Function); `VITE_MP_API_BASE`
 * points the build at another deployment (the Worker on workers.dev, say). In `vite dev`
 * the dev server proxies `/api/mp` to `wrangler dev` on port 8787.
 */
import type { ApiErrorCode } from "./protocol";

const configuredBase = (import.meta.env.VITE_MP_API_BASE as string | undefined)?.replace(/\/+$/, "") ?? "";

export const apiBase = (): string => configuredBase || `${location.origin}/api/mp`;

export const wsBase = (): string => apiBase().replace(/^http/, "ws");

/** The page phones open, on this same site. The room code goes after `#`: never logged. */
export const controllerUrl = (code: string): string => {
  const url = new URL("/controller", location.origin);
  url.hash = code;
  return url.toString();
};

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode | "network", readonly status: number) {
    super(`Multiplayer API: ${code} (${status})`);
  }
}

const TIMEOUT_MS = 8_000;

/** POST (or GET without a body) to the API; rejects with ApiError. */
export const callApi = async <T>(path: string, body?: unknown): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/${path}`, { // perf-allow: multiplayer signalling API, not asset bytes
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new ApiError("network", 0);
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => null) as ({ error?: ApiErrorCode } & T) | null;
  if (!response.ok || !data || data.error) throw new ApiError(data?.error ?? "network", response.status);
  return data;
};
