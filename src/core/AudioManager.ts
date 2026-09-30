import { Scene, Sound, Vector3, type AbstractMesh } from "@babylonjs/core";

export interface AudioCueOptions {
  loop?: boolean;
  volume?: number;
  playbackRate?: number;
  spatial?: boolean;
  maxDistance?: number;
}

export interface AudioPlayOptions {
  position?: Vector3;
  attachTo?: AbstractMesh;
  restart?: boolean;
}

interface RegisteredAudioCue {
  readonly url: string;
  readonly options: AudioCueOptions;
}

/** Safe, lazy audio facade: unknown cues and an empty registry are no-ops. */
export class AudioManager {
  private readonly cues = new Map<string, RegisteredAudioCue>();
  private readonly sounds = new Map<string, Sound>();
  private masterVolumeValue = 1;
  private enabledValue = true;

  constructor(private readonly scene: Scene) {}

  get masterVolume(): number {
    return this.masterVolumeValue;
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  register(id: string, url: string, options: AudioCueOptions = {}): void {
    if (this.cues.has(id)) {
      throw new Error(`Audio cue already registered: ${id}`);
    }
    this.cues.set(id, { url, options: { ...options } });
  }

  has(id: string): boolean {
    return this.cues.has(id);
  }

  setEnabled(enabled: boolean): void {
    this.enabledValue = enabled;
    if (!enabled) {
      this.stopAll();
    }
  }

  setMasterVolume(volume: number): void {
    this.masterVolumeValue = Math.min(1, Math.max(0, volume));
    for (const [id, sound] of this.sounds) {
      const cueVolume = this.cues.get(id)?.options.volume ?? 1;
      sound.setVolume(cueVolume * this.masterVolumeValue);
    }
  }

  play(id: string, options: AudioPlayOptions = {}): boolean {
    if (!this.enabledValue) {
      return false;
    }

    const sound = this.getOrCreateSound(id);
    if (!sound) {
      return false;
    }

    if (options.restart && sound.isPlaying) {
      sound.stop();
    }
    if (options.attachTo) {
      sound.attachToMesh(options.attachTo);
    } else if (options.position) {
      sound.setPosition(options.position);
    }
    sound.play();
    return true;
  }

  stop(id: string): void {
    this.sounds.get(id)?.stop();
  }

  stopAll(): void {
    for (const sound of this.sounds.values()) {
      sound.stop();
    }
  }

  dispose(): void {
    for (const sound of this.sounds.values()) {
      sound.dispose();
    }
    this.sounds.clear();
    this.cues.clear();
  }

  private getOrCreateSound(id: string): Sound | null {
    const existing = this.sounds.get(id);
    if (existing) {
      return existing;
    }

    const cue = this.cues.get(id);
    if (!cue) {
      return null;
    }

    const sound = new Sound(id, cue.url, this.scene, undefined, {
      autoplay: false,
      loop: cue.options.loop ?? false,
      volume: (cue.options.volume ?? 1) * this.masterVolumeValue,
      playbackRate: cue.options.playbackRate ?? 1,
      spatialSound: cue.options.spatial ?? false,
      maxDistance: cue.options.maxDistance ?? 30,
    });
    this.sounds.set(id, sound);
    return sound;
  }
}
