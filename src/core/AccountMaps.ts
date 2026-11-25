import { sanitizeMapData, type MapStore } from "../editor/MapStore";
import type { MapData } from "../editor/MapData";
import { deleteAccountMap, listAccountMaps, readAccountMap, writeAccountMap } from "./PlayerAccount";

/**
 * Keeps the editor's map slots in step with the signed-in account.
 *
 * The local `MapStore` stays what the game reads (the level picker, the editor), so playing
 * never waits on the network; the account is the copy that follows the player to another
 * device. Which local slots came from the account is remembered per user, with the server
 * time of the copy last seen: a slot is downloaded again only when the account has a newer
 * one, and signing out removes the account's slots from this browser (another player on the
 * same computer does not see, or upload, them).
 */
export class AccountMaps {
  private userId: string | null = null;

  constructor(private readonly store: MapStore, private readonly storage: Storage | null = safeStorage()) {}

  private key(userId: string) { return `byte-bistro:account:${userId}:maps`; }

  private synced(userId: string): Record<string, number> {
    try {
      const value = JSON.parse(this.storage?.getItem(this.key(userId)) ?? "{}") as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([, time]) => typeof time === "number")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  private remember(userId: string, synced: Record<string, number>): void {
    try { this.storage?.setItem(this.key(userId), JSON.stringify(synced)); } catch { /* re-downloaded next time */ }
  }

  get signedIn(): boolean { return this.userId !== null; }

  /**
   * Signs in: downloads the account's new or changed maps and returns the slots that exist
   * only in this browser (made before signing in), for the game to offer uploading.
   */
  async signIn(userId: string): Promise<string[]> {
    this.userId = userId;
    const remote = await listAccountMaps();
    if (this.userId !== userId) return [];
    const synced = this.synced(userId);
    const next: Record<string, number> = {};
    for (const entry of remote) {
      if (synced[entry.slotId] === entry.updatedAt && this.store.exists(entry.slotId)) {
        next[entry.slotId] = entry.updatedAt;
        continue;
      }
      const map = sanitizeMapData(await readAccountMap(entry.slotId).catch(() => null));
      if (this.userId !== userId) return [];
      if (map && this.store.save(entry.slotId, map)) next[entry.slotId] = entry.updatedAt;
    }
    // A slot deleted on another device goes from here too.
    for (const slotId of Object.keys(synced)) {
      if (!(slotId in next) && !remote.some((entry) => entry.slotId === slotId)) this.store.delete(slotId);
    }
    this.remember(userId, next);
    return this.store.list().map((slot) => slot.slotId).filter((slotId) => !(slotId in next));
  }

  /** Signs out: the account's maps leave this browser; maps never uploaded stay. */
  signOut(): void {
    const userId = this.userId;
    this.userId = null;
    if (!userId) return;
    for (const slotId of Object.keys(this.synced(userId))) this.store.delete(slotId);
  }

  /** Uploads one slot as it is saved locally now. */
  async upload(slotId: string, map: MapData | null = this.store.load(slotId)): Promise<void> {
    const userId = this.userId;
    if (!userId || !map) return;
    // Remembering the server's time keeps the next sign-in from downloading it back.
    const updatedAt = await writeAccountMap(slotId, map);
    if (this.userId === userId) this.remember(userId, { ...this.synced(userId), [slotId]: updatedAt });
  }

  async remove(slotId: string): Promise<void> {
    const userId = this.userId;
    if (!userId) return;
    const synced = this.synced(userId);
    if (!(slotId in synced)) return;
    await deleteAccountMap(slotId);
    delete synced[slotId];
    if (this.userId === userId) this.remember(userId, synced);
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
