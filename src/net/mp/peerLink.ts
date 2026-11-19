/**
 * One WebRTC connection between the host and one phone, with the browser's native API.
 *
 * - "Perfect negotiation" (W3C pattern): the phone is polite, the host impolite, so either
 *   side may renegotiate (ICE restarts) and glare resolves itself.
 * - Two data channels, opened by the phone:
 *     "act": reliable and ordered — buttons, menus, pause, pings;
 *     "mv":  unordered, no retransmissions — the stick; a late frame is worthless.
 * - Trickle ICE: candidates go out as they are found.
 *
 * Timeouts and the choice of fallback belong to the owner (sessions), not here.
 */
import type { IceServerConfig, SignalData, TransportKind } from "./protocol";

export type PeerState = "connecting" | "open" | "disconnected" | "failed" | "closed";

export interface PeerLinkOptions {
  readonly polite: boolean;
  readonly iceServers: readonly IceServerConfig[];
  readonly sendSignal: (data: SignalData) => void;
  readonly onState: (state: PeerState) => void;
  readonly onAction: (text: string) => void;
  readonly onMove: (bytes: ArrayBuffer) => void;
}

/** Above this, the movement channel is congested: skip frames instead of queueing them. */
export const MOVE_BUFFER_LIMIT = 1_024;
const ACTION_BUFFER_LIMIT = 64 * 1_024;

export const webRtcSupported = (): boolean =>
  typeof RTCPeerConnection === "function" && "createDataChannel" in RTCPeerConnection.prototype;

const toRtcServers = (servers: readonly IceServerConfig[]): RTCIceServer[] =>
  servers.map((server) => ({
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls as string,
    ...(server.username ? { username: server.username, credential: server.credential } : {}),
  }));

export interface PathInfo {
  readonly transport: TransportKind;
  readonly rttMs: number | null;
  readonly localType: string;
  readonly remoteType: string;
  readonly protocol: string;
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private action: RTCDataChannel | null = null;
  private move: RTCDataChannel | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private closed = false;
  private stateValue: PeerState = "connecting";

  constructor(private readonly options: PeerLinkOptions) {
    this.pc = new RTCPeerConnection({
      iceServers: toRtcServers(options.iceServers),
      // Gather a few candidates ahead: the first offer goes out faster.
      iceCandidatePoolSize: 2,
      bundlePolicy: "max-bundle",
    });
    this.pc.onicecandidate = ({ candidate }) => {
      if (this.closed) return;
      if (!candidate) {
        options.sendSignal({ kind: "end-of-candidates" });
        return;
      }
      // Port 53 candidates stall some browsers (Cloudflare's advice); none are needed.
      if (/ 53 typ /.test(candidate.candidate)) return;
      options.sendSignal({
        kind: "candidate",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    };
    this.pc.onnegotiationneeded = () => void this.negotiate();
    this.pc.onconnectionstatechange = () => this.refreshState();
    this.pc.oniceconnectionstatechange = () => this.refreshState();
    this.pc.ondatachannel = ({ channel }) => this.adopt(channel);
    if (options.polite) {
      this.adopt(this.pc.createDataChannel("act", { ordered: true }));
      this.adopt(this.pc.createDataChannel("mv", { ordered: false, maxRetransmits: 0 }));
    }
  }

  get state(): PeerState {
    return this.stateValue;
  }

  get isOpen(): boolean {
    return this.action?.readyState === "open" && this.move?.readyState === "open" && !this.closed;
  }

  get moveBuffered(): number {
    return this.move?.bufferedAmount ?? 0;
  }

  /** Sends a movement frame; false when the channel is closed or congested. */
  sendMove(bytes: Uint8Array): boolean {
    const channel = this.move;
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > MOVE_BUFFER_LIMIT) return false;
    try {
      channel.send(bytes as Uint8Array<ArrayBuffer>);
      return true;
    } catch {
      return false;
    }
  }

  sendAction(text: string): boolean {
    const channel = this.action;
    if (!channel || channel.readyState !== "open" || channel.bufferedAmount > ACTION_BUFFER_LIMIT) return false;
    try {
      channel.send(text);
      return true;
    } catch {
      return false;
    }
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (this.closed) return;
    try {
      if (data.kind === "description") {
        const collision = data.type === "offer" && (this.makingOffer || this.pc.signalingState !== "stable");
        this.ignoreOffer = !this.options.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription({ type: data.type, sdp: data.sdp });
        for (const candidate of this.pendingCandidates.splice(0)) await this.pc.addIceCandidate(candidate).catch(() => undefined);
        if (data.type === "offer") {
          await this.pc.setLocalDescription();
          const local = this.pc.localDescription;
          if (local) this.options.sendSignal({ kind: "description", type: local.type as "answer", sdp: local.sdp });
        }
        return;
      }
      if (data.kind === "candidate") {
        const candidate = { candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex };
        if (!this.pc.remoteDescription) {
          if (this.pendingCandidates.length < 64) this.pendingCandidates.push(candidate);
          return;
        }
        await this.pc.addIceCandidate(candidate).catch((error: unknown) => {
          if (!this.ignoreOffer) throw error;
        });
        return;
      }
      if (data.kind === "end-of-candidates" && this.pc.remoteDescription) await this.pc.addIceCandidate().catch(() => undefined);
    } catch (error) {
      console.warn("[mp] signalling error", error);
    }
  }

  /** ICE restart, optionally with new servers (TURN credentials, say). */
  restart(iceServers?: readonly IceServerConfig[]): void {
    if (this.closed) return;
    if (iceServers) {
      try {
        this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers: toRtcServers(iceServers) });
      } catch (error) {
        console.warn("[mp] could not apply ICE servers", error);
      }
    }
    this.pc.restartIce();
  }

  /** Which path the connection actually uses, from the selected candidate pair. */
  async describePath(): Promise<PathInfo | null> {
    if (this.closed) return null;
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return null;
    }
    const stats = new Map<string, Record<string, unknown>>();
    report.forEach((value: Record<string, unknown>) => stats.set(String(value.id), value));
    let pair: Record<string, unknown> | undefined;
    for (const value of stats.values()) {
      if (value.type === "transport" && typeof value.selectedCandidatePairId === "string") {
        pair = stats.get(value.selectedCandidatePairId);
      }
    }
    // Firefox has no selectedCandidatePairId: the nominated, succeeded pair is the one.
    pair ??= [...stats.values()].find((value) => value.type === "candidate-pair" && value.nominated && value.state === "succeeded")
      ?? [...stats.values()].find((value) => value.type === "candidate-pair" && value.selected === true);
    if (!pair) return null;
    const local = stats.get(String(pair.localCandidateId));
    const remote = stats.get(String(pair.remoteCandidateId));
    const localType = String(local?.candidateType ?? "?");
    const remoteType = String(remote?.candidateType ?? "?");
    const transport: TransportKind = localType === "relay" || remoteType === "relay"
      ? "turn"
      : localType === "host" && remoteType === "host" ? "direct" : "stun";
    const rtt = typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1_000 : null;
    return {
      transport,
      rttMs: rtt,
      localType,
      remoteType,
      protocol: String(local?.protocol ?? local?.relayProtocol ?? "?"),
      bytesSent: Number(pair.bytesSent ?? 0),
      bytesReceived: Number(pair.bytesReceived ?? 0),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of [this.action, this.move]) {
      if (!channel) continue;
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
      try {
        channel.close();
      } catch {
        // Already closed.
      }
    }
    this.pc.onicecandidate = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.ondatachannel = null;
    this.pc.close();
    this.setState("closed");
  }

  private adopt(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    if (channel.label === "act") {
      this.action = channel;
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") this.options.onAction(event.data);
      };
    } else if (channel.label === "mv") {
      this.move = channel;
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) this.options.onMove(event.data);
      };
    } else {
      // Unknown channels are never accepted: the phone can open only these two.
      channel.close();
      return;
    }
    channel.onopen = () => this.refreshState();
    channel.onclose = () => this.refreshState();
  }

  private async negotiate(): Promise<void> {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      const local = this.pc.localDescription;
      if (local) this.options.sendSignal({ kind: "description", type: local.type as "offer", sdp: local.sdp });
    } catch (error) {
      console.warn("[mp] offer failed", error);
    } finally {
      this.makingOffer = false;
    }
  }

  private refreshState(): void {
    if (this.closed) return;
    const connection = this.pc.connectionState;
    const ice = this.pc.iceConnectionState;
    const next: PeerState = this.isOpen && (connection === "connected" || ice === "connected" || ice === "completed")
      ? "open"
      : connection === "failed" || ice === "failed"
        ? "failed"
        : connection === "disconnected" || ice === "disconnected" || (this.stateValue === "open" && !this.isOpen)
          ? "disconnected"
          : "connecting";
    this.setState(next);
  }

  private setState(state: PeerState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.options.onState(state);
  }
}
