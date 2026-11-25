/**
 * Wire protocol shared by the game (host), the phone controller and the room Worker.
 *
 * Platform-neutral on purpose: no DOM, no Workers types. The Worker in `workers/mp/`
 * imports this file, so both ends always agree on limits and message shapes.
 *
 * Two kinds of traffic:
 *  - JSON control messages (lobby, signalling, reliable actions), validated on every hop;
 *  - a fixed 10-byte binary input frame for the analog stick, sent unreliably over the
 *    WebRTC movement channel or, as a fallback, relayed by the room over WebSocket.
 */

export const PROTOCOL_VERSION = 2;
/** Sent as the first WebSocket subprotocol; the room echoes it back. */
export const WS_SUBPROTOCOL = "bb-mp-v1";
/** Second subprotocol: `auth.<token>`. Keeps tokens out of URLs (and so out of logs). */
export const WS_AUTH_PREFIX = "auth.";

/** Unambiguous for people reading it off a TV: no 0/O, 1/I/L, 2/Z, 5/S, 8/B. */
export const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679";
export const CODE_LENGTH = 6;
export const MAX_PLAYERS_LIMIT = 8;
export const DEFAULT_MAX_PLAYERS = 4;
/** Largest JSON control message accepted anywhere, in bytes (UTF-16 length is checked). */
export const MAX_CONTROL_BYTES = 2_048;
/** SDP can be larger than any other control message. */
export const MAX_SIGNAL_BYTES = 12_000;
export const MAX_NAME_LENGTH = 16;
export const INPUT_FRAME_BYTES = 10;

export const isRoomCode = (value: unknown): value is string =>
  typeof value === "string" && value.length === CODE_LENGTH &&
  [...value].every((char) => CODE_ALPHABET.includes(char));

/** Upper-cases and strips what people type around a code (spaces, dashes). */
export const normalizeRoomCode = (value: string): string =>
  value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);

/** Tokens are 32 random bytes, base64url: 43 characters. */
export const isToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);

export const isPlayerId = (value: unknown): value is string =>
  typeof value === "string" && /^p[A-Za-z0-9_-]{10}$/.test(value);

/** Names are shown on the TV: printable, trimmed, short. */
export const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  // Control characters and bidi overrides would let a name mangle the lobby list.
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
};

export const PLAYER_COLORS = ["#4FD96B", "#4A9DFF", "#FF5A5F", "#FFC93C", "#B69CFF", "#FF9F5A", "#5AF0C0", "#F2F2F2"] as const;
export const isPlayerColor = (value: unknown): value is string =>
  typeof value === "string" && (PLAYER_COLORS as readonly string[]).includes(value);

// ---------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------

/**
 * Phone buttons. The host maps the first seven to game actions (see `PHONE_BUTTON_ACTIONS`);
 * the D-pad and `back` drive the menus (see `src/ui/menuInput.ts`). New buttons go at the
 * end: the order is the bit order of the frame's button mask.
 */
export const BUTTONS = ["grab", "use", "dash", "emote", "run", "recipes", "pause", "up", "down", "left", "right", "back"] as const;
export type PhoneButton = (typeof BUTTONS)[number];
export const buttonBit = (button: PhoneButton): number => 1 << BUTTONS.indexOf(button);
export const isButton = (value: unknown): value is PhoneButton =>
  typeof value === "string" && (BUTTONS as readonly string[]).includes(value);
export const ALL_BUTTONS_MASK = (1 << BUTTONS.length) - 1;

// ---------------------------------------------------------------------------------------
// Binary input frame (movement channel and WebSocket relay)
// ---------------------------------------------------------------------------------------
//
//  0      u8   frame type (FRAME_INPUT)
//  1      u8   flags (bit 0: phone in background → neutral)
//  2..3   u16  sequence, wraps
//  4      i8   stick x, -127..127 (right positive)
//  5      i8   stick y, -127..127 (down/back positive, as the keyboard vector)
//  6..7   u16  held buttons bitmask (BUTTONS order)
//  8..9   u16  sender clock, milliseconds mod 65536 (age estimate / diagnostics)

export const FRAME_INPUT = 1;
export const FLAG_BACKGROUND = 1;

export interface InputFrame {
  seq: number;
  x: number;
  y: number;
  buttons: number;
  flags: number;
  clock: number;
}

const clampAxis = (value: number): number =>
  Math.max(-127, Math.min(127, Math.round((Number.isFinite(value) ? value : 0) * 127)));

export const encodeInputFrame = (frame: Readonly<InputFrame>, out = new Uint8Array(INPUT_FRAME_BYTES)): Uint8Array => {
  const view = new DataView(out.buffer, out.byteOffset, INPUT_FRAME_BYTES);
  view.setUint8(0, FRAME_INPUT);
  view.setUint8(1, frame.flags & 0xff);
  view.setUint16(2, frame.seq & 0xffff);
  view.setInt8(4, clampAxis(frame.x));
  view.setInt8(5, clampAxis(frame.y));
  view.setUint16(6, frame.buttons & ALL_BUTTONS_MASK);
  view.setUint16(8, frame.clock & 0xffff);
  return out;
};

/** Returns null for anything that is not exactly a well-formed input frame. */
export const decodeInputFrame = (bytes: ArrayBuffer | Uint8Array, offset = 0): InputFrame | null => {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (array.byteLength - offset !== INPUT_FRAME_BYTES) return null;
  const view = new DataView(array.buffer, array.byteOffset + offset, INPUT_FRAME_BYTES);
  if (view.getUint8(0) !== FRAME_INPUT) return null;
  const buttons = view.getUint16(6);
  if (buttons & ~ALL_BUTTONS_MASK) return null;
  return {
    flags: view.getUint8(1),
    seq: view.getUint16(2),
    x: Math.max(-1, view.getInt8(4) / 127),
    y: Math.max(-1, view.getInt8(5) / 127),
    buttons,
    clock: view.getUint16(8),
  };
};

/** True when `seq` comes after `last` on a 16-bit wrapping counter. */
export const seqNewer = (seq: number, last: number): boolean => {
  const diff = (seq - last) & 0xffff;
  return diff !== 0 && diff < 0x8000;
};

// ---------------------------------------------------------------------------------------
// JSON control messages
// ---------------------------------------------------------------------------------------

export type TransportKind = "direct" | "stun" | "turn" | "websocket" | "https" | "none";

export interface LobbyPlayer {
  readonly id: string;
  readonly slot: number;
  readonly name: string;
  readonly color: string;
  readonly character: string | null;
  readonly ready: boolean;
  readonly connected: boolean;
  readonly transport: TransportKind;
}

export interface LobbySnapshot {
  readonly version: number;
  readonly code: string;
  readonly maxPlayers: number;
  readonly locked: boolean;
  readonly phase: RoomPhase;
  readonly hostConnected: boolean;
  readonly players: readonly LobbyPlayer[];
  readonly characters: readonly { readonly id: string; readonly name: string }[];
}

export type RoomPhase = "lobby" | "playing" | "paused" | "results";
export const ROOM_PHASES: readonly RoomPhase[] = ["lobby", "playing", "paused", "results"];

/** WebRTC signalling payload, relayed untouched between one phone and the host. */
export type SignalData =
  | { readonly kind: "description"; readonly type: "offer" | "answer"; readonly sdp: string }
  | { readonly kind: "candidate"; readonly candidate: string; readonly sdpMid: string | null; readonly sdpMLineIndex: number | null }
  | { readonly kind: "end-of-candidates" }
  /** The phone dropped its connection and starts a new one: the host drops its side too. */
  | { readonly kind: "reset" };

/** Phone → room (WebSocket or HTTPS). */
export type PlayerToRoom =
  | { readonly t: "profile"; readonly name?: string; readonly color?: string; readonly character?: string | null }
  | { readonly t: "ready"; readonly ready: boolean }
  | { readonly t: "signal"; readonly data: SignalData }
  | { readonly t: "transport"; readonly transport: TransportKind }
  | { readonly t: "leave" }
  | { readonly t: "to-host"; readonly msg: PhoneToHost };

/** Host → room. */
export type HostToRoom =
  | { readonly t: "signal"; readonly to: string; readonly data: SignalData }
  | { readonly t: "kick"; readonly player: string }
  | { readonly t: "lock"; readonly locked: boolean }
  | { readonly t: "phase"; readonly phase: RoomPhase }
  | { readonly t: "catalog"; readonly characters: readonly { readonly id: string; readonly name: string }[] }
  | { readonly t: "assign"; readonly player: string; readonly slot: number }
  | { readonly t: "to-player"; readonly to: string; readonly msg: HostToPhone }
  | { readonly t: "close" };

/** Room → phone and room → host. */
export type RoomToClient =
  | { readonly t: "welcome"; readonly role: "host" | "player"; readonly you?: string; readonly relay: boolean }
  | { readonly t: "lobby"; readonly lobby: LobbySnapshot }
  | { readonly t: "signal"; readonly from: string; readonly data: SignalData }
  | { readonly t: "from-player"; readonly from: string; readonly msg: PhoneToHost }
  | { readonly t: "from-host"; readonly msg: HostToPhone }
  | { readonly t: "relay"; readonly allowed: boolean }
  | { readonly t: "kicked" }
  | { readonly t: "closed"; readonly reason: CloseReason }
  | { readonly t: "error"; readonly code: string };

export type CloseReason = "host-left" | "host-closed" | "expired" | "quota";

/**
 * Phone → host, end to end: over the reliable data channel, or through the room when
 * there is no data channel. The host never trusts these beyond what validation allows.
 */
export type PhoneToHost =
  | { readonly t: "btn"; readonly b: PhoneButton; readonly down: boolean; readonly seq: number }
  | { readonly t: "release-all"; readonly seq: number }
  | { readonly t: "ping"; readonly id: number; readonly ts: number }
  | { readonly t: "stats"; readonly rtt: number; readonly jitter: number; readonly rate: number; readonly transport: TransportKind }
  | { readonly t: "form-submit"; readonly id: number; readonly username: string; readonly password: string }
  | { readonly t: "form-cancel"; readonly id: number }
  /** Switches the TV's form between signing in and creating an account. */
  | { readonly t: "form-mode"; readonly id: number; readonly mode: AccountFormMode };

/**
 * The account form typed on player 1's phone while the TV shows the sign-in dialog. `id`
 * changes with every form the TV opens, so an answer to an old one is ignored; `error` is
 * the account API's code for the last attempt (the phone words it).
 *
 * The password only ever travels phone → host, end to end (the data channel is DTLS, the
 * room is WSS/HTTPS); the room server relays it like any other message and keeps nothing.
 */
export type AccountFormMode = "login" | "register";
export interface AccountForm {
  readonly id: number;
  readonly mode: AccountFormMode;
  readonly error?: string;
  readonly busy?: boolean;
}
export const FORM_USERNAME_MAX = 20;
export const FORM_PASSWORD_MAX = 128;

/** Host → phone, end to end. */
export type HostToPhone =
  | { readonly t: "pong"; readonly id: number; readonly ts: number; readonly loss: number }
  | { readonly t: "cook"; readonly slot: number | null; readonly color: string; readonly label: string }
  | { readonly t: "phase"; readonly phase: RoomPhase }
  | { readonly t: "buzz"; readonly ms: number }
  | { readonly t: "ui"; readonly layout: PadLayout; readonly leader: boolean }
  /** `form: null` closes the phone's form. */
  | { readonly t: "form"; readonly form: AccountForm | null };

/**
 * What the phone's pad shows, decided by the host for each phone:
 * - "game": analog stick, the cook's buttons;
 * - "menu": D-pad, A confirm / B back (only the leader, player 1, gets it);
 * - "select": D-pad for this player's own cursor (character selection, every player);
 * - "wait": nothing to press; someone else (player 1) has the controls.
 */
export type PadLayout = "game" | "menu" | "select" | "wait";
export const PAD_LAYOUTS: readonly PadLayout[] = ["game", "menu", "select", "wait"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const isFiniteNumber = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const TRANSPORTS: readonly TransportKind[] = ["direct", "stun", "turn", "websocket", "https", "none"];
export const isTransport = (value: unknown): value is TransportKind =>
  typeof value === "string" && (TRANSPORTS as readonly string[]).includes(value);
const isCharacterId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9_-]{1,40}$/i.test(value);

export const parseSignal = (value: unknown): SignalData | null => {
  if (!isObject(value)) return null;
  if (value.kind === "description") {
    if ((value.type !== "offer" && value.type !== "answer") || typeof value.sdp !== "string") return null;
    if (value.sdp.length > MAX_SIGNAL_BYTES - 200) return null;
    return { kind: "description", type: value.type, sdp: value.sdp };
  }
  if (value.kind === "candidate") {
    if (typeof value.candidate !== "string" || value.candidate.length > 600) return null;
    const sdpMid = value.sdpMid === null || (typeof value.sdpMid === "string" && value.sdpMid.length <= 32) ? value.sdpMid as string | null : undefined;
    const index = value.sdpMLineIndex === null || isInt(value.sdpMLineIndex, 0, 16) ? value.sdpMLineIndex as number | null : undefined;
    if (sdpMid === undefined || index === undefined) return null;
    return { kind: "candidate", candidate: value.candidate, sdpMid, sdpMLineIndex: index };
  }
  if (value.kind === "end-of-candidates") return { kind: "end-of-candidates" };
  if (value.kind === "reset") return { kind: "reset" };
  return null;
};

export const parsePhoneToHost = (value: unknown): PhoneToHost | null => {
  if (!isObject(value)) return null;
  switch (value.t) {
    case "btn":
      return isButton(value.b) && typeof value.down === "boolean" && isInt(value.seq, 0, 0xffff)
        ? { t: "btn", b: value.b, down: value.down, seq: value.seq } : null;
    case "release-all":
      return isInt(value.seq, 0, 0xffff) ? { t: "release-all", seq: value.seq } : null;
    case "ping":
      return isInt(value.id, 0, 0xffffff) && isFiniteNumber(value.ts, 0, 1e13) ? { t: "ping", id: value.id, ts: value.ts } : null;
    case "stats":
      return isFiniteNumber(value.rtt, 0, 60_000) && isFiniteNumber(value.jitter, 0, 60_000) &&
        isFiniteNumber(value.rate, 0, 120) && isTransport(value.transport)
        ? { t: "stats", rtt: value.rtt, jitter: value.jitter, rate: value.rate, transport: value.transport } : null;
    case "form-submit":
      return isInt(value.id, 0, 0xffffff) && typeof value.username === "string" && value.username.length <= FORM_USERNAME_MAX &&
        typeof value.password === "string" && value.password.length <= FORM_PASSWORD_MAX
        ? { t: "form-submit", id: value.id, username: value.username, password: value.password } : null;
    case "form-cancel":
      return isInt(value.id, 0, 0xffffff) ? { t: "form-cancel", id: value.id } : null;
    case "form-mode":
      return isInt(value.id, 0, 0xffffff) && (value.mode === "login" || value.mode === "register")
        ? { t: "form-mode", id: value.id, mode: value.mode } : null;
    default:
      return null;
  }
};

const parseAccountForm = (value: unknown): AccountForm | null | undefined => {
  if (value === null) return null;
  if (!isObject(value) || !isInt(value.id, 0, 0xffffff) || (value.mode !== "login" && value.mode !== "register")) return undefined;
  if (value.error !== undefined && !(typeof value.error === "string" && /^[a-z-]{1,32}$/.test(value.error))) return undefined;
  if (value.busy !== undefined && typeof value.busy !== "boolean") return undefined;
  return {
    id: value.id,
    mode: value.mode,
    ...(value.error === undefined ? {} : { error: value.error }),
    ...(value.busy === undefined ? {} : { busy: value.busy }),
  };
};

export const parseHostToPhone = (value: unknown): HostToPhone | null => {
  if (!isObject(value)) return null;
  switch (value.t) {
    case "pong":
      return isInt(value.id, 0, 0xffffff) && isFiniteNumber(value.ts, 0, 1e13) && isFiniteNumber(value.loss, 0, 1)
        ? { t: "pong", id: value.id, ts: value.ts, loss: value.loss } : null;
    case "cook":
      return (value.slot === null || isInt(value.slot, 0, MAX_PLAYERS_LIMIT - 1)) && typeof value.color === "string" &&
        /^#[0-9a-f]{6}$/i.test(value.color) && typeof value.label === "string" && value.label.length <= 8
        ? { t: "cook", slot: value.slot as number | null, color: value.color, label: value.label } : null;
    case "phase":
      return (ROOM_PHASES as readonly unknown[]).includes(value.phase) ? { t: "phase", phase: value.phase as RoomPhase } : null;
    case "buzz":
      return isInt(value.ms, 1, 400) ? { t: "buzz", ms: value.ms } : null;
    case "ui":
      return (PAD_LAYOUTS as readonly unknown[]).includes(value.layout) && typeof value.leader === "boolean"
        ? { t: "ui", layout: value.layout as PadLayout, leader: value.leader } : null;
    case "form": {
      const form = parseAccountForm(value.form);
      return form === undefined ? null : { t: "form", form };
    }
    default:
      return null;
  }
};

export const parsePlayerToRoom = (value: unknown): PlayerToRoom | null => {
  if (!isObject(value)) return null;
  switch (value.t) {
    case "profile": {
      const out: { t: "profile"; name?: string; color?: string; character?: string | null } = { t: "profile" };
      if (value.name !== undefined) {
        if (typeof value.name !== "string") return null;
        out.name = value.name;
      }
      if (value.color !== undefined) {
        if (!isPlayerColor(value.color)) return null;
        out.color = value.color;
      }
      if (value.character !== undefined) {
        if (value.character !== null && !isCharacterId(value.character)) return null;
        out.character = value.character;
      }
      return out;
    }
    case "ready":
      return typeof value.ready === "boolean" ? { t: "ready", ready: value.ready } : null;
    case "signal": {
      const data = parseSignal(value.data);
      return data ? { t: "signal", data } : null;
    }
    case "transport":
      return isTransport(value.transport) ? { t: "transport", transport: value.transport } : null;
    case "leave":
      return { t: "leave" };
    case "to-host": {
      const msg = parsePhoneToHost(value.msg);
      return msg ? { t: "to-host", msg } : null;
    }
    default:
      return null;
  }
};

export const parseHostToRoom = (value: unknown): HostToRoom | null => {
  if (!isObject(value)) return null;
  switch (value.t) {
    case "signal": {
      const data = parseSignal(value.data);
      return data && isPlayerId(value.to) ? { t: "signal", to: value.to, data } : null;
    }
    case "kick":
      return isPlayerId(value.player) ? { t: "kick", player: value.player } : null;
    case "lock":
      return typeof value.locked === "boolean" ? { t: "lock", locked: value.locked } : null;
    case "phase":
      return (ROOM_PHASES as readonly unknown[]).includes(value.phase) ? { t: "phase", phase: value.phase as RoomPhase } : null;
    case "catalog": {
      if (!Array.isArray(value.characters) || value.characters.length > 32) return null;
      const characters: { id: string; name: string }[] = [];
      for (const entry of value.characters) {
        if (!isObject(entry) || !isCharacterId(entry.id) || typeof entry.name !== "string") return null;
        characters.push({ id: entry.id, name: sanitizeName(entry.name, entry.id).slice(0, 24) });
      }
      return { t: "catalog", characters };
    }
    case "assign":
      return isPlayerId(value.player) && isInt(value.slot, 0, MAX_PLAYERS_LIMIT - 1)
        ? { t: "assign", player: value.player, slot: value.slot } : null;
    case "to-player": {
      const msg = parseHostToPhone(value.msg);
      return msg && isPlayerId(value.to) ? { t: "to-player", to: value.to, msg } : null;
    }
    case "close":
      return { t: "close" };
    default:
      return null;
  }
};

/** Parses JSON within a size limit; never throws. */
export const safeJson = (text: unknown, limit = MAX_CONTROL_BYTES): unknown => {
  if (typeof text !== "string" || text.length > limit) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

// ---------------------------------------------------------------------------------------
// HTTP API shapes
// ---------------------------------------------------------------------------------------

export interface IceServerConfig {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

/** What the server tells clients about the transports it will allow. */
export interface TransportPolicy {
  readonly mode: "STRICT_FREE_MODE" | "TURN_FREE_TIER";
  readonly iceServers: readonly IceServerConfig[];
  /** TURN credentials can be requested from `/turn` (only in TURN_FREE_TIER mode). */
  readonly turnAvailable: boolean;
  /** The WebSocket relay may carry input when WebRTC fails. */
  readonly relayAllowed: boolean;
  /** HTTPS polling may be used when WebSocket is blocked too. */
  readonly httpsAllowed: boolean;
  readonly httpsMinIntervalMs: number;
}

export interface CreateRoomResponse {
  readonly code: string;
  readonly hostToken: string;
  readonly maxPlayers: number;
  readonly expiresAt: number;
  readonly policy: TransportPolicy;
}

export interface JoinRoomResponse {
  readonly playerId: string;
  readonly playerToken: string;
  readonly slot: number;
  readonly resumed: boolean;
  readonly policy: TransportPolicy;
}

export interface PollResponse {
  readonly messages: readonly RoomToClient[];
  readonly nextPollMs: number;
}

/** Errors the API returns as `{ error: <code> }`, mapped to texts by the clients. */
export type ApiErrorCode =
  | "not-found" | "full" | "locked" | "kicked" | "rate-limited" | "quota" | "bad-request"
  | "forbidden-origin" | "unauthorized" | "not-configured" | "turn-disabled" | "closed";
