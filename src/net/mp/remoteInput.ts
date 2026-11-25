/**
 * Host side of a phone controller: turns the frames and button events that arrive (late,
 * out of order, or not at all) into a steady, safe input state the game polls every frame.
 *
 * - Stale frames are dropped by sequence number.
 * - The stick is smoothed toward the last received value with a time constant matched to
 *   the observed frame interval, so 15 Hz input still moves a cook smoothly at 60 fps.
 * - Safety: no frame for a while → the stick returns to centre; no message at all for
 *   longer → every button is released too. A cook never walks on after a disconnect.
 * - Buttons come as reliable events; the unreliable frames also carry the held mask, which
 *   repairs a button whose event was lost (relay hiccup) after a short grace period.
 */
import type { InputAction, InputDevice } from "../../core/InputManager";
import { BUTTONS, FLAG_BACKGROUND, buttonBit, type InputFrame, type PhoneButton } from "./protocol";
import { LossEstimator } from "./linkStats";

export interface SafetyTiming {
  /** No frame for this long while the stick is off-centre → centre it. */
  readonly axisStaleMs: number;
  /** Nothing at all for this long → release everything. */
  readonly silenceMs: number;
}

/**
 * WebRTC frames come every ≤ 100 ms while the stick is held, heartbeats every second. The
 * frames travel unreliably: phone Wi-Fi power saving delays a few in a row now and then,
 * and 350 ms stopped the cook on those hiccups. 600 ms rides them out and still stops a
 * cook whose phone really went quiet in well under a second.
 */
export const P2P_SAFETY: SafetyTiming = { axisStaleMs: 600, silenceMs: 2_500 };
/** The relays are slower and burstier. */
export const RELAY_SAFETY: SafetyTiming = { axisStaleMs: 700, silenceMs: 3_500 };
export const HTTPS_SAFETY: SafetyTiming = { axisStaleMs: 1_400, silenceMs: 5_000 };

/** Grace before the frame mask may override a button's last reliable event. */
const MASK_REPAIR_MS = 300;

export class RemoteControllerState {
  x = 0;
  y = 0;
  private targetX = 0;
  private targetY = 0;
  /** Held buttons, BUTTONS bit order. */
  held = 0;
  /** Buttons pressed since the last `takePresses`, so a tap shorter than a frame counts. */
  private latched = 0;
  private lastSeq = -1;
  private lastFrameAt = -Infinity;
  private lastAnyAt = -Infinity;
  private readonly buttonEventAt: number[] = BUTTONS.map(() => -Infinity);
  /** Smoothed interval between frames, ms. */
  frameIntervalMs = 33;
  readonly loss = new LossEstimator();
  framesAccepted = 0;
  framesDropped = 0;
  timing: SafetyTiming = P2P_SAFETY;
  private lastStepAt = -Infinity;

  /** Applies one movement frame; returns false if it was stale and ignored. */
  applyFrame(frame: Readonly<InputFrame>, now: number): boolean {
    if (!this.loss.add(frame.seq)) {
      this.framesDropped += 1;
      return false;
    }
    this.framesAccepted += 1;
    if (Number.isFinite(this.lastFrameAt)) {
      const interval = Math.min(1_000, now - this.lastFrameAt);
      this.frameIntervalMs += (interval - this.frameIntervalMs) / 8;
    }
    this.lastFrameAt = now;
    this.lastAnyAt = now;
    this.lastSeq = frame.seq;
    if (frame.flags & FLAG_BACKGROUND) {
      this.neutralize();
      return true;
    }
    this.targetX = frame.x;
    this.targetY = frame.y;
    for (let bit = 0; bit < BUTTONS.length; bit++) {
      const mask = 1 << bit;
      if ((frame.buttons & mask) !== (this.held & mask) && now - this.buttonEventAt[bit]! > MASK_REPAIR_MS) {
        this.setBit(mask, (frame.buttons & mask) !== 0);
      }
    }
    return true;
  }

  applyButton(button: PhoneButton, down: boolean, now: number): void {
    const bit = BUTTONS.indexOf(button);
    this.buttonEventAt[bit] = now;
    this.lastAnyAt = now;
    this.setBit(buttonBit(button), down);
  }

  /** Any sign of life (heartbeat, ping) that is not a frame. */
  touch(now: number): void {
    this.lastAnyAt = now;
  }

  releaseAll(now?: number): void {
    if (now !== undefined) this.lastAnyAt = now;
    this.neutralize();
  }

  neutralize(): void {
    this.targetX = 0;
    this.targetY = 0;
    this.x = 0;
    this.y = 0;
    this.held = 0;
  }

  /** Call once per game frame. */
  step(now: number, deltaSeconds: number): void {
    if (now - this.lastAnyAt > this.timing.silenceMs) {
      this.neutralize();
      this.latched = 0;
    } else if (now - this.lastFrameAt > this.timing.axisStaleMs) {
      this.targetX = 0;
      this.targetY = 0;
    }
    // Real elapsed time, not the frame's (clamped) delta: on a host running at a few
    // frames per second the stick still settles, and a release still stops the cook.
    const elapsed = Number.isFinite(this.lastStepAt) ? Math.min(0.5, Math.max(0, (now - this.lastStepAt) / 1_000)) : deltaSeconds;
    this.lastStepAt = now;
    const stopping = this.targetX === 0 && this.targetY === 0;
    const tau = Math.min(0.09, Math.max(0.012, (this.frameIntervalMs / 1_000) * 0.6)) * (stopping ? 0.5 : 1);
    const alpha = 1 - Math.exp(-Math.max(0, elapsed) / tau);
    this.x += (this.targetX - this.x) * alpha;
    this.y += (this.targetY - this.y) * alpha;
    if (this.targetX === 0 && this.targetY === 0 && Math.hypot(this.x, this.y) < 0.03) {
      this.x = 0;
      this.y = 0;
    }
  }

  takePresses(): number {
    const pressed = this.latched;
    this.latched = 0;
    return pressed;
  }

  get sequence(): number {
    return this.lastSeq;
  }

  get silentForMs(): number {
    return Number.isFinite(this.lastAnyAt) ? performance.now() - this.lastAnyAt : Infinity;
  }

  private setBit(mask: number, down: boolean): void {
    if (down) {
      if (!(this.held & mask)) this.latched |= mask;
      this.held |= mask;
    } else {
      this.held &= ~mask;
    }
  }
}

/**
 * Phone buttons → game actions. Editable: it is the remapping table for phones. The D-pad
 * and `back` are menu-only (see `src/ui/menuInput.ts`) and drive no cook.
 */
export type PhoneButtonActions = Readonly<Partial<Record<PhoneButton, InputAction>>>;
export const PHONE_BUTTON_ACTIONS: PhoneButtonActions = {
  grab: "interact",
  use: "carry",
  dash: "dash",
  emote: "emote",
  run: "run",
  recipes: "cookbook",
  pause: "pause",
};

/** The letter printed on the phone's button for each action, for the HUD's prompts. */
const PHONE_LABELS: Partial<Record<InputAction, string>> = {
  interact: "A",
  dash: "B",
  carry: "X",
  emote: "Y",
};

/**
 * A phone's stick only steers: any push past this (after the phone's own deadzone and the
 * host's smoothing) moves the cook at full running speed in that direction, however far
 * the thumb went. A touchscreen gives no feel for "how far", so partial speeds read as lag.
 */
export const STICK_MOVE_THRESHOLD = 0.05;

/** Feeds a phone's state into an InputManager, alongside keyboard and gamepads. */
export class RemoteInputDevice implements InputDevice {
  readonly state = new RemoteControllerState();
  axisX = 0;
  axisY = 0;
  /** Stick moves at full running speed in any direction pushed (see STICK_MOVE_THRESHOLD). */
  fullSpeed = true;

  constructor(readonly id: string, private readonly mapping: PhoneButtonActions = PHONE_BUTTON_ACTIONS) {}

  poll(nowMs: number, deltaSeconds: number): void {
    this.state.step(nowMs, deltaSeconds);
    const x = this.state.x;
    const y = this.state.y;
    const length = Math.hypot(x, y);
    if (this.fullSpeed && length >= STICK_MOVE_THRESHOLD) {
      this.axisX = x / length;
      this.axisY = y / length;
    } else {
      this.axisX = this.fullSpeed ? 0 : x;
      this.axisY = this.fullSpeed ? 0 : y;
    }
  }

  collectHeld(out: Set<InputAction>): void {
    const held = this.state.held;
    for (let bit = 0; bit < BUTTONS.length; bit++) {
      const action = held & (1 << bit) ? this.mapping[BUTTONS[bit]!] : undefined;
      if (action) out.add(action);
    }
    if (this.fullSpeed && (this.axisX !== 0 || this.axisY !== 0)) out.add("run");
  }

  labelFor(action: InputAction): string | null {
    return PHONE_LABELS[action] ?? null;
  }

  collectPressed(out: Set<InputAction>): void {
    const pressed = this.state.takePresses();
    for (let bit = 0; bit < BUTTONS.length; bit++) {
      const action = pressed & (1 << bit) ? this.mapping[BUTTONS[bit]!] : undefined;
      if (action) out.add(action);
    }
  }
}
