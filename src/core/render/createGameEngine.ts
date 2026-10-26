import { Engine, WebGPUEngine, type AbstractEngine } from "@babylonjs/core";
import { qualityManager, readDeviceHints } from "../perf/QualityManager";

/**
 * Creates the kitchen's engine: WebGL2, or WebGPU as an EXPERIMENT (`?renderer=webgpu`).
 *
 * WebGL2 is the renderer, on measurement (2026-10-15, Intel UHD, Babylon 8.56, see
 * docs/PERFORMANCE_AUDIT.md):
 *   - WebGPU spent more CPU per frame on this scene (52 ms vs 37 ms): the kitchen's cost is
 *     collisions, active-mesh evaluation and skeletal animation, which WebGPU does not
 *     change, and static batching already cut draw calls from ~1,800 to ~330;
 *   - and it draws this game wrongly (washed-out floor, black cooks, missing counters),
 *     with optimized and original assets alike — a material/lighting incompatibility still
 *     to be investigated.
 * So the flag is per-URL only (never remembered), for developers. A failure to start
 * WebGPU (no adapter, blocklisted driver, init error) falls back to WebGL2 silently.
 * The two menu canvases always use WebGL2.
 */
export type RendererPreference = "webgl2" | "webgpu";

const readPreference = (): RendererPreference => {
  try {
    return new URLSearchParams(window.location.search).get("renderer") === "webgpu" ? "webgpu" : "webgl2";
  } catch {
    return "webgl2";
  }
};

const createWebGL2 = (canvas: HTMLCanvasElement): Engine => new Engine(
  canvas,
  true,
  { stencil: true, preserveDrawingBuffer: false, powerPreference: "high-performance" },
  true,
);

const startEngine = async (canvas: HTMLCanvasElement): Promise<AbstractEngine> => {
  if (readPreference() === "webgpu") {
    try {
      if (await WebGPUEngine.IsSupportedAsync) {
        const engine = new WebGPUEngine(canvas, {
          antialias: true,
          stencil: true,
          powerPreference: "high-performance",
          adaptToDeviceRatio: true,
        });
        await engine.initAsync();
        return engine;
      }
    } catch (error: unknown) {
      console.warn("WebGPU could not start; using WebGL2.", error);
    }
  }
  return createWebGL2(canvas);
};

/** The kitchen's engine, registered with the quality manager for as long as it lives. */
export const createGameEngine = async (canvas: HTMLCanvasElement): Promise<AbstractEngine> => {
  const engine = await startEngine(canvas);
  // The renderer is known now: a software one starts the automatic mode on `low`.
  qualityManager.setDeviceHints(readDeviceHints(engine));
  const unregister = qualityManager.registerEngine(engine, { followsDevicePixelRatio: true });
  engine.onDisposeObservable.addOnce(unregister);
  return engine;
};

export const rendererName = (engine: AbstractEngine): string =>
  engine.isWebGPU ? "WebGPU" : `WebGL${(engine as Engine).webGLVersion ?? ""}`;
