import { MAX_RENDER_SCALE, MIN_RENDER_SCALE, type QualityLevel } from "./qualityProfiles";

/**
 * The automatic quality controller: decides, from measured frame intervals, when to step
 * the picture down or back up. Pure (time is passed in), so its behaviour — above all, that
 * it does not oscillate — is unit tested rather than hoped for.
 *
 * The ladder, cheapest visual loss first:
 *   high@1.0 → high@0.9 → medium@0.9 → medium@0.8 → low@0.8 → low@0.7 → low@0.6
 * Resolution goes first because a 10% drop is nearly invisible and saves ~19% of pixels;
 * effects go next; the floor is MIN_RENDER_SCALE, never lower.
 *
 * Stability rules:
 *   - decisions use an exponential moving average, never a single frame;
 *   - frames over HITCH_MS (a model parse, a tab switch) are left out of the average;
 *   - stepping down needs the average over budget for DOWN_AFTER_MS; stepping up needs it
 *     comfortably under for UP_AFTER_MS — the gap between the two thresholds is the
 *     hysteresis;
 *   - no two changes closer than MIN_INTERVAL_MS;
 *   - an upgrade that has to be undone within REVERT_WINDOW_MS blocks upgrades for an
 *     exponentially growing back-off, so a device on the edge settles instead of
 *     flickering; the back-off relaxes again after BACKOFF_RELAX_MS without a change;
 *   - at a 30 fps cap (frames pinned near 33 ms), a step down that did not make frames
 *     meaningfully faster is undone once and the target becomes that pace, so a capped
 *     device does not slide down the whole ladder for nothing.
 */
export interface QualityStep {
  readonly level: QualityLevel;
  readonly renderScale: number;
}

export const QUALITY_LADDER: readonly QualityStep[] = [
  { level: "high", renderScale: 1 },
  { level: "high", renderScale: 0.9 },
  { level: "medium", renderScale: 0.9 },
  { level: "medium", renderScale: 0.8 },
  { level: "low", renderScale: 0.8 },
  { level: "low", renderScale: 0.7 },
  { level: "low", renderScale: MIN_RENDER_SCALE },
];

export interface AutoQualityOptions {
  /** Frame interval to hold, in ms (16.7 for 60 fps). */
  readonly targetFrameMs: number;
  /** Over budget by this factor counts as too slow. */
  readonly downThreshold?: number;
  /** Under budget by this factor counts as headroom. */
  readonly upThreshold?: number;
  readonly downAfterMs?: number;
  readonly upAfterMs?: number;
  readonly minIntervalMs?: number;
  /** Smoothing of the moving average, 0..1 per sample (higher reacts faster). */
  readonly smoothing?: number;
  /** Where on the ladder to start. */
  readonly startIndex?: number;
  /** Ladder bounds; the controller never leaves them. */
  readonly minIndex?: number;
  readonly maxIndex?: number;
}

export const HITCH_MS = 250;
/**
 * A step down this soon after a step up counts as undoing it. Wide on purpose: a shift's
 * load swings (a disaster, a burst of particles) arrive tens of seconds apart.
 */
const REVERT_WINDOW_MS = 60_000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 8 * 60_000;
/** After this long without any change the back-off starts over from its base. */
const BACKOFF_RELAX_MS = 5 * 60_000;
/** A step down must cut the average frame time by at least this share to count. */
const MIN_STEP_GAIN = 0.1;
/**
 * The pace of a frame-rate cap (battery saver, a 30 Hz display, a throttled tab), and how
 * close the average must sit to it to be read as one. A device that is merely slow (50 ms
 * a frame, say) still steps down: lower quality may well help it.
 */
const CAPPED_FRAME_MS = 1000 / 30;
const CAP_TOLERANCE_MS = 2.5;
/** Samples on a new step before its average is trusted for that comparison. */
const SETTLE_SAMPLES = 30;

export class AutoQualityController {
  private target: number;
  private readonly downThreshold: number;
  private readonly upThreshold: number;
  private readonly downAfterMs: number;
  private readonly upAfterMs: number;
  private readonly minIntervalMs: number;
  private readonly smoothing: number;
  private readonly minIndex: number;
  private readonly maxIndex: number;
  private index: number;
  private average = 0;
  private hasAverage = false;
  private slowSince: number | null = null;
  private fastSince: number | null = null;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private lastUpgradeAt = Number.NEGATIVE_INFINITY;
  private upgradeBlockedUntil = Number.NEGATIVE_INFINITY;
  private backoffMs = BASE_BACKOFF_MS;
  /** The average just before the last step down, until the new step has been judged. */
  private averageBeforeDown: number | null = null;
  private samplesOnStep = 0;

  constructor(options: AutoQualityOptions) {
    this.target = options.targetFrameMs;
    this.downThreshold = options.downThreshold ?? 1.2;
    this.upThreshold = options.upThreshold ?? 1.05;
    this.downAfterMs = options.downAfterMs ?? 2_000;
    this.upAfterMs = options.upAfterMs ?? 8_000;
    this.minIntervalMs = options.minIntervalMs ?? 4_000;
    this.smoothing = options.smoothing ?? 0.08;
    this.minIndex = Math.max(0, options.minIndex ?? 0);
    this.maxIndex = Math.min(QUALITY_LADDER.length - 1, options.maxIndex ?? QUALITY_LADDER.length - 1);
    this.index = clamp(options.startIndex ?? this.minIndex, this.minIndex, this.maxIndex);
  }

  /** Frame interval being held, in ms; rises to the measured pace on a capped display. */
  get targetFrameMs(): number {
    return this.target;
  }

  get step(): QualityStep {
    return QUALITY_LADDER[this.index]!;
  }

  get stepIndex(): number {
    return this.index;
  }

  get averageFrameMs(): number {
    return this.average;
  }

  /** Forget the running average, e.g. after a pause or a scene change. */
  reset(): void {
    this.hasAverage = false;
    this.average = 0;
    this.slowSince = null;
    this.fastSince = null;
  }

  /**
   * Feeds one frame interval measured at `now`. Returns the new step when the controller
   * decided to change, null otherwise.
   */
  sample(frameMs: number, now: number): QualityStep | null {
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > HITCH_MS) return null;
    this.average = this.hasAverage ? this.average + (frameMs - this.average) * this.smoothing : frameMs;
    this.hasAverage = true;
    this.samplesOnStep += 1;

    const slow = this.average > this.target * this.downThreshold;
    const fast = this.average <= this.target * this.upThreshold;
    this.slowSince = slow ? this.slowSince ?? now : null;
    this.fastSince = fast ? this.fastSince ?? now : null;

    if (now - this.lastChangeAt < this.minIntervalMs) return null;
    if (now - this.lastChangeAt >= BACKOFF_RELAX_MS) this.backoffMs = BASE_BACKOFF_MS;

    // Judge the last step down once it has settled: no real gain means the frame rate is
    // capped from outside, so the lost quality bought nothing. Take it back and hold the
    // pace that was measured instead of the one hoped for.
    if (this.averageBeforeDown !== null && this.samplesOnStep >= SETTLE_SAMPLES) {
      const before = this.averageBeforeDown;
      this.averageBeforeDown = null;
      const capped = Math.abs(before - CAPPED_FRAME_MS) <= CAP_TOLERANCE_MS;
      if (capped && this.average > before * (1 - MIN_STEP_GAIN) && this.index > this.minIndex) {
        this.target = Math.max(this.target, before);
        return this.move(this.index - 1, now);
      }
    }

    if (slow && this.slowSince !== null && now - this.slowSince >= this.downAfterMs && this.index < this.maxIndex) {
      // Undoing a recent upgrade means this device sits on the edge: wait longer next time.
      if (now - this.lastUpgradeAt < REVERT_WINDOW_MS) {
        this.upgradeBlockedUntil = now + this.backoffMs;
        this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
      }
      const before = this.average;
      const step = this.move(this.index + 1, now);
      this.averageBeforeDown = before;
      return step;
    }
    if (fast && this.fastSince !== null && now - this.fastSince >= this.upAfterMs
      && this.index > this.minIndex && now >= this.upgradeBlockedUntil) {
      this.lastUpgradeAt = now;
      return this.move(this.index - 1, now);
    }
    return null;
  }

  private move(index: number, now: number): QualityStep {
    this.index = clamp(index, this.minIndex, this.maxIndex);
    this.lastChangeAt = now;
    this.slowSince = null;
    this.fastSince = null;
    // The new step changes the cost of a frame: measure it afresh.
    this.hasAverage = false;
    this.samplesOnStep = 0;
    this.averageBeforeDown = null;
    return this.step;
  }
}

/** The highest (best-looking) ladder step at a given level. */
export const ladderIndexOf = (level: QualityLevel): number =>
  QUALITY_LADDER.findIndex((step) => step.level === level);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const clampRenderScale = (value: number): number => clamp(value, MIN_RENDER_SCALE, MAX_RENDER_SCALE);
