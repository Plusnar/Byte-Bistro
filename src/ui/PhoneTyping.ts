import type { PhoneField, PhoneFieldKind, PhoneToHost } from "../net/mp/protocol";

export interface PhoneTypingHost {
  /** Player 1's phone is connected and can be the keyboard. */
  readonly available: () => boolean;
  /** Carries the offer to player 1's phone (null puts the keyboard away). */
  readonly offer: (field: PhoneField | null) => void;
  /** After a field is typed: the cursor moves on, as a D-pad "down" would. */
  readonly advance: () => void;
}

/**
 * Player 1's phone as the TV's keyboard. The screen stays on the TV: any text field marked
 * `data-phone-field="<kind>"` is offered to the phone as soon as the cursor (or the mouse,
 * or the dialog's autofocus) lands on it, and again when A is pressed on it after the
 * keyboard was put away. What is typed goes into the field, which then gets the usual
 * `input` event, and the cursor moves to the next control.
 *
 * Passwords are never sent to the phone (the field's text stays on the TV); see PhoneField.
 */
export class PhoneTyping {
  private active: HTMLInputElement | null = null;
  /** The active field was offered with its keyboard open. */
  private activeOpen = false;
  private offeredId = -1;
  private nextId = 0;
  private readonly hooks = new AbortController();

  constructor(private readonly host: PhoneTypingHost) {
    const signal = this.hooks.signal;
    document.addEventListener("focusin", (event) => this.focused(event.target), { signal });
    document.addEventListener("focusout", (event) => {
      if (event.target === this.active && !(event as FocusEvent).relatedTarget) this.withdraw();
    }, { signal });
    document.addEventListener("navactivate", (event) => {
      const field = fieldOf(event.target);
      if (field) this.offer(field, true);
    }, { signal });
    // A dialog closing takes its fields with it.
    document.addEventListener("close", () => {
      if (this.active && !this.active.isConnected) this.withdraw();
      else if (this.active?.closest("dialog:not([open])")) this.withdraw();
    }, { signal, capture: true });
  }

  dispose(): void {
    this.withdraw();
    this.hooks.abort();
  }

  /**
   * Offers the focused field, or puts the keyboard away when focus left the fields. Focus
   * events do not fire while the TV's window is not the active one, so the game also calls
   * this after each D-pad command and when a dialog opens. `open`: the flow led here (a
   * dialog opening on its first field, the field before typed), so the phone's keyboard
   * opens at once; just passing over a field with the D-pad only offers it.
   */
  sync(open = false): void {
    const field = fieldOf(document.activeElement);
    if (field) this.offer(field, open);
    else if (!field && this.active) this.withdraw();
  }

  /** Player 1 answered on their phone. */
  answer(message: Extract<PhoneToHost, { t: "field-submit" | "field-cancel" }>): void {
    const input = this.active;
    if (!input || message.id !== this.offeredId) return;
    if (message.t === "field-cancel") {
      // The keyboard was put away; the field stays offered (the phone shows its bar, and A
      // on the field opens it again).
      this.active = null;
      this.offer(input, false);
      return;
    }
    this.withdraw();
    if (!input.isConnected) return;
    input.value = message.value.slice(0, input.maxLength > 0 ? input.maxLength : undefined);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    this.host.advance();
    // The next control may be another field: its keyboard opens straight away.
    this.sync(true);
  }

  private focused(target: EventTarget | null): void {
    const field = fieldOf(target);
    if (field) this.offer(field);
    else if (this.active) this.withdraw();
  }

  private offer(input: HTMLInputElement, open = false): void {
    if (!this.host.available()) return;
    // Already offered: only a request to open the keyboard changes anything.
    if (input === this.active && (!open || this.activeOpen)) return;
    this.activeOpen = open;
    const kind = input.dataset.phoneField as PhoneFieldKind;
    this.active?.removeAttribute("data-phone-active");
    this.active = input;
    this.offeredId = this.nextId = (this.nextId + 1) & 0xffffff;
    input.setAttribute("data-phone-active", "");
    const secret = kind === "password" || kind === "new-password";
    this.host.offer({ id: this.offeredId, kind, ...(secret ? {} : { value: input.value }), ...(open ? { open } : {}) });
  }

  private withdraw(): void {
    if (!this.active) return;
    this.active.removeAttribute("data-phone-active");
    this.active = null;
    this.activeOpen = false;
    this.offeredId = -1;
    this.host.offer(null);
  }
}

const KINDS: ReadonlySet<string> = new Set(["username", "password", "new-password", "name"]);
const fieldOf = (target: EventTarget | null): HTMLInputElement | null =>
  target instanceof HTMLInputElement && KINDS.has(target.dataset.phoneField ?? "") ? target : null;
