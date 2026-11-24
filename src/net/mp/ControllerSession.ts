/**
 * The phone's side of a room. Picks the best transport on its own, in this order:
 *
 *   1. WebRTC direct (same network: host candidates)
 *   2. WebRTC through STUN (different networks, most NATs)
 *   3. WebRTC through TURN (only if the server runs TURN_FREE_TIER and grants credentials)
 *   4. WebSocket relay through the room (WSS on 443) — always tried in parallel, so the
 *      phone works from the first second while WebRTC negotiates
 *   5. HTTPS polling with batched input, when WebSockets are blocked too
 *
 * Failures are detected by timeouts and connection states, recovered by ICE restarts and
 * reconnection, and the session (identity, slot, choices) survives all of it, including a
 * switch from Wi-Fi to mobile data.
 */
import { ApiError, callApi } from "./api";
import { RttEstimator, TrafficCounter } from "./linkStats";
import { InputSender, profileFor } from "./inputSender";
import { PeerLink, webRtcSupported } from "./peerLink";
import {
  FLAG_BACKGROUND,
  INPUT_FRAME_BYTES,
  buttonBit,
  encodeInputFrame,
  parseHostToPhone,
  safeJson,
  type ApiErrorCode,
  type HostToPhone,
  type IceServerConfig,
  type JoinRoomResponse,
  type LobbySnapshot,
  type PadLayout,
  type PhoneButton,
  type PhoneToHost,
  type PlayerToRoom,
  type PollResponse,
  type RoomPhase,
  type RoomToClient,
  type TransportKind,
  type TransportPolicy,
  type PhoneTheme,
} from "./protocol";
import { RoomSocket } from "./roomSocket";

export type ControllerStatus =
  | "joining" | "connecting" | "connected" | "reconnecting" | "failed"
  | "kicked" | "closed" | "full" | "locked" | "not-found" | "quota" | "error";

export interface ControllerView {
  readonly status: ControllerStatus;
  readonly transport: TransportKind;
  readonly rtt: number;
  readonly jitter: number;
  readonly loss: number;
  readonly rateHz: number;
  readonly lobby: LobbySnapshot | null;
  readonly playerId: string | null;
  readonly cook: { readonly slot: number | null; readonly color: string; readonly label: string } | null;
  readonly phase: RoomPhase;
  /** What the pad shows, as the host decides (stick, D-pad, or waiting). */
  readonly layout: PadLayout;
  /** This phone drives the menus (player 1). */
  readonly leader: boolean;
  /** A disaster playing in the kitchen: the pad shows its background. Null otherwise. */
  readonly theme: PhoneTheme | null;
  /** Why the current transport is not WebRTC, for the diagnostics line. */
  readonly fallbackReason: string;
  readonly sent: number;
  readonly received: number;
  readonly bytes: number;
}

/** Counted from when the offer actually leaves, not from when the connection was made. */
const ICE_TIMEOUT_MS = 15_000;
const TURN_TIMEOUT_MS = 12_000;
const DISCONNECT_GRACE_MS = 3_500;
/** After WebRTC gives up, it is retried with these delays, then every last one, forever:
 * the relay carries the game meanwhile, and a network that changes may allow it later. */
// The first retry is almost immediate: a fresh negotiation often succeeds where the
// first one lost a race (mDNS host candidates that did not resolve, a slow answer).
const P2P_RETRY_MS = [3_000, 15_000, 60_000, 180_000];
const PING_P2P_MS = 2_000;
const PING_RELAY_MS = 5_000;
const STATS_MS = 5_000;
/** WebSocket attempts that never opened before HTTPS polling takes over. */
const WS_FAILURES_BEFORE_HTTPS = 3;

const storageKey = (code: string): string => `byte-bistro:mp-phone:${code}`;

export class ControllerSession {
  private socket: RoomSocket | null = null;
  private peer: PeerLink | null = null;
  private policy: TransportPolicy | null = null;
  private playerId: string | null = null;
  private token: string | null = null;
  private statusValue: ControllerStatus = "joining";
  private lobby: LobbySnapshot | null = null;
  private cook: ControllerView["cook"] = null;
  private phase: RoomPhase = "lobby";
  private layout: PadLayout = "wait";
  private theme: PhoneTheme | null = null;
  private leader = false;
  private relayAllowed = true;
  private transportValue: TransportKind = "none";
  private reportedTransport: TransportKind | null = null;
  private fallbackReason = "";
  readonly sender = new InputSender();
  private readonly rtt = new RttEstimator();
  private readonly traffic = new TrafficCounter();
  private hostLoss = 0;
  private buttonSeq = 0;
  private pingId = 0;
  private readonly pings = new Map<number, number>();
  private lastPingAt = 0;
  private lastStatsAt = 0;
  private iceTimer = 0;
  private disconnectTimer = 0;
  private retryTimer = 0;
  private p2pAttempts = 0;
  private turnTried = false;
  private turnServers: IceServerConfig[] | null = null;
  private https: { timer: number; inFlight: boolean; queue: PlayerToRoom[]; frames: string[]; version: number; interval: number } | null = null;
  private readonly frame = new Uint8Array(INPUT_FRAME_BYTES);
  private readonly listeners = new Set<(view: ControllerView) => void>();
  private readonly hooks = new AbortController();
  private background = false;
  private disposed = false;
  /** Called when the host asks for a vibration. */
  onBuzz: ((ms: number) => void) | null = null;

  constructor(readonly code: string, private readonly name: string) {
    // A phone switching networks: restart ICE and the socket at once.
    window.addEventListener("online", () => this.networkChanged(), { signal: this.hooks.signal });
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    connection?.addEventListener?.("change", () => this.networkChanged(), { signal: this.hooks.signal });
    document.addEventListener("visibilitychange", () => this.visibilityChanged(), { signal: this.hooks.signal });
    window.addEventListener("pagehide", () => this.goBackground(), { signal: this.hooks.signal });
  }

  onChange(listener: (view: ControllerView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }

  view(): ControllerView {
    return {
      status: this.statusValue,
      transport: this.transportValue,
      rtt: Math.round(this.rtt.smoothed),
      jitter: Math.round(this.rtt.jitter),
      loss: this.hostLoss,
      rateHz: Math.round(this.sender.rateHz),
      lobby: this.lobby,
      playerId: this.playerId,
      cook: this.cook,
      phase: this.phase,
      layout: this.layout,
      theme: this.theme,
      leader: this.leader,
      fallbackReason: this.fallbackReason,
      sent: this.traffic.sentMessages,
      received: this.traffic.receivedMessages,
      bytes: this.traffic.sentBytes + this.traffic.receivedBytes,
    };
  }

  /** Joins (or rejoins with the saved identity) and starts connecting. */
  async start(): Promise<void> {
    this.setStatus("joining");
    let saved: { playerId?: string; token?: string } = {};
    try {
      saved = JSON.parse(localStorage.getItem(storageKey(this.code)) ?? "{}") as typeof saved;
    } catch {
      // No storage (private mode): a fresh identity, like a new phone.
    }
    let joined: JoinRoomResponse;
    try {
      joined = await callApi<JoinRoomResponse>(`rooms/${this.code}/join`, { name: this.name, playerId: saved.playerId, token: saved.token });
    } catch (error) {
      this.failFromApi(error);
      return;
    }
    if (this.disposed) return;
    this.playerId = joined.playerId;
    this.token = joined.playerToken;
    this.policy = joined.policy;
    this.relayAllowed = joined.policy.relayAllowed;
    try {
      localStorage.setItem(storageKey(this.code), JSON.stringify({ playerId: joined.playerId, token: joined.playerToken }));
    } catch {
      // Reconnection after a reload will not be possible; within the page it still is.
    }
    this.setStatus("connecting");
    this.openSocket();
    this.startPeer();
  }

  // -------------------------------------------------------------------------------------
  // Commands from the controller page
  // -------------------------------------------------------------------------------------

  setProfile(profile: { name?: string; color?: string; character?: string | null }): void {
    this.sendRoom({ t: "profile", ...profile });
  }

  setReady(ready: boolean): void {
    this.sendRoom({ t: "ready", ready });
  }

  leave(): void {
    this.sendRoom({ t: "leave" });
    try {
      localStorage.removeItem(storageKey(this.code));
    } catch {
      // Nothing stored.
    }
    window.setTimeout(() => this.dispose(), 200);
  }

  setStick(x: number, y: number): void {
    this.sender.setStick(x, y);
  }

  /** A button edge: sent reliably at once, and folded into the next frames' mask. */
  setButton(button: PhoneButton, down: boolean): void {
    const bit = buttonBit(button);
    const mask = this.sender.heldButtons;
    const next = down ? mask | bit : mask & ~bit;
    if (next === mask) return;
    this.sender.setButtons(next);
    this.buttonSeq = (this.buttonSeq + 1) & 0xffff;
    this.sendToHost({ t: "btn", b: button, down, seq: this.buttonSeq });
  }

  /** Call every animation frame: sends what is due on the best open path. */
  tick(now: number): void {
    if (this.disposed || !this.playerId) return;
    const transport = this.currentTransport();
    this.sender.setProfile(profileFor(transport));
    if (transport !== "none" && this.sender.due(now)) this.sendFrame(now, transport);
    const pingEvery = this.peer?.isOpen ? PING_P2P_MS : PING_RELAY_MS;
    if (transport !== "none" && now - this.lastPingAt > pingEvery) {
      this.lastPingAt = now;
      this.pingId = (this.pingId + 1) & 0xffffff;
      this.pings.set(this.pingId, now);
      if (this.pings.size > 16) this.pings.delete(this.pings.keys().next().value!);
      this.sendToHost({ t: "ping", id: this.pingId, ts: Math.round(now) });
    }
    if (now - this.lastStatsAt > STATS_MS && this.rtt.samples > 0) {
      this.lastStatsAt = now;
      this.sendToHost({ t: "stats", rtt: Math.round(this.rtt.smoothed), jitter: Math.round(this.rtt.jitter), rate: Math.round(this.sender.rateHz), transport });
      this.sender.adapt(now, { rtt: this.rtt.smoothed, jitter: this.rtt.jitter, loss: this.hostLoss });
    }
    if (transport !== this.transportValue) {
      this.transportValue = transport;
      this.emit();
    }
    if (transport !== this.reportedTransport && this.socketOrHttpsReady()) {
      this.reportedTransport = transport;
      this.sendRoom({ t: "transport", transport });
    }
  }

  /** Manual retry from the error screen. */
  retry(): void {
    this.p2pAttempts = 0;
    this.turnTried = false;
    if (!this.playerId) {
      void this.start();
      return;
    }
    this.setStatus("connecting");
    this.socket?.reconnectNow();
    if (!this.socket) this.openSocket();
    this.restartPeer();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hooks.abort();
    window.clearTimeout(this.iceTimer);
    window.clearTimeout(this.disconnectTimer);
    window.clearTimeout(this.retryTimer);
    this.stopHttps();
    this.socket?.stop();
    this.peer?.close();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------
  // Transports
  // -------------------------------------------------------------------------------------

  private currentTransport(): TransportKind {
    if (this.peer?.isOpen) return this.peerTransport;
    if (!this.relayAllowed) return "none";
    if (this.socket?.isOpen) return "websocket";
    if (this.https) return "https";
    return "none";
  }

  /** Refined by getStats every few seconds; "stun" until known. */
  private peerTransport: TransportKind = "stun";

  private socketOrHttpsReady(): boolean {
    return Boolean(this.socket?.isOpen || this.https);
  }

  private sendFrame(now: number, transport: TransportKind): void {
    const seq = this.sender.markSent(now);
    const { x, y } = this.sender.stick;
    encodeInputFrame({
      seq,
      x,
      y,
      buttons: this.sender.heldButtons,
      flags: this.background ? FLAG_BACKGROUND : 0,
      clock: Math.round(now),
    }, this.frame);
    let ok = false;
    if (transport === "websocket") ok = this.socket!.sendBinary(this.frame);
    else if (transport === "https") {
      // Only the newest frame matters; the poll carries it.
      this.https!.frames = [btoa(String.fromCharCode(...this.frame))];
      ok = true;
    } else ok = this.peer!.sendMove(this.frame);
    if (ok) this.traffic.sent(INPUT_FRAME_BYTES);
    else this.sender.congested();
  }

  /** End-to-end message to the host: data channel first, then the room. */
  private sendToHost(message: PhoneToHost): void {
    const text = JSON.stringify(message);
    if (this.peer?.sendAction(text)) {
      this.traffic.sent(text.length);
      return;
    }
    if (!this.relayAllowed) return;
    if (this.sendRoom({ t: "to-host", msg: message })) this.traffic.sent(text.length);
  }

  /** Messages for the room sent before any path to it was open (the first offer, say). */
  private readonly pendingRoom: PlayerToRoom[] = [];

  private sendRoom(message: PlayerToRoom): boolean {
    if (this.socket?.send(message)) return true;
    if (this.https) {
      const queue = this.https.queue;
      // A newer ready/profile replaces a queued one; button events all go, in order.
      if (queue.length >= 16) queue.shift();
      queue.push(message);
      return true;
    }
    // Signalling and lobby choices wait for the path; input never does (it would be stale).
    if (message.t !== "to-host" && message.t !== "transport" && this.pendingRoom.length < 64) {
      this.pendingRoom.push(message);
    }
    return false;
  }

  private flushPendingRoom(): void {
    const queued = this.pendingRoom.splice(0);
    for (const message of queued) this.sendRoom(message);
    // The offer waited for the path; the ICE clock starts now.
    if (queued.some((message) => message.t === "signal") && this.peer && !this.peer.isOpen) {
      this.armIceTimeout(this.turnServers ? TURN_TIMEOUT_MS : ICE_TIMEOUT_MS);
    }
  }

  private openSocket(): void {
    if (!this.playerId || !this.token) return;
    this.socket = new RoomSocket({
      code: this.code,
      role: "player",
      token: this.token,
      playerId: this.playerId,
      onMessage: (message) => this.onRoomMessage(message),
      onState: (state, detail) => {
        if (state === "open") {
          this.stopHttps();
          this.reportedTransport = null;
          this.setStatus("connected");
          this.flushPendingRoom();
        } else if (state === "stopped") {
          if (detail.closeCode === 4003) this.setStatus("kicked");
          else if (detail.closeCode === 4000) this.setStatus("closed");
        } else if (state === "retrying") {
          if (!this.peer?.isOpen && !this.https) this.setStatus("reconnecting");
          if (detail.failures >= WS_FAILURES_BEFORE_HTTPS && !this.https && this.policy?.httpsAllowed) {
            this.fallbackReason = "websocket-blocked";
            this.startHttps();
          } else if (detail.failures >= WS_FAILURES_BEFORE_HTTPS + 2 && !this.https && !this.peer?.isOpen) {
            this.setStatus("failed");
          }
        }
        this.emit();
      },
    });
    this.socket.connect();
  }

  private onRoomMessage(message: RoomToClient): void {
    this.traffic.received(0);
    switch (message.t) {
      case "welcome":
        this.relayAllowed = message.relay;
        return;
      case "lobby":
        this.lobby = message.lobby;
        if (message.lobby.phase !== this.phase) this.phase = message.lobby.phase;
        this.emit();
        return;
      case "signal":
        if (this.peer) void this.peer.handleSignal(message.data);
        return;
      case "from-host":
        this.onHostMessage(message.msg);
        return;
      case "relay":
        this.relayAllowed = message.allowed;
        if (!message.allowed) this.fallbackReason = "quota";
        this.emit();
        return;
      case "kicked":
        this.setStatus("kicked");
        this.dispose();
        return;
      case "closed":
        this.setStatus(message.reason === "quota" ? "quota" : "closed");
        this.dispose();
        return;
      default:
        return;
    }
  }

  private onHostMessage(message: HostToPhone): void {
    switch (message.t) {
      case "pong": {
        const sentAt = this.pings.get(message.id);
        if (sentAt !== undefined) {
          this.pings.delete(message.id);
          this.rtt.add(performance.now() - sentAt);
        }
        this.hostLoss = message.loss;
        this.emit();
        return;
      }
      case "cook":
        this.cook = { slot: message.slot, color: message.color, label: message.label };
        this.emit();
        return;
      case "phase":
        this.phase = message.phase;
        this.emit();
        return;
      case "buzz":
        this.onBuzz?.(message.ms);
        return;
      case "ui":
        if (message.layout === this.layout && message.leader === this.leader) return;
        this.layout = message.layout;
        this.leader = message.leader;
        this.emit();
        return;
      case "theme":
        if (message.event === this.theme) return;
        this.theme = message.event;
        this.emit();
        return;
    }
  }

  // -------------------------------------------------------------------------------------
  // WebRTC
  // -------------------------------------------------------------------------------------

  private startPeer(): void {
    if (this.disposed || !webRtcSupported()) {
      this.fallbackReason = "webrtc-unsupported";
      return;
    }
    if (this.peer) {
      this.peer.close();
      this.sendRoom({ t: "signal", data: { kind: "reset" } });
    }
    const servers = this.turnServers ?? this.policy?.iceServers ?? [];
    const peer = new PeerLink({
      polite: true,
      iceServers: servers,
      sendSignal: (data) => this.sendRoom({ t: "signal", data }),
      onState: (state) => this.onPeerState(peer, state),
      onAction: (text) => {
        this.traffic.received(text.length);
        const message = parseHostToPhone(safeJson(text));
        if (message) this.onHostMessage(message);
      },
      onMove: () => undefined,
    });
    this.peer = peer;
    this.armIceTimeout(this.turnServers ? TURN_TIMEOUT_MS : ICE_TIMEOUT_MS);
  }

  private armIceTimeout(ms: number): void {
    window.clearTimeout(this.iceTimer);
    this.iceTimer = window.setTimeout(() => void this.iceTimedOut(), ms);
  }

  private async iceTimedOut(): Promise<void> {
    if (this.disposed || this.peer?.isOpen) return;
    // STUN did not get through (symmetric NAT, CGNAT, UDP blocked…). TURN next, if offered.
    if (!this.turnTried && this.policy?.turnAvailable && this.playerId && this.token) {
      this.turnTried = true;
      try {
        const { iceServers } = await callApi<{ iceServers: IceServerConfig[] }>(`rooms/${this.code}/turn`, { playerId: this.playerId, token: this.token });
        if (this.disposed) return;
        this.turnServers = iceServers;
        this.fallbackReason = "stun-failed";
        this.peer?.restart(iceServers);
        this.armIceTimeout(TURN_TIMEOUT_MS);
        return;
      } catch (error) {
        this.fallbackReason = error instanceof ApiError && error.code === "quota" ? "turn-quota" : "turn-unavailable";
      }
    } else {
      this.fallbackReason = this.policy?.turnAvailable ? "turn-failed" : "p2p-failed";
    }
    // WebRTC is not possible right now: the relay carries the input. Retry later.
    this.peer?.close();
    this.peer = null;
    this.sendRoom({ t: "signal", data: { kind: "reset" } });
    this.emit();
    const delay = P2P_RETRY_MS[Math.min(this.p2pAttempts, P2P_RETRY_MS.length - 1)]!;
    this.p2pAttempts += 1;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.startPeer(), delay);
  }

  private onPeerState(peer: PeerLink, state: string): void {
    if (peer !== this.peer || this.disposed) return;
    if (state === "open") {
      window.clearTimeout(this.iceTimer);
      window.clearTimeout(this.disconnectTimer);
      this.fallbackReason = "";
      this.p2pAttempts = 0;
      this.setStatus("connected");
      void peer.describePath().then((path) => {
        if (path && peer === this.peer) {
          this.peerTransport = path.transport;
          this.emit();
        }
      });
    } else if (state === "disconnected") {
      // Often recovers by itself (a Wi-Fi hiccup); if not, restart ICE.
      window.clearTimeout(this.disconnectTimer);
      this.disconnectTimer = window.setTimeout(() => {
        if (peer === this.peer && !peer.isOpen) this.restartPeer();
      }, DISCONNECT_GRACE_MS);
    } else if (state === "failed") {
      this.restartPeer();
    }
    this.emit();
  }

  private restartPeer(): void {
    if (!this.peer) {
      this.startPeer();
      return;
    }
    this.peer.restart(this.turnServers ?? undefined);
    this.armIceTimeout(this.turnServers ? TURN_TIMEOUT_MS : ICE_TIMEOUT_MS);
  }

  private networkChanged(): void {
    if (this.disposed || !this.playerId) return;
    this.socket?.reconnectNow();
    this.restartPeer();
  }

  // -------------------------------------------------------------------------------------
  // HTTPS polling (last resort)
  // -------------------------------------------------------------------------------------

  private startHttps(): void {
    if (this.https || !this.policy?.httpsAllowed) return;
    this.https = { timer: 0, inFlight: false, queue: [], frames: [], version: -1, interval: this.policy.httpsMinIntervalMs };
    this.setStatus("connected");
    this.flushPendingRoom();
    void this.pollOnce();
  }

  private stopHttps(): void {
    if (!this.https) return;
    window.clearTimeout(this.https.timer);
    this.https = null;
  }

  private async pollOnce(): Promise<void> {
    const state = this.https;
    if (!state || state.inFlight || this.disposed) return;
    state.inFlight = true;
    const messages = state.queue.splice(0, state.queue.length);
    const frames = state.frames.splice(0, state.frames.length);
    try {
      const reply = await callApi<PollResponse>(`rooms/${this.code}/poll`, {
        playerId: this.playerId, token: this.token, messages, frames, lobbyVersion: state.version,
      });
      for (const message of reply.messages) {
        if (message.t === "lobby") state.version = message.lobby.version;
        this.onRoomMessage(message);
      }
      state.interval = Math.max(this.policy?.httpsMinIntervalMs ?? 333, reply.nextPollMs);
      if (this.statusValue === "reconnecting") this.setStatus("connected");
    } catch (error) {
      // Put the commands back; slow down.
      state.queue.unshift(...messages.slice(-8));
      state.interval = Math.min(5_000, state.interval * 2);
      if (error instanceof ApiError && (error.code === "quota" || error.code === "kicked" || error.code === "not-found")) {
        this.failFromApi(error);
        this.stopHttps();
        return;
      }
      this.setStatus("reconnecting");
    } finally {
      state.inFlight = false;
    }
    if (this.https === state) state.timer = window.setTimeout(() => void this.pollOnce(), this.background ? 5_000 : state.interval);
  }

  // -------------------------------------------------------------------------------------

  private visibilityChanged(): void {
    if (document.visibilityState === "hidden") this.goBackground();
    else if (this.background) {
      this.background = false;
      this.sender.setButtons(0);
      // Networks change while a phone sleeps; check the paths at once.
      if (!this.socket?.isOpen && !this.https) this.socket?.reconnectNow();
      if (this.peer && !this.peer.isOpen) this.restartPeer();
    }
  }

  /** In the background the phone stops controlling: the cook stops and lets go. */
  private goBackground(): void {
    if (this.background) return;
    this.background = true;
    this.sender.setStick(0, 0);
    this.sender.setButtons(0);
    this.buttonSeq = (this.buttonSeq + 1) & 0xffff;
    this.sendToHost({ t: "release-all", seq: this.buttonSeq });
    const transport = this.currentTransport();
    if (transport !== "none") this.sendFrame(performance.now(), transport);
  }

  private failFromApi(error: unknown): void {
    const code: ApiErrorCode | "network" = error instanceof ApiError ? error.code : "network";
    const map: Partial<Record<ApiErrorCode | "network", ControllerStatus>> = {
      "not-found": "not-found", full: "full", locked: "locked", kicked: "kicked", quota: "quota", closed: "closed",
    };
    this.fallbackReason = code;
    this.setStatus(map[code] ?? "failed");
  }

  private setStatus(status: ControllerStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emit();
  }

  private emit(): void {
    const view = this.view();
    for (const listener of this.listeners) listener(view);
  }
}
