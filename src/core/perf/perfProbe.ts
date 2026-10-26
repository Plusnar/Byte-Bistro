import type { PerformanceManager, PerformanceSnapshot } from "./PerformanceManager";

/**
 * `?perf` in the URL: a small overlay with fps, frame-time percentiles, draw calls and
 * texture memory, and `window.__bbPerf` for the benchmark script (scripts/perf/run-perf.mjs).
 * `?dev` installs the handle without the overlay. Neither exists in a normal session.
 */
export interface PerfProbeSources {
  readonly performance: PerformanceManager;
  /** Extra sections for the snapshot: quality, asset streaming, ... */
  readonly extras?: () => Record<string, unknown>;
}

declare global {
  interface Window {
    __bbPerf?: {
      snapshot(): PerformanceSnapshot & Record<string, unknown>;
      reset(): void;
    };
  }
}

const OVERLAY_REFRESH_MS = 500;

export const perfFlags = (search = typeof window === "undefined" ? "" : window.location.search): {
  overlay: boolean;
  handle: boolean;
} => {
  const params = new URLSearchParams(search);
  const overlay = params.has("perf");
  return { overlay, handle: overlay || params.has("dev") };
};

/** Installs what the URL asks for; returns the uninstall. */
export const installPerfProbe = (sources: PerfProbeSources): (() => void) => {
  const flags = perfFlags();
  if (!flags.handle) return () => undefined;
  const snapshot = (): PerformanceSnapshot & Record<string, unknown> => ({
    ...sources.performance.snapshot(),
    ...(sources.extras?.() ?? {}),
  });
  window.__bbPerf = { snapshot, reset: () => sources.performance.reset() };
  if (!flags.overlay) return () => { delete window.__bbPerf; };

  sources.performance.enableGpuTiming();
  const overlay = document.createElement("pre");
  overlay.className = "perf-overlay";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed", right: "8px", bottom: "8px", zIndex: "2147483600", margin: "0",
    padding: "6px 8px", font: "11px/1.35 ui-monospace, monospace", color: "#d8fff4",
    background: "rgba(4, 12, 30, 0.82)", border: "1px solid #2b6d8f", borderRadius: "6px",
    pointerEvents: "none", whiteSpace: "pre",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.append(overlay);
  const timer = window.setInterval(() => {
    const s = snapshot();
    const quality = s.quality as { mode?: string; level?: string; renderScale?: number } | undefined;
    const lines = [
      `${s.frame.fps.toFixed(0)} fps  p50 ${s.frame.p50Ms.toFixed(1)}  p95 ${s.frame.p95Ms.toFixed(1)}  max ${s.frame.maxMs.toFixed(0)} ms`,
      `cpu ${s.cpu.meanMs.toFixed(1)} ms  gpu ${s.gpuFrameMs === null ? "n/a" : `${s.gpuFrameMs.toFixed(1)} ms`}  hitches ${s.hitches}`,
      s.scene
        ? `draws ${s.scene.drawCalls}  active ${s.scene.activeMeshes}/${s.scene.totalMeshes}  mats ${s.scene.materials}`
        : "no scene attached",
      `${s.renderWidth}x${s.renderHeight}  scale ${(1 / s.hardwareScalingLevel).toFixed(2)}`
        + (quality ? `  ${quality.mode}/${quality.level}@${quality.renderScale}` : ""),
      `tex est ${s.engines.map((engine) => `${engine.estimatedMb.toFixed(0)}`).join("+")} MB`
        + (s.jsHeapMb === null ? "" : `  heap ${s.jsHeapMb.toFixed(0)} MB`),
    ];
    overlay.textContent = lines.join("\n");
  }, OVERLAY_REFRESH_MS);
  return () => {
    window.clearInterval(timer);
    overlay.remove();
    delete window.__bbPerf;
  };
};
