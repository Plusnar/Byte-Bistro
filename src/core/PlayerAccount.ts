import { createDefaultPersistentState } from "./GameState";
import { sanitizePersistentState } from "./SaveSystem";
import { recordLevelRank } from "../data/levelRanks";
import type { PersistentGameState } from "../types/game";

/**
 * Player accounts on Cloudflare (D1 behind `/api/auth/*`, see workers/accounts): username +
 * password, a session in an HttpOnly cookie the browser sends by itself, and one saved
 * snapshot per player with a revision number so two devices never overwrite each other.
 */

/** An API answer that is not a success: its error code (`wrong-login`, `conflict`, …). */
export class AccountApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`Account API: ${code}`);
  }
}

export interface AccountUser { readonly id: string; readonly username: string }

const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`/api/auth/${path}`, { // perf-allow: account API call (JSON), not an asset
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new AccountApiError(data.error ?? "failed", response.status);
  return data;
};

/** The signed-in user, null when signed out; throws `not-configured` without a server. */
export const currentUser = async (): Promise<AccountUser | null> => {
  try {
    return (await call<{ user: AccountUser }>("GET", "me")).user;
  } catch (error) {
    if (error instanceof AccountApiError && error.status === 401) return null;
    throw error;
  }
};
export const register = async (username: string, password: string): Promise<AccountUser> =>
  (await call<{ user: AccountUser }>("POST", "register", { username, password })).user;
export const logIn = async (username: string, password: string): Promise<AccountUser> =>
  (await call<{ user: AccountUser }>("POST", "login", { username, password })).user;
export const logOut = async (): Promise<void> => { await call("POST", "logout", {}); };
export const changePassword = async (current: string, next: string): Promise<void> => {
  await call("POST", "password", { current, next });
};
export const deleteAccount = async (password: string): Promise<void> => { await call("POST", "delete", { password }); };

export const avatars = ["william", "milena", "jean", "sandy"] as const;
export type Avatar = typeof avatars[number];
export interface PlayerProfile { name: string; avatar: Avatar }
export interface AccountSnapshot {
  progress: PersistentGameState;
  profile: PlayerProfile;
  settingsAt: number;
}
const onlyOfficial = <T>(values: Record<string, T>): Record<string, T> =>
  Object.fromEntries(Object.entries(values).filter(([key]) => /^(official|scenario):/.test(key)));
const bestNumbers = (a: Record<string, number>, b: Record<string, number>) => ({
  ...a,
  ...Object.fromEntries(Object.entries(b).map(([key, value]) => [key, Math.max(value, a[key] ?? 0)])),
});
const union = <T>(a: readonly T[] = [], b: readonly T[] = []) => [...new Set([...a, ...b])];

export function mergeProgress(local: PersistentGameState, remote: PersistentGameState, newerLocal: boolean): PersistentGameState {
  let ranks = { ...local.levelRanks };
  for (const [key, rank] of Object.entries(remote.levelRanks)) ranks = recordLevelRank(ranks, key, rank);
  return {
    ...local,
    levelRanks: ranks,
    levelStars: bestNumbers(local.levelStars, remote.levelStars),
    levelBestScore: bestNumbers(local.levelBestScore, remote.levelBestScore),
    upgrades: bestNumbers(local.upgrades, remote.upgrades),
    credits: Math.max(local.credits, remote.credits),
    chapter: Math.max(local.chapter, remote.chapter),
    discoveries: union(local.discoveries, remote.discoveries),
    lifetimeOrders: Math.max(local.lifetimeOrders ?? 0, remote.lifetimeOrders ?? 0),
    highestRank: remote.highestRank
      ? recordLevelRank(local.highestRank ? { all: local.highestRank } : {}, "all", remote.highestRank).all ?? null
      : local.highestRank,
    unlockedRecipes: union(local.unlockedRecipes, remote.unlockedRecipes),
    unlockedStations: union(local.unlockedStations, remote.unlockedStations),
    settings: newerLocal ? local.settings : remote.settings,
  };
}

export async function readAccount() {
  const data = await call<{ snapshot: unknown; revision: number | null }>("GET", "save");
  if (data.revision === null || !data.snapshot) return null;
  const s = data.snapshot as Partial<AccountSnapshot>;
  const avatar = s.profile?.avatar;
  return {
    revision: data.revision,
    snapshot: {
      progress: sanitizePersistentState(s.progress, createDefaultPersistentState()),
      profile: { name: String(s.profile?.name ?? "").slice(0, 40), avatar: avatars.find((id) => id === avatar) ?? "william" },
      settingsAt: Number(s.settingsAt) || 0,
    },
  };
}

/**
 * Merges the local snapshot with the saved one and writes it on top of the revision read.
 * Another device saving in between makes the server refuse (`conflict`): read, merge and
 * try again, a few times.
 */
export async function syncAccount(local: AccountSnapshot): Promise<AccountSnapshot> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await readAccount();
    const settingsAt = Math.max(local.settingsAt, remote?.snapshot.settingsAt ?? 0);
    const progress = remote
      ? mergeProgress(local.progress, remote.snapshot.progress, local.settingsAt >= remote.snapshot.settingsAt)
      : local.progress;
    const next = { ...local, settingsAt, progress };
    const snapshot = {
      ...next,
      progress: {
        ...progress,
        levelRanks: onlyOfficial(progress.levelRanks),
        levelStars: onlyOfficial(progress.levelStars),
        levelBestScore: onlyOfficial(progress.levelBestScore),
      },
    };
    try {
      await call("PUT", "save", { snapshot, revision: remote?.revision ?? null });
      return next;
    } catch (error) {
      if (error instanceof AccountApiError && error.code === "conflict") continue;
      throw error;
    }
  }
  throw new Error("Concurrent account updates");
}
