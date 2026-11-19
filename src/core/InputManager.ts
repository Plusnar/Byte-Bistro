import { Vector2 } from "@babylonjs/core/Maths/math.vector";

export type InputAction =
  | "moveUp"
  | "moveDown"
  | "moveLeft"
  | "moveRight"
  | "run"
  | "dash"
  | "emote"
  | "interact"
  | "carry"
  | "cookbook"
  | "pause";

export type InputBindings = Readonly<Record<InputAction, readonly string[]>>;

/**
 * Anything other than the keyboard that drives a cook: a phone controller, a gamepad.
 * Devices feed the same actions and movement vector as the keys, so every mechanic works
 * with every device and none has its own movement code. `InputManager.poll` reads them
 * once per frame.
 */
export interface InputDevice {
  readonly id: string;
  /** Updates the device's state for this frame (smoothing, safety timeouts, gamepad poll). */
  poll(nowMs: number, deltaSeconds: number): void;
  /** Analog movement, -1..1, same axes as the keyboard vector (y positive = down/back). */
  readonly axisX: number;
  readonly axisY: number;
  /** Adds the actions held right now. */
  collectHeld(out: Set<InputAction>): void;
  /** Adds the actions pressed since the last poll, even if already released again. */
  collectPressed(out: Set<InputAction>): void;
  /** The button to show for `action` on this device ("A" on a phone), if it has its own. */
  labelFor?(action: InputAction): string | null;
}

export const PLAYER_ONE_BINDINGS: InputBindings = {
  moveUp: ["KeyW"],
  moveDown: ["KeyS"],
  moveLeft: ["KeyA"],
  moveRight: ["KeyD"],
  run: ["ShiftLeft"],
  dash: ["Space"],
  emote: ["KeyQ"],
  interact: ["KeyE"],
  carry: ["KeyF"],
  cookbook: ["Tab"],
  pause: ["Escape"],
};

export const PLAYER_TWO_BINDINGS: InputBindings = {
  moveUp: ["ArrowUp"],
  moveDown: ["ArrowDown"],
  moveLeft: ["ArrowLeft"],
  moveRight: ["ArrowRight"],
  // Not Right Ctrl: Ctrl is one modifier for the whole keyboard, so holding it turned
  // player one's W/Tab/S/D into Ctrl+W (close tab), Ctrl+Tab and other browser shortcuts.
  run: ["Numpad0"],
  // Right of player two's own run key, so dash sits under the same thumb as on the left
  // half of the keyboard.
  dash: ["NumpadDecimal"],
  emote: ["Numpad1"],
  interact: ["Enter"],
  carry: ["ShiftRight"],
  cookbook: [],
  pause: [],
};

/** Cooks three and four have no half of the keyboard: they play with a phone or a gamepad. */
export const NO_KEYBOARD_BINDINGS: InputBindings = {
  moveUp: [],
  moveDown: [],
  moveLeft: [],
  moveRight: [],
  run: [],
  dash: [],
  emote: [],
  interact: [],
  carry: [],
  cookbook: [],
  pause: [],
};

/** Human-readable keycap labels for the codes actually bound above. */
const KEY_LABELS: Readonly<Record<string, string>> = {
  KeyW: "W",
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  KeyE: "E",
  KeyF: "F",
  KeyQ: "Q",
  // Unaccented on purpose: keycaps are the one place the game writes letters outside i18n.
  Space: "SPACE",
  NumpadDecimal: "NUM .",
  Numpad1: "NUM 1",
  Tab: "TAB",
  Escape: "ESC",
  Enter: "ENTER",
  ShiftLeft: "SHIFT",
  ShiftRight: "RSHIFT",
  Numpad0: "NUM 0",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/** Strips the common code prefixes so an unmapped binding still reads sensibly. */
const labelForCode = (code: string): string =>
  KEY_LABELS[code] ?? code.replace(/^(Key|Digit|Numpad)/, "").toUpperCase();

/**
 * The keycap to show for `action` under `bindings`, e.g. "E" for player one's interact and
 * "ENTER" for player two's. Returns null when the action is unbound for that player.
 */
export const labelForAction = (
  bindings: InputBindings,
  action: InputAction,
): string | null => {
  const code = bindings[action][0];
  return code ? labelForCode(code) : null;
};

/** Fields where keys are text, never gameplay. */
const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || Boolean(target.closest("input, textarea, select")));

/** Buttons and disclosure toggles: they react to the keys in CLICK_KEYS. */
const isClickableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && Boolean(target.closest("button, summary"));

/**
 * The keys that activate a focused button. Only these are left to the button; ESC, TAB and
 * movement keep reaching the game, so the pause and recipe screens close with the keys
 * their hints advertise even while one of their buttons has focus.
 */
const CLICK_KEYS: ReadonlySet<string> = new Set(["Enter", "NumpadEnter", "Space"]);

const PREVENT_DEFAULT_CODES = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  // Dash. Left alone it scrolls the page; it stays in CLICK_KEYS, so a focused button
  // still gets it.
  "Space",
]);

/**
 * Owns all gameplay keyboard listeners and exposes both held and one-frame input.
 * Call `endFrame` after every simulation update.
 */
export class InputManager {
  private readonly heldCodes = new Set<string>();
  private readonly heldActions = new Set<InputAction>();
  private readonly pressedActions = new Set<InputAction>();
  private readonly releasedActions = new Set<InputAction>();
  private readonly codeActions = new Map<string, readonly InputAction[]>();
  private readonly movementVector = new Vector2();
  private readonly devices: InputDevice[] = [];
  /** Actions held by any device, as of the last poll. */
  private readonly deviceActions = new Set<InputAction>();
  private readonly deviceScratch = new Set<InputAction>();
  private readonly devicePressedScratch = new Set<InputAction>();
  /** Held through a clear(): they must be let go before they count again. */
  private readonly suppressedDeviceActions = new Set<InputAction>();
  private enabledValue = true;
  private disposed = false;

  constructor(
    private readonly target: EventTarget = window,
    private readonly bindings: InputBindings = PLAYER_ONE_BINDINGS,
  ) {
    const actionEntries = Object.entries(bindings) as Array<
      [InputAction, readonly string[]]
    >;

    for (const [action, codes] of actionEntries) {
      for (const code of codes) {
        const actions = this.codeActions.get(code) ?? [];
        this.codeActions.set(code, [...actions, action]);
      }
    }

    target.addEventListener("keydown", this.handleKeyDown);
    target.addEventListener("keyup", this.handleKeyUp);
    target.addEventListener("blur", this.handleBlur);
  }

  /**
   * Label for `action`, for on-screen prompts: the button of an attached device that names
   * its own (a phone's "A"), else this player's keycap.
   */
  labelFor(action: InputAction): string | null {
    for (const device of this.devices) {
      const label = device.labelFor?.(action);
      if (label) return label;
    }
    return labelForAction(this.bindings, action);
  }

  /** Swaps left with right and up with down, as the inverted-controls disaster does. */
  invertMovement = false;

  get enabled(): boolean {
    return this.enabledValue;
  }

  set enabled(value: boolean) {
    if (this.enabledValue === value) {
      return;
    }

    this.enabledValue = value;
    if (!value) {
      this.clear();
    }
  }

  isDown(action: InputAction): boolean {
    return this.enabledValue && (this.heldActions.has(action) || this.deviceActions.has(action));
  }

  attachDevice(device: InputDevice): void {
    if (!this.devices.includes(device)) this.devices.push(device);
  }

  detachDevice(device: InputDevice): void {
    const index = this.devices.indexOf(device);
    if (index < 0) return;
    this.devices.splice(index, 1);
    // Whatever it held is let go now, not left pressed.
    this.poll(0);
  }

  get attachedDevices(): readonly InputDevice[] {
    return this.devices;
  }

  /**
   * Reads every attached device; call once per frame before gameplay reads input. Press
   * and release edges are produced only where the keyboard is not already holding the
   * same action, so two devices on one cook never double a press.
   */
  poll(deltaSeconds: number, nowMs: number = performance.now()): void {
    const held = this.deviceScratch;
    const pressed = this.devicePressedScratch;
    held.clear();
    pressed.clear();
    for (const device of this.devices) {
      device.poll(nowMs, deltaSeconds);
      device.collectHeld(held);
      device.collectPressed(pressed);
    }
    for (const action of this.suppressedDeviceActions) {
      if (!held.has(action)) this.suppressedDeviceActions.delete(action);
      else {
        held.delete(action);
        pressed.delete(action);
      }
    }
    for (const action of held) {
      if (!this.deviceActions.has(action) && !this.heldActions.has(action)) this.pressedActions.add(action);
    }
    // A tap that started and ended between two frames still presses once.
    for (const action of pressed) {
      if (!this.heldActions.has(action)) this.pressedActions.add(action);
    }
    for (const action of this.deviceActions) {
      if (!held.has(action) && !this.heldActions.has(action)) this.releasedActions.add(action);
    }
    this.deviceActions.clear();
    for (const action of held) this.deviceActions.add(action);
  }

  wasPressed(action: InputAction): boolean {
    return this.enabledValue && this.pressedActions.has(action);
  }

  consumePressed(action: InputAction): boolean {
    if (!this.wasPressed(action)) {
      return false;
    }

    this.pressedActions.delete(action);
    return true;
  }

  wasReleased(action: InputAction): boolean {
    return this.enabledValue && this.releasedActions.has(action);
  }

  /** Returns a normalized WASD vector (x = horizontal, y = forward/back). */
  getMovement(out: Vector2 = this.movementVector): Vector2 {
    if (!this.enabledValue) {
      return out.set(0, 0);
    }

    const horizontal = Number(this.heldActions.has("moveRight")) -
      Number(this.heldActions.has("moveLeft"));
    const vertical = Number(this.heldActions.has("moveDown")) -
      Number(this.heldActions.has("moveUp"));

    out.set(horizontal, vertical);
    if (horizontal === 0 && vertical === 0) {
      // No key held: the most deflected analog device steers (partial deflection walks
      // slower, as on any analog stick).
      let best = 0;
      for (const device of this.devices) {
        const magnitude = device.axisX * device.axisX + device.axisY * device.axisY;
        if (magnitude > best) {
          best = magnitude;
          out.set(device.axisX, device.axisY);
        }
      }
    }
    if (this.invertMovement) out.scaleInPlace(-1);
    if (out.lengthSquared() > 1) {
      out.normalize();
    }
    return out;
  }

  endFrame(): void {
    this.pressedActions.clear();
    this.releasedActions.clear();
  }

  clear(): void {
    this.heldCodes.clear();
    this.heldActions.clear();
    this.pressedActions.clear();
    this.releasedActions.clear();
    this.movementVector.set(0, 0);
    for (const action of this.deviceActions) this.suppressedDeviceActions.add(action);
    this.deviceActions.clear();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clear();
    this.devices.length = 0;
    this.target.removeEventListener("keydown", this.handleKeyDown);
    this.target.removeEventListener("keyup", this.handleKeyUp);
    this.target.removeEventListener("blur", this.handleBlur);
  }

  private readonly handleKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }

    if (!this.enabledValue || isTypingTarget(event.target) ||
      (isClickableTarget(event.target) && CLICK_KEYS.has(event.code))) return;

    if (PREVENT_DEFAULT_CODES.has(event.code)) {
      event.preventDefault();
    }

    if (this.heldCodes.has(event.code)) {
      return;
    }

    this.heldCodes.add(event.code);
    for (const action of this.codeActions.get(event.code) ?? []) {
      if (!this.heldActions.has(action) && !this.deviceActions.has(action)) {
        this.pressedActions.add(action);
      }
      this.heldActions.add(action);
    }
  };

  private readonly handleKeyUp = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }

    // A release is always honoured, wherever focus is: a key let go while a pause or recipe
    // button had focus used to stay held, and the cook kept walking after resuming.
    const ownsKey = this.enabledValue && !isTypingTarget(event.target) &&
      !(isClickableTarget(event.target) && CLICK_KEYS.has(event.code));
    if (ownsKey && PREVENT_DEFAULT_CODES.has(event.code)) {
      event.preventDefault();
    }

    this.heldCodes.delete(event.code);
    for (const action of this.codeActions.get(event.code) ?? []) {
      if (this.isActionStillHeld(action)) {
        continue;
      }

      // Still held on a phone or gamepad: not a release of the action.
      if (this.heldActions.delete(action) && !this.deviceActions.has(action)) {
        this.releasedActions.add(action);
      }
    }
  };

  private readonly handleBlur = (): void => {
    // Only the keyboard loses its keys when the window loses focus: a phone or a gamepad
    // keeps working while the TV's browser window is not focused.
    this.heldCodes.clear();
    for (const action of this.heldActions) {
      if (!this.deviceActions.has(action)) this.releasedActions.add(action);
    }
    this.heldActions.clear();
  };

  private isActionStillHeld(action: InputAction): boolean {
    return this.bindings[action].some((code) => this.heldCodes.has(code));
  }
}
