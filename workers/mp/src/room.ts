/**
 * RoomDO: one Durable Object per room, named by its join code. SQLite holds the room and
 * its players, so a phone or the host can reconnect after the object hibernates or the
 * page reloads. Sockets use the WebSocket Hibernation API: while WebRTC carries the input,
 * the sockets sit idle and the object accrues no duration at all.
 *
 * The room is a relay and a referee, never the game: it validates every message, keeps
 * the lobby, forwards WebRTC signalling, and only when WebRTC is impossible relays the
 * phones' input to the host, within the quota budget.
 */
import { DurableObject } from "cloudflare:workers";
import {
  CODE_LENGTH,
  INPUT_FRAME_BYTES,
  MAX_SIGNAL_BYTES,
  PLAYER_COLORS,
  WS_AUTH_PREFIX,
  WS_SUBPROTOCOL,
  decodeInputFrame,
  isPlayerColor,
  isPlayerId,
  isRoomCode,
  isToken,
  parseHostToRoom,
  parsePlayerToRoom,
  safeJson,
  sanitizeName,
  type ApiErrorCode,
  type CloseReason,
  type CreateRoomResponse,
  type HostToRoom,
  type IceServerConfig,
  type JoinRoomResponse,
  type LobbyPlayer,
  type LobbySnapshot,
  type PlayerToRoom,
  type PollResponse,
  type RoomPhase,
  type RoomToClient,
  type TransportKind,
  type TransportPolicy,
} from "../../../src/net/mp/protocol";
import { COST, ROOM_TIMING, STUN_SERVERS, readConfig, type MpConfig, type MpEnv } from "./config";
import type { QuotaDO, QuotaReply } from "./quota";
import { TokenBucket, hashToken, newPlayerId, newToken, originAllowed, sameDigest } from "./security";

export type ApiResult<T> = T | { readonly error: ApiErrorCode };

export interface CallerInfo {
  /** The browser's Origin header, checked against ALLOWED_ORIGINS. */
  readonly origin: string | null;
  /** The URL the request arrived on (its origin is always allowed). */
  readonly url: string;
}

interface Meta {
  code: string;
  hostHash: string;
  createdAt: number;
  expiresAt: number;
  maxPlayers: number;
  locked: boolean;
  phase: RoomPhase;
  version: number;
  hostLeftAt: number;
  hostEverConnected: boolean;
  catalog: { id: string; name: string }[];
}

interface Player {
  id: string;
  tokenHash: string;
  slot: number;
  name: string;
  color: string;
  character: string | null;
  ready: boolean;
  kicked: boolean;
  transport: TransportKind;
  joinedAt: number;
}

interface Attachment {
  readonly role: "host" | "player";
  readonly id: string;
}

/** What one HTTPS-polling phone is waiting to receive. */
interface PollState {
  outbox: RoomToClient[];
  lastPollAt: number;
  polls: number;
  lobbyVersion: number;
}

const MAX_OUTBOX = 48;
const MAX_POLL_MESSAGES = 16;
const MAX_POLL_FRAMES = 8;
/** Per room, an HTTPS phone gets this many polls (about 17 minutes at 3 Hz). */
const MAX_POLLS_PER_PLAYER = 3_000;
const HTTPS_MIN_INTERVAL_MS = 333;
/** Report usage to the quota object after this many estimated DO requests. */
const REPORT_EVERY = 50;

const err = (error: ApiErrorCode): { error: ApiErrorCode } => ({ error });

export class RoomDO extends DurableObject<MpEnv> {
  private readonly config: MpConfig;
  private meta: Meta | null = null;
  private readonly players = new Map<string, Player>();
  private readonly buckets = new WeakMap<WebSocket, { input: TokenBucket; control: TokenBucket }>();
  private readonly polls = new Map<string, PollState>();
  private relayAllowed = true;
  private httpsAllowed = true;
  private pending = { workerRequests: 0, doRequests: 0, awakeMs: 0 };
  private lastMessageAt = 0;
  private reporting: Promise<void> | null = null;
  private closing = false;

  constructor(ctx: DurableObjectState, env: MpEnv) {
    super(ctx, env);
    this.config = readConfig(env);
    this.relayAllowed = this.config.relayEnabled;
    this.httpsAllowed = this.config.httpsEnabled;
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    sql.exec(`CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY, token_hash TEXT, slot INTEGER, name TEXT, color TEXT, character TEXT,
      ready INTEGER, kicked INTEGER, transport TEXT, joined_at INTEGER)`);
    const row = sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'room'").toArray()[0];
    if (row) this.meta = JSON.parse(row.value) as Meta;
    for (const player of sql.exec<Record<string, string | number | null>>("SELECT * FROM players").toArray()) {
      this.players.set(String(player.id), {
        id: String(player.id),
        tokenHash: String(player.token_hash),
        slot: Number(player.slot),
        name: String(player.name),
        color: String(player.color),
        character: player.character === null ? null : String(player.character),
        ready: Boolean(player.ready),
        kicked: Boolean(player.kicked),
        transport: String(player.transport) as TransportKind,
        joinedAt: Number(player.joined_at),
      });
    }
    // Keepalive pings from clients are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // -------------------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------------------

  private saveMeta(): void {
    if (!this.meta) return;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('room', ?)", JSON.stringify(this.meta));
  }

  private savePlayer(player: Player): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO players (id, token_hash, slot, name, color, character, ready, kicked, transport, joined_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      player.id, player.tokenHash, player.slot, player.name, player.color, player.character,
      player.ready ? 1 : 0, player.kicked ? 1 : 0, player.transport, player.joinedAt,
    );
  }

  private deletePlayer(id: string): void {
    this.players.delete(id);
    this.polls.delete(id);
    this.ctx.storage.sql.exec("DELETE FROM players WHERE id = ?", id);
  }

  // -------------------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------------------

  private quota(): DurableObjectStub<QuotaDO> {
    return this.env.QUOTA.get(this.env.QUOTA.idFromName("global")) as DurableObjectStub<QuotaDO>;
  }

  private charge(cost: { readonly worker: number; readonly durableObject: number }, count = 1): void {
    this.pending.workerRequests += cost.worker * count;
    this.pending.doRequests += cost.durableObject * count;
    const now = Date.now();
    const gap = now - this.lastMessageAt;
    // Messages close together keep the object awake (billed duration); far apart, it
    // hibernates in between and each wake-up costs a short slice instead.
    this.pending.awakeMs += gap < ROOM_TIMING.awakeGapMs ? gap : 50;
    this.lastMessageAt = now;
    if (this.pending.doRequests >= REPORT_EVERY) void this.flushUsage();
  }

  private applyQuota(reply: QuotaReply): void {
    const relay = this.config.relayEnabled && reply.relay;
    this.httpsAllowed = this.config.httpsEnabled && reply.https;
    if (relay !== this.relayAllowed) {
      this.relayAllowed = relay;
      this.broadcast({ t: "relay", allowed: relay });
    }
  }

  private async flushUsage(): Promise<void> {
    if (this.reporting) return this.reporting;
    const delta = this.pending;
    if (delta.doRequests === 0 && delta.workerRequests === 0 && delta.awakeMs === 0) return;
    this.pending = { workerRequests: 0, doRequests: 0, awakeMs: 0 };
    this.reporting = this.quota().report(delta)
      .then((reply) => this.applyQuota(reply))
      .catch(() => {
        // The quota object being unreachable is itself a sign of trouble: put the usage
        // back for the next report and stop relaying until a report goes through.
        this.pending.workerRequests += delta.workerRequests;
        this.pending.doRequests += delta.doRequests;
        this.pending.awakeMs += delta.awakeMs;
        this.applyQuota({ ok: false, relay: false, https: false, pressure: 1 });
      })
      .finally(() => { this.reporting = null; });
    return this.reporting;
  }

  private policy(): TransportPolicy {
    return {
      mode: this.config.mode,
      iceServers: STUN_SERVERS,
      turnAvailable: this.config.turn.enabled,
      relayAllowed: this.relayAllowed,
      httpsAllowed: this.httpsAllowed,
      httpsMinIntervalMs: HTTPS_MIN_INTERVAL_MS,
    };
  }

  // -------------------------------------------------------------------------------------
  // Lobby
  // -------------------------------------------------------------------------------------

  /** The socket being closed right now: still listed by the runtime, but already gone. */
  private leaving: WebSocket | null = null;

  private socketsOf(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((socket) => socket !== this.leaving);
  }

  private isConnected(player: Player): boolean {
    if (this.socketsOf(`p:${player.id}`).length > 0) return true;
    const poll = this.polls.get(player.id);
    return Boolean(poll && Date.now() - poll.lastPollAt < ROOM_TIMING.httpsStaleMs);
  }

  private snapshot(): LobbySnapshot {
    const meta = this.meta!;
    const players: LobbyPlayer[] = [...this.players.values()]
      .filter((player) => !player.kicked)
      .sort((a, b) => a.slot - b.slot)
      .map((player) => ({
        id: player.id,
        slot: player.slot,
        name: player.name,
        color: player.color,
        character: player.character,
        ready: player.ready,
        connected: this.isConnected(player),
        transport: this.isConnected(player) ? player.transport : "none",
      }));
    return {
      version: meta.version,
      code: meta.code,
      maxPlayers: meta.maxPlayers,
      locked: meta.locked,
      phase: meta.phase,
      hostConnected: this.socketsOf("host").length > 0,
      players,
      characters: meta.catalog,
    };
  }

  private touchLobby(): void {
    if (!this.meta) return;
    this.meta.version += 1;
    this.saveMeta();
    const message: RoomToClient = { t: "lobby", lobby: this.snapshot() };
    this.broadcast(message);
  }

  private send(socket: WebSocket, message: RoomToClient): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A socket closing under us is cleaned up by webSocketClose.
    }
  }

  /** Outgoing WebSocket messages are not billed; HTTPS phones get it on their next poll. */
  private broadcast(message: RoomToClient): void {
    for (const socket of this.socketsOf()) this.send(socket, message);
    if (message.t !== "lobby") for (const id of this.polls.keys()) this.queue(id, message);
  }

  private queue(playerId: string, message: RoomToClient): void {
    const poll = this.polls.get(playerId);
    if (!poll) return;
    if (poll.outbox.length >= MAX_OUTBOX) poll.outbox.shift();
    poll.outbox.push(message);
  }

  private sendToPlayer(playerId: string, message: RoomToClient): void {
    const sockets = this.socketsOf(`p:${playerId}`);
    for (const socket of sockets) this.send(socket, message);
    if (sockets.length === 0) this.queue(playerId, message);
  }

  private sendToHost(message: RoomToClient | Uint8Array): void {
    for (const socket of this.socketsOf("host")) {
      try {
        socket.send(message instanceof Uint8Array ? message : JSON.stringify(message));
      } catch {
        // See send().
      }
    }
  }

  private freeSlot(): number | null {
    const used = new Set([...this.players.values()].filter((player) => !player.kicked).map((player) => player.slot));
    for (let slot = 0; slot < (this.meta?.maxPlayers ?? 0); slot++) if (!used.has(slot)) return slot;
    return null;
  }

  private activePlayers(): Player[] {
    return [...this.players.values()].filter((player) => !player.kicked);
  }

  // -------------------------------------------------------------------------------------
  // RPC: create / join / poll / turn
  // -------------------------------------------------------------------------------------

  private checkCaller(caller: CallerInfo): boolean {
    return originAllowed(caller.origin, caller.url, this.config.allowedOrigins);
  }

  async create(caller: CallerInfo & { readonly code: string }): Promise<ApiResult<CreateRoomResponse> | { readonly error: "exists" }> {
    if (!this.checkCaller(caller)) return err("forbidden-origin");
    if (!isRoomCode(caller.code) || caller.code.length !== CODE_LENGTH) return err("bad-request");
    if (this.meta) return { error: "exists" };
    const reply = await this.quota().reserveRoom({
      workerRequests: COST.apiCall.worker,
      doRequests: COST.apiCall.durableObject,
    }).catch(() => null);
    if (!reply?.ok) return err("quota");
    this.applyQuota(reply);
    const hostToken = newToken();
    const now = Date.now();
    this.meta = {
      code: caller.code,
      hostHash: await hashToken(hostToken),
      createdAt: now,
      expiresAt: now + ROOM_TIMING.maxAgeMs,
      maxPlayers: this.config.maxPlayers,
      locked: false,
      phase: "lobby",
      version: 1,
      hostLeftAt: now,
      hostEverConnected: false,
      catalog: [],
    };
    this.saveMeta();
    await this.ctx.storage.setAlarm(now + ROOM_TIMING.unclaimedMs);
    return { code: caller.code, hostToken, maxPlayers: this.meta.maxPlayers, expiresAt: this.meta.expiresAt, policy: this.policy() };
  }

  async join(caller: CallerInfo & {
    readonly name?: unknown;
    readonly resumeId?: unknown;
    readonly resumeToken?: unknown;
  }): Promise<ApiResult<JoinRoomResponse>> {
    if (!this.checkCaller(caller)) return err("forbidden-origin");
    if (!this.meta || this.closing) return err("not-found");
    this.charge(COST.apiCall);
    // Reconnection: the same identity, slot and choices, never a duplicate player.
    if (isPlayerId(caller.resumeId) && isToken(caller.resumeToken)) {
      const player = this.players.get(caller.resumeId);
      if (player && sameDigest(player.tokenHash, await hashToken(caller.resumeToken))) {
        if (player.kicked) return err("kicked");
        return { playerId: player.id, playerToken: caller.resumeToken, slot: player.slot, resumed: true, policy: this.policy() };
      }
    }
    if (this.meta.locked) return err("locked");
    const slot = this.freeSlot();
    if (slot === null) return err("full");
    const token = newToken();
    const taken = new Set(this.activePlayers().map((player) => player.color));
    const player: Player = {
      id: newPlayerId(),
      tokenHash: await hashToken(token),
      slot,
      name: sanitizeName(caller.name, `P${slot + 1}`),
      color: PLAYER_COLORS.find((color) => !taken.has(color)) ?? PLAYER_COLORS[0],
      character: null,
      ready: false,
      kicked: false,
      transport: "none",
      joinedAt: Date.now(),
    };
    this.players.set(player.id, player);
    this.savePlayer(player);
    this.touchLobby();
    return { playerId: player.id, playerToken: token, slot, resumed: false, policy: this.policy() };
  }

  /** The HTTPS fallback: batched messages and input frames in, queued messages out. */
  async poll(caller: CallerInfo & {
    readonly playerId?: unknown;
    readonly token?: unknown;
    readonly messages?: unknown;
    readonly frames?: unknown;
    readonly lobbyVersion?: unknown;
  }): Promise<ApiResult<PollResponse>> {
    if (!this.checkCaller(caller)) return err("forbidden-origin");
    if (!this.meta || this.closing) return err("not-found");
    const player = await this.authPlayer(caller.playerId, caller.token);
    if (!player) return err("unauthorized");
    if (player.kicked) return err("kicked");
    this.charge(COST.apiCall);
    const now = Date.now();
    let state = this.polls.get(player.id);
    if (!state) {
      state = { outbox: [], lastPollAt: 0, polls: 0, lobbyVersion: -1 };
      this.polls.set(player.id, state);
    }
    if (!this.httpsAllowed || state.polls >= MAX_POLLS_PER_PLAYER) return err("quota");
    if (now - state.lastPollAt < HTTPS_MIN_INTERVAL_MS * 0.8) return err("rate-limited");
    const wasConnected = state.lastPollAt > 0 && now - state.lastPollAt < ROOM_TIMING.httpsStaleMs;
    state.lastPollAt = now;
    state.polls += 1;
    if (player.transport !== "https" && this.socketsOf(`p:${player.id}`).length === 0) {
      player.transport = "https";
      this.savePlayer(player);
    }
    const messages = Array.isArray(caller.messages) ? caller.messages.slice(0, MAX_POLL_MESSAGES) : [];
    for (const raw of messages) {
      const message = parsePlayerToRoom(raw);
      if (message) this.handlePlayerMessage(player, message);
    }
    const frames = Array.isArray(caller.frames) ? caller.frames.slice(0, MAX_POLL_FRAMES) : [];
    for (const frame of frames) {
      if (typeof frame !== "string" || frame.length > 24) continue;
      try {
        const bytes = Uint8Array.from(atob(frame), (char) => char.charCodeAt(0));
        this.relayFrame(player, bytes);
      } catch {
        // Not base64: ignored.
      }
    }
    if (!wasConnected) this.touchLobby();
    const out = state.outbox.splice(0, state.outbox.length);
    const known = typeof caller.lobbyVersion === "number" ? caller.lobbyVersion : -1;
    if (known !== this.meta.version) out.unshift({ t: "lobby", lobby: this.snapshot() });
    // Slower in the lobby; as fast as allowed while playing.
    const nextPollMs = this.meta.phase === "playing" ? HTTPS_MIN_INTERVAL_MS : 1_000;
    return { messages: out, nextPollMs };
  }

  /** TURN credentials, only in TURN_FREE_TIER and within the configured budget. */
  async turn(caller: CallerInfo & { readonly playerId?: unknown; readonly token?: unknown }): Promise<ApiResult<{ iceServers: IceServerConfig[] }>> {
    if (!this.checkCaller(caller)) return err("forbidden-origin");
    if (!this.meta || this.closing) return err("not-found");
    this.charge(COST.apiCall);
    const isHost = caller.playerId === "host" && isToken(caller.token) &&
      sameDigest(this.meta.hostHash, await hashToken(caller.token));
    if (!isHost && !(await this.authPlayer(caller.playerId, caller.token))) return err("unauthorized");
    if (!this.config.turn.enabled) return err("turn-disabled");
    const reply = await this.quota().reserveTurn().catch(() => null);
    if (!reply?.ok) return err("quota");
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.config.turn.keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.turn.apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: this.config.turn.ttlSeconds }),
      },
    ).catch(() => null);
    if (!response || !response.ok) return err("not-configured");
    const body = await response.json().catch(() => null) as { iceServers?: IceServerConfig[] } | null;
    const servers = (body?.iceServers ?? []).map((server) => ({
      ...server,
      // Port 53 URLs can stall browsers that are not trickling (Cloudflare's own advice).
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter((url) => !/:53(\?|$)/.test(url)),
    })).filter((server) => server.urls.length > 0);
    return { iceServers: servers };
  }

  private async authPlayer(id: unknown, token: unknown): Promise<Player | null> {
    if (!isPlayerId(id) || !isToken(token)) return null;
    const player = this.players.get(id);
    if (!player) return null;
    return sameDigest(player.tokenHash, await hashToken(token)) ? player : null;
  }

  // -------------------------------------------------------------------------------------
  // WebSockets
  // -------------------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/ws") || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    if (!this.checkCaller({ origin: request.headers.get("Origin"), url: request.url })) {
      return new Response("Forbidden origin", { status: 403 });
    }
    if (!this.meta || this.closing) return new Response("Room not found", { status: 404 });
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((entry) => entry.trim());
    const token = protocols.find((entry) => entry.startsWith(WS_AUTH_PREFIX))?.slice(WS_AUTH_PREFIX.length);
    if (!protocols.includes(WS_SUBPROTOCOL) || !isToken(token)) return new Response("Unauthorized", { status: 401 });
    const role = url.searchParams.get("role");
    let attachment: Attachment;
    if (role === "host") {
      if (!sameDigest(this.meta.hostHash, await hashToken(token))) return new Response("Unauthorized", { status: 401 });
      attachment = { role: "host", id: "host" };
    } else {
      const player = await this.authPlayer(url.searchParams.get("player"), token);
      if (!player) return new Response("Unauthorized", { status: 401 });
      if (player.kicked) return new Response("Kicked", { status: 403 });
      attachment = { role: "player", id: player.id };
    }
    this.charge(COST.wsConnect);
    const tag = attachment.role === "host" ? "host" : `p:${attachment.id}`;
    // One live socket per identity: a reconnect replaces the old one, and a stolen token
    // can at most kick the real owner out, who then reconnects and kicks it back.
    for (const old of this.socketsOf(tag)) {
      try {
        old.close(4001, "replaced");
      } catch {
        // Already closed.
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [tag]);
    server.serializeAttachment(attachment);
    this.send(server, { t: "welcome", role: attachment.role, you: attachment.role === "player" ? attachment.id : undefined, relay: this.relayAllowed });
    if (attachment.role === "host") {
      this.meta.hostEverConnected = true;
      this.meta.hostLeftAt = 0;
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TIMING.checkEveryMs);
    } else {
      this.polls.delete(attachment.id);
    }
    this.touchLobby();
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": WS_SUBPROTOCOL } });
  }

  private bucketsFor(socket: WebSocket): { input: TokenBucket; control: TokenBucket } {
    let buckets = this.buckets.get(socket);
    if (!buckets) {
      // Input: up to 30 frames/s sustained over the relay (the phone sends ≤ 15 Hz there).
      buckets = { input: new TokenBucket(30, 45), control: new TokenBucket(20, 40) };
      this.buckets.set(socket, buckets);
    }
    return buckets;
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.meta || this.closing) return;
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    this.charge(COST.wsMessage);
    const buckets = this.bucketsFor(socket);
    if (attachment.role === "player") {
      const player = this.players.get(attachment.id);
      if (!player || player.kicked) {
        socket.close(4003, "kicked");
        return;
      }
      if (typeof message !== "string") {
        if (buckets.input.take()) this.relayFrame(player, new Uint8Array(message));
        else this.punish(socket, buckets.input);
        return;
      }
      if (!buckets.control.take()) {
        this.punish(socket, buckets.control);
        return;
      }
      const parsed = parsePlayerToRoom(safeJson(message, MAX_SIGNAL_BYTES));
      if (parsed) this.handlePlayerMessage(player, parsed);
      return;
    }
    if (typeof message !== "string" || !buckets.control.take(Date.now(), 0.25)) return;
    const parsed = parseHostToRoom(safeJson(message, MAX_SIGNAL_BYTES));
    if (parsed) await this.handleHostMessage(parsed);
  }

  /** A client far over its rate is closed: it is broken or hostile either way. */
  private punish(socket: WebSocket, bucket: TokenBucket): void {
    if (bucket.refused > 200) socket.close(4008, "rate-limited");
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.socketGone(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.socketGone(socket);
  }

  private async socketGone(socket: WebSocket): Promise<void> {
    if (!this.meta || this.closing) return;
    const attachment = socket.deserializeAttachment() as Attachment | null;
    this.leaving = socket;
    try {
      if (attachment?.role === "host" && this.socketsOf("host").length === 0) {
        this.meta.hostLeftAt = Date.now();
        await this.ctx.storage.setAlarm(Date.now() + ROOM_TIMING.hostGraceMs);
      }
      this.touchLobby();
    } finally {
      this.leaving = null;
    }
    if (this.socketsOf().length === 0) await this.flushUsage();
  }

  private relayFrame(player: Player, frame: Uint8Array): void {
    if (!this.relayAllowed || frame.byteLength !== INPUT_FRAME_BYTES || !decodeInputFrame(frame)) return;
    const out = new Uint8Array(INPUT_FRAME_BYTES + 1);
    out[0] = player.slot;
    out.set(frame, 1);
    this.sendToHost(out);
  }

  private handlePlayerMessage(player: Player, message: PlayerToRoom): void {
    const meta = this.meta!;
    switch (message.t) {
      case "profile": {
        if (message.name !== undefined) player.name = sanitizeName(message.name, player.name);
        if (message.color !== undefined && isPlayerColor(message.color)) player.color = message.color;
        if (message.character !== undefined) {
          const known = meta.catalog.length === 0 || meta.catalog.some((entry) => entry.id === message.character);
          if (message.character === null || known) player.character = message.character;
        }
        this.savePlayer(player);
        this.touchLobby();
        return;
      }
      case "ready":
        player.ready = message.ready;
        this.savePlayer(player);
        this.touchLobby();
        return;
      case "transport":
        if (player.transport !== message.transport) {
          player.transport = message.transport;
          this.savePlayer(player);
          this.touchLobby();
        }
        return;
      case "signal":
        this.sendToHost({ t: "signal", from: player.id, data: message.data });
        return;
      case "to-host":
        if (this.relayAllowed) this.sendToHost({ t: "from-player", from: player.id, msg: message.msg });
        return;
      case "leave":
        for (const socket of this.socketsOf(`p:${player.id}`)) socket.close(1000, "left");
        this.deletePlayer(player.id);
        this.touchLobby();
        return;
    }
  }

  private async handleHostMessage(message: HostToRoom): Promise<void> {
    const meta = this.meta!;
    switch (message.t) {
      case "signal":
        if (this.players.has(message.to)) this.sendToPlayer(message.to, { t: "signal", from: "host", data: message.data });
        return;
      case "to-player":
        if (this.players.has(message.to)) this.sendToPlayer(message.to, { t: "from-host", msg: message.msg });
        return;
      case "kick": {
        const player = this.players.get(message.player);
        if (!player) return;
        player.kicked = true;
        this.savePlayer(player);
        this.sendToPlayer(player.id, { t: "kicked" });
        for (const socket of this.socketsOf(`p:${player.id}`)) socket.close(4003, "kicked");
        this.polls.delete(player.id);
        this.touchLobby();
        return;
      }
      case "lock":
        meta.locked = message.locked;
        this.touchLobby();
        return;
      case "phase":
        if (meta.phase === message.phase) return;
        meta.phase = message.phase;
        this.touchLobby();
        return;
      case "catalog":
        if (JSON.stringify(meta.catalog) === JSON.stringify(message.characters)) return;
        meta.catalog = [...message.characters];
        this.touchLobby();
        return;
      case "assign": {
        const player = this.players.get(message.player);
        if (!player || player.kicked || message.slot >= meta.maxPlayers || player.slot === message.slot) return;
        const other = this.activePlayers().find((entry) => entry.slot === message.slot);
        if (other) {
          other.slot = player.slot;
          this.savePlayer(other);
        }
        player.slot = message.slot;
        this.savePlayer(player);
        this.touchLobby();
        return;
      }
      case "close":
        await this.closeRoom("host-closed");
        return;
    }
  }

  // -------------------------------------------------------------------------------------
  // Lifetime
  // -------------------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const meta = this.meta;
    if (!meta) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    const hostConnected = this.socketsOf("host").length > 0;
    if (now >= meta.expiresAt) return this.closeRoom("expired");
    if (!hostConnected) {
      const limit = meta.hostEverConnected ? ROOM_TIMING.hostGraceMs : ROOM_TIMING.unclaimedMs;
      const since = meta.hostEverConnected ? meta.hostLeftAt : meta.createdAt;
      if (now - since >= limit - 1_000) return this.closeRoom(meta.hostEverConnected ? "host-left" : "expired");
      await this.ctx.storage.setAlarm(since + limit);
      return;
    }
    await this.flushUsage();
    await this.ctx.storage.setAlarm(Math.min(meta.expiresAt, now + ROOM_TIMING.checkEveryMs));
  }

  private async closeRoom(reason: CloseReason): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.broadcast({ t: "closed", reason });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(4000, reason);
      } catch {
        // Already closed.
      }
    }
    await this.flushUsage();
    this.meta = null;
    this.players.clear();
    this.polls.clear();
    // Everything the room stored goes: the join code can be handed out again.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.closing = false;
  }
}
