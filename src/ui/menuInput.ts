/**
 * Menu commands, independent of where they come from (a phone's D-pad today; the keyboard
 * and gamepads could feed the same type). Pure: no DOM, no network.
 */
import type { PhoneButton } from "../net/mp/protocol";

export type MenuCommand = "up" | "down" | "left" | "right" | "confirm" | "back" | "pause" | "recipes";
export type MenuDirection = "up" | "down" | "left" | "right";

export const isDirection = (command: MenuCommand): command is MenuDirection =>
  command === "up" || command === "down" || command === "left" || command === "right";

/**
 * A phone button press → the menu command it means. A confirms; B (sent as `dash` on the
 * game pad, `back` on the menu pad) goes back, so a player's thumb finds the same button
 * on both layouts.
 */
export const menuCommandFor = (button: PhoneButton): MenuCommand | null => {
  switch (button) {
    case "up":
    case "down":
    case "left":
    case "right":
      return button;
    case "grab":
      return "confirm";
    case "back":
    case "dash":
      return "back";
    case "pause":
      return "pause";
    case "recipes":
      return "recipes";
    default:
      return null;
  }
};

/** Synthetic key for a command, for screens that already handle the keyboard (the map). */
export const MENU_KEYS: Readonly<Record<MenuCommand, string>> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  confirm: "Enter",
  back: "Escape",
  pause: "Escape",
  recipes: "Tab",
};
