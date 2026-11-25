/**
 * The game's phone-controller feature: the pairing panel (QR code, code, the four player
 * slots) and the glue between the HostSession, the kitchen and the menus. Loaded as its
 * own chunk right after the menu is up: phones are how the game is played.
 *
 * - Each phone is one player. Its device is attached to that cook's InputManager, exactly
 *   like the keyboard half that cook already has.
 * - What each phone's pad shows (stick, D-pad, or "wait") is decided by the game through
 *   `padFor`; buttons pressed on a D-pad come back as menu commands (`onMenuCommand`).
 */
import qrcode from "qrcode-generator";
import type { InputManager } from "../../core/InputManager";
import { MAX_PLAYERS, PLAYER_COLORS, playerLabel } from "../../data/players";
import { t } from "../../i18n";
import { menuCommandFor, type MenuCommand } from "../../ui/menuInput";
import { ApiError } from "./api";
import { HostSession, type HostSnapshot, type PadState, type PhonePeer } from "./HostSession";
import type { AccountForm, PhoneToHost, RoomPhase } from "./protocol";
import type { RemoteInputDevice } from "./remoteInput";

export interface PhoneHubOptions {
  /** Where the pairing panel is drawn (the menu's pairing step). */
  readonly panel: HTMLElement;
  readonly characters: () => readonly { readonly id: string; readonly name: string }[];
  readonly notify: (message: string, tone: "info" | "success" | "warning" | "error") => void;
  /** Where the shift is, for the phones' screens. */
  readonly phase: () => RoomPhase;
  /** What each player's pad shows right now. */
  readonly padFor: (slot: number) => PadState;
  /** A player pressed a button on their D-pad. */
  readonly onMenuCommand: (slot: number, command: MenuCommand) => void;
  /** The pairing panel's players changed (joined, left, reconnected). */
  readonly onPlayersChanged?: () => void;
  /** Player 1 answered the account form on their phone. */
  readonly onAccountForm?: (message: Extract<PhoneToHost, { t: "form-submit" | "form-cancel" }>) => void;
}

/** How often the pads are re-checked against the game's state. Sends only on change. */
const PAD_REFRESH_MS = 150;

/** Renders a QR code as one SVG path: crisp at any size, no canvas. */
export const qrSvg = (text: string): string => {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const margin = 4;
  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) if (code.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
  }
  const size = count + margin * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img"><path fill="#102445" d="${path}"/></svg>`;
};

const text = (tag: string, className: string, content: string): HTMLElement => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
};

export class PhoneHub {
  private session: HostSession | null = null;
  private opening: Promise<HostSession | null> | null = null;
  private inputs: readonly InputManager[] = [];
  private attached: (RemoteInputDevice | null)[] = [];
  private accountForm: AccountForm | null = null;
  private padTimer = 0;
  private readonly knownNames = new Map<string, string>();
  private readonly slots: HTMLElement[] = [];
  private disposed = false;
  private built = false;
  private readonly hooks = new AbortController();
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  constructor(private readonly options: PhoneHubOptions) {}

  /** Draws the panel and creates the room (or reclaims this tab's), if not done yet. */
  async open(): Promise<void> {
    this.build();
    this.render();
    await this.ensureSession();
    this.render();
  }

  /**
   * Vibrates every player's phone (Android; iOS browsers have no vibration API and keep
   * the on-screen feedback only).
   */
  buzzAll(ms: number): void {
    this.session?.buzzAll(ms);
  }

  /** The kitchen changed (new level, rebuilt): phones move to its cooks' inputs. */
  attachKitchen(inputs: readonly InputManager[]): void {
    this.detachAll();
    this.inputs = inputs;
    this.syncDevices();
  }

  get active(): boolean {
    return Boolean(this.session && !this.session.snapshot().closedReason);
  }

  /** Phones connected right now, in slot order. */
  connectedPlayers(): number {
    return this.session?.snapshot().phones.filter((phone) => phone.info.connected && phone.info.slot < MAX_PLAYERS).length ?? 0;
  }

  /**
   * Ends the pairing: the connected phones become players 1..n, the room locks. Returns n
   * (0 when there is no room or nobody is connected; the caller stays on the pairing step).
   */
  settlePlayers(): number {
    if (!this.session || this.connectedPlayers() === 0) return 0;
    return this.session.settlePlayers();
  }

  /** Lets new phones join (the room locks when the pairing is settled). */
  unlock(): void {
    this.session?.setLocked(false);
  }

  /** Shows the account form on player 1's phone (null closes it). */
  setAccountForm(form: AccountForm | null): void {
    this.accountForm = form;
    this.session?.setForm(form);
  }

  /** Player 1's phone is connected and can type for the TV. */
  get leaderConnected(): boolean {
    return [...(this.session?.phones.values() ?? [])].some((phone) => phone.info.slot === 0 && phone.info.connected);
  }

  /** Re-sends what each pad should show; call when the game's screen changes. */
  refreshPads(): void {
    this.session?.setPhase(this.options.phase());
    this.session?.refreshPads();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.padTimer);
    this.hooks.abort();
    this.detachAll();
    // Not `close()`: the page is going away (a reload, say), and the room waits for its host
    // for a while, so the reloaded page takes the same room back and the phones reconnect
    // without scanning again. Nobody reclaiming it, the server ends it on its own.
    this.session?.dispose();
    this.session = null;
    this.options.panel.replaceChildren();
  }

  // -------------------------------------------------------------------------------------

  private async ensureSession(): Promise<HostSession | null> {
    if (this.session && !this.session.snapshot().closedReason) return this.session;
    if (this.opening) return this.opening;
    this.session?.dispose();
    this.session = null;
    this.setStatus(t("mp.creating"));
    this.opening = HostSession.open({ cookSlots: MAX_PLAYERS, cookColors: PLAYER_COLORS })
      .then((session) => {
        if (this.disposed) {
          session.dispose();
          return null;
        }
        this.session = session;
        session.setCatalog(this.options.characters());
        session.onChange(() => this.onSessionChange());
        session.onPhonesChanged(() => {
          this.syncDevices();
          this.options.onPlayersChanged?.();
        });
        session.onMenuButton = (slot, button) => {
          const command = menuCommandFor(button);
          if (command) this.options.onMenuCommand(slot, command);
        };
        session.onForm = (message) => this.options.onAccountForm?.(message);
        session.setForm(this.accountForm);
        session.setPadSource(this.options.padFor);
        window.clearInterval(this.padTimer);
        this.padTimer = window.setInterval(() => this.refreshPads(), PAD_REFRESH_MS);
        this.setStatus("");
        return session;
      })
      .catch((error: unknown) => {
        const code = error instanceof ApiError ? error.code : "network";
        this.setStatus(
          code === "not-configured" || code === "not-found" ? t("mp.unavailable") : code === "quota" ? t("mp.quota") : t("mp.failed"),
          "error",
        );
        return null;
      })
      .finally(() => { this.opening = null; });
    return this.opening;
  }

  private detachAll(): void {
    this.attached.forEach((device, slot) => {
      if (device) this.inputs[slot]?.detachDevice(device);
    });
    this.attached = [];
  }

  /** Puts each cook slot's phone on that cook's InputManager, and only that one. */
  private syncDevices(): void {
    const devices = this.session?.cookDevices() ?? [];
    for (let slot = 0; slot < Math.max(this.inputs.length, this.attached.length); slot++) {
      const next = devices[slot] ?? null;
      const current = this.attached[slot] ?? null;
      if (next === current) continue;
      if (current) this.inputs[slot]?.detachDevice(current);
      if (next) this.inputs[slot]?.attachDevice(next);
      this.attached[slot] = next;
    }
  }

  private onSessionChange(): void {
    const snapshot = this.session?.snapshot();
    if (!snapshot) return;
    if (snapshot.closedReason) {
      this.detachAll();
      this.setStatus(snapshot.closedReason === "replaced" ? t("mp.replaced") : t("mp.roomClosed"), "error");
    }
    this.announce(snapshot);
    this.render();
    this.options.onPlayersChanged?.();
  }

  private announce(snapshot: HostSnapshot): void {
    const now = new Map(snapshot.phones.map((phone) => [phone.id, phone.info.name]));
    for (const [id, name] of now) {
      if (!this.knownNames.has(id)) this.options.notify(t("mp.joined", { name }), "success");
    }
    for (const [id, name] of this.knownNames) {
      if (!now.has(id)) this.options.notify(t("mp.left", { name }), "info");
    }
    this.knownNames.clear();
    for (const [id, name] of now) this.knownNames.set(id, name);
  }

  // -------------------------------------------------------------------------------------
  // Panel
  // -------------------------------------------------------------------------------------

  private statusText = "";
  private statusTone: "info" | "error" = "info";

  private setStatus(message: string, tone: "info" | "error" = "info"): void {
    this.statusText = message;
    this.statusTone = tone;
    this.render();
  }

  private build(): void {
    if (this.built) return;
    this.built = true;
    const panel = this.options.panel;
    panel.classList.add("phone-room");
    panel.innerHTML = `
      <section class="phone-room-join">
        <div class="phone-room-qr" data-ui="qr"></div>
        <div class="phone-room-code" data-ui="code"></div>
        <p class="phone-room-hint" data-ui="hint"></p>
        <p class="phone-room-status" data-ui="status" role="status"></p>
        <button type="button" class="secondary-action" data-act="retry" hidden></button>
      </section>
      <section class="phone-room-players">
        <ol class="phone-room-slots" data-ui="slots" aria-live="polite"></ol>
        <p class="phone-room-continue" data-ui="continue"></p>
        <div class="phone-room-tools">
          <button type="button" data-act="copy"></button>
        </div>
      </section>`;
    panel.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!target) return;
      const session = this.session;
      switch (target.dataset.act) {
        case "copy":
          if (session) void navigator.clipboard?.writeText(session.joinUrl).then(() => this.setStatus(t("mp.copied")), () => undefined);
          return;
        case "kick":
          if (target.dataset.player) session?.kick(target.dataset.player);
          return;
        case "retry":
          void this.open();
          return;
      }
    }, { signal: this.hooks.signal });
  }

  private qrFor = "";
  private render(): void {
    if (!this.built || this.disposed) return;
    const panel = this.options.panel;
    const q = <T extends HTMLElement = HTMLElement>(selector: string): T => panel.querySelector<T>(selector)!;
    q("[data-act=copy]").textContent = t("mp.copyLink");
    q("[data-act=retry]").textContent = t("mp.retry");
    const status = q("[data-ui=status]");
    const snapshot = this.session?.snapshot() ?? null;
    let message = this.statusText;
    if (!message && snapshot?.socket === "retrying") message = t("mp.reconnecting");
    if (!message && snapshot && !snapshot.relayAllowed) message = t("mp.relayOff");
    status.textContent = message;
    status.dataset.tone = this.statusTone;
    q("[data-act=retry]").hidden = !(this.statusTone === "error" && !this.opening);

    if (!snapshot) {
      this.qrFor = "";
      q("[data-ui=qr]").replaceChildren();
      q("[data-ui=code]").textContent = "······";
      q("[data-ui=hint]").textContent = "";
    } else {
      if (this.qrFor !== snapshot.joinUrl) {
        this.qrFor = snapshot.joinUrl;
        q("[data-ui=qr]").innerHTML = qrSvg(snapshot.joinUrl);
        q("[data-ui=qr]").setAttribute("aria-label", snapshot.joinUrl);
      }
      q("[data-ui=code]").textContent = snapshot.code;
      const site = new URL(snapshot.joinUrl);
      q("[data-ui=hint]").textContent = `${t("mp.scan")} — ${t("mp.orOpen", { url: `${site.host}${site.pathname}` })}`;
    }

    const phones = snapshot?.phones ?? [];
    const bySlot = new Map(phones.map((phone) => [phone.info.slot, phone]));
    const list = q("[data-ui=slots]");
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const phone = bySlot.get(slot) ?? null;
      const previous = this.slots[slot];
      const online = Boolean(phone?.info.connected);
      const state = phone ? (online ? "online" : "offline") : "empty";
      const name = "";
      const label = t(phone ? (online ? "pair.connected" : "mp.offline") : slot === 0 ? "pair.slotFirst" : "pair.slotEmpty");
      if (previous?.dataset.state === state && previous.dataset.phone === phone?.id &&
          previous.dataset.name === name && previous.dataset.label === label &&
          previous.dataset.kick === t("mp.kick")) continue;
      const row = this.renderSlot(slot, phone, state, label);
      if (!this.reducedMotion.matches && online &&
          (previous?.dataset.state !== "online" || previous.dataset.phone !== phone?.id)) {
        row.classList.add("just-connected");
        row.addEventListener("animationend", () => row.classList.remove("just-connected"), { once: true });
        row.addEventListener("animationcancel", () => row.classList.remove("just-connected"), { once: true });
      }
      if (previous) previous.replaceWith(row);
      else list.append(row);
      this.slots[slot] = row;
    }
    const connected = this.connectedPlayers();
    const prompt = q("[data-ui=continue]");
    prompt.textContent = connected === 0 ? t("pair.waitingFirst") : t("pair.pressA", { count: connected });
    prompt.dataset.ready = String(connected > 0);

  }

  private renderSlot(slot: number, phone: PhonePeer | null, state: string, label: string): HTMLElement {
    const item = document.createElement("li");
    item.className = "phone-room-slot";
    item.style.setProperty("--player", PLAYER_COLORS[slot] ?? "#fff");
    item.dataset.state = state;
    if (phone) item.dataset.phone = phone.id;
    // Players are P1–P4 only: no names on the shared screen. P1 hosts (drives the menus,
    // starts the match); everyone else is a guest.
    item.dataset.name = "";
    item.dataset.role = slot === 0 ? "host" : "guest";
    item.dataset.label = label;
    item.dataset.kick = t("mp.kick");
    item.append(text("span", "phone-room-badge", playerLabel(slot)));
    const body = document.createElement("span");
    body.className = "phone-room-name";
    const role = text("span", "phone-room-role", t(slot === 0 ? "pair.host" : "pair.guest"));
    body.append(role, text("span", "phone-room-meta", label));
    item.append(body);
    if (!phone) return item;
    const kick = text("button", "phone-room-kick", "×") as HTMLButtonElement;
    kick.type = "button";
    kick.dataset.act = "kick";
    kick.dataset.player = phone.id;
    kick.setAttribute("aria-label", `${t("mp.kick")} ${playerLabel(slot)}`);
    kick.title = t("mp.kick");
    item.append(kick);
    return item;
  }

}
