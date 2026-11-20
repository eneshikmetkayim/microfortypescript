/**
 * SipStack — the user-agent MicroSIP builds on pjsua.
 *
 * Owns one account, one transport, registration, the call table and the
 * inbound request dispatch (INVITE/BYE/CANCEL/INFO/REFER/MESSAGE/OPTIONS).
 */

import { Emitter } from "../util/emitter.ts";
import { systemTimers, type Timers } from "../util/clock.ts";
import { buildResponse, parseMessage, SipMessage } from "./message.ts";
import { TransactionLayer } from "./transaction.ts";
import type { RemoteTarget, SipTransport } from "./transport.ts";
import {
  buildAor,
  buildContact,
  Registration,
  type AccountConfig,
  type RegistrationSnapshot,
} from "./registration.ts";
import {
  Call,
  SdpOnlyMediaSession,
  type CallSnapshot,
  type MediaSession,
} from "./call.ts";
import { parseSipUri, type SipUri } from "./uri.ts";
import { USER_AGENT } from "../core/version.ts";

export interface SipStackEvents {
  incomingCall: Call;
  callState: CallSnapshot;
  registration: RegistrationSnapshot;
  message: { from: string; contentType: string; body: string };
  error: Error;
}

export interface SipStackConfig {
  account: AccountConfig;
  transport: SipTransport;
  /** Advertised host[:port] for Contact/REGISTER. */
  localAddress?: string;
  mediaAddress?: string;
  mediaPort?: number;
  mediaFactory?: (account: AccountConfig) => MediaSession;
  timers?: Timers;
  resolveTarget?: (uri: SipUri) => RemoteTarget;
  userAgent?: string;
  /** Answer immediately (MicroSIP autoAnswer). */
  autoAnswer?: boolean;
  maxConcurrentCalls?: number;
  /** OPTIONS keep-alive interval in seconds; 0 disables it. */
  keepAlive?: number;
}

const ALLOW =
  "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, REFER, NOTIFY, MESSAGE, UPDATE";

export class SipStack {
  readonly events = new Emitter<SipStackEvents>();
  readonly transactions: TransactionLayer;
  readonly registration: Registration;
  readonly account: AccountConfig;
  private readonly transport: SipTransport;
  private readonly timers: Timers;
  private readonly config: SipStackConfig;
  private readonly calls = new Map<string, Call>();
  private readonly finished: Call[] = [];
  private readonly mediaSessions = new Map<string, MediaSession>();
  private keepAliveTimer: number | undefined;
  private started = false;

  constructor(config: SipStackConfig) {
    this.config = config;
    this.account = config.account;
    this.transport = config.transport;
    this.timers = config.timers ?? systemTimers;

    const localAddress = config.localAddress ?? config.transport.localAddress ?? "127.0.0.1:5060";
    const aor = buildAor(config.account);
    const contact = buildContact(
      config.account.username,
      localAddress,
      config.account.transport,
    );

    this.transactions = new TransactionLayer(config.transport, {
      timers: this.timers,
    });
    this.registration = new Registration({
      transactions: this.transactions,
      account: config.account,
      aor,
      contact,
      timers: this.timers,
      userAgent: config.userAgent ?? USER_AGENT,
    });

    this.registration.events.on("state", (snapshot) => this.events.emit("registration", snapshot));
    // The handler is installed eagerly so calls placed before start() still
    // receive their responses.
    this.transport.setHandler(({ raw }) => this.onRaw(raw));
  }

  get aor(): string {
    return buildAor(this.account);
  }

  get contact(): string {
    const localAddress = this.config.localAddress ?? this.transport.localAddress ?? "127.0.0.1:5060";
    return buildContact(this.account.username, localAddress, this.account.transport);
  }

  get activeCalls(): Call[] {
    return [...this.calls.values()].filter((call) => call.isActive);
  }

  get history(): CallSnapshot[] {
    return [...this.finished.map((call) => call.snapshot), ...[...this.calls.values()].map((c) => c.snapshot)];
  }

  async start(options: { register?: boolean } = {}): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.transport instanceof Object && "start" in this.transport) {
      await (this.transport as unknown as { start(): Promise<void> }).start();
    }
    if (options.register !== false) {
      await this.registration.register();
    }
    const keepAlive = this.config.keepAlive ?? this.account.keepAlive ?? 0;
    if (keepAlive > 0) this.startKeepAlive(keepAlive);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.keepAliveTimer !== undefined) {
      this.timers.clearTimeout(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    for (const call of [...this.calls.values()]) {
      call.finish("Stack stopped", 0);
    }
    await this.registration.unregister();
    this.registration.stop();
    this.transactions.close();
    await this.transport.close();
  }

  private onRaw(raw: string): void {
    let message: SipMessage;
    try {
      message = parseMessage(raw);
    } catch (error) {
      this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (message.startLine.kind === "response") {
      this.transactions.handle(message);
      return;
    }
    try {
      this.onRequest(message);
    } catch (error) {
      this.events.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onRequest(request: SipMessage): void {
    const method = request.method ?? "";
    const hasToTag = Boolean(request.toTag);

    switch (method) {
      case "INVITE": {
        if (hasToTag) {
          const call = this.findCall(request);
          if (call) call.handleReinvite(request);
          else this.reply(request, 481);
          return;
        }
        const existing = this.findCall(request);
        if (existing) {
          existing.retransmitLastResponse();
          return;
        }
        if (this.calls.size >= (this.config.maxConcurrentCalls ?? 8)) {
          this.reply(request, 486);
          return;
        }
        const call = Call.incoming(this.callDeps(), request);
        this.calls.set(call.callId, call);
        this.wireCall(call);
        call.startRinging();
        this.events.emit("incomingCall", call);
        if (this.config.autoAnswer) {
          void call.answer().catch(() => undefined);
        }
        return;
      }
      case "ACK": {
        this.findCall(request)?.handleAck();
        return;
      }
      case "BYE": {
        const call = this.findCall(request);
        if (call) call.handleBye(request);
        else this.reply(request, 481);
        return;
      }
      case "CANCEL": {
        const call = this.findCall(request);
        if (call) call.handleCancel(request);
        else this.reply(request, 481);
        return;
      }
      case "INFO": {
        const call = this.findCall(request);
        if (call) call.handleInfo(request);
        else this.reply(request, 481);
        return;
      }
      case "REFER": {
        const call = this.findCall(request);
        if (call) call.handleRefer(request);
        else this.reply(request, 481);
        return;
      }
      case "MESSAGE": {
        const call = this.findCall(request);
        if (call) {
          call.handleMessage(request);
        } else {
          this.events.emit("message", {
            from: request.header("from") ?? "",
            contentType: request.header("content-type") ?? "text/plain",
            body: request.body,
          });
          this.reply(request, 200);
        }
        return;
      }
      case "OPTIONS": {
        this.reply(request, 200, [["Allow", ALLOW]]);
        return;
      }
      case "NOTIFY": {
        this.reply(request, 200);
        return;
      }
      case "REGISTER": {
        // We are not a registrar.
        this.reply(request, 405);
        return;
      }
      default:
        this.reply(request, 501);
    }
  }

  private reply(request: SipMessage, status: number, extra: Array<[string, string]> = []): void {
    const from = request.header("via");
    if (!from) return;
    const sentBy = /SIP\/2\.0\/\S+\s+([^;\s]+)/.exec(from)?.[1] ?? "";
    const [host, port] = sentBy.split(":");
    const target: RemoteTarget = { host: host as string, port: Number(port ?? 5060) };
    const response = buildResponse(request, status, {
      toTag: request.toTag ?? randomTag(),
      extraHeaders: extra,
    });
    void Promise.resolve(this.transport.send(response.toString(), target)).catch((error: unknown) =>
      this.events.emit("error", error instanceof Error ? error : new Error(String(error))),
    );
  }

  private findCall(message: SipMessage): Call | undefined {
    if (!message.callId) return undefined;
    return this.calls.get(message.callId);
  }

  private callDeps() {
    const account = this.account;
    const media =
      this.config.mediaFactory?.(account) ??
      new SdpOnlyMediaSession({
        address: this.config.mediaAddress ?? "127.0.0.1",
        port: this.config.mediaPort ?? 4000,
        codecs: account.audioCodecs,
      });
    return {
      transactions: this.transactions,
      transport: this.transport,
      account,
      aor: this.aor,
      contact: this.contact,
      media,
      timers: this.timers,
      userAgent: this.config.userAgent ?? USER_AGENT,
      resolveTarget: (uri: SipUri) => this.resolveTarget(uri),
    };
  }

  private resolveTarget(uri: SipUri): RemoteTarget {
    if (this.config.resolveTarget) return this.config.resolveTarget(uri);
    return {
      host: uri.host,
      port:
        uri.port ??
        (this.account.transport === "tls" || this.account.transport === "wss" ? 5061 : 5060),
      transport: this.account.transport,
    };
  }

  private wireCall(call: Call): void {
    call.events.on("state", (snapshot) => {
      this.events.emit("callState", snapshot);
      if (snapshot.state === "disconnected") {
        this.calls.delete(call.callId);
        if (!this.finished.includes(call)) this.finished.unshift(call);
        if (this.finished.length > 50) this.finished.pop();
        const media = this.mediaSessions.get(call.callId);
        media?.close();
        this.mediaSessions.delete(call.callId);
      }
    });
    call.events.on("message", (message) =>
      this.events.emit("message", { from: call.remoteUri, ...message }),
    );
  }

  async dial(
    destination: string,
    options: { fromDisplayName?: string; sdpOffer?: string } = {},
  ): Promise<Call> {
    const target = destination.includes("sip:")
      ? destination
      : `sip:${destination}@${this.account.domain ?? this.account.server}`;
    const deps = this.callDeps();
    const call = await Call.outgoing(deps, target, options);
    this.calls.set(call.callId, call);
    this.mediaSessions.set(call.callId, deps.media);
    this.wireCall(call);
    return call;
  }

  async answer(callId?: string): Promise<boolean> {
    const call = callId ? this.calls.get(callId) : this.activeCalls[0];
    if (!call) return false;
    await call.answer();
    return true;
  }

  async hangup(callId?: string): Promise<boolean> {
    const call = callId ? this.calls.get(callId) : this.activeCalls[0];
    if (!call) return false;
    await call.hangup();
    return true;
  }

  async hangupAll(): Promise<void> {
    await Promise.all(this.activeCalls.map((call) => call.hangup()));
  }

  async toggleHold(callId?: string): Promise<boolean> {
    const call = callId ? this.calls.get(callId) : this.activeCalls[0];
    if (!call) return false;
    await (call.snapshot.held ? call.unhold() : call.hold());
    return true;
  }

  async sendDtmf(digits: string, callId?: string): Promise<boolean> {
    const call = callId ? this.calls.get(callId) : this.activeCalls[0];
    if (!call) return false;
    await call.sendDtmf(digits);
    return true;
  }

  async transfer(target: string, callId?: string): Promise<boolean> {
    const call = callId ? this.calls.get(callId) : this.activeCalls[0];
    if (!call) return false;
    await call.transfer(target);
    return true;
  }

  async sendMessage(to: string, body: string): Promise<void> {
    const uri = to.includes("sip:") ? to : `sip:${to}@${this.account.domain ?? this.account.server}`;
    const request = SipMessage.request("MESSAGE", uri);
    request.addHeader("Max-Forwards", "70");
    request.addHeader("To", `<${uri}>`);
    request.addHeader(
      "From",
      `<${this.aor}>;tag=${Math.random().toString(16).slice(2, 10)}`,
    );
    request.addHeader("Call-ID", `${Math.random().toString(16).slice(2)}@microfortypescript`);
    request.addHeader("CSeq", "1 MESSAGE");
    request.addHeader("Content-Type", "text/plain");
    request.addHeader("User-Agent", this.config.userAgent ?? USER_AGENT);
    request.body = body;
    await this.transactions.send(request, {
      target: this.resolveTarget(parseSipUri(uri)),
    });
  }

  private startKeepAlive(seconds: number): void {
    const tick = () => {
      this.keepAliveTimer = this.timers.setTimeout(async () => {
        if (!this.started) return;
        const account = this.account;
        const target: RemoteTarget = {
          host: account.server.replace(/:\d+$/, ""),
          port: Number(account.server.split(":")[1] ?? 5060),
        };
        const ping = SipMessage.request("OPTIONS", `sip:${account.server}`);
        ping.addHeader("Max-Forwards", "0");
        ping.addHeader("To", `<${this.aor}>`);
        ping.addHeader("From", `<${this.aor}>;tag=${randomTag()}`);
        ping.addHeader("Call-ID", `${randomTag()}@microfortypescript`);
        ping.addHeader("CSeq", "1 OPTIONS");
        ping.addHeader("User-Agent", this.config.userAgent ?? USER_AGENT);
        try {
          await this.transactions.send(ping, { target, timeoutMs: 10_000 });
        } catch {
          // Keep-alive failures are surfaced through registration state.
        }
        tick();
      }, seconds * 1000);
    };
    tick();
  }
}

function randomTag(): string {
  return Math.random().toString(16).slice(2, 10);
}

export type { Call };
