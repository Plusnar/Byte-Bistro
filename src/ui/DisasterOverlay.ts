import { t } from "../i18n";
import { publicUrl } from "../utils/assetUrl";

/** What a disaster card shows: its glyph, title and one line of advice. */
export interface DisasterCard {
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * The HUD side of the chaos: a small penalty clock beside the order queue, the red
 * vignette of a kitchen on fire, and the white flash of a lightning strike.
 *
 * A failed order sets off a disaster. Its whole countdown — the warning before it starts,
 * then the time it has left — lives in that one clock, which shows the disaster's glyph
 * and leaves when it ends. Its name and advice are on the clock's label (tooltip and
 * screen readers); the warning sound still announces it.
 *
 * Everything is drawn into GameUI's disaster layer and owned here, so the scene
 * only says what is happening and when.
 */
export class DisasterOverlay {
  private readonly vignette: HTMLElement;
  private readonly chaosChip: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly clockGlyph: HTMLElement;
  private readonly clockSeconds: HTMLElement;
  private readonly flashLayer: HTMLElement;
  /** What the clock is counting, so text is only rewritten when it changes. */
  private phase: "idle" | "warning" | "active" = "idle";
  private card: DisasterCard | null = null;
  private lastCount = -1;

  constructor(layer: HTMLElement) {
    this.vignette = this.make("div", "disaster-vignette");
    this.chaosChip = this.make("div", "disaster-chaos-chip");
    this.chaosChip.hidden = true;
    this.clock = this.make("div", "penalty-clock");
    this.clock.hidden = true;
    this.clock.setAttribute("role", "timer");
    const face = document.createElement("img");
    face.className = "penalty-clock-face";
    face.alt = "";
    face.src = publicUrl("assets/ui/hud/penalty_clock.webp");
    this.clockGlyph = this.make("span", "penalty-clock-glyph");
    this.clockGlyph.setAttribute("aria-hidden", "true");
    this.clockSeconds = this.make("strong", "penalty-clock-seconds");
    this.clock.append(face, this.clockGlyph, this.clockSeconds);
    this.flashLayer = this.make("div", "disaster-flash");
    layer.append(this.vignette, this.chaosChip, this.clock, this.flashLayer);
  }

  /** Starts the clock on the warning before a disaster, counting down from `seconds`. */
  showWarning(card: DisasterCard, seconds: number): void {
    this.enter("warning", card);
    this.updateWarning(seconds);
  }

  /** Moves the warning countdown on; `remaining` is in seconds. */
  updateWarning(remaining: number): void {
    if (this.phase === "warning") this.tick(remaining);
  }

  hideWarning(): void {
    if (this.phase === "warning") this.leave();
  }

  /** The disaster in progress and its time left, or none: the clock goes away. */
  setStatus(card: DisasterCard | null, secondsLeft = 0): void {
    // Out of time is over, as far as the player is concerned: some disasters play an
    // exit afterwards (the saucer flying off), and a clock sitting on 0 through it read
    // as stuck.
    if (!card || secondsLeft <= 0) {
      if (this.phase === "active") this.leave();
      return;
    }
    if (this.phase !== "active" || this.card !== card) this.enter("active", card);
    this.tick(secondsLeft);
  }

  private enter(phase: "warning" | "active", card: DisasterCard): void {
    this.phase = phase;
    this.card = card;
    this.lastCount = -1;
    this.clock.dataset.phase = phase;
    this.clockGlyph.textContent = card.icon;
    const label = phase === "warning"
      ? `${t("disaster.imminent")}: ${card.title}. ${card.detail} ${t("disaster.penalty")}`
      : `${card.title}. ${card.detail}`;
    this.clock.title = label;
    this.clock.setAttribute("aria-label", label);
    this.clock.hidden = false;
  }

  private leave(): void {
    this.phase = "idle";
    this.card = null;
    this.clock.hidden = true;
    delete this.clock.dataset.phase;
  }

  /** Writes whole seconds, and pops the number as each one turns over. */
  private tick(remaining: number): void {
    const whole = Math.max(0, Math.ceil(remaining));
    if (whole === this.lastCount) return;
    this.lastCount = whole;
    this.clockSeconds.textContent = whole.toString();
    this.clockSeconds.classList.remove("is-ticking");
    void this.clockSeconds.offsetWidth;
    this.clockSeconds.classList.add("is-ticking");
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
    this.leave();
    this.setChaos(0);
    this.flashLayer.classList.remove("is-flashing");
  }

  dispose(): void {
    this.reset();
    for (const element of [this.vignette, this.chaosChip, this.clock, this.flashLayer]) element.remove();
  }

  private make(tag: string, className: string, text?: string): HTMLElement {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
}
