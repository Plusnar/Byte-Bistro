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
import { t, type MessageKey } from "../../i18n";
import { menuCommandFor, type MenuCommand } from "../../ui/menuInput";
import { ApiError, callApi } from "./api";
import { HostSession, type HostSnapshot, type PadState, type PhonePeer } from "./HostSession";
import type { RoomPhase } from "./protocol";
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
}

/** How often the pads are re-checked against the game's state. Sends only on change. */
const PAD_REFRESH_MS = 150;

/** Renders a QR code as one SVG path: crisp at any size, no canvas. */
export const qrSvg = (text: string): string => {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const margin = 2;
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
  private padTimer = 0;
  private readonly knownNames = new Map<string, string>();
  private showDiagnostics = false;
  private disposed = false;
  private built = false;
  private readonly hooks = new AbortController();

  constructor(private readonly options: PhoneHubOptions) {}

  /** Draws the panel and creates the room (or reclaims this tab's), if not done yet. */
  async open(): Promise<void> {
    this.build();
    this.render();
    await this.ensureSession();
    this.render();
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

  /** Back to pairing: new phones may join again. */
  reopenPairing(): void {
    this.unlock();
    void this.open();
  }

  /** Lets new phones join (the room locks when the pairing is settled). */
  unlock(): void {
    this.session?.setLocked(false);
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
        <ol class="phone-room-slots" data-ui="slots"></ol>
        <p class="phone-room-continue" data-ui="continue"></p>
        <div class="phone-room-tools">
          <button type="button" data-act="copy"></button>
          <button type="button" data-act="diag"></button>
        </div>
      </section>
      <pre class="phone-room-diag" data-ui="diag" hidden></pre>`;
    panel.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!target) return;
      const session = this.session;
      switch (target.dataset.act) {
        case "copy":
          if (session) void navigator.clipboard?.writeText(session.joinUrl).then(() => this.setStatus(t("mp.copied")), () => undefined);
          return;
        case "diag":
          this.showDiagnostics = !this.showDiagnostics;
          this.render();
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
  /** Server-side estimate of today's free-quota use, refreshed while diagnostics show. */
  private quotaLine = "";
  private quotaAt = 0;

  private refreshQuota(): void {
    if (performance.now() - this.quotaAt < 10_000) return;
    this.quotaAt = performance.now();
    void callApi<{ workerRequestsPct: number; doRequestsPct: number; doGbSecondsPct: number; rooms: number; roomsPerDay: number; safetyRatio: number; allow: Record<string, boolean>; turn: { enabled: boolean; plannedGbThisMonth: number; monthlyGbBudget: number } }>("status")
      .then((status) => {
        this.quotaLine = `quota (estimate, % of ${Math.round(status.safetyRatio * 100)}% of Free): workers ${status.workerRequestsPct}% · DO requests ${status.doRequestsPct}% · DO GB-s ${status.doGbSecondsPct}% · rooms ${status.rooms}/${status.roomsPerDay} · allow ${Object.entries(status.allow).filter(([, on]) => on).map(([name]) => name).join(",") || "none"} · TURN ${status.turn.enabled ? `${status.turn.plannedGbThisMonth}/${status.turn.monthlyGbBudget} GB planned` : "off"}`;
        if (this.showDiagnostics) this.render();
      }, () => { this.quotaLine = "quota: unavailable"; });
  }

  private render(): void {
    if (!this.built || this.disposed) return;
    const panel = this.options.panel;
    const q = <T extends HTMLElement = HTMLElement>(selector: string): T => panel.querySelector<T>(selector)!;
    q("[data-act=copy]").textContent = t("mp.copyLink");
    q("[data-act=diag]").textContent = t("mp.diagnostics");
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
    q("[data-ui=slots]").replaceChildren(...Array.from({ length: MAX_PLAYERS }, (_, slot) => this.renderSlot(slot, bySlot.get(slot) ?? null)));
    const connected = this.connectedPlayers();
    const prompt = q("[data-ui=continue]");
    prompt.textContent = connected === 0 ? t("pair.waitingFirst") : t("pair.pressA", { count: connected });
    prompt.dataset.ready = String(connected > 0);

    const diag = q("[data-ui=diag]");
    diag.hidden = !this.showDiagnostics || !snapshot;
    if (this.showDiagnostics && snapshot) {
      this.refreshQuota();
      diag.textContent = `${this.diagnostics(snapshot)}
${this.quotaLine}`;
    }
  }

  private renderSlot(slot: number, phone: PhonePeer | null): HTMLElement {
    const item = document.createElement("li");
    item.className = "phone-room-slot";
    item.style.setProperty("--player", PLAYER_COLORS[slot] ?? "#fff");
    item.dataset.state = !phone ? "empty" : phone.info.connected ? "online" : "offline";
    item.append(text("span", "phone-room-badge", playerLabel(slot)));
    const body = document.createElement("span");
    body.className = "phone-room-name";
    if (!phone) {
      body.append(text("span", "phone-room-meta", t(slot === 0 ? "pair.slotFirst" : "pair.slotEmpty")));
      item.append(body);
      return item;
    }
    body.append(document.createTextNode(phone.info.name));
    const transport = phone.info.connected ? t(`phone.transport.${phone.transport}` as MessageKey) : t("mp.offline");
    const rtt = phone.path?.rttMs ?? phone.phoneRtt;
    body.append(text("span", "phone-room-meta", transport + (phone.info.connected && rtt ? ` · ${Math.round(rtt)} ms` : "")));
    item.append(body);
    const kick = text("button", "phone-room-kick", "×") as HTMLButtonElement;
    kick.type = "button";
    kick.dataset.act = "kick";
    kick.dataset.player = phone.id;
    kick.setAttribute("aria-label", `${t("mp.kick")} ${phone.info.name}`);
    kick.title = t("mp.kick");
    item.append(kick);
    return item;
  }

  private diagnostics(snapshot: HostSnapshot): string {
    const lines = [
      `room ${snapshot.code} · mode ${snapshot.policy.mode} · socket ${snapshot.socket} · relay ${snapshot.relayAllowed ? "on" : "off"} · https ${snapshot.policy.httpsAllowed ? "on" : "off"} · turn ${snapshot.policy.turnAvailable ? "on" : "off"} · locked ${snapshot.lobby?.locked ? "yes" : "no"}`,
      `phones ${snapshot.phones.length}/${snapshot.lobby?.maxPlayers ?? "?"} · connected ${snapshot.phones.filter((phone) => phone.info.connected).length}`,
    ];
    for (const phone of snapshot.phones) {
      const state = phone.device.state;
      const path = phone.path;
      lines.push([
        `P${phone.info.slot + 1} ${phone.info.name}`,
        `pad ${phone.layout}`,
        `via ${phone.transport}${path ? ` (${path.localType}/${path.remoteType} ${path.protocol})` : ""}`,
        `rtt ${Math.round(path?.rttMs ?? phone.phoneRtt)} ms (avg ${Math.round(phone.rtt.smoothed)}, jitter ${Math.round(phone.phoneJitter)})`,
        `loss ${(state.loss.loss * 100).toFixed(1)}%`,
        `rate ${phone.phoneRate} Hz · frame ${Math.round(state.frameIntervalMs)} ms`,
        `in ${phone.traffic.receivedMessages} msg / ${(phone.traffic.receivedBytes / 1024).toFixed(1)} kB · out ${phone.traffic.sentMessages}`,
        `frames ok ${state.framesAccepted} stale ${state.framesDropped}`,
        `peer ${phone.peer?.state ?? "none"}${phone.negotiationFailures ? ` · failures ${phone.negotiationFailures}` : ""}`,
      ].join(" · "));
    }
    return lines.join("\n");
  }
}
