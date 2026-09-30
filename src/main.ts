import { Game } from "./core/Game";

declare global {
  interface Window {
    /** Read by the watchdog in index.html: set once the game's code is running. */
    __bbBooted?: boolean;
  }
}
window.__bbBooted = true;

/**
 * Puts the boot loader into its error state. It sits above everything (see index.html), so
 * without this a failed start — no WebGL, say — showed "Preparando a cozinha..." forever
 * while the message below it stayed hidden. Same shape as the index.html watchdog.
 */
const showBootError = (message: string): void => {
  const loader = document.getElementById("boot-loader");
  if (!loader) return;
  loader.hidden = false;
  loader.dataset.state = "error";
  const status = loader.querySelector(".bl-status");
  if (status) status.textContent = `Não foi possível iniciar o jogo: ${message}`;
  const retry = loader.querySelector<HTMLButtonElement>("[data-action='boot-retry']");
  if (retry) {
    retry.textContent = "Recarregar";
    retry.onclick = () => window.location.reload();
  }
  const skip = loader.querySelector<HTMLButtonElement>("[data-action='boot-continue']");
  if (skip) skip.hidden = true;
};

const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas");
const uiRoot = document.querySelector<HTMLElement>("#ui-root");

if (!canvas || !uiRoot) {
  throw new Error("Byte Bistro could not find its canvas or UI root.");
}

try {
  const game = new Game(canvas, uiRoot);
  // Debug handle for ?dev sessions: lets the screenshot harness open screens that would
  // otherwise need a full 4-minute shift (results) to reach.
  if (new URLSearchParams(window.location.search).has("dev")) {
    (window as unknown as { __bbGame?: Game }).__bbGame = game;
  }
  window.addEventListener("beforeunload", () => game.dispose(), { once: true });
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown initialization error";
  const fallback = document.createElement("main");
  fallback.className = "fatal-error";
  const title = document.createElement("h1");
  title.textContent = "BYTE BISTRO // BOOT FAILURE";
  const copy = document.createElement("p");
  copy.textContent = message;
  fallback.append(title, copy);
  uiRoot.replaceChildren(fallback);
  showBootError(message);
  console.error("Byte Bistro failed to initialize", error);
}
