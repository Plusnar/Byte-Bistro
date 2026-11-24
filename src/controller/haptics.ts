/**
 * Haptics for the phone controller.
 *
 * Android browsers have the Vibration API. iOS browsers (all of them run Safari's engine)
 * have none, but since iOS 18 Safari plays a short haptic "tick" when a switch control
 * (`<input type="checkbox" switch>`) is toggled. Clicking a hidden one through its label
 * borrows that tick. It is a single short tap, so a longer buzz becomes a few ticks in a
 * row. It is not an official API: on older iOS, or if Apple changes it, nothing happens
 * and the on-screen feedback remains.
 */

/** Gap between ticks standing in for one longer buzz, and the most ticks per buzz. */
const TICK_GAP_MS = 110;
const MAX_TICKS = 4;
/** About this many milliseconds of vibration per tick. */
const MS_PER_TICK = 110;

/** How many ticks stand in for a vibration of `ms` milliseconds. */
export const ticksFor = (ms: number): number =>
  Math.max(1, Math.min(MAX_TICKS, Math.round(ms / MS_PER_TICK)));

type Vibrate = (pattern: number) => boolean;

export interface Haptics {
  /** Vibrates for about `ms` milliseconds, or ticks on iOS. */
  buzz(ms: number): void;
  dispose(): void;
}

export const createHaptics = (doc: Document = document, nav: Navigator = navigator): Haptics => {
  const vibrateApi = (nav as Navigator & { vibrate?: Vibrate }).vibrate;
  const canVibrate = typeof vibrateApi === "function";
  let label: HTMLLabelElement | null = null;
  let pending: number | null = null;

  /** The hidden switch, built on first use and kept out of sight and out of the way. */
  const tickLabel = (): HTMLLabelElement => {
    if (label) return label;
    const input = doc.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.id = "bb-haptic-switch";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    label = doc.createElement("label");
    label.htmlFor = input.id;
    label.setAttribute("aria-hidden", "true");
    label.append(input);
    label.style.cssText =
      "position:fixed;left:-100px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;";
    doc.body.append(label);
    return label;
  };

  const stop = (): void => {
    if (pending !== null) window.clearTimeout(pending);
    pending = null;
  };

  const tick = (left: number): void => {
    pending = null;
    try {
      tickLabel().click();
    } catch {
      // No switch haptics here: the visual feedback remains.
    }
    if (left > 1) pending = window.setTimeout(() => tick(left - 1), TICK_GAP_MS);
  };

  return {
    buzz(ms: number): void {
      if (canVibrate) {
        try {
          vibrateApi.call(nav, ms);
        } catch {
          // Ignored: some browsers refuse without a recent tap.
        }
        return;
      }
      // A new buzz replaces one still ticking, so they never pile up.
      stop();
      tick(ticksFor(ms));
    },
    dispose(): void {
      stop();
      label?.remove();
      label = null;
    },
  };
};
