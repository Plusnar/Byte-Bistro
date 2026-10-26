import { t } from "../i18n";

/** What a disaster card shows: its glyph, title and one line of advice. */
export interface DisasterCard {
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * The HUD side of the chaos: the imminent-disaster card with its countdown, the
 * chip naming the disaster in progress, the red vignette of a kitchen on fire,
 * and the white flash of a lightning strike.
 *
 * Everything is drawn into GameUI's disaster layer and owned here, so the scene
 * only says what is happening and when.
 */
export class DisasterOverlay {
  private readonly vignette: HTMLElement;
  private readonly chaosChip: HTMLElement;
  private readonly status: HTMLElement;
  private readonly flashLayer: HTMLElement;
  private warning: { readonly element: HTMLElement; readonly count: HTMLElement; readonly bar: HTMLElement } | null = null;
  private warningTotal = 0;
  private lastCount = -1;

  constructor(private readonly layer: HTMLElement) {
    this.vignette = this.make("div", "disaster-vignette");
    this.chaosChip = this.make("div", "disaster-chaos-chip");
    this.chaosChip.hidden = true;
    this.status = this.make("div", "disaster-status");
    this.status.hidden = true;
    this.flashLayer = this.make("div", "disaster-flash");
    layer.append(this.vignette, this.chaosChip, this.status, this.flashLayer);
  }

  /** Shows the imminent-disaster card counting down from `seconds`. */
  showWarning(card: DisasterCard, seconds: number): void {
    this.hideWarning();
    const element = this.make("section", "disaster-warning");
    element.setAttribute("role", "alert");
    const stripeTop = this.make("div", "disaster-stripes");
    const body = this.make("div", "disaster-warning-body");
    const icon = this.make("div", "disaster-warning-icon", card.icon);
    icon.setAttribute("aria-hidden", "true");
    const copy = this.make("div", "disaster-warning-copy");
    copy.append(
      this.make("small", "disaster-warning-eyebrow", t("disaster.imminent")),
      this.make("strong", "disaster-warning-title", card.title),
      this.make("p", "disaster-warning-detail", card.detail),
      this.make("p", "disaster-warning-cause", t("disaster.penalty")),
    );
    const count = this.make("div", "disaster-warning-count");
    body.append(icon, copy, count);
    const track = this.make("div", "disaster-warning-track");
    const bar = this.make("div", "disaster-warning-bar");
    track.append(bar);
    const stripeBottom = this.make("div", "disaster-stripes");
    element.append(stripeTop, body, track, stripeBottom);
    this.layer.append(element);
    this.warning = { element, count, bar };
    this.warningTotal = Math.max(0.1, seconds);
    this.lastCount = -1;
    this.updateWarning(seconds);
  }

  /** Moves the countdown on; `remaining` is in seconds. */
  updateWarning(remaining: number): void {
    const warning = this.warning;
    if (!warning) return;
    const whole = Math.max(0, Math.ceil(remaining));
    if (whole !== this.lastCount) {
      this.lastCount = whole;
      warning.count.textContent = whole.toString();
      // Restart the pop on each new number.
      warning.count.classList.remove("is-ticking");
      void warning.count.offsetWidth;
      warning.count.classList.add("is-ticking");
    }
    warning.bar.style.setProperty("--left", `${Math.max(0, Math.min(1, remaining / this.warningTotal)) * 100}%`);
  }

  hideWarning(): void {
    this.warning?.element.remove();
    this.warning = null;
  }

  /** The chip naming the disaster in progress, or none. */
  setStatus(card: DisasterCard | null, secondsLeft = 0): void {
    if (!card) {
      this.status.hidden = true;
      return;
    }
    this.status.hidden = false;
    this.status.textContent = `${card.icon} ${t("disaster.active", { name: card.title, seconds: Math.ceil(secondsLeft) })}`;
  }

  /** 0..1 how much of the kitchen is burning; 0 clears the alarm. */
  setChaos(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    this.vignette.style.setProperty("--chaos", clamped.toFixed(3));
    this.vignette.classList.toggle("is-on", clamped > 0);
    const show = clamped > 0;
    if (this.chaosChip.hidden === show) {
      this.chaosChip.hidden = !show;
      this.chaosChip.textContent = `🔥 ${t("disaster.chaos")} 🔥`;
    }
  }

  /** A white flash over the whole screen, as a bolt strikes. */
  flash(strength = 1): void {
    this.flashLayer.style.setProperty("--flash", Math.max(0, Math.min(1, strength)).toFixed(2));
    this.flashLayer.classList.remove("is-flashing");
    void this.flashLayer.offsetWidth;
    this.flashLayer.classList.add("is-flashing");
  }

  /** Back to a calm screen, as at the start of a shift. */
  reset(): void {
    this.hideWarning();
    this.setStatus(null);
    this.setChaos(0);
    this.flashLayer.classList.remove("is-flashing");
  }

  dispose(): void {
    this.reset();
    for (const element of [this.vignette, this.chaosChip, this.status, this.flashLayer]) element.remove();
  }

  private make(tag: string, className: string, text?: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
}
