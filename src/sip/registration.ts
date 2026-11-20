/**
 * REGISTER client (RFC 3261 §10), mirroring pjsua account registration:
 * digest challenge handling, Contact binding, refresh before expiry,
 * unregister on shutdown and an observable state for the UI.
 */

import { buildAuthorization, challengeFromResponse, type DigestChallenge } from "./digest.ts";
import { SipMessage } from "./message.ts";
import type { TransactionLayer } from "./transaction.ts";
import { newCallId } from "./transaction.ts";
import { formatSipUri, parseSipUri, urlencode } from "./uri.ts";
import { Emitter } from "../util/emitter.ts";
import { systemTimers, type Timers } from "../util/clock.ts";

export type RegistrationState = "unregistered" | "registering" | "registered" | "failed";

export interface AccountConfig {
  id: number;
  label: string;
  /** Registrar/public address, e.g. `pbx.example.com` (MicroSIP `server`). */
  server: string;
  proxy?: string;
  /** SIP domain; defaults to `server` without the port. */
  domain?: string;
  username: string;
  password: string;
  authId?: string;
  displayName?: string;
  transport?: "udp" | "tcp" | "tls" | "ws" | "wss";
  registerRefresh?: number;
  keepAlive?: number;
  dialingPrefix?: string;
  dialPlan?: string;
  hideCid?: boolean;
  voicemailNumber?: string;
  audioCodecs?: string[];
  /** 0 auto (RFC 4733 when negotiated), 1 SIP INFO, 2 RFC 4733 preferred. */
  dtmfMethod?: number;
}

export interface RegistrationDeps {
  transactions: TransactionLayer;
  account: AccountConfig;
  /** Local AOR, e.g. sip:1001@pbx.example.com */
  aor: string;
  /** Contact URI placed in REGISTER, e.g. sip:1001@192.0.2.5:5060. */
  contact: string;
  timers?: Timers;
  userAgent?: string;
}

export interface RegistrationSnapshot {
  state: RegistrationState;
  expires: number;
  reason?: string;
  contact?: string;
  /** Epoch ms of the last successful 200. */
  updatedAt?: number;
}

export class Registration {
  readonly events = new Emitter<{ state: RegistrationSnapshot }>();
  private state: RegistrationState = "unregistered";
  private expires = 0;
  private reason: string | undefined;
  private contact: string | undefined;
  private updatedAt: number | undefined;
  private cseq = 0;
  private callId: string;
  private fromTag: string;
  private challenge: DigestChallenge | null = null;
  private challengeHeader: "Authorization" | "Proxy-Authorization" = "Authorization";
  private nc = 0;
  private refreshTimer: number | null = null;
  private stopped = false;
  private readonly timers: Timers;
  private readonly deps: RegistrationDeps;

  constructor(deps: RegistrationDeps) {
    this.deps = deps;
    this.timers = deps.timers ?? systemTimers;
    this.callId = newCallId("microfortypescript");
    this.fromTag = Math.random().toString(16).slice(2, 10);
  }

  get snapshot(): RegistrationSnapshot {
    const snap: RegistrationSnapshot = { state: this.state, expires: this.expires };
    if (this.reason !== undefined) snap.reason = this.reason;
    if (this.contact !== undefined) snap.contact = this.contact;
    if (this.updatedAt !== undefined) snap.updatedAt = this.updatedAt;
    return snap;
  }

  private setState(state: RegistrationState, reason?: string): void {
    this.state = state;
    this.reason = reason;
    this.events.emit("state", this.snapshot);
  }

  private registrarUri(): string {
    const server = this.deps.account.server;
    const transport = this.deps.account.transport;
    const suffix = transport && transport !== "udp" ? `;transport=${transport}` : "";
    return `sip:${server}${suffix}`;
  }

  private buildRequest(expires: number): SipMessage {
    const aor = this.deps.aor;
    const account = this.deps.account;
    this.cseq += 1;
    const message = SipMessage.request("REGISTER", this.registrarUri());
    message.addHeader("Max-Forwards", "70");
    message.addHeader("To", `<${aor}>`);
    message.addHeader(
      "From",
      account.displayName ? `"${account.displayName}" <${aor}>;tag=${this.fromTag}` : `<${aor}>;tag=${this.fromTag}`,
    );
    message.addHeader("Call-ID", this.callId);
    message.addHeader("CSeq", `${this.cseq} REGISTER`);
    message.addHeader("Contact", `<${this.deps.contact}>;expires=${expires}`);
    message.addHeader(
      "Allow",
      "INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, REFER, NOTIFY, MESSAGE, UPDATE",
    );
    message.addHeader("User-Agent", this.deps.userAgent ?? "MicroSIP/3.23.5 (microfortypescript)");
    message.addHeader("Expires", String(expires));
    return message;
  }

  async register(expires?: number): Promise<boolean> {
    if (this.stopped) return false;
    const requested = expires ?? this.deps.account.registerRefresh ?? 300;
    this.setState("registering");
    let attemptExpires = requested;

    for (let attempt = 0; attempt < 3; attempt++) {
      const request = this.buildRequest(attemptExpires);
      if (this.challenge) {
        this.nc += 1;
        const authorization = buildAuthorization(
          {
            challenge: this.challenge,
            credentials: {
              username: this.deps.account.username,
              password: this.deps.account.password,
              authId: this.deps.account.authId,
            },
            method: "REGISTER",
            uri: request.requestUri ?? this.registrarUri(),
            nc: this.nc,
          },
          this.challengeHeader,
        );
        request.addHeader(authorization.headerName, authorization.value);
      }

      let response: SipMessage;
      try {
        response = await this.deps.transactions.send(request, {
          target: this.registrarTarget(),
        });
      } catch (error) {
        this.setState("failed", error instanceof Error ? error.message : String(error));
        return false;
      }

      const status = response.status ?? 0;
      if (status === 401 || status === 407) {
        const challenge = challengeFromResponse(
          status,
          response.header("www-authenticate"),
          response.header("proxy-authenticate"),
        );
        if (!challenge) {
          this.setState("failed", `HTTP ${status} without digest challenge`);
          return false;
        }
        this.challenge = challenge.challenge;
        this.challengeHeader = challenge.headerName;
        this.nc = 0;
        continue;
      }

      if (status === 423) {
        // Interval Too Brief: retry with the Min-Expires the registrar requires.
        const minExpires = Number(response.header("min-expires") ?? "0");
        if (minExpires > 0 && minExpires !== attemptExpires) {
          attemptExpires = minExpires;
          continue;
        }
      }

      if (status >= 200 && status < 300) {
        this.expires = expiresFromResponse(response, attemptExpires);
        this.contact = response.header("contact");
        this.updatedAt = this.timers.now();
        this.setState("registered");
        this.scheduleRefresh();
        return true;
      }

      const reason =
        response.startLine.kind === "response"
          ? `${response.startLine.status} ${response.startLine.reason}`.trim()
          : `HTTP ${status}`;
      this.setState("failed", reason);
      return false;
    }

    this.setState("failed", "authentication retry limit reached");
    return false;
  }

  async unregister(): Promise<void> {
    this.clearRefresh();
    if (this.state !== "registered" && this.state !== "failed") {
      this.setState("unregistered");
      return;
    }
    try {
      await this.deps.transactions.send(this.buildRequest(0), { target: this.registrarTarget() });
    } catch {
      // Unregister is best effort; local state still clears.
    }
    this.setState("unregistered");
  }

  stop(): void {
    this.stopped = true;
    this.clearRefresh();
  }

  private registrarTarget(): { host: string; port: number } {
    const address = this.deps.account.proxy || this.deps.account.server;
    const parsed = parseSipUri(`sip:${address}`);
    return {
      host: parsed.host || this.deps.account.server,
      port:
        parsed.port ??
        (this.deps.account.transport === "tls" || this.deps.account.transport === "wss" ? 5061 : 5060),
    };
  }

  private scheduleRefresh(): void {
    this.clearRefresh();
    const lifetime = this.expires > 0 ? this.expires : 300;
    // Refresh at 90% of the granted lifetime, like pjsua's default policy.
    const delay = Math.max(10, Math.floor(lifetime * 0.9)) * 1000;
    this.refreshTimer = this.timers.setTimeout(() => {
      if (this.stopped) return;
      void this.register(lifetime);
    }, delay);
  }

  private clearRefresh(): void {
    if (this.refreshTimer !== null) {
      this.timers.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

export function expiresFromResponse(response: SipMessage, fallback: number): number {
  for (const contact of response.headerValues("contact")) {
    const match = /expires\s*=\s*"?(\d+)"?/i.exec(contact);
    if (match) return Number(match[1]);
  }
  const header = response.header("expires");
  if (header) {
    const value = Number(header.trim());
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

export function buildAor(account: AccountConfig): string {
  const domain = account.domain || account.server.replace(/:\d+$/, "");
  return formatSipUri({
    scheme: "sip",
    user: account.username,
    host: domain,
    params: [],
    headers: [],
  });
}

export function buildContact(
  username: string,
  localAddress: string,
  transport?: AccountConfig["transport"],
): string {
  const suffix = transport && transport !== "udp" ? `;transport=${transport}` : "";
  const host = localAddress.includes(":") ? localAddress : `${localAddress}:5060`;
  return `sip:${urlencode(username)}@${host}${suffix}`;
}

export function contactFromHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /<([^>]+)>/.exec(value);
  if (match) return match[1];
  return value.split(";")[0]?.trim();
}

export function aorFromHeader(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return match ? (match[1] as string) : (value.split(";")[0] ?? value);
}
