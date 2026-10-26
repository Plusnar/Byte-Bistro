/**
 * Fixed-size window of recent frame times, with the statistics the performance overlay and
 * the automatic quality controller read: mean, percentiles and the worst frame.
 *
 * Pure and allocation-free per frame: `push` writes into a preallocated ring, and the sorted
 * copy needed for percentiles is only made when someone asks, never on the render path.
 */
export interface FrameTimeSummary {
  readonly samples: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  /** 1000 / mean frame interval; 0 with no samples. */
  readonly fps: number;
}

export const EMPTY_SUMMARY: FrameTimeSummary = {
  samples: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, fps: 0,
};

export class FrameTimeWindow {
  private readonly ring: Float32Array;
  private readonly scratch: Float32Array;
  private next = 0;
  private filled = 0;

  constructor(readonly capacity = 300) {
    this.ring = new Float32Array(capacity);
    this.scratch = new Float32Array(capacity);
  }

  push(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
    this.ring[this.next] = milliseconds;
    this.next = (this.next + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  get count(): number {
    return this.filled;
  }

  clear(): void {
    this.next = 0;
    this.filled = 0;
  }

  summary(): FrameTimeSummary {
    const n = this.filled;
    if (n === 0) return EMPTY_SUMMARY;
    let sum = 0;
    let max = 0;
    for (let index = 0; index < n; index++) {
      const value = this.ring[index]!;
      this.scratch[index] = value;
      sum += value;
      if (value > max) max = value;
    }
    const sorted = this.scratch.subarray(0, n).sort();
    const mean = sum / n;
    return {
      samples: n,
      meanMs: mean,
      p50Ms: percentileOfSorted(sorted, 0.5),
      p95Ms: percentileOfSorted(sorted, 0.95),
      p99Ms: percentileOfSorted(sorted, 0.99),
      maxMs: max,
      fps: mean > 0 ? 1000 / mean : 0,
    };
  }
}

/** Nearest-rank percentile of an ascending array; `fraction` in 0..1. */
export const percentileOfSorted = (sorted: ArrayLike<number>, fraction: number): number => {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(Math.min(1, Math.max(0, fraction)) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))]!;
};
