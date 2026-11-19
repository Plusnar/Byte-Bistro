import { createClient } from "@supabase/supabase-js";
import { createDefaultPersistentState } from "./GameState";
import { sanitizePersistentState } from "./SaveSystem";
import { recordLevelRank } from "../data/levelRanks";
import type { PersistentGameState } from "../types/game";

const env = import.meta.env;
export const accountAvailable = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
const client = accountAvailable
  ? createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, { auth: { flowType: "pkce" } })
  : null;

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

export function getAccountClient() {
  if (!client) throw new Error("Account service unavailable");
  return client;
}

export async function readAccount(id: string) {
  const { data, error } = await getAccountClient().from("player_saves")
    .select("snapshot,revision").eq("user_id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const s = data.snapshot as Partial<AccountSnapshot>;
  const avatar = s.profile?.avatar;
  return {
    revision: data.revision as number,
    snapshot: {
      progress: sanitizePersistentState(s.progress, createDefaultPersistentState()),
      profile: { name: String(s.profile?.name ?? "").slice(0, 40), avatar: avatars.find((id) => id === avatar) ?? "william" },
      settingsAt: Number(s.settingsAt) || 0,
    },
  };
}

export async function syncAccount(id: string, local: AccountSnapshot): Promise<AccountSnapshot> {
  const store = getAccountClient().from("player_saves");
  for (let attempt = 0; attempt < 4; attempt++) {
    const remote = await readAccount(id);
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
    if (!remote) {
      const { error } = await store.insert({ user_id: id, snapshot, revision: 0 });
      if (!error) return next;
      if (error.code === "23505") continue;
      throw error;
    }
    const { data, error } = await store.update({ snapshot, revision: remote.revision + 1 })
      .eq("user_id", id).eq("revision", remote.revision).select("revision").maybeSingle();
    if (error) throw error;
    if (data) return next;
  }
  throw new Error("Concurrent account updates");
}
