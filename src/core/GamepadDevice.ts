import type { InputAction, InputDevice } from "./InputManager";

/** Standard-mapping buttons (https://w3c.github.io/gamepad/#remapping) → game actions. */
export const GAMEPAD_BUTTON_ACTIONS: Readonly<Record<number, InputAction>> = {
  0: "interact", // A / Cross
  2: "carry", // X / Square
  1: "dash", // B / Circle
  3: "emote", // Y / Triangle
  4: "run", // LB
  5: "run", // RB
  7: "carry", // RT
  8: "cookbook", // Back / Select
  9: "pause", // Start
};

const DEADZONE = 0.18;

/**
 * A physical gamepad driving one cook. Polled once per frame through `InputManager.poll`,
 * like every other device; the keyboard keeps working alongside it.
 */
export class GamepadDevice implements InputDevice {
  axisX = 0;
  axisY = 0;
  private held = new Set<InputAction>();
  private previous = new Set<InputAction>();
  private readonly pressed = new Set<InputAction>();

  constructor(
    readonly padIndex: number,
    private readonly mapping: Readonly<Record<number, InputAction>> = GAMEPAD_BUTTON_ACTIONS,
  ) {}

  get id(): string {
    return `gamepad:${this.padIndex}`;
  }

  poll(): void {
    const pad = navigator.getGamepads?.()[this.padIndex];
    const swap = this.previous;
    this.previous = this.held;
    this.held = swap;
    this.held.clear();
    if (!pad?.connected) {
      this.axisX = 0;
      this.axisY = 0;
      return;
    }
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    // Radial dead zone, rescaled so movement starts at 0 just past it.
    const magnitude = Math.hypot(x, y);
    const scaled = magnitude < DEADZONE ? 0 : Math.min(1, (magnitude - DEADZONE) / (1 - DEADZONE)) / magnitude;
    this.axisX = x * scaled;
    this.axisY = y * scaled;
    // D-pad (12-15) moves too, digitally.
    const dx = Number(Boolean(pad.buttons[15]?.pressed)) - Number(Boolean(pad.buttons[14]?.pressed));
    const dy = Number(Boolean(pad.buttons[13]?.pressed)) - Number(Boolean(pad.buttons[12]?.pressed));
    if (dx || dy) {
      const length = Math.hypot(dx, dy);
      this.axisX = dx / length;
      this.axisY = dy / length;
    }
    for (const [index, action] of Object.entries(this.mapping)) {
      if (pad.buttons[Number(index)]?.pressed) this.held.add(action);
    }
    for (const action of this.held) if (!this.previous.has(action)) this.pressed.add(action);
  }

  collectHeld(out: Set<InputAction>): void {
    for (const action of this.held) out.add(action);
  }

  collectPressed(out: Set<InputAction>): void {
    for (const action of this.pressed) out.add(action);
    this.pressed.clear();
  }
}
