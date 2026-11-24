import type { AbstractEngine } from "@babylonjs/core";
import { AutoQualityController, ladderIndexOf, type QualityStep } from "./autoQuality";
import {
  QUALITY_PROFILES,
  initialLevelFor,
  isQualityMode,
  targetFrameMsFor,
  type DeviceHints,
  type QualityLevel,
  type QualityMode,
  type QualitySettings,
} from "./qualityProfiles";

/**
 * The one owner of graphics quality. Subsystems never pick their own detail level: they
 * subscribe here and apply what they are told (glow, particles, menu shadows, resolution).
 *
 * Modes: `low`, `medium`, `high` are fixed; `auto` starts from a device guess and lets
 * AutoQualityController move along its ladder from measured frame times — only while a
 * shift is actually being played (menus and loading frames say nothing about gameplay).
 *
 * The choice is stored on its own key, so the save format does not change.
 */
export interface EngineRegistration {
  /**
   * Whether this engine draws at device resolution. The kitchen does; the two menu
   * canvases were always drawn at CSS resolution, and `high` keeps them that way.
   */
  readonly followsDevicePixelRatio: boolean;
}

type Listener = (settings: QualitySettings) => void;

const STORAGE_KEY = "byte-bistro:quality";

export interface QualityManagerOptions {
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  readonly hints?: DeviceHints;
  readonly devicePixelRatio?: () => number;
  readonly now?: () => number;
}

export class QualityManager {
  private modeValue: QualityMode;
  private current: QualitySettings;
  private controller: AutoQualityController | null = null;
  private autoActive = false;
  /** An automatic step decided at the end of a frame, applied before the next one. */
  private pendingStep: QualityStep | null = null;
  private readonly engines = new Map<AbstractEngine, EngineRegistration>();
  private readonly listeners = new Set<Listener>();
  private readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
  private readonly devicePixelRatio: () => number;
  private readonly now: () => number;
  private hints: DeviceHints;

  constructor(options: QualityManagerOptions = {}) {
    this.storage = options.storage === undefined ? safeLocalStorage() : options.storage;
    this.devicePixelRatio = options.devicePixelRatio
      ?? (() => (typeof window === "undefined" ? 1 : window.devicePixelRatio || 1));
    this.now = options.now ?? (() => performance.now());
    this.hints = options.hints ?? {};
    const stored = this.read();
    this.modeValue = stored ?? "auto";
    this.current = this.resolve();
  }

  get mode(): QualityMode {
    return this.modeValue;
  }

  get settings(): QualitySettings {
    return this.current;
  }

  /** The renderer is known only once an engine exists; refines the auto mode's start. */
  setDeviceHints(hints: DeviceHints): void {
    this.hints = { ...this.hints, ...hints };
    if (this.modeValue === "auto") {
      this.controller = null;
      this.apply(this.resolve());
    }
  }

  setMode(mode: QualityMode): void {
    if (!isQualityMode(mode)) return;
    this.modeValue = mode;
    this.write(mode);
    this.controller = null;
    this.apply(this.resolve());
  }

  /** Engines get their resolution from here; returns the unregister. */
  registerEngine(engine: AbstractEngine, registration: EngineRegistration): () => void {
    this.engines.set(engine, registration);
    this.applyResolution(engine, registration);
    return () => this.engines.delete(engine);
  }

  /** Calls `listener` now and on every change; returns the unsubscribe. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  /** Re-applies resolution, e.g. after the window moved to a screen with another DPR. */
  refreshResolution(): void {
    for (const [engine, registration] of this.engines) this.applyResolution(engine, registration);
  }

  /** The auto mode only listens while a shift is being played. */
  setAutoActive(active: boolean): void {
    if (this.autoActive === active) return;
    this.autoActive = active;
    this.pendingStep = null;
    this.controller?.reset();
  }

  /**
   * One presented frame's interval, from PerformanceManager.
   *
   * Samples arrive at the end of a frame, after it is drawn but before the browser shows
   * it. Applying a step there would resize the canvas (setHardwareScalingLevel resizes the
   * engine), which clears the frame just drawn: a blank frame, a visible blink, on every
   * automatic change. So a decision is only queued here; `flushPending` applies it at the
   * start of the next frame, before anything is drawn.
   */
  sampleFrame(intervalMs: number): void {
    if (this.modeValue !== "auto" || !this.autoActive) return;
    const controller = this.ensureController();
    const step = controller.sample(intervalMs, this.now());
    if (step) this.pendingStep = step;
  }

  /** Applies an automatic change decided last frame. Call before rendering a frame. */
  flushPending(): void {
    const step = this.pendingStep;
    if (!step) return;
    this.pendingStep = null;
    // The mode may have changed in between; a manual choice wins over a stale decision.
    if (this.modeValue !== "auto" || !this.autoActive) return;
    this.apply(this.settingsFor(step));
  }

  /** For the perf overlay and the benchmark. */
  describe(): { mode: QualityMode; level: QualityLevel; renderScale: number; averageFrameMs: number | null } {
    return {
      mode: this.modeValue,
      level: this.current.level,
      renderScale: this.current.renderScale,
      averageFrameMs: this.controller?.averageFrameMs ?? null,
    };
  }

  // ---------------------------------------------------------------------------------------

  private resolve(): QualitySettings {
    if (this.modeValue !== "auto") return QUALITY_PROFILES[this.modeValue];
    return this.settingsFor(this.ensureController().step);
  }

  private ensureController(): AutoQualityController {
    if (!this.controller) {
      const start = initialLevelFor(this.hints);
      this.controller = new AutoQualityController({
        targetFrameMs: targetFrameMsFor(start),
        startIndex: ladderIndexOf(start),
      });
    }
    return this.controller;
  }

  private settingsFor(step: QualityStep): QualitySettings {
    return { ...QUALITY_PROFILES[step.level], renderScale: step.renderScale };
  }

  private apply(settings: QualitySettings): void {
    const changed = JSON.stringify(settings) !== JSON.stringify(this.current);
    this.current = settings;
    this.refreshResolution();
    if (!changed) return;
    for (const listener of this.listeners) listener(settings);
  }

  private applyResolution(engine: AbstractEngine, registration: EngineRegistration): void {
    const deviceRatio = registration.followsDevicePixelRatio
      ? Math.min(this.devicePixelRatio(), this.current.maxDevicePixelRatio)
      : 1;
    const pixelsPerCssPixel = Math.max(0.25, deviceRatio * this.current.renderScale);
    const level = 1 / pixelsPerCssPixel;
    if (Math.abs(engine.getHardwareScalingLevel() - level) > 1e-3) engine.setHardwareScalingLevel(level);
  }

  private read(): QualityMode | null {
    try {
      const value = this.storage?.getItem(STORAGE_KEY);
      return isQualityMode(value) ? value : null;
    } catch {
      return null;
    }
  }

  private write(mode: QualityMode): void {
    try {
      this.storage?.setItem(STORAGE_KEY, mode);
    } catch {
      // Private mode or full storage: the choice lasts for this session only.
    }
  }
}

const safeLocalStorage = (): Pick<Storage, "getItem" | "setItem"> | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Hardware hints from the browser and a live engine. */
export const readDeviceHints = (engine: AbstractEngine): DeviceHints => {
  const nav = typeof navigator === "undefined"
    ? undefined
    : navigator as Navigator & { deviceMemory?: number };
  // WebGL and WebGPU engines both report a renderer; the abstract type does not declare it.
  const info = (engine as unknown as { getGlInfo?: () => { renderer: string } }).getGlInfo?.();
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return {
    gpuRenderer: info?.renderer,
    hardwareConcurrency: nav?.hardwareConcurrency,
    deviceMemoryGb: nav?.deviceMemory,
    mobile: coarse && /Mobi|Android|iPhone|iPad/i.test(nav?.userAgent ?? ""),
  };
};

/** The game's single quality owner, shared by every engine and scene. */
export const qualityManager = new QualityManager();
