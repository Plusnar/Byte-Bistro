/**
 * Drives the loading screen that `index.html` paints before any JavaScript runs.
 *
 * The markup and styles live inline in the page on purpose: the game's bundle is the largest
 * download, and a loader created by that bundle could only appear after it. This class just
 * takes over the element that is already on screen.
 *
 * The bar shows real progress, smoothed. The displayed value eases toward the reported one
 * but never runs ahead of it and never moves backwards, so it cannot claim more than has
 * actually loaded, and it does not jitter when a new file joins the batch.
 */

import { nextFrame } from "../core/assets/MainThreadQueue";

export type LoadingMode = "boot" | "match";

/** Fraction per second the display closes on the target; ~95% of a gap in half a second. */
const EASE_RATE = 6;
/** The bar reaches at least this many percent per second while catching up, so it ends. */
const MIN_CATCH_UP = 0.35;
const FADE_MS = 450;

export interface LoadingFailure {
  readonly message: string;
  /** Omitted when retrying cannot help (a slow network just needs time). */
  readonly onRetry?: () => void;
  /** Omitted when there is nothing sensible to continue into. */
  readonly onContinue?: () => void;
}

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly status: HTMLElement;
  private readonly percent: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly continueButton: HTMLButtonElement;
  private target = 0;
  private shown = 0;
  private frame = 0;
  private lastTick = 0;
  private hideTimer = 0;

  private constructor(root: HTMLElement) {
    this.root = root;
    this.fill = LoadingScreen.part(root, ".bl-fill");
    this.status = LoadingScreen.part(root, ".bl-status");
    this.percent = LoadingScreen.part(root, ".bl-pct");
    this.retryButton = LoadingScreen.part<HTMLButtonElement>(root, "[data-action='boot-retry']");
    this.continueButton = LoadingScreen.part<HTMLButtonElement>(root, "[data-action='boot-continue']");
  }

  /** Adopts the loader from index.html. Returns null when the page has none (tests, embeds). */
  static attach(documentRef: Document = document): LoadingScreen | null {
    const root = documentRef.getElementById("boot-loader");
    return root ? new LoadingScreen(root) : null;
  }

  private static part<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Loading screen is missing ${selector}`);
    return element;
  }

  get visible(): boolean {
    return !this.root.hidden && this.root.dataset.state !== "done";
  }

  /** Shows the loader. `match` is the short, smaller variant used before a shift. */
  show(mode: LoadingMode, status: string): void {
    window.clearTimeout(this.hideTimer);
    this.root.hidden = false;
    this.root.dataset.mode = mode;
    this.root.dataset.state = "loading";
    this.retryButton.hidden = false;
    this.continueButton.hidden = false;
    this.target = 0;
    this.shown = 0;
    this.render();
    this.setStatus(status);
    this.startTicking();
  }

  /** Reports real progress, 0..1. Lower values than before are ignored. */
  setProgress(fraction: number, status?: string): void {
    if (Number.isFinite(fraction)) this.target = Math.max(this.target, Math.min(1, Math.max(0, fraction)));
    if (status) this.setStatus(status);
    this.startTicking();
  }

  setStatus(text: string): void {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  /** Stops on an error, with retry and (when possible) continue. Never a dead end. */
  fail(failure: LoadingFailure): void {
    this.root.dataset.state = "error";
    this.setStatus(failure.message);
    this.retryButton.textContent = "Tentar novamente";
    this.retryButton.hidden = !failure.onRetry;
    const retry = failure.onRetry;
    this.retryButton.onclick = retry
      ? () => {
        this.root.dataset.state = "loading";
        retry();
      }
      : null;
    this.continueButton.hidden = !failure.onContinue;
    this.continueButton.onclick = failure.onContinue ?? null;
  }

  /** Fills the bar, fades out, and resolves once the loader is gone. */
  async hide(): Promise<void> {
    this.target = 1;
    // Let the bar visibly reach 100% rather than vanishing at 87%.
    const deadline = performance.now() + 400;
    // nextFrame, not requestAnimationFrame: rAF stops in a background tab and would hang here.
    while (this.shown < 0.999 && performance.now() < deadline) await nextFrame();
    this.shown = 1;
    this.render();
    this.root.dataset.state = "done";
    await new Promise<void>((resolve) => {
      this.hideTimer = window.setTimeout(resolve, FADE_MS);
    });
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private startTicking(): void {
    if (this.frame) return;
    this.lastTick = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    const seconds = Math.min(0.1, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;
    const gap = this.target - this.shown;
    if (gap > 0) {
      const eased = gap * (1 - Math.exp(-EASE_RATE * seconds));
      this.shown = Math.min(this.target, this.shown + Math.max(eased, MIN_CATCH_UP * seconds));
    }
    this.render();
    this.frame = this.root.dataset.state === "done" ? 0 : requestAnimationFrame(this.tick);
  };

  private render(): void {
    const percent = Math.floor(this.shown * 100);
    this.fill.style.transform = `scaleX(${this.shown.toFixed(4)})`;
    const label = `${percent}%`;
    if (this.percent.textContent !== label) {
      this.percent.textContent = label;
      this.root.setAttribute("aria-valuenow", String(percent));
    }
  }
}
