import { Vector2 } from "@babylonjs/core/Maths/math.vector";

export type InputAction =
  | "moveUp"
  | "moveDown"
  | "moveLeft"
  | "moveRight"
  | "run"
  | "interact"
  | "carry"
  | "cookbook"
  | "pause";

export type InputBindings = Readonly<Record<InputAction, readonly string[]>>;

export const PLAYER_ONE_BINDINGS: InputBindings = {
  moveUp: ["KeyW"],
  moveDown: ["KeyS"],
  moveLeft: ["KeyA"],
  moveRight: ["KeyD"],
  run: ["ShiftLeft"],
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
  interact: ["Enter"],
  carry: ["ShiftRight"],
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

  /** Keycap label for `action` under this player's bindings, for on-screen prompts. */
  labelFor(action: InputAction): string | null {
    return labelForAction(this.bindings, action);
  }

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
    return this.enabledValue && this.heldActions.has(action);
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
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clear();
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
      if (!this.heldActions.has(action)) {
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

      if (this.heldActions.delete(action)) {
        this.releasedActions.add(action);
      }
    }
  };

  private readonly handleBlur = (): void => {
    this.clear();
  };

  private isActionStillHeld(action: InputAction): boolean {
    return this.bindings[action].some((code) => this.heldCodes.has(code));
  }
}
