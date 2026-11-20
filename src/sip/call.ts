/**
 * Call state machine — the port of pjsua's call states as MicroSIP observes
 * them (mainDlg.cpp `onCallState`): CALLING, EARLY, CONNECTING, CONFIRMED,
 * DISCONNECTED, plus the dialog actions MicroSIP exposes (answer, hangup,
 * hold, DTMF over INFO, REFER transfer).
 *
 * Media itself is pluggable: the Windows build uses pjmedia devices, the web
 * shell uses a WebRTC session. `SdpOnlyMediaSession` keeps signalling tests
 * deterministic without opening RTP ports.
 */

import { Emitter } from "../util/emitter.ts";
import { systemTimers, type Timers } from "../util/clock.ts";
import {
  buildResponse,
  headerParam,
  isFinal,
  isProvisional,
  SipMessage,
} from "./message.ts";
import type { TransactionLayer } from "./transaction.ts";
import { newBranch, newCallId } from "./transaction.ts";
import type { RemoteTarget, SipTransport } from "./transport.ts";
import type { AccountConfig } from "./registration.ts";
import { parseNameAddr, parseSipUri, type SipUri } from "./uri.ts";
import {
  buildAudioAnswer,
  buildAudioOffer,
  codecsOf,
  audioMedia,
  mediaDirection,
  negotiateAudio,
  parseSdp,
  type NegotiatedMedia,
} from "./sdp.ts";

export type CallState = "idle" | "calling" | "early" | "connecting" | "confirmed" | "disconnected";
export type CallDirection = "in" | "out";
export type MediaDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive";

export interface MediaSession {
  readonly kind: string;
  readonly address: string;
  readonly port: number;
  createOffer(): string;
  createAnswer(offerSdp: string): string;
  setRemoteAnswer(sdp: string): void;
  setDirection(direction: MediaDirection): void;
  close(): void;
  readonly negotiated: NegotiatedMedia | null;
}

/** Signalling-only media: real SDP, no RTP socket (documented in PARITY.md). */
export class SdpOnlyMediaSession implements MediaSession {
  readonly kind = "sdp-only";
  readonly address: string;
  readonly port: number;
  private direction: MediaDirection = "sendrecv";
  private negotiation: NegotiatedMedia | null = null;
  private readonly codecs: string[];

  constructor(options: { address?: string; port?: number; codecs?: string[] } = {}) {
    this.address = options.address ?? "127.0.0.1";
    this.port = options.port ?? 4000;
    this.codecs = options.codecs ?? ["PCMA/8000/1", "PCMU/8000/1"];
  }

  get negotiated(): NegotiatedMedia | null {
    return this.negotiation;
  }

  createOffer(): string {
    return buildAudioOffer({
      address: this.address,
      port: this.port,
      codecs: this.codecs,
      direction: this.direction,
    });
  }

  createAnswer(offerSdp: string): string {
    const offer = parseSdp(offerSdp);
    this.negotiation = negotiateAudio(offer);
    return buildAudioAnswer(offer, {
      address: this.address,
      port: this.port,
      direction: this.direction,
      codecs: this.codecs,
    });
  }

  setRemoteAnswer(sdp: string): void {
    this.negotiation = negotiateAudio(parseSdp(sdp));
  }

  setDirection(direction: MediaDirection): void {
    this.direction = direction;
  }

  close(): void {
    // No media resources owned by this session.
  }
}

export interface CallSnapshot {
  id: string;
  callId: string;
  direction: CallDirection;
  state: CallState;
  remoteUri: string;
  remoteUser: string;
  remoteHost: string;
  remoteDisplayName?: string;
  localUri: string;
  startTime: number;
  connectTime?: number;
  duration: number;
  lastStatus?: number;
  reason?: string;
  held: boolean;
  muted: boolean;
  /** Codec chosen by offer/answer, e.g. PCMA. */
  codec?: string;
}

export interface CallDeps {
  transactions: TransactionLayer;
  transport: SipTransport;
  account: AccountConfig;
  aor: string;
  contact: string;
  media: MediaSession;
  timers?: Timers;
  userAgent?: string;
  resolveTarget?: (uri: SipUri) => RemoteTarget;
}

export interface CallEvents {
  state: CallSnapshot;
  dtmf: { digit: string; duration: number };
  transfer: { target: string; status: number };
  message: { contentType: string; body: string };
}

const ALLOW =
  "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, REFER, NOTIFY, MESSAGE, UPDATE";

function defaultTarget(uri: SipUri): RemoteTarget {
  return { host: uri.host, port: uri.port ?? 5060 };
}

function routeSetFrom(headers: string[]): string[] {
  const hops: string[] = [];
  for (const header of headers) {
    for (const part of header.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const match = /<([^>]+)>/.exec(trimmed);
      hops.push(match ? `<${match[1]}>` : `<${trimmed.split(";")[0]}>`);
    }
  }
  return hops;
}

export class Call {
  readonly events = new Emitter<CallEvents>();
  readonly id: string;
  readonly callId: string;
  readonly direction: CallDirection;
  state: CallState = "idle";
  private readonly deps: CallDeps;
  private readonly timers: Timers;
  private localTag: string;
  private remoteTag: string | undefined;
  readonly remoteUri: string;
  private remoteDisplayName: string | undefined;
  private localUriValue: string;
  private readonly startTime: number;
  private connectTime: number | undefined;
  private lastStatus: number | undefined;
  private reason: string | undefined;
  private held = false;
  private muted = false;
  private inviteCSeq = 1;
  private localCSeq = 1;
  private branch: string;
  private remoteTarget: RemoteTarget | undefined;
  private routeSet: string[] = [];
  private inviteRequest: SipMessage | undefined;
  private inviteResponse: SipMessage | undefined;
  private ackTimer: number | undefined;
  private pendingReinvite: SipMessage | undefined;
  private media: MediaSession;
  private stopped = false;

  private constructor(
    deps: CallDeps,
    direction: CallDirection,
    params: {
      callId: string;
      localTag: string;
      remoteUri: string;
      remoteDisplayName?: string;
      localUri: string;
      media: MediaSession;
    },
  ) {
    this.deps = deps;
    this.timers = deps.timers ?? systemTimers;
    this.direction = direction;
    this.callId = params.callId;
    this.localTag = params.localTag;
    this.remoteUri = params.remoteUri;
    this.localUriValue = params.localUri;
    this.remoteDisplayName = params.remoteDisplayName;
    this.media = params.media;
    this.id = params.callId;
    this.startTime = this.timers.now();
    this.branch = newBranch();
  }

  get snapshot(): CallSnapshot {
    const now = this.timers.now();
    const snap: CallSnapshot = {
      id: this.id,
      callId: this.callId,
      direction: this.direction,
      state: this.state,
      remoteUri: this.remoteUri,
      remoteUser: this.remoteUser,
      remoteHost: this.remoteHost,
      localUri: this.localUriValue,
      startTime: this.startTime,
      duration:
        this.connectTime !== undefined
          ? Math.max(0, Math.floor((now - this.connectTime) / 1000))
          : 0,
      held: this.held,
      muted: this.muted,
    };
    if (this.remoteDisplayName) snap.remoteDisplayName = this.remoteDisplayName;
    if (this.connectTime !== undefined) snap.connectTime = this.connectTime;
    if (this.lastStatus !== undefined) snap.lastStatus = this.lastStatus;
    if (this.reason !== undefined) snap.reason = this.reason;
    const codec = this.media.negotiated?.codecs[0]?.name;
    if (codec) snap.codec = codec;
    return snap;
  }

  get remoteUser(): string {
    try {
      return parseSipUri(this.remoteUri).user ?? this.remoteUri;
    } catch {
      return this.remoteUri;
    }
  }

  get remoteHost(): string {
    try {
      return parseSipUri(this.remoteUri).host;
    } catch {
      return "";
    }
  }

  get isActive(): boolean {
    return this.state === "calling" || this.state === "early" || this.state === "connecting" || this.state === "confirmed";
  }

  private transition(state: CallState, reason?: string, status?: number): void {
    this.state = state;
    if (reason !== undefined) this.reason = reason;
    if (status !== undefined) this.lastStatus = status;
    this.events.emit("state", this.snapshot);
  }

  private send(message: SipMessage, target?: RemoteTarget): void {
    const destination = target ?? this.remoteTarget;
    if (!destination) return;
    void Promise.resolve(this.deps.transport.send(message.toString(), destination)).catch(() => undefined);
  }

  // ---------------------------------------------------------------- outgoing

  static async outgoing(
    deps: CallDeps,
    target: string,
    options: {
      fromDisplayName?: string;
      callId?: string;
      sdpOffer?: string;
      noMedia?: boolean;
    } = {},
  ): Promise<Call> {
    const uri = parseSipUri(target);
    const callId = options.callId ?? newCallId("microfortypescript");
    const call = new Call(deps, "out", {
      callId,
      localTag: Math.random().toString(16).slice(2, 10),
      remoteUri: target,
      localUri: deps.aor,
      media: deps.media,
    });

    call.inviteCSeq = 1;
    const request = call.buildInvite(options.sdpOffer ?? (options.noMedia ? "" : deps.media.createOffer()));
    call.inviteRequest = request;
    call.transition("calling", undefined, 0);

    const targetAddress = (deps.resolveTarget ?? defaultTarget)(uri);
    call.remoteTarget = targetAddress;

    const responsePromise = deps.transactions.send(request, {
      target: targetAddress,
      onProvisional: (response) => call.onProvisional(response),
    });

    responsePromise
      .then((response) => call.onInviteFinal(response))
      .catch((error: unknown) => {
        if (!call.stopped) {
          call.transition("disconnected", error instanceof Error ? error.message : String(error));
        }
      });

    return call;
  }

  private buildInvite(sdp: string): SipMessage {
    const request = SipMessage.request("INVITE", this.remoteUri);
    request.addHeader("Max-Forwards", "70");
    request.addHeader("To", `<${this.remoteUri}>`);
    request.addHeader("From", this.fromHeader());
    request.addHeader("Call-ID", this.callId);
    request.addHeader("CSeq", `${this.inviteCSeq} INVITE`);
    request.addHeader("Contact", `<${this.deps.contact}>`);
    request.addHeader("Allow", ALLOW);
    request.addHeader("User-Agent", this.deps.userAgent ?? "MicroSIP/3.23.5 (microfortypescript)");
    request.addHeader("Supported", "replaces, 100rel, timer");
    request.addHeader("Session-Expires", "1800;refresher=uac");
    if (sdp) {
      request.body = sdp;
      request.addHeader("Content-Type", "application/sdp");
    }
    return request;
  }

  private fromHeader(): string {
    const account = this.deps.account;
    return account.displayName
      ? `"${account.displayName}" <${this.deps.aor}>;tag=${this.localTag}`
      : `<${this.deps.aor}>;tag=${this.localTag}`;
  }

  private onProvisional(response: SipMessage): void {
    const status = response.status ?? 0;
    this.lastStatus = status;
    if (status === 180 || status === 183) {
      this.remoteTag = response.toTag ?? this.remoteTag;
      this.captureDialog(response);
      this.transition("early", undefined, status);
    } else {
      this.events.emit("state", this.snapshot);
    }
  }

  private captureDialog(response: SipMessage): void {
    const contact = response.header("contact");
    if (contact) {
      const match = /<([^>]+)>/.exec(contact);
      const raw = match ? (match[1] as string) : contact.split(";")[0];
      if (raw) {
        try {
          const uri = parseSipUri(raw);
          this.remoteTarget = {
            host: uri.host,
            port: uri.port ?? 5060,
          };
        } catch {
          // Keep the request target when Contact is unusable.
        }
      }
    }
    const recordRoute = response.headerValues("record-route");
    if (recordRoute.length) this.routeSet = routeSetFrom(recordRoute).reverse();
  }

  private onInviteFinal(response: SipMessage): void {
    if (this.stopped) return;
    const status = response.status ?? 0;
    this.lastStatus = status;

    if (status >= 200 && status < 300) {
      this.remoteTag = response.toTag ?? this.remoteTag;
      this.captureDialog(response);
      if (response.body) this.media.setRemoteAnswer(response.body);
      this.transition("connecting", undefined, status);
      this.sendAck(response);
      this.connectTime = this.timers.now();
      this.transition("confirmed", undefined, status);
      return;
    }

    // A local CANCEL keeps its reason when the resulting 487 arrives.
    this.transition("disconnected", this.reason ?? this.statusText(response), status);
  }

  private statusText(response: SipMessage): string {
    if (response.startLine.kind === "response") {
      return `${response.startLine.status} ${response.startLine.reason}`.trim();
    }
    return "call failed";
  }

  private sendAck(response: SipMessage): void {
    const ack = SipMessage.request("ACK", this.dialogRequestUri());
    for (const hop of [...this.routeSet].reverse()) ack.addHeader("Route", hop);
    ack.addHeader("Max-Forwards", "70");
    ack.addHeader("To", `${this.toHeaderValue()}`);
    ack.addHeader("From", this.fromHeader());
    ack.addHeader("Call-ID", this.callId);
    ack.addHeader("CSeq", `${this.inviteCSeq} ACK`);
    // 2xx ACK is a new transaction with a fresh branch.
    this.send(ack);
    void response;
  }

  private dialogRequestUri(): string {
    if (this.remoteTarget) {
      const user = this.remoteUser;
      return `sip:${user}@${this.remoteTarget.host}${this.remoteTarget.port ? `:${this.remoteTarget.port}` : ""}`;
    }
    return this.remoteUri;
  }

  private toHeaderValue(): string {
    return this.remoteTag ? `<${this.remoteUri}>;tag=${this.remoteTag}` : `<${this.remoteUri}>`;
  }

  private inDialogHeaders(request: SipMessage): void {
    request.addHeader("Max-Forwards", "70");
    request.addHeader("To", this.toHeaderValue());
    request.addHeader("From", this.fromHeader());
    request.addHeader("Call-ID", this.callId);
    request.addHeader("User-Agent", this.deps.userAgent ?? "MicroSIP/3.23.5 (microfortypescript)");
    for (const hop of [...this.routeSet].reverse()) request.addHeader("Route", hop);
  }

  // ----------------------------------------------------------------- actions

  async hangup(): Promise<void> {
    if (!this.isActive) return;
    // Hanging up a ringing inbound call is a decline (486), not a CANCEL.
    if (this.direction === "in" && this.state !== "confirmed") {
      this.decline(486);
      return;
    }
    if (this.state === "confirmed") {
      this.localCSeq += 1;
      const bye = SipMessage.request("BYE", this.dialogRequestUri());
      this.inDialogHeaders(bye);
      bye.addHeader("CSeq", `${this.localCSeq} BYE`);
      try {
        await this.deps.transactions.send(bye, { target: this.remoteTarget });
      } catch {
        // Treat a missing BYE response as a local hangup, like pjsua.
      }
      this.finish("Local hangup", 200);
      return;
    }

    // CANCEL the pending INVITE (same branch, CSeq number with CANCEL method).
    if (this.inviteRequest) {
      const cancel = SipMessage.request("CANCEL", this.inviteRequest.requestUri ?? this.remoteUri);
      for (const via of this.inviteRequest.headerValues("via")) cancel.addHeader("Via", via);
      cancel.addHeader("Max-Forwards", "70");
      cancel.addHeader("To", this.toHeaderValue());
      cancel.addHeader("From", this.fromHeader());
      cancel.addHeader("Call-ID", this.callId);
      cancel.addHeader("CSeq", `${this.inviteCSeq} CANCEL`);
      try {
        await this.deps.transactions.send(cancel, {
          target: this.remoteTarget,
          branch: this.branchFromInvite(),
        });
      } catch {
        // The INVITE transaction still ends through its 487 or timeout.
      }
      this.finish("Call cancelled", 487);
    }
  }

  private branchFromInvite(): string {
    return this.inviteRequest?.branch ?? this.branch;
  }

  async answer(): Promise<void> {
    if (this.direction !== "in" || this.state !== "early" || !this.inviteRequest) return;
    const answerSdp = this.inviteRequest.body
      ? this.media.createAnswer(this.inviteRequest.body)
      : this.media.createOffer();

    const ok = buildResponse(this.inviteRequest, 200, {
      toTag: this.localTag,
      contact: `<${this.deps.contact}>`,
      sdp: answerSdp,
      extraHeaders: [
        ["Allow", ALLOW],
        ["User-Agent", this.deps.userAgent ?? "MicroSIP/3.23.5 (microfortypescript)"],
      ],
    });
    this.inviteResponse = ok;
    this.captureDialog(this.inviteRequest);
    this.transition("connecting", undefined, 200);
    this.send(ok, this.remoteTarget);

    this.ackTimer = this.timers.setTimeout(() => {
      if (this.state === "connecting") this.finish("ACK not received", 408);
    }, 32_000);
  }

  decline(status = 486): void {
    if (this.direction !== "in" || !this.inviteRequest) return;
    const response = buildResponse(this.inviteRequest, status, { toTag: this.localTag });
    this.send(response);
    this.finish(status === 486 ? "Busy Here" : "Declined", status);
  }

  async hold(hold = true): Promise<void> {
    if (this.state !== "confirmed") return;
    this.held = hold;
    this.media.setDirection(hold ? "sendonly" : "sendrecv");
    await this.sendReinvite(this.media.createOffer());
  }

  async unhold(): Promise<void> {
    await this.hold(false);
  }

  private async sendReinvite(sdp: string): Promise<void> {
    this.inviteCSeq += 1;
    const request = SipMessage.request("INVITE", this.dialogRequestUri());
    this.inDialogHeaders(request);
    request.addHeader("CSeq", `${this.inviteCSeq} INVITE`);
    request.addHeader("Contact", `<${this.deps.contact}>`);
    if (sdp) {
      request.body = sdp;
      request.addHeader("Content-Type", "application/sdp");
    }
    this.pendingReinvite = request;
    try {
      const response = await this.deps.transactions.send(request, { target: this.remoteTarget });
      if ((response.status ?? 0) === 491) {
        // Request Pending: retry once after 2s, like pjsua's re-INVITE policy.
        this.timers.setTimeout(() => {
          void this.deps.transactions
            .send(request, { target: this.remoteTarget })
            .then((retry) => this.completeReinvite(retry))
            .catch(() => undefined);
        }, 2000);
        return;
      }
      this.completeReinvite(response);
    } catch {
      // Keep the previous direction when the re-INVITE fails.
    }
  }

  private completeReinvite(response: SipMessage): void {
    const status = response.status ?? 0;
    if (status >= 200 && status < 300) {
      if (response.body) this.media.setRemoteAnswer(response.body);
      this.captureDialog(response);
      this.remoteTag = response.toTag ?? this.remoteTag;
      this.sendAck(response);
    }
    this.events.emit("state", this.snapshot);
  }

  async sendDtmf(digits: string, duration = 160): Promise<void> {
    if (this.state !== "confirmed") return;
    for (const digit of digits) {
      this.localCSeq += 1;
      const info = SipMessage.request("INFO", this.dialogRequestUri());
      this.inDialogHeaders(info);
      info.addHeader("CSeq", `${this.localCSeq} INFO`);
      info.addHeader("Content-Type", "application/dtmf-relay");
      info.body = `Signal=${digit}\r\nDuration=${duration}\r\n`;
      try {
        await this.deps.transactions.send(info, { target: this.remoteTarget });
      } catch {
        // DTMF is fire-and-forget; keep dialing the remaining digits.
      }
    }
  }

  async transfer(target: string): Promise<void> {
    if (this.state !== "confirmed") return;
    this.localCSeq += 1;
    const refer = SipMessage.request("REFER", this.dialogRequestUri());
    this.inDialogHeaders(refer);
    refer.addHeader("CSeq", `${this.localCSeq} REFER`);
    refer.addHeader("Refer-To", `<${target}>`);
    refer.addHeader("Referred-By", `<${this.deps.aor}>`);
    try {
      const response = await this.deps.transactions.send(refer, { target: this.remoteTarget });
      const status = response.status ?? 0;
      this.events.emit("transfer", { target, status });
    } catch {
      this.events.emit("transfer", { target, status: 408 });
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.events.emit("state", this.snapshot);
  }

  // ---------------------------------------------------------------- incoming

  static incoming(deps: CallDeps, invite: SipMessage): Call {
    const from = invite.header("from") ?? "";
    const parsedFrom = parseNameAddr(from);
    const call = new Call(deps, "in", {
      callId: invite.callId ?? newCallId("microfortypescript"),
      localTag: Math.random().toString(16).slice(2, 10),
      remoteUri: `${parsedFrom.uri.scheme}:${parsedFrom.uri.user ?? ""}@${parsedFrom.uri.host}`,
      remoteDisplayName: parsedFrom.displayName,
      localUri: deps.aor,
      media: deps.media,
    });
    call.inviteRequest = invite;
    call.inviteCSeq = invite.cseq?.seq ?? 1;
    if (parsedFrom.displayName) call.remoteDisplayName = parsedFrom.displayName;
    call.captureDialog(invite);
    return call;
  }

  /** Send 100 Trying + 180 Ringing, then expose the call to the UI. */
  startRinging(): void {
    if (this.direction !== "in" || !this.inviteRequest) return;
    this.send(buildResponse(this.inviteRequest, 100, { toTag: this.localTag }), this.remoteTarget);
    const ringing = buildResponse(this.inviteRequest, 180, {
      toTag: this.localTag,
      contact: `<${this.deps.contact}>`,
    });
    this.inviteResponse = ringing;
    this.transition("early", "Incoming call", 180);
    this.send(ringing, this.remoteTarget);
  }

  handleAck(): void {
    if (this.direction === "in" && this.state === "connecting") {
      if (this.ackTimer !== undefined) {
        this.timers.clearTimeout(this.ackTimer);
        this.ackTimer = undefined;
      }
      this.connectTime = this.timers.now();
      this.transition("confirmed", undefined, 200);
    }
  }

  handleBye(request: SipMessage): void {
    this.send(buildResponse(request, 200, { toTag: this.localTag }), this.remoteTarget);
    this.finish("Remote hangup", 200);
  }

  handleCancel(request: SipMessage): void {
    this.send(buildResponse(request, 200, { toTag: this.localTag }), this.remoteTarget);
    if (this.inviteRequest) {
      this.send(
        buildResponse(this.inviteRequest, 487, { toTag: this.localTag }),
        this.remoteTarget,
      );
    }
    this.finish("Call cancelled", 487);
  }

  /** In-dialog re-INVITE from the remote party (hold/unhold/session refresh). */
  handleReinvite(request: SipMessage): void {
    const answerSdp = request.body ? this.media.createAnswer(request.body) : this.media.createOffer();
    const ok = buildResponse(request, 200, {
      toTag: this.localTag,
      contact: `<${this.deps.contact}>`,
      sdp: answerSdp,
    });
    this.send(ok, this.remoteTarget);
    if (request.body) {
      const offer = parseSdp(request.body);
      const audio = audioMedia(offer);
      if (audio) {
        const direction = mediaDirection(audio);
        this.held = direction === "sendonly" || direction === "inactive";
        this.events.emit("state", this.snapshot);
      }
    }
  }

  handleInfo(request: SipMessage): void {
    this.send(buildResponse(request, 200, { toTag: this.localTag }), this.remoteTarget);
    if ((request.header("content-type") ?? "").includes("application/dtmf-relay")) {
      const match = /Signal\s*=\s*(\S)/i.exec(request.body);
      const durationMatch = /Duration\s*=\s*(\d+)/i.exec(request.body);
      if (match) {
        this.events.emit("dtmf", {
          digit: match[1] as string,
          duration: durationMatch ? Number(durationMatch[1]) : 0,
        });
      }
    }
  }

  handleRefer(request: SipMessage): void {
    const referTo = request.header("refer-to") ?? "";
    this.send(buildResponse(request, 202, { toTag: this.localTag }), this.remoteTarget);
    const target = /<([^>]+)>/.exec(referTo)?.[1] ?? referTo;
    this.events.emit("transfer", { target, status: 202 });
  }

  handleMessage(request: SipMessage): void {
    this.send(buildResponse(request, 200, { toTag: this.localTag }), this.remoteTarget);
    this.events.emit("message", {
      contentType: request.header("content-type") ?? "text/plain",
      body: request.body,
    });
  }

  handleOptions(request: SipMessage): void {
    this.send(
      buildResponse(request, 200, {
        toTag: this.localTag,
        extraHeaders: [["Allow", ALLOW]],
      }),
      this.remoteTarget,
    );
  }

  /** Handle retransmitted INVITE/response for the same dialog. */
  retransmitLastResponse(): void {
    if (this.inviteResponse && this.remoteTarget) this.send(this.inviteResponse, this.remoteTarget);
  }

  finish(reason: string, status?: number): void {
    if (this.state === "disconnected") return;
    this.stopped = true;
    if (this.ackTimer !== undefined) {
      this.timers.clearTimeout(this.ackTimer);
      this.ackTimer = undefined;
    }
    this.media.close();
    this.transition("disconnected", reason, status);
  }

  matchesDialog(message: SipMessage): boolean {
    if (message.callId !== this.callId) return false;
    const toTag = message.toTag;
    return toTag === undefined || toTag === this.localTag;
  }

  /** Number of codecs in the negotiated SDP, used by parity audits. */
  get negotiatedCodecs(): string[] {
    return this.media.negotiated?.codecs.map((c) => c.name) ?? [];
  }
}

export { codecsOf, isFinal, isProvisional, headerParam };
