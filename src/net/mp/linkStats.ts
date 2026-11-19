/**
 * Connection quality estimators, pure so they can be tested: round-trip time (smoothed as
 * TCP does, RFC 6298), jitter (RFC 3550-style mean deviation) and loss on the unreliable
 * movement stream from sequence gaps.
 */
import { seqNewer } from "./protocol";

export class RttEstimator {
  last = 0;
  smoothed = 0;
  jitter = 0;
  samples = 0;

  add(rtt: number): void {
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.last = rtt;
    if (this.samples === 0) {
      this.smoothed = rtt;
      this.jitter = rtt / 2;
    } else {
      this.jitter += (Math.abs(rtt - this.smoothed) - this.jitter) / 4;
      this.smoothed += (rtt - this.smoothed) / 8;
    }
    this.samples += 1;
  }

  reset(): void {
    this.last = 0;
    this.smoothed = 0;
    this.jitter = 0;
    this.samples = 0;
  }
}

/**
 * Loss on a 16-bit sequence stream, over a sliding window: frames that never arrived
 * (gaps) over frames expected. Reordered late frames are not counted twice.
 */
export class LossEstimator {
  private last = -1;
  private expected = 0;
  private received = 0;
  /** Loss of the last completed window, 0..1. */
  loss = 0;

  constructor(private readonly window = 200) {}

  /** Returns false for a stale (older or duplicate) frame, which the caller should drop. */
  add(seq: number): boolean {
    if (this.last < 0) {
      this.last = seq;
      this.expected += 1;
      this.received += 1;
      return true;
    }
    if (!seqNewer(seq, this.last)) return false;
    const gap = (seq - this.last) & 0xffff;
    // A jump of thousands is a phone that restarted its counter, not lost frames.
    this.expected += gap > 1_000 ? 1 : gap;
    this.received += 1;
    this.last = seq;
    if (this.expected >= this.window) {
      this.loss = Math.max(0, 1 - this.received / this.expected);
      this.expected = 0;
      this.received = 0;
    }
    return true;
  }

  reset(): void {
    this.last = -1;
    this.expected = 0;
    this.received = 0;
    this.loss = 0;
  }
}

/** Bytes and messages counted per direction, for the diagnostics panel. */
export class TrafficCounter {
  sentMessages = 0;
  receivedMessages = 0;
  sentBytes = 0;
  receivedBytes = 0;

  sent(bytes: number): void {
    this.sentMessages += 1;
    this.sentBytes += bytes;
  }

  received(bytes: number): void {
    this.receivedMessages += 1;
    this.receivedBytes += bytes;
  }
}
