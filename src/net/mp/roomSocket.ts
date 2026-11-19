/**
 * The WebSocket to a room (signalling, lobby, and the input relay when WebRTC cannot
 * connect), with automatic reconnection.
 *
 * WSS on port 443 gets through nearly every network that lets the page load at all. The
 * token travels in the subprotocol header, never the URL. Keepalives are the literal text
 * "ping", which the room answers with "pong" without waking (Hibernation API).
 */
import {
  WS_AUTH_PREFIX,
  WS_SUBPROTOCOL,
  safeJson,
  MAX_SIGNAL_BYTES,
  type RoomToClient,
} from "./protocol";
import { wsBase } from "./api";

export type SocketState = "connecting" | "open" | "retrying" | "stopped";

export interface RoomSocketOptions {
  readonly code: string;
  readonly role: "host" | "player";
  readonly token: string;
  readonly playerId?: string;
  readonly onMessage: (message: RoomToClient) => void;
  readonly onBinary?: (bytes: Uint8Array) => void;
  readonly onState: (state: SocketState, detail: { failures: number; closeCode: number }) => void;
}

const KEEPALIVE_MS = 25_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 15_000;
/** Close codes after which reconnecting would be wrong (see room.ts). */
const FINAL_CODES = new Set([4000, 4001, 4003]);

export class RoomSocket {
  private socket: WebSocket | null = null;
  private stateValue: SocketState = "stopped";
  private failures = 0;
  private retryTimer = 0;
  private keepaliveTimer = 0;
  private pongTimer = 0;
  private stopped = false;
  private readonly listeners = new AbortController();
  /** Bytes and messages out/in, for diagnostics. */
  sentMessages = 0;
  receivedMessages = 0;
  lastCloseCode = 0;

  constructor(private readonly options: RoomSocketOptions) {
    // A phone that changes network (Wi-Fi → 4G) keeps a dead socket open for a while;
    // reconnect at once instead of waiting for a keepalive to time out.
    window.addEventListener("online", () => this.reconnectNow(), { signal: this.listeners.signal });
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    connection?.addEventListener?.("change", () => this.reconnectNow(), { signal: this.listeners.signal });
  }

  get state(): SocketState {
    return this.stateValue;
  }

  get isOpen(): boolean {
    // 1 is OPEN; not `WebSocket.OPEN`, which is undefined where the API is missing or
    // replaced (and `undefined === undefined` would call a missing socket open).
    return this.socket !== null && this.socket.readyState === 1;
  }

  connect(): void {
    if (this.stopped || this.socket) return;
    this.setState("connecting");
    const query = this.options.role === "host"
      ? "role=host"
      : `role=player&player=${encodeURIComponent(this.options.playerId ?? "")}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${wsBase()}/rooms/${this.options.code}/ws?${query}`, [
        WS_SUBPROTOCOL,
        `${WS_AUTH_PREFIX}${this.options.token}`,
      ]);
    } catch {
      // Constructing can throw (a blocked or policy-stripped WebSocket): a failed attempt.
      this.failures += 1;
      this.scheduleRetry(0);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      this.failures = 0;
      this.setState("open");
      this.armKeepalive();
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      this.receivedMessages += 1;
      if (typeof event.data !== "string") {
        this.options.onBinary?.(new Uint8Array(event.data));
        return;
      }
      if (event.data === "pong") {
        window.clearTimeout(this.pongTimer);
        return;
      }
      const message = safeJson(event.data, MAX_SIGNAL_BYTES * 4) as RoomToClient | undefined;
      if (message && typeof message === "object" && typeof message.t === "string") this.options.onMessage(message);
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearKeepalive();
      this.lastCloseCode = event.code;
      if (!opened) this.failures += 1;
      if (FINAL_CODES.has(event.code)) {
        this.stop();
        this.options.onState("stopped", { failures: this.failures, closeCode: event.code });
        return;
      }
      this.scheduleRetry(event.code);
    };
  }

  send(message: unknown): boolean {
    if (!this.isOpen) return false;
    try {
      this.socket!.send(JSON.stringify(message));
      this.sentMessages += 1;
      return true;
    } catch {
      return false;
    }
  }

  sendBinary(bytes: Uint8Array): boolean {
    if (!this.isOpen) return false;
    // A congested socket would only queue stale input; drop it instead.
    if (this.socket!.bufferedAmount > 2_048) return false;
    try {
      this.socket!.send(bytes);
      this.sentMessages += 1;
      return true;
    } catch {
      return false;
    }
  }

  /** Drops the current socket (if any) and reconnects immediately. */
  reconnectNow(): void {
    if (this.stopped) return;
    window.clearTimeout(this.retryTimer);
    const old = this.socket;
    this.socket = null;
    this.clearKeepalive();
    try {
      old?.close(1000, "reconnect");
    } catch {
      // Already closed.
    }
    this.connect();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    this.clearKeepalive();
    this.listeners.abort();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "bye");
    } catch {
      // Already closed.
    }
    this.stateValue = "stopped";
  }

  private setState(state: SocketState): void {
    this.stateValue = state;
    this.options.onState(state, { failures: this.failures, closeCode: this.lastCloseCode });
  }

  private scheduleRetry(code: number): void {
    if (this.stopped) return;
    // Exponential backoff with jitter; a rate-limited client waits longer.
    const base = code === 4008 ? 10_000 : Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(this.failures, 5));
    const delay = base * (0.75 + Math.random() * 0.5);
    this.setState("retrying");
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.connect(), delay);
  }

  private armKeepalive(): void {
    this.clearKeepalive();
    this.keepaliveTimer = window.setInterval(() => {
      if (!this.isOpen) return;
      try {
        this.socket!.send("ping");
      } catch {
        return;
      }
      window.clearTimeout(this.pongTimer);
      this.pongTimer = window.setTimeout(() => this.reconnectNow(), KEEPALIVE_TIMEOUT_MS);
    }, KEEPALIVE_MS);
  }

  private clearKeepalive(): void {
    window.clearInterval(this.keepaliveTimer);
    window.clearTimeout(this.pongTimer);
  }
}
