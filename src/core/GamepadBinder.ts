import { GamepadDevice } from "./GamepadDevice";
import type { InputManager } from "./InputManager";

/**
 * Physical gamepads: pad 0 drives cook 1, pad 1 cook 2 (and so on, wrapping), alongside the
 * keyboard. Devices exist only while a pad is connected; nothing is polled without one.
 */
export class GamepadBinder {
  private inputs: readonly InputManager[] = [];
  private readonly devices = new Map<number, GamepadDevice>();
  private readonly listeners = new AbortController();

  constructor() {
    window.addEventListener("gamepadconnected", (event) => this.connect((event as GamepadEvent).gamepad.index), { signal: this.listeners.signal });
    window.addEventListener("gamepaddisconnected", (event) => this.disconnect((event as GamepadEvent).gamepad.index), { signal: this.listeners.signal });
    // Pads connected before the page loaded show up only once a button is pressed; any
    // already reported are picked up here.
    for (const pad of navigator.getGamepads?.() ?? []) if (pad?.connected) this.connect(pad.index);
  }

  attachKitchen(inputs: readonly InputManager[]): void {
    for (const [index, device] of this.devices) this.slotFor(index)?.detachDevice(device);
    this.inputs = inputs;
    for (const [index, device] of this.devices) this.slotFor(index)?.attachDevice(device);
  }

  dispose(): void {
    this.listeners.abort();
    for (const [index, device] of this.devices) this.slotFor(index)?.detachDevice(device);
    this.devices.clear();
  }

  private slotFor(index: number): InputManager | undefined {
    return this.inputs.length ? this.inputs[index % this.inputs.length] : undefined;
  }

  private connect(index: number): void {
    if (this.devices.has(index)) return;
    const device = new GamepadDevice(index);
    this.devices.set(index, device);
    this.slotFor(index)?.attachDevice(device);
  }

  private disconnect(index: number): void {
    const device = this.devices.get(index);
    if (!device) return;
    this.devices.delete(index);
    this.slotFor(index)?.detachDevice(device);
  }
}
