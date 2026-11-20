/**
 * SIP client transactions (RFC 3261 §17.1) with timers A/B/D/E/F/K.
 *
 * pjsip provides this in the Windows build. The port keeps the same observable
 * behaviour: retransmission only on unreliable transports, 408 on timeout and
 * an automatic ACK for final non-2xx INVITE responses.
 */

import { SipMessage, buildResponse, parseMessage } from "./message.ts";
import type { RemoteTarget, SipTransport } from "./transport.ts";
import { systemTimers, type Timers } from "../util/clock.ts";

export class TransactionTimeoutError extends Error {
  readonly status = 408;
  constructor(message = "SIP transaction timeout") {
    super(message);
    this.name = "TransactionTimeoutError";
  }
}

export class TransactionError extends Error {
  readonly response?: SipMessage;
  constructor(message: string, response?: SipMessage) {
    super(message);
    this.name = "TransactionError";
    this.response = response;
  }
}

export function randomToken(bytes = 8): string {
  const data = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(data);
  return Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newBranch(): string {
  return `z9hG4bK${randomToken(10)}`;
}

export function newCallId(host = "localhost"): string {
  return `${randomToken(12)}@${host}`;
}

export interface SendOptions {
  target?: RemoteTarget;
  onProvisional?: (response: SipMessage) => void;
  /** Overrides Timer B/F. */
  timeoutMs?: number;
  /** Explicit branch, used by CANCEL to match its INVITE. */
  branch?: string;
}

export interface TransactionLayerOptions {
  timers?: Timers;
  t1?: number;
  t2?: number;
  t4?: number;
  timeout?: number;
  userAgent?: string;
}

interface Pending {
  branch: string;
  method: string;
  request: SipMessage;
  target: RemoteTarget;
  resolve: (response: SipMessage) => void;
  reject: (error: Error) => void;
  onProvisional?: (response: SipMessage) => void;
  retransmit?: number;
  timeout?: number;
  interval: number;
  done: boolean;
}

export class TransactionLayer {
  private readonly transport: SipTransport;
  private pending = new Map<string, Pending>();
  private readonly timers: Timers;
  private readonly t1: number;
  private readonly t2: number;
  private readonly timeout: number;
  private closed = false;

  constructor(transport: SipTransport, options: TransactionLayerOptions = {}) {
    this.transport = transport;
    this.timers = options.timers ?? systemTimers;
    this.t1 = options.t1 ?? 500;
    this.t2 = options.t2 ?? 4000;
    this.timeout = options.timeout ?? 32_000;
  }

  /** Route an already parsed inbound message; responses resolve transactions. */
  handle(message: SipMessage): boolean {
    if (message.startLine.kind !== "response") return false;
    const branch = message.branch;
    if (!branch) return false;
    const cseq = message.cseq;
    // CANCEL shares the INVITE branch but is a separate transaction.
    const candidates = [this.pending.get(branch), this.pending.get(`${branch}-cancel`)].filter(
      (entry): entry is Pending => entry !== undefined,
    );
    if (!candidates.length) return true;
    const pending =
      (cseq ? candidates.find((entry) => entry.method === cseq.method) : undefined) ??
      (candidates[0] as Pending);
    if (cseq && cseq.method !== pending.method) return true;

    if ((message.status ?? 0) < 200) {
      pending.onProvisional?.(message);
      return true;
    }

    this.finish(pending);
    if (pending.method === "INVITE" && (message.status ?? 0) >= 300) {
      this.sendAckForFailure(pending, message);
    }
    pending.resolve(message);
    return true;
  }

  async send(request: SipMessage, options: SendOptions = {}): Promise<SipMessage> {
    if (this.closed) throw new TransactionError("transaction layer is closed");
    const branch = options.branch ?? ensureVia(request, this.transport, branchFrom(request));
    const target = options.target ?? targetFrom(request, this.transport);
    if (!target) throw new TransactionError("no target for SIP request");

    const pending: Pending = {
      branch,
      method: request.method ?? "UNKNOWN",
      request,
      target,
      resolve: () => undefined,
      reject: () => undefined,
      interval: this.t1,
      done: false,
    };
    if (options.onProvisional) pending.onProvisional = options.onProvisional;

    const promise = new Promise<SipMessage>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });

    // CANCEL shares the INVITE branch and must not clobber it.
    const key = pending.method === "CANCEL" ? `${branch}-cancel` : branch;
    this.pending.set(key, pending);

    const send = () => {
      if (pending.done) return;
      void Promise.resolve(this.transport.send(request.toString(), target)).catch((error) => {
        this.finish(pending);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    };

    send();

    if (!this.transport.reliable) {
      const schedule = () => {
        if (pending.done) return;
        pending.retransmit = this.timers.setTimeout(() => {
          if (pending.done) return;
          send();
          pending.interval = Math.min(pending.interval * 2, this.t2);
          schedule();
        }, pending.interval);
      };
      schedule();
    }

    pending.timeout = this.timers.setTimeout(
      () => {
        if (pending.done) return;
        this.finish(pending);
        pending.reject(new TransactionTimeoutError(`${pending.method} timed out`));
      },
      options.timeoutMs ?? this.timeout,
    );

    return promise;
  }

  /** Stop retransmissions and waiters (used on shutdown and after CANCEL). */
  abort(branch: string, error = new TransactionError("transaction aborted")): void {
    const pending = this.pending.get(branch);
    if (!pending) return;
    this.finish(pending);
    pending.reject(error);
  }

  stopAll(error = new TransactionError("stack stopped")): void {
    for (const [key, pending] of [...this.pending]) {
      this.pending.delete(key);
      this.finish(pending);
      pending.reject(error);
    }
  }

  close(): void {
    this.closed = true;
    this.stopAll();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private finish(pending: Pending): void {
    pending.done = true;
    if (pending.retransmit !== undefined) this.timers.clearTimeout(pending.retransmit);
    if (pending.timeout !== undefined) this.timers.clearTimeout(pending.timeout);
    for (const [key, value] of [...this.pending]) if (value === pending) this.pending.delete(key);
  }

  private sendAckForFailure(pending: Pending, response: SipMessage): void {
    const request = pending.request;
    const ack = SipMessage.request("ACK", request.requestUri ?? "", [], "");
    for (const via of request.headerValues("via")) ack.addHeader("Via", via);
    for (const name of ["Max-Forwards", "From", "To", "Call-ID", "CSeq", "Route"]) {
      for (const value of request.headerValues(name)) {
        ack.addHeader(name, name === "To" ? response.header("to") ?? value : value);
      }
    }
    // ACK for non-2xx keeps the INVITE branch and CSeq number.
    const cseq = request.cseq;
    if (cseq) ack.setHeader("CSeq", `${cseq.seq} ACK`);
    const target = pending.target;
    void Promise.resolve(this.transport.send(ack.toString(), target)).catch(() => undefined);
  }
}

function branchFrom(request: SipMessage): string {
  return request.branch ?? "";
}

function ensureVia(request: SipMessage, transport: SipTransport, branch: string): string {
  const value = branch || newBranch();
  const existing = request.header("via");
  if (!existing) {
    const protocol =
      transport.kind === "udp"
        ? "UDP"
        : transport.kind === "tcp"
          ? "TCP"
          : transport.kind === "tls"
            ? "TLS"
            : transport.kind === "wss"
              ? "WSS"
              : transport.kind === "ws"
                ? "WS"
                : "UDP";
    const sentBy = transport.localAddress || "127.0.0.1:5060";
    request.addHeader("Via", `SIP/2.0/${protocol} ${sentBy};branch=${value};rport`);
  } else if (!request.branch) {
    request.setHeader("Via", `${existing};branch=${value}`);
  }
  return value;
}

function targetFrom(request: SipMessage, transport: SipTransport): RemoteTarget | undefined {
  const via = request.header("via");
  const sentBy = via ? /SIP\/2\.0\/\S+\s+([^;\s]+)/.exec(via)?.[1] : undefined;
  if (sentBy) {
    const [host, port] = sentBy.split(":");
    return { host: host as string, port: Number(port ?? 5060) };
  }
  const uri = request.requestUri;
  if (!uri) return undefined;
  try {
    const parsed = new URL(uri.replace(/^sips?:/, "http://"));
    return { host: parsed.hostname, port: Number(parsed.port || 5060) };
  } catch {
    return { host: transport.localAddress.split(":")[0] as string, port: 5060 };
  }
}

export { buildResponse, parseMessage };
