/**
 * The game's side of a phone-controller room. The browser running the game is the host and
 * the only authority: phones send commands, the host decides what they do.
 *
 * Per phone it keeps one RemoteInputDevice (what the cook reads) and, when possible, one
 * WebRTC PeerLink. Input arrives over the best path available at that moment — the data
 * channels, or the room's WebSocket relay while WebRTC negotiates or when it cannot connect
 * — and feeds the same device, so a change of transport is invisible to the game.
 */
import { callApi, controllerUrl } from "./api";
import { RttEstimator, TrafficCounter } from "./linkStats";
import { PeerLink, webRtcSupported, type PathInfo } from "./peerLink";
import {
  INPUT_FRAME_BYTES,
  decodeInputFrame,
  seqNewer,
  parsePhoneToHost,
  safeJson,
  type PhoneField,
  type CreateRoomResponse,
  type HostToPhone,
  type LobbyPlayer,
  type LobbySnapshot,
  type PadLayout,
  type PhoneButton,
  type PhoneToHost,
  type RoomPhase,
  type RoomToClient,
  type SignalData,
  type TransportKind,
  type TransportPolicy,
} from "./protocol";
import { HTTPS_SAFETY, P2P_SAFETY, RELAY_SAFETY, RemoteInputDevice } from "./remoteInput";
import { RoomSocket, type SocketState } from "./roomSocket";

export interface PhonePeer {
  readonly id: string;
  info: LobbyPlayer;
  readonly device: RemoteInputDevice;
  peer: PeerLink | null;
  path: PathInfo | null;
  /** Transport input actually arrives on right now. */
  transport: TransportKind;
  /** As measured by the phone and reported in its `stats` messages. */
  phoneRtt: number;
  phoneJitter: number;
  phoneRate: number;
  readonly traffic: TrafficCounter;
  readonly rtt: RttEstimator;
  negotiationFailures: number;
  peerFailedAt: number;
  lastCookMessage: string;
  /** What this phone's pad shows; only "game" drives a cook. */
  layout: PadLayout;
  lastUiMessage: string;
  lastFieldMessage: string;
  /** Last button event turned into a menu command, so a resent one is not run twice. */
  lastMenuSeq: number;
}

/** What one phone's pad should show, decided by the game. */
export interface PadState {
  readonly layout: PadLayout;
  readonly leader: boolean;
}

export interface HostSnapshot {
  readonly code: string;
  readonly joinUrl: string;
  readonly socket: SocketState;
  readonly lobby: LobbySnapshot | null;
  readonly policy: TransportPolicy;
  readonly relayAllowed: boolean;
  readonly closedReason: string | null;
  readonly phones: readonly PhonePeer[];
}

export interface HostSessionOptions {
  /** How many phones drive cooks; the others wait on the bench. */
  readonly cookSlots: number;
  /** Colour and label shown on the phone of each cook slot. */
  readonly cookColors: readonly string[];
}

const STORAGE_KEY = "byte-bistro:mp-host";
const DIAGNOSTICS_MS = 2_000;
/** A peer that stays failed this long is dropped; the phone starts a fresh one. */
const PEER_FAILED_DROP_MS = 15_000;

interface StoredHost {
  readonly code: string;
  readonly hostToken: string;
  readonly policy: TransportPolicy;
  readonly maxPlayers: number;
  readonly savedAt: number;
}

const readStored = (): StoredHost | null => {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as StoredHost | null;
    // Within the room's 2-minute host grace: a reload of the page reclaims the same room.
    return value && Date.now() - value.savedAt < 110_000 ? value : null;
  } catch {
    return null;
  }
};

export class HostSession {
  readonly code: string;
  readonly joinUrl: string;
  readonly policy: TransportPolicy;
  readonly phones = new Map<string, PhonePeer>();
  private readonly socket: RoomSocket;
  private lobby: LobbySnapshot | null = null;
  private relayAllowed: boolean;
  private closedReason: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly phoneListeners = new Set<(phones: readonly PhonePeer[]) => void>();
  private diagnosticsTimer = 0;
  private storeTimer = 0;
  private disposed = false;
  private phase: RoomPhase = "lobby";
  private catalogSent = "";
  /**
   * Signalling from a phone the lobby has not listed yet: the offer can overtake the lobby
   * update that announces the player. Kept briefly and replayed when it shows up.
   */
  private readonly earlySignals = new Map<string, { at: number; data: SignalData[] }>();
  /** Decides each cook slot's pad; null until the game sets it (every pad then waits). */
  private padFor: ((slot: number) => PadState) | null = null;
  /** A button pressed on a pad showing the D-pad (menus, character selection). */
  onMenuButton: ((slot: number, button: PhoneButton) => void) | null = null;
  /** Player 1 typed (or put away) the field their phone offered. */
  onField: ((message: Extract<PhoneToHost, { t: "field-submit" | "field-cancel" }>) => void) | null = null;
  /** The TV field player 1's phone is the keyboard for (null: none). */
  private field: PhoneField | null = null;

  /** Creates a room (or reclaims the one this tab hosted moments ago) and connects. */
  static async open(options: HostSessionOptions): Promise<HostSession> {
    const stored = readStored();
    if (stored) {
      const session = new HostSession(stored.code, stored.hostToken, stored.policy, options);
      return session;
    }
    const created = await callApi<CreateRoomResponse>("rooms", {});
    return new HostSession(created.code, created.hostToken, created.policy, options);
  }

  private constructor(code: string, private readonly hostToken: string, policy: TransportPolicy, private readonly options: HostSessionOptions) {
    this.code = code;
    this.joinUrl = controllerUrl(code);
    this.policy = policy;
    this.relayAllowed = policy.relayAllowed;
    this.socket = new RoomSocket({
      code,
      role: "host",
      token: hostToken,
      onMessage: (message) => this.onRoomMessage(message),
      onBinary: (bytes) => this.onRelayFrame(bytes),
      onState: (state, detail) => {
        if (state === "stopped" && detail.closeCode === 4000) this.closedReason ??= "closed";
        if (state === "stopped" && detail.closeCode === 4001) this.closedReason ??= "replaced";
        this.emit();
      },
    });
    this.socket.connect();
    this.diagnosticsTimer = window.setInterval(() => void this.refreshDiagnostics(), DIAGNOSTICS_MS);
    this.remember();
    this.storeTimer = window.setInterval(() => this.remember(), 30_000);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Phones joining, leaving or changing slot. */
  onPhonesChanged(listener: (phones: readonly PhonePeer[]) => void): () => void {
    this.phoneListeners.add(listener);
    return () => this.phoneListeners.delete(listener);
  }

  snapshot(): HostSnapshot {
    return {
      code: this.code,
      joinUrl: this.joinUrl,
      socket: this.socket.state,
      lobby: this.lobby,
      policy: this.policy,
      relayAllowed: this.relayAllowed,
      closedReason: this.closedReason,
      phones: [...this.phones.values()].sort((a, b) => a.info.slot - b.info.slot),
    };
  }

  /** The phone driving each cook slot (null when none). */
  cookDevices(): (RemoteInputDevice | null)[] {
    const out: (RemoteInputDevice | null)[] = Array.from({ length: this.options.cookSlots }, () => null);
    for (const phone of this.phones.values()) {
      if (phone.info.slot < this.options.cookSlots) out[phone.info.slot] = phone.device;
    }
    return out;
  }

  setCatalog(characters: readonly { id: string; name: string }[]): void {
    const json = JSON.stringify(characters);
    if (json === this.catalogSent) return;
    this.catalogSent = json;
    this.socket.send({ t: "catalog", characters });
  }

  setPhase(phase: RoomPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    this.socket.send({ t: "phase", phase });
  }

  setLocked(locked: boolean): void {
    this.socket.send({ t: "lock", locked });
  }

  /** Sets who decides each pad's layout, and applies it now. */
  setPadSource(padFor: (slot: number) => PadState): void {
    this.padFor = padFor;
    this.refreshPads();
  }

  /**
   * Sends each phone its pad layout when it changed. Cheap to call often: nothing is sent
   * unless something differs. A phone leaving "game" lets go of its cook at once.
   */
  refreshPads(): void {
    for (const phone of this.phones.values()) {
      const slot = phone.info.slot < this.options.cookSlots ? phone.info.slot : -1;
      const pad: PadState = slot >= 0 && this.padFor ? this.padFor(slot) : { layout: "wait", leader: false };
      if (pad.layout !== phone.layout) {
        if (phone.layout === "game") phone.device.state.neutralize();
        phone.layout = pad.layout;
      }
      if (!phone.info.connected) continue;
      const json = `${pad.layout}|${pad.leader}`;
      if (json === phone.lastUiMessage) continue;
      if (this.sendToPhone(phone, { t: "ui", layout: pad.layout, leader: pad.leader })) phone.lastUiMessage = json;
    }
    this.refreshFields();
  }

  /** Offers a TV field to player 1's phone as a keyboard, or puts it away (null). */
  setField(field: PhoneField | null): void {
    this.field = field;
    this.refreshFields();
  }

  /** Only player 1's phone gets the field; every other phone is told to put away any it has. */
  private refreshFields(): void {
    for (const phone of this.phones.values()) {
      if (!phone.info.connected) continue;
      const field = phone.info.slot === 0 ? this.field : null;
      const json = JSON.stringify(field);
      // A phone that never had a field needs no "put away".
      if (json === (phone.lastFieldMessage || "null")) continue;
      if (this.sendToPhone(phone, { t: "field", field })) phone.lastFieldMessage = json;
    }
  }

  /**
   * Closes the pairing: phones that dropped are removed, the rest are packed into slots
   * 0..n-1 in their current order (so the players are P1..Pn with no gaps), and the room
   * stops taking new phones. Returns n, the number of players.
   */
  settlePlayers(): number {
    const connected: PhonePeer[] = [];
    for (const phone of [...this.phones.values()].sort((a, b) => a.info.slot - b.info.slot)) {
      if (phone.info.connected) connected.push(phone);
      else this.kick(phone.id);
    }
    connected.forEach((phone, index) => {
      if (phone.info.slot !== index) this.assign(phone.id, index);
    });
    this.setLocked(true);
    return connected.length;
  }

  kick(playerId: string): void {
    this.socket.send({ t: "kick", player: playerId });
    this.dropPhone(playerId);
  }

  assign(playerId: string, slot: number): void {
    this.socket.send({ t: "assign", player: playerId, slot });
  }

  /** Short vibration on a phone (e.g. when its cook gets hit). */
  buzz(slot: number, ms: number): void {
    for (const phone of this.phones.values()) if (phone.info.slot === slot) this.sendToPhone(phone, { t: "buzz", ms });
  }

  /** Buzzes every phone that has a cook, as something hits the whole kitchen. */
  buzzAll(ms: number): void {
    for (const phone of this.phones.values()) {
      if (phone.info.connected && phone.info.slot < this.options.cookSlots) this.sendToPhone(phone, { t: "buzz", ms });
    }
  }

  /** Ends the room for everyone and frees its resources on the server. */
  close(): void {
    if (this.disposed) return;
    this.socket.send({ t: "close" });
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private mode: nothing was stored.
    }
    // Give the close a moment to leave before the socket goes.
    window.setTimeout(() => this.dispose(), 150);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.diagnosticsTimer);
    window.clearInterval(this.storeTimer);
    this.socket.stop();
    for (const phone of this.phones.values()) {
      phone.peer?.close();
      phone.device.state.neutralize();
    }
    this.phones.clear();
    this.listeners.clear();
    this.phoneListeners.clear();
    this.onMenuButton = null;
    this.onField = null;
    this.padFor = null;
  }

  // -------------------------------------------------------------------------------------

  private remember(): void {
    try {
      const stored: StoredHost = { code: this.code, hostToken: this.hostToken, policy: this.policy, maxPlayers: 0, savedAt: Date.now() };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // Private mode: a reload makes a new room instead.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private emitPhones(): void {
    const phones = this.snapshot().phones;
    for (const listener of this.phoneListeners) listener(phones);
  }

  private onRoomMessage(message: RoomToClient): void {
    switch (message.t) {
      case "welcome":
        this.relayAllowed = message.relay;
        // A reconnect: tell the room what it may have missed.
        if (this.catalogSent) this.socket.send({ t: "catalog", characters: JSON.parse(this.catalogSent) as unknown[] });
        this.socket.send({ t: "phase", phase: this.phase });
        this.emit();
        return;
      case "lobby":
        this.applyLobby(message.lobby);
        return;
      case "signal": {
        const phone = this.phones.get(message.from);
        if (!phone) {
          const early = this.earlySignals.get(message.from) ?? { at: performance.now(), data: [] };
          if (early.data.length < 64) early.data.push(message.data);
          this.earlySignals.set(message.from, early);
          return;
        }
        this.applySignal(phone, message.data);
        return;
      }
      case "from-player": {
        const phone = this.phones.get(message.from);
        if (phone) this.onPhoneMessage(phone, message.msg, phone.info.transport === "https" ? "https" : "websocket");
        return;
      }
      case "relay":
        this.relayAllowed = message.allowed;
        this.emit();
        return;
      case "closed":
        this.closedReason = message.reason;
        for (const phone of this.phones.values()) phone.device.state.neutralize();
        this.emit();
        return;
      default:
        return;
    }
  }

  private applySignal(phone: PhonePeer, data: SignalData): void {
    if (data.kind === "reset") {
      // A brand-new connection follows: its offer must not land on the old one.
      phone.peer?.close();
      phone.peer = null;
      phone.path = null;
      phone.peerFailedAt = 0;
      if (phone.info.connected) phone.transport = phone.info.transport;
      this.emit();
      return;
    }
    this.ensurePeer(phone);
    void phone.peer?.handleSignal(data);
  }

  private applyLobby(lobby: LobbySnapshot): void {
    this.lobby = lobby;
    let changed = false;
    const seen = new Set<string>();
    for (const info of lobby.players) {
      seen.add(info.id);
      let phone = this.phones.get(info.id);
      if (!phone) {
        phone = {
          id: info.id,
          info,
          device: new RemoteInputDevice(`phone:${info.id}`),
          peer: null,
          path: null,
          transport: info.transport,
          phoneRtt: 0,
          phoneJitter: 0,
          phoneRate: 0,
          traffic: new TrafficCounter(),
          rtt: new RttEstimator(),
          negotiationFailures: 0,
          peerFailedAt: 0,
          lastCookMessage: "",
          layout: "wait",
          lastUiMessage: "",
          lastFieldMessage: "",
          lastMenuSeq: -1,
        };
        this.phones.set(info.id, phone);
        changed = true;
        const early = this.earlySignals.get(info.id);
        this.earlySignals.delete(info.id);
        if (early && performance.now() - early.at < 30_000) for (const data of early.data) this.applySignal(phone, data);
      } else if (phone.info.slot !== info.slot) {
        changed = true;
      }
      phone.info = info;
      if (!info.connected) {
        // The safety net: a phone that dropped never leaves its cook walking.
        phone.device.state.neutralize();
      }
      if (!phone.peer?.isOpen) phone.transport = info.connected ? info.transport : "none";
      // A reconnected phone has a fresh page: tell it everything again.
      if (!info.connected) {
        phone.lastCookMessage = "";
        phone.lastUiMessage = "";
        phone.lastFieldMessage = "";
      }
      this.sendCook(phone);
    }
    this.refreshPads();
    for (const [id, early] of this.earlySignals) {
      if (performance.now() - early.at > 30_000) this.earlySignals.delete(id);
    }
    for (const id of [...this.phones.keys()]) {
      if (!seen.has(id)) {
        this.dropPhone(id);
        changed = true;
      }
    }
    if (changed) this.emitPhones();
    this.emit();
  }

  private dropPhone(id: string): void {
    const phone = this.phones.get(id);
    if (!phone) return;
    phone.peer?.close();
    phone.device.state.neutralize();
    this.phones.delete(id);
  }

  /** Which cook a phone drives, so its screen shows the right colour and label. */
  private sendCook(phone: PhonePeer): void {
    const slot = phone.info.slot < this.options.cookSlots ? phone.info.slot : null;
    const color = slot === null ? "#8a94b8" : this.options.cookColors[slot] ?? phone.info.color;
    const message: HostToPhone = { t: "cook", slot, color, label: slot === null ? "—" : `P${slot + 1}` };
    const json = JSON.stringify(message);
    if (json === phone.lastCookMessage || !phone.info.connected) return;
    if (this.sendToPhone(phone, message)) phone.lastCookMessage = json;
  }

  private ensurePeer(phone: PhonePeer): void {
    if (phone.peer || !webRtcSupported()) return;
    const peer = new PeerLink({
      polite: false,
      iceServers: this.policy.iceServers,
      sendSignal: (data) => this.socket.send({ t: "signal", to: phone.id, data }),
      onState: (state) => {
        if (phone.peer !== peer) return;
        if (state === "open") {
          phone.negotiationFailures = 0;
          phone.peerFailedAt = 0;
          phone.device.state.timing = P2P_SAFETY;
          phone.lastCookMessage = "";
          phone.lastUiMessage = "";
          phone.lastFieldMessage = "";
          this.sendCook(phone);
          this.refreshPads();
          void this.refreshDiagnostics();
        } else if (state === "failed" || state === "disconnected") {
          phone.peerFailedAt ||= performance.now();
          phone.device.state.timing = phone.info.transport === "https" ? HTTPS_SAFETY : RELAY_SAFETY;
          phone.transport = phone.info.connected ? phone.info.transport : "none";
        }
        this.emit();
      },
      onAction: (text) => {
        phone.traffic.received(text.length);
        const message = parsePhoneToHost(safeJson(text));
        if (message) this.onPhoneMessage(phone, message, "p2p");
      },
      onMove: (bytes) => {
        phone.traffic.received(bytes.byteLength);
        const frame = decodeInputFrame(bytes);
        if (frame) this.applyFrame(phone, frame);
      },
    });
    phone.peer = peer;
  }

  private onRelayFrame(bytes: Uint8Array): void {
    if (bytes.byteLength !== INPUT_FRAME_BYTES + 1) return;
    const slot = bytes[0];
    const phone = [...this.phones.values()].find((entry) => entry.info.slot === slot);
    if (!phone) return;
    phone.traffic.received(bytes.byteLength);
    // A relayed frame while WebRTC is up is a duplicate path; sequence numbers sort it out.
    const frame = decodeInputFrame(bytes.subarray(1));
    if (!frame) return;
    if (!phone.peer?.isOpen) phone.device.state.timing = phone.info.transport === "https" ? HTTPS_SAFETY : RELAY_SAFETY;
    this.applyFrame(phone, frame);
  }

  /** A pad showing anything but the game drives no cook; its frames only prove it is there. */
  private applyFrame(phone: PhonePeer, frame: NonNullable<ReturnType<typeof decodeInputFrame>>): void {
    if (phone.layout === "game") phone.device.state.applyFrame(frame, performance.now());
    else phone.device.state.touch(performance.now());
  }

  private onPhoneMessage(phone: PhonePeer, message: PhoneToHost, via: "p2p" | "websocket" | "https"): void {
    const now = performance.now();
    switch (message.t) {
      case "btn":
        if (phone.layout === "game") {
          phone.device.state.applyButton(message.b, message.down, now);
          return;
        }
        phone.device.state.touch(now);
        if (!message.down || (phone.lastMenuSeq >= 0 && !seqNewer(message.seq, phone.lastMenuSeq))) return;
        phone.lastMenuSeq = message.seq;
        if (phone.info.slot < this.options.cookSlots) this.onMenuButton?.(phone.info.slot, message.b);
        return;
      case "release-all":
        phone.device.state.releaseAll(now);
        return;
      case "ping": {
        phone.device.state.touch(now);
        const pong: HostToPhone = { t: "pong", id: message.id, ts: message.ts, loss: Math.round(phone.device.state.loss.loss * 1_000) / 1_000 };
        if (via === "p2p") this.sendP2p(phone, pong);
        else this.socket.send({ t: "to-player", to: phone.id, msg: pong });
        return;
      }
      case "stats":
        phone.device.state.touch(now);
        phone.phoneRtt = message.rtt;
        phone.phoneJitter = message.jitter;
        phone.phoneRate = message.rate;
        phone.rtt.add(message.rtt);
        return;
      case "field-submit":
      case "field-cancel":
        phone.device.state.touch(now);
        if (phone.info.slot === 0 && this.field?.id === message.id) this.onField?.(message);
        return;
    }
  }

  private sendP2p(phone: PhonePeer, message: HostToPhone): boolean {
    const text = JSON.stringify(message);
    if (!phone.peer?.sendAction(text)) return false;
    phone.traffic.sent(text.length);
    return true;
  }

  /** Data channel when open; otherwise through the room (outgoing room messages are free). */
  private sendToPhone(phone: PhonePeer, message: HostToPhone): boolean {
    if (this.sendP2p(phone, message)) return true;
    return this.socket.send({ t: "to-player", to: phone.id, msg: message });
  }

  private async refreshDiagnostics(): Promise<void> {
    const now = performance.now();
    for (const phone of this.phones.values()) {
      const peer = phone.peer;
      if (!peer) continue;
      if (peer.isOpen) {
        phone.path = await peer.describePath();
        if (phone.path) phone.transport = phone.path.transport;
      } else if (phone.peerFailedAt && now - phone.peerFailedAt > PEER_FAILED_DROP_MS) {
        // Let the phone start over with a new connection (it will send a fresh offer).
        peer.close();
        phone.peer = null;
        phone.path = null;
        phone.peerFailedAt = 0;
        phone.negotiationFailures += 1;
      }
    }
    this.emit();
  }
}
