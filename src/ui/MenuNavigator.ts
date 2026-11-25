/**
 * Moves through the menus with a D-pad: player one's phone (or anything else that produces
 * `MenuCommand`s). Works on the DOM as it is: it finds the layer on top (a confirm box, an
 * open dialog, the pause/recipes/results overlay, or the menu step), walks between its
 * buttons by their position on screen, clicks on confirm and takes the layer's own way out
 * on back.
 *
 * Nothing runs per frame: it only works when a command arrives.
 */
import { MENU_KEYS, isDirection, type MenuCommand } from "./menuInput";
import { pickNeighbour } from "./spatialNav";
import type { SplashStep } from "./GameUI";

export interface MenuNavigatorHost {
  /** The game's UI root (`#ui-root`): overlays and the menu live under it. */
  readonly root: HTMLElement;
  /** The menu step on screen, or null while the menu is hidden. */
  splashStep(): SplashStep | null;
}

/**
 * What the cursor can stop on. A text field takes A as "type here" (`navactivate`, the
 * phone becomes its keyboard); an element with `data-nav-x` takes left/right itself
 * (`navstep`, e.g. the avatar wheel); `data-nav-back` is a layer's own "back" inside a
 * dialog; `data-nav-start` (or `autofocus`) is where the cursor starts.
 */
const FOCUSABLE = "button, summary, input:not([type=hidden]), [data-nav]";
const FOCUS_CLASS = "nav-focus";

const isShown = (element: Element): boolean => {
  if (!(element instanceof HTMLElement) || element.closest("[hidden], [inert]")) return false;
  if (element instanceof HTMLButtonElement && element.disabled) return false;
  // Inside a closed <details>, only its <summary> can be reached.
  const details = element.closest("details");
  if (details && !details.open && !(element instanceof HTMLElement && element.tagName === "SUMMARY" && element.parentElement === details)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

export class MenuNavigator {
  private current: HTMLElement | null = null;

  constructor(private readonly host: MenuNavigatorHost) {}

  /** Runs one command; true when it did something. */
  command(command: MenuCommand): boolean {
    const scope = this.scope();
    if (!scope) return false;

    // The level map has its own arrow-key graph between landmarks; feed it keys, as the
    // gamepad code on the map already does.
    if (scope.kind === "level" && this.mapTakes(command)) {
      const canvas = scope.element.querySelector<HTMLCanvasElement>("[data-ui='level-map-canvas']");
      if (canvas) {
        this.clearFocus();
        if (document.activeElement !== canvas) canvas.focus({ preventScroll: true });
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: MENU_KEYS[command], bubbles: true }));
        return true;
      }
    }

    if (command === "back" || (command === "pause" && scope.kind === "pause")) return this.back(scope);
    if (command === "pause" || command === "recipes") return false;

    const items = this.items(scope.element);
    if (items.length === 0) return false;
    // In a dialog the cursor starts where the focus already is (its autofocus: the first
    // field, the avatar wheel, the first item), already shown, so the first press moves.
    const active = document.activeElement;
    if (scope.kind === "dialog" && (!this.current || !items.includes(this.current)) && active instanceof HTMLElement && items.includes(active)) {
      this.focus(active);
    }
    if (!this.current || !items.includes(this.current)) {
      // The first press only shows where the cursor is; it does not move or click yet.
      this.focus(this.preferred(items));
      return true;
    }
    if (command === "confirm") {
      if (this.current instanceof HTMLInputElement) this.current.dispatchEvent(new CustomEvent("navactivate", { bubbles: true }));
      else this.current.click();
      return true;
    }
    if ((command === "left" || command === "right") && this.current.hasAttribute("data-nav-x")) {
      this.current.dispatchEvent(new CustomEvent("navstep", { detail: command === "left" ? -1 : 1 }));
      return true;
    }
    if (isDirection(command)) {
      const rects = items.map((item) => item.getBoundingClientRect());
      const index = pickNeighbour(this.current.getBoundingClientRect(), rects, command);
      if (index >= 0) {
        this.focus(items[index]!);
        return true;
      }
      // Nothing that way: scroll a long panel (the recipe text) instead.
      const scroller = scope.element.querySelector<HTMLElement>(".cookbook-detail, .bistro-collection-content");
      if (scroller && (command === "up" || command === "down")) {
        scroller.scrollBy({ top: command === "down" ? 140 : -140, behavior: "smooth" });
        return true;
      }
    }
    return false;
  }

  /** Moves the cursor one step, as if the D-pad was pressed (after typing a field). */
  advance(): void {
    this.command("down");
  }

  /** Forgets the cursor (the layer under it closed). */
  clearFocus(): void {
    this.current?.classList.remove(FOCUS_CLASS);
    this.current = null;
  }

  // -------------------------------------------------------------------------------------

  private scope(): { kind: "confirm" | "dialog" | "pause" | "cookbook" | "results" | SplashStep; element: HTMLElement } | null {
    const confirm = [...document.querySelectorAll<HTMLElement>(".confirm-dialog-backdrop")].at(-1);
    if (confirm) return { kind: "confirm", element: confirm };
    const dialog = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1);
    if (dialog) return { kind: "dialog", element: dialog };
    const root = this.host.root;
    for (const kind of ["results", "pause", "cookbook"] as const) {
      const overlay = root.querySelector<HTMLElement>(`[data-ui='${kind}']`);
      if (overlay && !overlay.hidden) return { kind, element: overlay };
    }
    const step = this.host.splashStep();
    if (!step) return null;
    const screen = root.querySelector<HTMLElement>(".selection-screen");
    if (!screen) return null;
    const element = step === "home"
      ? screen.querySelector<HTMLElement>(".selection-header")
      : step === "level"
        ? screen.querySelector<HTMLElement>("[data-ui='level-select']")
        : step === "pair"
          ? screen.querySelector<HTMLElement>("[data-ui='pair-select']")
          : screen.querySelector<HTMLElement>(".selection-footer");
    return element ? { kind: step, element } : null;
  }

  /** On the level step, the map takes the D-pad unless the cursor is on a button. */
  private mapTakes(command: MenuCommand): boolean {
    if (command === "pause" || command === "recipes") return false;
    const onButton = this.current !== null && this.current.isConnected && isShown(this.current) && this.current.closest("[data-ui='level-select']");
    if (onButton) {
      // An arrow from a button returns to the map's landmarks.
      if (isDirection(command)) {
        this.clearFocus();
        return true;
      }
      return false;
    }
    return true;
  }

  private items(scope: HTMLElement): HTMLElement[] {
    return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isShown);
  }

  /** Where the cursor starts in a layer: its main action, else its first control. */
  private preferred(items: readonly HTMLElement[]): HTMLElement {
    const start = items.find((item) => item.hasAttribute("data-nav-start") || item.hasAttribute("autofocus"));
    const primary = items.find((item) => item.classList.contains("primary-action") || item.classList.contains("confirm-dialog-cancel"));
    return start ?? primary ?? items[0]!;
  }

  private focus(element: HTMLElement): void {
    this.current?.classList.remove(FOCUS_CLASS);
    this.current = element;
    element.classList.add(FOCUS_CLASS);
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Each layer's own way out. */
  private back(scope: { kind: string; element: HTMLElement }): boolean {
    const click = (selector: string): boolean => {
      const button = scope.element.querySelector<HTMLElement>(selector) ?? this.host.root.querySelector<HTMLElement>(selector);
      if (!button || !isShown(button)) return false;
      button.click();
      this.clearFocus();
      return true;
    };
    switch (scope.kind) {
      case "confirm":
        return click(".confirm-dialog-cancel");
      case "dialog":
        // A step inside the dialog (an item's detail, a sub-form) goes back to the dialog.
        if (click("[data-nav-back]")) return true;
        (scope.element as HTMLDialogElement).close();
        this.clearFocus();
        return true;
      case "pause":
        return click("[data-action='resume']");
      case "cookbook":
        return click("[data-action='close-cookbook']");
      case "level":
        return click("[data-action='back-home']");
      case "home": {
        // Back on the home screen closes the settings drawer if it is open.
        const settings = scope.element.querySelector<HTMLDetailsElement>("details[open]");
        if (settings) {
          settings.open = false;
          this.clearFocus();
          return true;
        }
        return false;
      }
      default:
        return false;
    }
  }
}
