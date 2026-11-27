import type { ShiftRank } from "../types/game";
import { publicUrl } from "../utils/assetUrl";
import { clamp } from "../utils/math";

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

const CLOCK_TOLERANCE = 0.18;
const MAX_RATE_ADJUSTMENT = 0.04;

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

  constructor() {
    this.audio.preload = "none";
    this.audio.preservesPitch = true;
    const { signal } = this.listeners;
    window.addEventListener("pointerup", this.activate, { signal });
    window.addEventListener("keydown", this.activate, { signal });
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
      this.audio.playbackRate = 1;
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
    let rate = 1;
    if (this.elapsed !== undefined && !this.paused && !this.finished && this.playRequested &&
      this.audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      // A slow frame can leave the game clock behind the audio. Correct the drift
      // without seeking to a passage the player has already heard.
      const drift = this.audio.currentTime - this.elapsed;
      const adjustment = clamp((Math.abs(drift) - CLOCK_TOLERANCE) * 0.12, 0, MAX_RATE_ADJUSTMENT);
      rate -= Math.sign(drift) * adjustment;
    }
    const current = this.audio.playbackRate;
    if (current !== rate && (rate === 1 || Math.abs(current - rate) >= 0.003)) this.audio.playbackRate = rate;
  }
}
