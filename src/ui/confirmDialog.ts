import { t } from "../i18n";
import "../styles/confirm-dialog.css";

export interface ConfirmDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  readonly danger?: boolean;
}

let sequence = 0;

/**
 * Asks a yes/no question in the game's own style and resolves with the answer.
 *
 * Replaces `window.confirm`, which is unstyled, blocks the page (the render loop and the
 * shift timer with it) and cannot be translated. Mounted on <body> so it works over the
 * game UI and over the map editor, which live in separate trees.
 *
 * Focus starts on Cancel so that an Enter pressed out of habit never destroys anything;
 * Escape and a click on the backdrop cancel too.
 */
export const confirmDialog = (options: ConfirmDialogOptions): Promise<boolean> => {
  const id = `confirm-dialog-${++sequence}`;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const backdrop = document.createElement("div");
  backdrop.className = "confirm-dialog-backdrop";
  const dialog = document.createElement("section");
  dialog.className = "confirm-dialog";
  dialog.dataset.danger = String(Boolean(options.danger));
  dialog.setAttribute("role", "alertdialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${id}-title`);
  dialog.setAttribute("aria-describedby", `${id}-message`);

  const title = document.createElement("h2");
  title.id = `${id}-title`;
  title.className = "confirm-dialog-title";
  title.textContent = options.title;
  const message = document.createElement("p");
  message.id = `${id}-message`;
  message.className = "confirm-dialog-message";
  message.textContent = options.message;

  const actions = document.createElement("div");
  actions.className = "confirm-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "confirm-dialog-cancel";
  cancel.textContent = options.cancelLabel ?? t("common.cancel");
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "confirm-dialog-confirm";
  confirm.textContent = options.confirmLabel ?? t("common.confirm");
  actions.append(cancel, confirm);

  dialog.append(title, message, actions);
  backdrop.append(dialog);
  document.body.append(backdrop);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const close = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.dataset.open = "false";
      window.setTimeout(() => backdrop.remove(), 160);
      previousFocus?.focus({ preventScroll: true });
      resolve(answer);
    };
    // Captured at the document so the game's own key handlers never see these keys.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
      } else if (event.key === "Tab") {
        // Keep focus inside the two buttons.
        event.preventDefault();
        (document.activeElement === cancel ? confirm : cancel).focus();
      } else {
        event.stopPropagation();
      }
    };
    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey, true);
    window.requestAnimationFrame(() => {
      backdrop.dataset.open = "true";
      cancel.focus({ preventScroll: true });
    });
  });
};

export interface TextDialogOptions {
  readonly title: string;
  readonly message: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

/**
 * Asks for a short text in the game's own style; resolves with the trimmed text, or null
 * when cancelled. Replaces `window.prompt` for the same reasons `confirmDialog` replaces
 * `window.confirm`. Enter confirms, Escape and the backdrop cancel.
 */
export const textDialog = (options: TextDialogOptions): Promise<string | null> => {
  const id = `confirm-dialog-${++sequence}`;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const backdrop = document.createElement("div");
  backdrop.className = "confirm-dialog-backdrop";
  const dialog = document.createElement("form");
  dialog.className = "confirm-dialog";
  dialog.dataset.danger = "false";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", `${id}-title`);

  const title = document.createElement("h2");
  title.id = `${id}-title`;
  title.className = "confirm-dialog-title";
  title.textContent = options.title;
  const message = document.createElement("label");
  message.className = "confirm-dialog-message";
  message.textContent = options.message;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "confirm-dialog-input";
  input.value = options.value ?? "";
  input.placeholder = options.placeholder ?? "";
  input.maxLength = options.maxLength ?? 60;
  message.append(input);

  const actions = document.createElement("div");
  actions.className = "confirm-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "confirm-dialog-cancel";
  cancel.textContent = options.cancelLabel ?? t("common.cancel");
  const confirm = document.createElement("button");
  confirm.type = "submit";
  confirm.className = "confirm-dialog-confirm";
  confirm.textContent = options.confirmLabel ?? t("common.confirm");
  actions.append(cancel, confirm);

  dialog.append(title, message, actions);
  backdrop.append(dialog);
  document.body.append(backdrop);

  return new Promise<string | null>((resolve) => {
    let settled = false;
    const close = (answer: string | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.dataset.open = "false";
      window.setTimeout(() => backdrop.remove(), 160);
      previousFocus?.focus({ preventScroll: true });
      resolve(answer);
    };
    // Captured so the editor's shortcuts never see what is typed here.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(null);
      }
      event.stopPropagation();
    };
    dialog.addEventListener("submit", (event) => {
      event.preventDefault();
      close(input.value.trim());
    });
    cancel.addEventListener("click", () => close(null));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey, true);
    window.requestAnimationFrame(() => {
      backdrop.dataset.open = "true";
      input.focus({ preventScroll: true });
      input.select();
    });
  });
};
