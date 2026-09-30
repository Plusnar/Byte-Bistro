import type { AssetPriority } from "./AssetCache";

/**
 * Runs heavy main-thread jobs — parsing a GLB into a scene — one at a time, most urgent
 * first, and hands a frame back to the browser between them.
 *
 * Downloads run in parallel on the network; parsing does not parallelise, it only stacks.
 * Before this, a burst of arriving files parsed back to back inside a single task, which is
 * where the 1.6 s freezes at boot came from. One parse per frame bounds each freeze to the
 * cost of one file, and lets the loading screen and the menu keep painting in between.
 */

const RANK: Readonly<Record<AssetPriority, number>> = { critical: 0, gameplay: 1, background: 2 };

interface Job {
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly priority: AssetPriority;
  readonly sequence: number;
}

/**
 * Resolves on the next paint, or after `fallbackMs` when the tab is hidden and
 * requestAnimationFrame stops firing — otherwise a backgrounded tab would stall every load.
 */
export const nextFrame = (fallbackMs = 50): Promise<void> => new Promise((resolve) => {
  let settled = false;
  const done = (): void => { if (!settled) { settled = true; resolve(); } };
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
  if (raf) raf(done);
  setTimeout(done, raf ? fallbackMs : 0);
});

export class MainThreadQueue {
  private readonly jobs: Job[] = [];
  private running = false;
  private sequence = 0;

  constructor(private readonly yieldToBrowser: () => Promise<void> = () => nextFrame()) {}

  run<T>(job: () => Promise<T>, priority: AssetPriority = "gameplay"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({
        run: job,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority,
        sequence: this.sequence++,
      });
      void this.drain();
    });
  }

  get pending(): number {
    return this.jobs.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        this.jobs.sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.sequence - b.sequence);
        const job = this.jobs.shift()!;
        try {
          job.resolve(await job.run());
        } catch (error: unknown) {
          job.reject(error);
        }
        // Give the browser a frame before the next parse, so it can paint and handle input.
        if (this.jobs.length > 0) await this.yieldToBrowser();
      }
    } finally {
      this.running = false;
    }
  }
}

/** Shared by every scene: two scenes parsing at once would stack their freezes. */
export const mainThreadQueue = new MainThreadQueue();

/** Main-thread time a sliced job may take before it hands a frame back, in ms. */
export const FRAME_BUDGET_MS = 8;

/**
 * Runs `steps` in order, yielding a frame whenever the budget for this frame is spent.
 *
 * For work that is many small synchronous pieces — building 30 station views, compiling 40
 * materials — doing it in one go is a single long freeze; sliced, it is a string of short
 * frames the menu can keep animating between.
 */
export const runSliced = async <T>(
  items: readonly T[],
  step: (item: T) => void,
  shouldStop: () => boolean = () => false,
  budgetMs = FRAME_BUDGET_MS,
): Promise<void> => {
  let frameStart = performance.now();
  for (const item of items) {
    if (shouldStop()) return;
    step(item);
    if (performance.now() - frameStart >= budgetMs) {
      await nextFrame();
      frameStart = performance.now();
    }
  }
};
