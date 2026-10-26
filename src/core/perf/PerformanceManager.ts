import {
  EngineInstrumentation,
  EngineStore,
  SceneInstrumentation,
  type AbstractEngine,
  type Nullable,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import { EMPTY_SUMMARY, FrameTimeWindow, type FrameTimeSummary } from "./frameStats";

/**
 * Measures the game while it runs: frame intervals (what the player feels), main-thread
 * time spent inside each frame, draw calls and meshes of the scene being played, and, where
 * the browser exposes them, GPU frame time and JS heap.
 *
 * It only reads. Everything that reacts to the numbers — the automatic quality mode — is in
 * QualityManager and subscribes through `onFrame`.
 *
 * Honesty rules for the numbers it reports:
 *   - `gpuFrameMs` is null unless the GPU timer extension is available (Chrome usually
 *     hides it); it is never derived from CPU time;
 *   - `jsHeapMb` is Chrome's non-standard `performance.memory`, coarse by design; null
 *     elsewhere;
 *   - texture memory is an ESTIMATE from texture dimensions (RGBA8 plus mipmaps); browsers
 *     do not report real VRAM use.
 */
export interface SceneCounters {
  readonly drawCalls: number;
  readonly activeMeshes: number;
  readonly totalMeshes: number;
  readonly materials: number;
  readonly textures: number;
  readonly particleSystems: number;
}

export interface EngineTextureEstimate {
  readonly engine: string;
  readonly scenes: number;
  readonly textures: number;
  /** Estimated GPU bytes of every texture in the engine's scenes, in MB. */
  readonly estimatedMb: number;
}

export interface PerformanceSnapshot {
  /** Interval between frames presented, the number fps is computed from. */
  readonly frame: FrameTimeSummary;
  /** Main-thread time inside the frame (update + render submission), without vsync waits. */
  readonly cpu: FrameTimeSummary;
  /** Frames slower than 100 ms since the last reset, the visible hitches. */
  readonly hitches: number;
  readonly scene: SceneCounters | null;
  readonly gpuFrameMs: number | null;
  readonly jsHeapMb: number | null;
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly hardwareScalingLevel: number;
  readonly engines: readonly EngineTextureEstimate[];
}

type FrameListener = (intervalMs: number, now: number) => void;

/** Longer than this between frames is a hidden tab or a breakpoint, not a slow frame. */
const PAUSE_GAP_MS = 1_000;
const HITCH_MS = 100;

export class PerformanceManager {
  private readonly intervals = new FrameTimeWindow(300);
  private readonly cpuTimes = new FrameTimeWindow(300);
  private readonly listeners = new Set<FrameListener>();
  private readonly beginObserver: Nullable<Observer<AbstractEngine>>;
  private readonly endObserver: Nullable<Observer<AbstractEngine>>;
  private frameStart = 0;
  private lastFrameEnd = 0;
  private hitchCount = 0;
  private scene: Scene | null = null;
  private sceneInstrumentation: SceneInstrumentation | null = null;
  private engineInstrumentation: EngineInstrumentation | null = null;
  private lastDrawCalls = 0;

  constructor(private readonly engine: AbstractEngine) {
    this.beginObserver = engine.onBeginFrameObservable.add(() => {
      this.frameStart = performance.now();
    });
    this.endObserver = engine.onEndFrameObservable.add(() => {
      const now = performance.now();
      this.cpuTimes.push(now - this.frameStart);
      if (this.sceneInstrumentation) this.lastDrawCalls = this.sceneInstrumentation.drawCallsCounter.current;
      if (this.lastFrameEnd > 0) {
        const interval = now - this.lastFrameEnd;
        if (interval < PAUSE_GAP_MS) {
          this.intervals.push(interval);
          if (interval > HITCH_MS) this.hitchCount += 1;
          for (const listener of this.listeners) listener(interval, now);
        }
      }
      this.lastFrameEnd = now;
    });
  }

  /** The scene whose draw calls and meshes are reported; replaces the previous one. */
  attachScene(scene: Scene): void {
    if (this.scene === scene) return;
    this.sceneInstrumentation?.dispose();
    this.scene = scene;
    this.sceneInstrumentation = new SceneInstrumentation(scene);
    this.lastDrawCalls = 0;
    scene.onDisposeObservable.addOnce(() => {
      if (this.scene !== scene) return;
      this.sceneInstrumentation?.dispose();
      this.sceneInstrumentation = null;
      this.scene = null;
    });
  }

  /**
   * Turns on GPU frame timing where the browser supports timer queries. Off by default:
   * the queries have a cost, so only the `?perf` overlay and the benchmark ask for them.
   */
  enableGpuTiming(): boolean {
    if (this.engineInstrumentation) return true;
    const caps = this.engine.getCaps() as { timerQuery?: unknown };
    if (!caps.timerQuery) return false;
    this.engineInstrumentation = new EngineInstrumentation(this.engine);
    this.engineInstrumentation.captureGPUFrameTime = true;
    return true;
  }

  /** Called after every presented frame with its interval; returns the unsubscribe. */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts a fresh measurement window (e.g. once a shift is running). */
  reset(): void {
    this.intervals.clear();
    this.cpuTimes.clear();
    this.hitchCount = 0;
    this.lastFrameEnd = 0;
  }

  snapshot(): PerformanceSnapshot {
    const gpu = this.engineInstrumentation?.gpuFrameTimeCounter;
    const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
    return {
      frame: this.intervals.count ? this.intervals.summary() : EMPTY_SUMMARY,
      cpu: this.cpuTimes.count ? this.cpuTimes.summary() : EMPTY_SUMMARY,
      hitches: this.hitchCount,
      scene: this.scene ? this.sceneCounters(this.scene) : null,
      // The counter is in nanoseconds.
      gpuFrameMs: gpu && gpu.count > 0 ? gpu.lastSecAverage * 1e-6 : null,
      jsHeapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
      renderWidth: this.engine.getRenderWidth(),
      renderHeight: this.engine.getRenderHeight(),
      hardwareScalingLevel: this.engine.getHardwareScalingLevel(),
      engines: estimateTextureMemory(),
    };
  }

  dispose(): void {
    this.engine.onBeginFrameObservable.remove(this.beginObserver);
    this.engine.onEndFrameObservable.remove(this.endObserver);
    this.sceneInstrumentation?.dispose();
    this.engineInstrumentation?.dispose();
    this.listeners.clear();
  }

  private sceneCounters(scene: Scene): SceneCounters {
    return {
      drawCalls: this.lastDrawCalls,
      activeMeshes: scene.getActiveMeshes().length,
      totalMeshes: scene.meshes.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
      particleSystems: scene.particleSystems.length,
    };
  }
}

/**
 * Estimated GPU memory of the textures of every live Babylon engine (the game has three: the
 * kitchen, the cook selection and the level map). Textures shared inside an engine are
 * counted once; the same image loaded by two engines is counted twice, as it is uploaded
 * twice.
 */
export const estimateTextureMemory = (): EngineTextureEstimate[] =>
  EngineStore.Instances.map((engine, index) => {
    const seen = new Set<unknown>();
    let bytes = 0;
    let count = 0;
    for (const scene of engine.scenes) {
      for (const texture of scene.textures) {
        const internal = texture.getInternalTexture();
        if (!internal || seen.has(internal)) continue;
        seen.add(internal);
        count += 1;
        const faces = internal.isCube ? 6 : 1;
        const mipFactor = internal.generateMipMaps ? 4 / 3 : 1;
        bytes += internal.width * internal.height * 4 * faces * mipFactor;
      }
    }
    const canvas = engine.getRenderingCanvas();
    return {
      engine: canvas?.id || canvas?.className || `engine-${index}`,
      scenes: engine.scenes.length,
      textures: count,
      estimatedMb: bytes / 1048576,
    };
  });
