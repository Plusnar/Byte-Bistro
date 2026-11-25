import { t } from "../i18n";

/** The round ✕ in a dialog's top-right corner (styled by `.bistro-close`). */
export const closeCorner = (dialog: HTMLDialogElement): HTMLButtonElement => {
  const close = document.createElement("button");
  close.type = "button";
  close.className = "bistro-close";
  close.textContent = "✕";
  close.setAttribute("aria-label", t("common.close"));
  close.title = t("common.close");
  close.onclick = () => dialog.close();
  return close;
};
