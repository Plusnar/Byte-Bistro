/**
 * Phone side: decides when to send a movement frame. Pure (the clock is passed in), so the
 * adaptive rate is unit tested.
 *
 *  - Sends on change: a stick that has not moved (after 8-bit quantisation) is not resent…
 *  - …except as a keepalive, so the host's safety timeout never fires on a held stick.
 *  - The rate adapts within the transport's range: up on a clean link, down quickly on
 *    loss, jitter or a congested channel (bufferedAmount).
 */
import type { TransportKind } from "./protocol";

export interface RateProfile {
  readonly minHz: number;
  readonly maxHz: number;
  readonly startHz: number;
  /** Keepalive while the stick is off-centre or a button is held. */
  readonly activeKeepaliveMs: number;
  /** Heartbeat when nothing is pressed. */
  readonly idleKeepaliveMs: number;
}

export const RATE_PROFILES: Readonly<Record<"p2p" | "websocket" | "https", RateProfile>> = {
  p2p: { minHz: 10, maxHz: 60, startHz: 30, activeKeepaliveMs: 100, idleKeepaliveMs: 1_000 },
  // Every relayed frame is a billed message (1/20 of a request): 15 Hz is smooth with the
  // host's interpolation and keeps a 4-player match inside the free quota.
  websocket: { minHz: 10, maxHz: 15, startHz: 12, activeKeepaliveMs: 250, idleKeepaliveMs: 2_000 },
  https: { minHz: 2, maxHz: 3, startHz: 3, activeKeepaliveMs: 600, idleKeepaliveMs: 3_000 },
};

export const profileFor = (transport: TransportKind): RateProfile =>
  transport === "websocket" ? RATE_PROFILES.websocket : transport === "https" ? RATE_PROFILES.https : RATE_PROFILES.p2p;

const quantize = (value: number): number => Math.round(Math.max(-1, Math.min(1, value)) * 127);

export class InputSender {
  private profile: RateProfile = RATE_PROFILES.p2p;
  rateHz = RATE_PROFILES.p2p.startHz;
  private x = 0;
  private y = 0;
  private buttons = 0;
  private sentX = Number.NaN;
  private sentY = 0;
  private sentButtons = -1;
  private lastSentAt = -Infinity;
  private lastAdaptAt = 0;
  seq = 0;
  framesSent = 0;
  framesSkipped = 0;

  setProfile(profile: RateProfile): void {
    if (profile === this.profile) return;
    this.profile = profile;
    this.rateHz = profile.startHz;
    // Force a fresh frame on the new path.
    this.sentButtons = -1;
  }

  setStick(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  setButtons(mask: number): void {
    this.buttons = mask;
  }

  get stick(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  get heldButtons(): number {
    return this.buttons;
  }

  /** Whether a frame should go out now. Call often (every animation frame). */
  due(now: number): boolean {
    const qx = quantize(this.x);
    const qy = quantize(this.y);
    const changed = qx !== this.sentX || qy !== this.sentY || this.buttons !== this.sentButtons;
    const since = now - this.lastSentAt;
    if (changed) return since >= 1_000 / this.rateHz;
    const active = qx !== 0 || qy !== 0 || this.buttons !== 0;
    return since >= (active ? this.profile.activeKeepaliveMs : this.profile.idleKeepaliveMs);
  }

  /** Records that a frame was sent; returns its sequence number. */
  markSent(now: number): number {
    this.sentX = quantize(this.x);
    this.sentY = quantize(this.y);
    this.sentButtons = this.buttons;
    this.lastSentAt = now;
    this.framesSent += 1;
    this.seq = (this.seq + 1) & 0xffff;
    return this.seq;
  }

  /** The channel refused the frame (congested): back off. */
  congested(): void {
    this.framesSkipped += 1;
    this.rateHz = Math.max(this.profile.minHz, this.rateHz * 0.7);
  }

  /** Feeds link quality; adapts at most every 2 s, faster downwards. */
  adapt(now: number, quality: { rtt: number; jitter: number; loss: number }): void {
    if (now - this.lastAdaptAt < 2_000) return;
    this.lastAdaptAt = now;
    const { minHz, maxHz } = this.profile;
    if (quality.loss > 0.05 || quality.jitter > 40 || quality.rtt > 400) {
      this.rateHz = Math.max(minHz, this.rateHz * 0.7);
    } else if (quality.loss < 0.01 && quality.jitter < 12 && quality.rtt < 80) {
      this.rateHz = Math.min(maxHz, this.rateHz + 5);
    }
  }
}
