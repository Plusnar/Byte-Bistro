import type { ShiftRank } from "../types/game";
import { publicUrl } from "../utils/assetUrl";

export type MusicTrack = "menu" | "level-select" | "character-select" | "editor" | "success" | "defeat"
  | "wedding" | "schlachtfest" | "pauli" | "univille";

export function stageMusic(scenarioId: string): MusicTrack | null {
  switch (scenarioId) {
    case "wedding":
    case "schlachtfest":
    case "pauli":
    case "univille":
      return scenarioId;
    default:
      return null;
  }
}

export const resultMusic = (rank: ShiftRank): MusicTrack => rank === "C" || rank === "D" ? "defeat" : "success";

function containsTime(ranges: TimeRanges, seconds: number): boolean {
  for (let i = 0; i < ranges.length; i += 1) {
    if (ranges.start(i) <= seconds && seconds < ranges.end(i)) return true;
  }
  return false;
}

export class Soundtrack {
  private readonly audio = new Audio();
  private readonly listeners = new AbortController();
  private track: MusicTrack | null = null;
  private loadedTrack: MusicTrack | null = null;
  private elapsed: number | undefined;
  private paused = true;
  private activated = false;
  private playRequested = false;
  private failedPlay = false;
  private finished = false;
  private nextSeekAt = 0;

  constructor() {
    this.audio.preload = "none";
    const { signal } = this.listeners;
    window.addEventListener("pointerup", this.activate, { signal });
    window.addEventListener("keydown", this.activate, { signal });
    this.audio.addEventListener("loadedmetadata", () => this.syncClock(), { signal });
    this.audio.addEventListener("ended", () => { this.finished = true; }, { signal });
    this.audio.addEventListener("error", () => { this.failedPlay = true; }, { signal });
  }

  setSettings(muted: boolean, masterVolume: number): void {
    this.audio.muted = muted;
    this.audio.volume = masterVolume * 0.5;
  }

  update(track: MusicTrack | null, paused = false, elapsed?: number): void {
    this.track = track;
    this.paused = paused;
    this.elapsed = elapsed;
    if (this.activated) this.apply();
  }

  dispose(): void {
    this.listeners.abort();
    this.update(null);
  }

  private readonly activate = (event: Event): void => {
    if (!event.isTrusted) return;
    this.activated = true;
    if (this.failedPlay && this.audio.error === null) this.failedPlay = false;
    this.apply();
  };

  private apply(): void {
    if (this.track !== this.loadedTrack) {
      this.audio.pause();
      this.loadedTrack = this.track;
      this.playRequested = false;
      this.failedPlay = false;
      this.finished = false;
      this.nextSeekAt = 0;
      if (this.track) {
        this.audio.loop = this.elapsed === undefined;
        this.audio.preload = this.audio.loop ? "none" : "auto";
        this.audio.src = publicUrl(`audio/music/${this.track}.mp3`);
      } else {
        this.audio.removeAttribute("src");
        this.audio.load();
      }
    }
    if (!this.track) return;
    this.syncClock();
    if (this.paused || this.finished) {
      if (this.playRequested) {
        this.playRequested = false;
        this.audio.pause();
      }
      return;
    }
    if (this.playRequested || this.failedPlay) return;
    this.playRequested = true;
    void this.audio.play().catch((error: unknown) => {
      // Changing screen or pausing can interrupt an outstanding play request.
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.playRequested = false;
      this.failedPlay = true;
    });
  }

  private syncClock(): void {
    const elapsed = this.elapsed;
    if (elapsed === undefined || this.paused || this.finished || !Number.isFinite(this.audio.duration)) return;
    if (elapsed >= this.audio.duration) {
      this.finished = true;
      return;
    }
    if (Math.abs(this.audio.currentTime - elapsed) <= 0.35 || this.audio.seeking) return;
    // A server can stream audio without allowing seeks yet. Such a seek can snap to zero.
    // Leave playback running until the target is both buffered and seekable.
    const now = performance.now();
    if (now < this.nextSeekAt || !containsTime(this.audio.seekable, elapsed) ||
      !containsTime(this.audio.buffered, elapsed + 0.25)) return;
    this.nextSeekAt = now + 1_500;
    this.audio.currentTime = elapsed;
  }
}
