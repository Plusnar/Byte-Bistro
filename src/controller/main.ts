/**
 * The phone controller page (`/controller#CODE`). No app to install: the QR code on the TV
 * opens this page, which joins the room and turns the phone into a gamepad.
 *
 * One pad, laid out like a console controller held sideways: the left thumb has an analog
 * stick in play and a D-pad in menus (the host decides which, per phone), the right thumb
 * has A/B/X/Y, and the middle holds recipes and pause. Player 1 drives the menus; the
 * others see who has the controls until their own turn (character selection, the match).
 *
 * Deliberately light: no Babylon, only the session code and the texts. Multi-touch through
 * Pointer Events, one pointer per control, so the stick and several buttons work at once.
 */
import "./controller.css";
import { initLanguage, t, type MessageKey } from "../i18n";
import { ControllerSession, type ControllerStatus, type ControllerView } from "../net/mp/ControllerSession";
import { BUTTONS, PHONE_THEMES, isRoomCode, normalizeRoomCode, type PadLayout, type PhoneButton, type PhoneTheme, type TransportKind } from "../net/mp/protocol";
import { dpadDirection, stickVector, type DpadDirection } from "./stick";

initLanguage(null);
document.documentElement.lang = t("phone.pageTitle").startsWith("Controle") ? "pt-BR" : "en";
document.title = t("phone.pageTitle");

const NAME_KEY = "byte-bistro:mp-name";
const app = document.getElementById("pad-app")!;
const esc = (key: MessageKey, params?: Record<string, string | number>): string =>
  t(key, params).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

/** Face buttons: letter, css class, button in play, button in menus (null: unused there). */
const FACE: readonly { readonly letter: string; readonly css: string; readonly game: PhoneButton; readonly menu: PhoneButton | null; readonly label: MessageKey; readonly menuLabel: MessageKey | null }[] = [
  { letter: "Y", css: "face-y", game: "emote", menu: null, label: "phone.buttons.emote", menuLabel: null },
  { letter: "B", css: "face-b", game: "dash", menu: "back", label: "phone.buttons.dash", menuLabel: "phone.buttons.back" },
  { letter: "X", css: "face-x", game: "use", menu: null, label: "phone.buttons.use", menuLabel: null },
  { letter: "A", css: "face-a", game: "grab", menu: "grab", label: "phone.buttons.grab", menuLabel: "phone.buttons.confirm" },
];
const DIRECTIONS: readonly DpadDirection[] = ["up", "right", "down", "left"];
/** D-pad auto-repeat while held, like a keyboard. */
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 120;

app.innerHTML = `
  <section class="screen" data-screen="join">
    <h1 class="brand">BYTE <span>BISTRO</span></h1>
    <form class="card" data-ui="join-form" novalidate>
      <label class="field"><span>${esc("phone.codeLabel")}</span>
        <input class="code" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="7" inputmode="text" required></label>
      <label class="field"><span>${esc("phone.nameLabel")}</span>
        <input name="name" autocomplete="nickname" maxlength="16" placeholder="${esc("phone.namePlaceholder")}"></label>
      <button class="primary" type="submit">${esc("phone.join")}</button>
    </form>
  </section>
  <section class="screen" data-screen="status" hidden>
    <div class="status-icon" data-ui="status-icon"></div>
    <p class="status-title" data-ui="status-title"></p>
    <p class="status-help" data-ui="status-help"></p>
    <button class="primary" type="button" data-action="retry" hidden>${esc("phone.retry")}</button>
  </section>
  <section class="pad" data-screen="pad" data-layout="wait" hidden>
    <button class="corner-btn" type="button" data-action="menu" aria-label="${esc("phone.options")}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>
    </button>
    <div class="who" data-ui="who">
      <span class="who-badge" data-ui="badge">P?</span>
      <span class="link" data-ui="link" data-quality="off"></span>
    </div>
    <div class="center-col">
      <button class="round-btn emblem" type="button" data-button="recipes" aria-label="${esc("phone.buttons.recipes")}"></button>
      <button class="round-btn" type="button" data-button="pause" aria-label="${esc("phone.buttons.pause")}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14"/></svg>
      </button>
    </div>
    <div class="stick-zone" data-ui="stick-zone">
      <div class="stick-base" data-ui="stick-base"></div>
      <div class="stick-knob" data-ui="stick-knob"></div>
      <div class="dpad" data-ui="dpad">
        ${DIRECTIONS.map((dir) => `<span class="dpad-arm dpad-${dir}" data-dir="${dir}" role="button" aria-label="${esc(`phone.dpad.${dir}` as MessageKey)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14l5-5 5 5"/></svg></span>`).join("")}
      </div>
    </div>
    <div class="face" data-ui="face">
      ${FACE.map((face, index) => `<button class="face-btn ${face.css}" type="button" data-face="${index}"><span class="face-letter">${face.letter}</span><span class="face-label" data-ui="face-label"></span></button>`).join("")}
    </div>
    <p class="pad-hint" data-ui="pad-hint"></p>
    <div class="wait-veil" data-ui="wait-veil" hidden><p data-ui="wait-text"></p></div>
    <div class="pause-veil" data-ui="pause-veil" hidden>${esc("phone.paused")}</div>
    <p class="banner" data-ui="banner" hidden></p>
    <div class="rotate-veil">
      <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="16" y="6" width="16" height="30" rx="3"/><path d="M8 30a16 16 0 0 0 26 10M34 40l0-6 6 0"/></svg>
      <p class="rotate-title">${esc("phone.rotate")}</p>
      <p>${esc("phone.rotateHelp")}</p>
      <button class="secondary" type="button" data-action="landscape">${esc("phone.rotateAction")}</button>
    </div>
  </section>
  <section class="sheet" data-ui="sheet" hidden>
    <label class="field"><span>${esc("phone.nameLabel")}</span><input name="sheet-name" maxlength="16" autocomplete="nickname"></label>
    <dl class="diag" data-ui="diag"></dl>
    <div class="sheet-actions">
      <button class="secondary" type="button" data-action="fullscreen">${esc("phone.fullscreen")}</button>
      <button class="secondary" type="button" data-action="leave">${esc("phone.leave")}</button>
      <button class="primary" type="button" data-action="close-sheet">OK</button>
    </div>
  </section>
`;

const q = <T extends HTMLElement = HTMLElement>(selector: string): T => app.querySelector<T>(selector)!;
const screens = {
  join: q("[data-screen=join]"),
  status: q("[data-screen=status]"),
  pad: q("[data-screen=pad]"),
};
const pad = screens.pad;
const banner = q("[data-ui=banner]");
const sheet = q("[data-ui=sheet]");
const joinForm = q<HTMLFormElement>("[data-ui=join-form]");
const codeInput = joinForm.elements.namedItem("code") as HTMLInputElement;
const nameInput = joinForm.elements.namedItem("name") as HTMLInputElement;
const sheetName = q<HTMLInputElement>("input[name=sheet-name]");

let session: ControllerSession | null = null;
let view: ControllerView | null = null;
let shownScreen: keyof typeof screens = "join";
let layout: PadLayout = "wait";

const readName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveName = (name: string): void => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Not remembered next time; harmless.
  }
};

// ------------------------------------------------------------------------- browser care

/** The page's own listeners: they live as long as the page, and go with it. */
const pageHooks = new AbortController();
window.addEventListener("pagehide", (event) => { if (!event.persisted) pageHooks.abort(); }, { signal: pageHooks.signal });

for (const type of ["contextmenu", "selectstart", "dblclick", "gesturestart", "gesturechange"]) {
  document.addEventListener(type, (event) => {
    if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
  }, { passive: false, signal: pageHooks.signal });
}
// iOS Safari ignores user-scalable=no; this stops pinch-zoom on the pad.
document.addEventListener("touchmove", (event) => {
  if (event.touches.length > 1 || pad.contains(event.target as Node)) event.preventDefault();
}, { passive: false, signal: pageHooks.signal });

let wakeLock: { release(): Promise<void> } | null = null;
const keepAwake = async (): Promise<void> => {
  const api = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void>; addEventListener(type: string, cb: () => void): void }> } }).wakeLock;
  if (!api || wakeLock || document.visibilityState !== "visible") return;
  try {
    const lock = await api.request("screen");
    wakeLock = lock;
    lock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    // Not allowed (battery saver, iOS < 16.4): the screen may dim; play keeps working.
  }
};
document.addEventListener("visibilitychange", () => void keepAwake(), { signal: pageHooks.signal });

const vibrate = (ms: number): void => {
  // Android Chrome vibrates; iOS has no Vibration API, the visual press feedback remains.
  try {
    navigator.vibrate?.(ms);
  } catch {
    // Ignored.
  }
};

const fullscreenAvailable = Boolean(document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled);
q("[data-action=fullscreen]").hidden = !fullscreenAvailable;
q("[data-action=landscape]").hidden = !fullscreenAvailable;
const enterFullscreen = async (landscape: boolean): Promise<void> => {
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  try {
    if (!document.fullscreenElement) {
      if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: "hide" });
      else await root.webkitRequestFullscreen?.();
    }
    // Only possible in full screen, and only on some browsers (Android Chrome).
    if (landscape) await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape");
  } catch {
    // Refused by the browser: the player turns the phone by hand.
  }
};
const toggleFullscreen = async (): Promise<void> => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await enterFullscreen(false);
  } catch {
    // Refused by the browser.
  }
};

// ------------------------------------------------------------------------- joining

const startSession = (code: string): void => {
  const name = nameInput.value.trim() || readName() || t("phone.namePlaceholder");
  saveName(name);
  session?.dispose();
  session = new ControllerSession(code, name);
  session.onBuzz = vibrate;
  session.onChange(render);
  history.replaceState(null, "", `#${code}`);
  void session.start();
  void keepAwake();
};

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = normalizeRoomCode(codeInput.value);
  if (!isRoomCode(code)) {
    codeInput.focus();
    codeInput.select();
    return;
  }
  startSession(code);
});
codeInput.addEventListener("input", () => { codeInput.value = normalizeRoomCode(codeInput.value); });
nameInput.value = readName();

let nameTimer = 0;
sheetName.addEventListener("input", () => {
  window.clearTimeout(nameTimer);
  nameTimer = window.setTimeout(() => {
    const name = sheetName.value.trim();
    if (!name) return;
    saveName(name);
    session?.setProfile({ name });
  }, 400);
});

app.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  if (!session) {
    if (target.dataset.action === "retry") location.reload();
    return;
  }
  switch (target.dataset.action) {
    case "retry":
      if (view && (["not-found", "full", "locked", "kicked", "closed"] as ControllerStatus[]).includes(view.status)) {
        session.dispose();
        session = null;
        view = null;
        history.replaceState(null, "", location.pathname);
        show("join");
        return;
      }
      session.retry();
      return;
    case "menu":
      sheet.hidden = !sheet.hidden;
      if (!sheet.hidden) {
        releaseEverything();
        sheetName.value = myPlayer()?.name ?? readName();
      }
      renderDiagnostics();
      return;
    case "close-sheet":
      sheet.hidden = true;
      return;
    case "fullscreen":
      void toggleFullscreen();
      return;
    case "landscape":
      void enterFullscreen(true);
      return;
    case "leave":
      if (window.confirm(t("phone.leaveConfirm"))) {
        session.leave();
        session = null;
        sheet.hidden = true;
        history.replaceState(null, "", location.pathname);
        show("join");
      }
      return;
  }
});

// ------------------------------------------------------------------------- pad input

/** Keeps a finger's events on its control; some browsers refuse capture, which is fine. */
const capture = (element: HTMLElement, pointerId: number): void => {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The pointer is already gone, or the browser has no capture for it.
  }
};

/** Held phone buttons, by finger: several fingers may hold the same button. */
const held = new Map<number, { readonly button: PhoneButton; readonly element: HTMLElement }>();
const press = (pointerId: number, button: PhoneButton, element: HTMLElement): void => {
  held.set(pointerId, { button, element });
  element.classList.add("down");
  session?.setButton(button, true);
};
const release = (pointerId: number): void => {
  const entry = held.get(pointerId);
  if (!entry) return;
  held.delete(pointerId);
  const others = [...held.values()];
  if (!others.some((other) => other.button === entry.button)) session?.setButton(entry.button, false);
  if (!others.some((other) => other.element === entry.element)) entry.element.classList.remove("down");
};

const stickZone = q("[data-ui=stick-zone]");
const stickBase = q("[data-ui=stick-base]");
const stickKnob = q("[data-ui=stick-knob]");
const dpad = q("[data-ui=dpad]");
let stickPointer: number | null = null;
let stickOrigin = { x: 0, y: 0 };
/** D-pad: the finger on it, the direction it holds, and its auto-repeat timer. */
let dpadPointer: number | null = null;
let dpadHeld: DpadDirection | null = null;
let repeatTimer = 0;

const stickRadius = (): number => stickBase.getBoundingClientRect().width / 2 || 70;

/** The stick rests in the middle of its zone, and jumps under the thumb when touched. */
const restStick = (): void => {
  for (const element of [stickBase, stickKnob]) {
    element.style.left = "50%";
    element.style.top = "50%";
  }
  stickZone.classList.remove("active");
};

const moveStick = (event: PointerEvent): void => {
  const radius = stickRadius();
  const dx = event.clientX - stickOrigin.x;
  const dy = event.clientY - stickOrigin.y;
  const vector = stickVector(dx, dy, radius);
  const distance = Math.min(radius, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx);
  const zone = stickZone.getBoundingClientRect();
  stickKnob.style.left = `${stickOrigin.x - zone.left + Math.cos(angle) * distance}px`;
  stickKnob.style.top = `${stickOrigin.y - zone.top + Math.sin(angle) * distance}px`;
  session?.setStick(vector.x, vector.y);
};

const setDpad = (direction: DpadDirection | null): void => {
  if (direction === dpadHeld) return;
  window.clearTimeout(repeatTimer);
  if (dpadHeld) session?.setButton(dpadHeld, false);
  for (const arm of dpad.querySelectorAll<HTMLElement>("[data-dir]")) arm.classList.toggle("down", arm.dataset.dir === direction);
  dpadHeld = direction;
  if (!direction) return;
  session?.setButton(direction, true);
  vibrate(8);
  const repeat = (): void => {
    if (dpadHeld !== direction) return;
    session?.setButton(direction, false);
    session?.setButton(direction, true);
    repeatTimer = window.setTimeout(repeat, REPEAT_EVERY_MS);
  };
  repeatTimer = window.setTimeout(repeat, REPEAT_DELAY_MS);
};

const dpadFromEvent = (event: PointerEvent): DpadDirection | null => {
  const box = dpad.getBoundingClientRect();
  return dpadDirection(event.clientX - (box.left + box.width / 2), event.clientY - (box.top + box.height / 2), box.width / 2);
};

const usesDpad = (): boolean => layout === "menu" || layout === "select";

stickZone.addEventListener("pointerdown", (event) => {
  if (layout === "wait") return;
  event.preventDefault();
  void keepAwake();
  if (usesDpad()) {
    if (dpadPointer !== null) return;
    dpadPointer = event.pointerId;
    capture(stickZone, event.pointerId);
    setDpad(dpadFromEvent(event));
    return;
  }
  if (stickPointer !== null) return;
  stickPointer = event.pointerId;
  capture(stickZone, event.pointerId);
  // The stick appears under the thumb: no need to find a fixed spot without looking.
  stickOrigin = { x: event.clientX, y: event.clientY };
  const zone = stickZone.getBoundingClientRect();
  for (const element of [stickBase, stickKnob]) {
    element.style.left = `${event.clientX - zone.left}px`;
    element.style.top = `${event.clientY - zone.top}px`;
  }
  stickZone.classList.add("active");
});
stickZone.addEventListener("pointermove", (event) => {
  if (event.pointerId === dpadPointer) setDpad(dpadFromEvent(event));
  else if (event.pointerId === stickPointer) moveStick(event);
});
const releaseZone = (event: PointerEvent): void => {
  if (event.pointerId === dpadPointer) {
    dpadPointer = null;
    setDpad(null);
  }
  if (event.pointerId === stickPointer) {
    stickPointer = null;
    restStick();
    session?.setStick(0, 0);
  }
};
stickZone.addEventListener("pointerup", releaseZone);
stickZone.addEventListener("pointercancel", releaseZone);
stickZone.addEventListener("lostpointercapture", releaseZone);

/** Which phone button a control sends right now (B is dash in play, back in menus). */
const buttonOf = (element: HTMLElement): PhoneButton | null => {
  if (element.dataset.button) return element.dataset.button as PhoneButton;
  const face = FACE[Number(element.dataset.face)];
  if (!face) return null;
  return usesDpad() ? face.menu : face.game;
};

for (const element of app.querySelectorAll<HTMLButtonElement>("[data-button], [data-face]")) {
  element.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const button = buttonOf(element);
    if (!button || element.disabled || !(BUTTONS as readonly string[]).includes(button)) return;
    capture(element, event.pointerId);
    press(event.pointerId, button, element);
    vibrate(button === "dash" ? 20 : 10);
    void keepAwake();
  });
  const up = (event: PointerEvent): void => release(event.pointerId);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", up);
  element.addEventListener("lostpointercapture", up);
  // Keyboard/accessibility activation still works as a tap.
  element.addEventListener("click", (event) => {
    if (event.detail !== 0) return;
    const button = buttonOf(element);
    if (!button || element.disabled) return;
    session?.setButton(button, true);
    window.setTimeout(() => session?.setButton(button, false), 80);
  });
}

/** Lets go of everything: on a layout change, a hidden pad, or the options sheet. */
function releaseEverything(): void {
  stickPointer = null;
  dpadPointer = null;
  setDpad(null);
  restStick();
  session?.setStick(0, 0);
  held.clear();
  for (const button of BUTTONS) session?.setButton(button, false);
  for (const element of app.querySelectorAll(".down")) element.classList.remove("down");
}

const loop = (now: number): void => {
  session?.tick(now);
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

// ------------------------------------------------------------------------- rendering

const STATUS_TEXT: Partial<Record<ControllerStatus, MessageKey>> = {
  joining: "phone.joining",
  connecting: "phone.connecting",
  reconnecting: "phone.reconnecting",
  failed: "phone.failed",
  kicked: "phone.kicked",
  closed: "phone.closed",
  full: "phone.full",
  locked: "phone.locked",
  "not-found": "phone.notFound",
  quota: "phone.quota",
  error: "phone.error",
};
const ERROR_STATES: ReadonlySet<ControllerStatus> = new Set(["failed", "kicked", "closed", "full", "locked", "not-found", "quota", "error"]);

const show = (screen: keyof typeof screens): void => {
  shownScreen = screen;
  for (const [name, element] of Object.entries(screens)) element.hidden = name !== screen;
  if (screen !== "pad") releaseEverything();
};

const myPlayer = () => view?.lobby?.players.find((player) => player.id === view?.playerId) ?? null;

const quality = (current: ControllerView): "good" | "ok" | "bad" | "off" => {
  if (current.transport === "none" || current.status !== "connected") return "off";
  if (current.transport === "https" || current.rtt > 150 || current.loss > 0.05) return "bad";
  if (current.transport === "websocket" || current.rtt > 70) return "ok";
  return "good";
};

const applyLayout = (next: PadLayout): void => {
  if (next === layout) return;
  // A finger held across a change would send the wrong button on release.
  releaseEverything();
  layout = next;
  pad.dataset.layout = next;
  const menu = usesDpad();
  app.querySelectorAll<HTMLButtonElement>("[data-face]").forEach((element, index) => {
    const face = FACE[index]!;
    const button = menu ? face.menu : face.game;
    element.disabled = next === "wait" || button === null;
    element.querySelector("[data-ui=face-label]")!.textContent = button === null ? "" : t(menu ? face.menuLabel! : face.label);
  });
  // Recipes and pause belong to the cook in play and to the leader in menus.
  for (const element of app.querySelectorAll<HTMLButtonElement>("[data-button]")) {
    element.disabled = next === "wait" || next === "select";
  }
  q("[data-ui=pad-hint]").textContent = next === "menu" ? t("phone.menuHint") : next === "select" ? t("phone.selectHint") : "";
};

/**
 * A disaster playing in the kitchen swaps the pad's background (nothing else) for its
 * art, and takes it back when it ends. The art is fetched as soon as the pad first goes
 * into play, so the first disaster does not flash an empty background.
 */
let shownTheme: PhoneTheme | null = null;
let themesPreloaded = false;
const themeArt = (theme: PhoneTheme): string => `/assets/ui/phone/${theme}.webp`;

const applyTheme = (theme: PhoneTheme | null): void => {
  if (layout === "game" && !themesPreloaded) {
    themesPreloaded = true;
    for (const each of PHONE_THEMES) new Image().src = themeArt(each);
  }
  if (theme === shownTheme) return;
  shownTheme = theme;
  if (theme) pad.dataset.theme = theme;
  else delete pad.dataset.theme;
};

function render(next: ControllerView): void {
  view = next;
  const errorState = ERROR_STATES.has(next.status);
  const me = myPlayer();
  if (errorState || (!next.lobby && next.status !== "connected")) {
    show("status");
    q("[data-ui=status-icon]").dataset.tone = errorState ? "error" : "busy";
    q("[data-ui=status-title]").textContent = t(STATUS_TEXT[next.status] ?? "phone.connecting");
    q("[data-ui=status-help]").textContent = next.status === "failed" ? t("phone.failedHelp") : "";
    q("[data-action=retry]").hidden = !errorState;
    return;
  }
  if (shownScreen !== "pad") show("pad");
  applyLayout(next.layout);
  applyTheme(next.layout === "game" ? next.theme : null);

  const color = next.cook?.color ?? me?.color ?? "#74f4ff";
  document.documentElement.style.setProperty("--cook", color);
  const label = next.cook?.label ?? `P${(me?.slot ?? 0) + 1}`;
  q("[data-ui=badge]").textContent = label;
  const link = q("[data-ui=link]");
  link.dataset.quality = quality(next);
  link.textContent = next.transport === "none"
    ? t("phone.transport.none")
    : `${next.rtt ? `${next.rtt} ms · ` : ""}${t(`phone.transport.${next.transport}` as MessageKey)}`;

  const waiting = next.layout === "wait";
  q("[data-ui=wait-veil]").hidden = !waiting;
  if (waiting) {
    q("[data-ui=wait-text]").textContent = next.cook?.slot === null
      ? t("phone.bench")
      : next.phase === "lobby" && !next.lobby?.locked
        ? t("phone.waitPaired", { label })
        : t("phone.waitLeader", { label: "P1" });
  }

  const hostAway = next.lobby && !next.lobby.hostConnected;
  banner.hidden = !(next.status === "reconnecting" || hostAway);
  banner.textContent = next.status === "reconnecting" ? t("phone.reconnecting") : t("phone.hostAway");
  q("[data-ui=pause-veil]").hidden = !(next.phase === "paused" && waiting);

  if (!sheet.hidden) renderDiagnostics();
}

function renderDiagnostics(): void {
  if (!view) return;
  const rows: [string, string][] = [
    ["status", view.status],
    ["transport", view.transport satisfies TransportKind],
    ["rtt", `${view.rtt} ms`],
    ["jitter", `${view.jitter} ms`],
    ["loss", `${Math.round(view.loss * 1000) / 10}%`],
    ["rate", `${view.rateHz} Hz`],
    ["sent / recv", `${view.sent} / ${view.received}`],
    ["bytes", `${Math.round(view.bytes / 102.4) / 10} kB`],
    ["fallback", view.fallbackReason || "—"],
    ["pad", `${view.layout}${view.leader ? " · P1" : ""}`],
    ["room", session?.code ?? "—"],
  ];
  q("[data-ui=diag]").replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    return [dt, dd];
  }));
}

// ------------------------------------------------------------------------- start

applyLayout("game");
applyLayout("wait");
restStick();

const hashCode = normalizeRoomCode(decodeURIComponent(location.hash.slice(1)));
if (isRoomCode(hashCode)) {
  codeInput.value = hashCode;
  startSession(hashCode);
} else {
  show("join");
  codeInput.focus();
}
