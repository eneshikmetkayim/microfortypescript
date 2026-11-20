/**
 * Softphone — the application layer MicroSIP's CmainDlg provides on Windows:
 * one active account, registration status, the call table with history and
 * the cmd* hook callbacks.
 *
 * Platform pieces (native audio, tray icon, Windows messaging window) are
 * deliberately outside this class; the web shell and CLI drive it instead.
 */

import { Emitter } from "../util/emitter.ts";
import { systemTimers, type Timers } from "../util/clock.ts";
import { SipStack } from "../sip/stack.ts";
import { UdpTransport, WebSocketTransport, type SipTransport } from "../sip/transport.ts";
import type { Call, CallSnapshot } from "../sip/call.ts";
import type { RegistrationSnapshot } from "../sip/registration.ts";
import { formatNumber, unwrapUri } from "./dialing.ts";
import { CallLog, CALL_TYPE, type CallRecord } from "./calllog.ts";
import { Contacts } from "./contacts.ts";
import { resolveHook, type HookInvocation } from "./commands.ts";
import type { MicroSipAccount, MicroSipSettings } from "./settings.ts";
import { toAccountConfig } from "./settings.ts";

export interface SoftphoneEvents {
  registration: RegistrationSnapshot;
  call: CallSnapshot;
  incomingCall: CallSnapshot;
  history: CallRecord[];
  hook: HookInvocation;
  message: { from: string; body: string };
  error: Error;
}

export interface SoftphoneOptions {
  settings: MicroSipSettings;
  accountId?: number;
  transport?: SipTransport;
  callLog?: CallLog;
  contacts?: Contacts;
  localAddress?: string;
  mediaAddress?: string;
  mediaPort?: number;
  timers?: Timers;
  /** Executes cmd* hooks; the CLI/web shell logs or spawns them. */
  onHook?: (hook: HookInvocation) => void;
  autoAnswer?: boolean;
  /** false returns as soon as the transport is up; registration continues. */
  awaitRegistration?: boolean;
}

interface CallTracking {
  logId?: number;
  commands?: string;
  answerHookSent?: boolean;
}

export class Softphone {
  readonly events = new Emitter<SoftphoneEvents>();
  readonly settings: MicroSipSettings;
  private activeAccount: MicroSipAccount;
  readonly callLog: CallLog;
  readonly contacts: Contacts;
  private stack: SipStack | null = null;
  private transport: SipTransport;
  private readonly timers: Timers;
  private readonly options: SoftphoneOptions;
  private readonly tracking = new Map<Call, CallTracking>();
  private readonly wired = new Set<Call>();
  private started = false;

  constructor(options: SoftphoneOptions) {
    this.options = options;
    this.settings = options.settings;
    this.activeAccount =
      this.settings.accounts.find((candidate) => candidate.id === (options.accountId ?? this.settings.accountId)) ??
      this.settings.account;
    this.timers = options.timers ?? systemTimers;
    this.callLog = options.callLog ?? new CallLog();
    this.contacts = options.contacts ?? new Contacts(this.callLog.db);
    this.transport = options.transport ?? this.createTransport();
  }

  private createTransport(): SipTransport {
    if (this.account.transport === "ws" || this.account.transport === "wss") {
      const scheme = this.account.transport === "wss" ? "wss" : "ws";
      return new WebSocketTransport(`${scheme}://${this.account.server}`, { protocols: ["sip"] });
    }
    return new UdpTransport(this.settings.sourcePort, "0.0.0.0");
  }

  get account(): MicroSipAccount {
    return this.activeAccount;
  }

  get registration(): RegistrationSnapshot {
    return this.stack?.registration.snapshot ?? { state: "unregistered", expires: 0 };
  }

  get activeCalls(): Call[] {
    return this.stack?.activeCalls ?? [];
  }

  get history(): CallRecord[] {
    return this.callLog.list(100);
  }

  get isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    const transport = this.transport as SipTransport & { start?: () => Promise<void> };
    if (typeof transport.start === "function") await transport.start();

    const localAddress =
      this.options.localAddress ||
      this.account.publicAddr ||
      this.transport.localAddress ||
      "127.0.0.1:5060";

    this.stack = new SipStack({
      account: toAccountConfig(this.account, this.settings),
      transport: this.transport,
      localAddress,
      mediaAddress: this.options.mediaAddress ?? "127.0.0.1",
      mediaPort: this.options.mediaPort ?? 4000,
      autoAnswer: this.options.autoAnswer ?? this.account.autoAnswer === "all",
      maxConcurrentCalls: Math.max(1, this.settings.maxConcurrentCalls),
      keepAlive: this.account.keepAlive,
      timers: this.timers,
    });

    this.stack.events.on("registration", (snapshot) => this.events.emit("registration", snapshot));
    this.stack.events.on("message", (message) =>
      this.events.emit("message", { from: message.from, body: message.body }),
    );
    this.stack.events.on("error", (error) => this.events.emit("error", error));
    this.stack.events.on("incomingCall", (call) => this.trackIncoming(call));

    this.started = true;
    const registration = this.stack.start({ register: Boolean(this.account.server) });
    if (this.options.awaitRegistration === false) {
      void registration.catch((error: unknown) =>
        this.events.emit("error", error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    await registration;
  }

  async stop(): Promise<void> {
    if (!this.started || !this.stack) return;
    await this.stack.stop();
    this.stack = null;
    this.started = false;
  }

  /**
   * Rebuilds the stack after the account was edited in place (setup panel).
   * The transport is recreated because server/transport may have changed.
   */
  async restart(): Promise<void> {
    const wasStarted = this.started;
    await this.stop();
    this.activeAccount =
      this.settings.accounts.find((candidate) => candidate.id === this.settings.accountId) ??
      this.settings.account;
    this.transport = this.options.transport ?? this.createTransport();
    if (wasStarted) await this.start();
  }

  async dial(destination: string): Promise<Call> {
    if (!this.stack) throw new Error("softphone is not started");
    const formatted = formatNumber(destination, {
      account: {
        server: this.account.server,
        domain: this.account.domain,
        username: this.account.username,
        dialingPrefix: this.account.dialingPrefix,
        dialPlan: this.account.dialPlan,
      },
    });
    if (formatted.blocked) {
      throw new Error(`number blocked by dial plan: ${destination}`);
    }

    const call = await this.stack.dial(unwrapUri(formatted.uri));
    this.tracking.set(call, { commands: formatted.commands });
    this.attachCall(call);
    this.runHook("cmdOutgoingCall", call);
    return call;
  }

  async answer(callId?: string): Promise<boolean> {
    return (await this.stack?.answer(callId)) ?? false;
  }

  async hangup(callId?: string): Promise<boolean> {
    return (await this.stack?.hangup(callId)) ?? false;
  }

  async hangupAll(): Promise<void> {
    await this.stack?.hangupAll();
  }

  async toggleHold(callId?: string): Promise<boolean> {
    return (await this.stack?.toggleHold(callId)) ?? false;
  }

  async sendDtmf(digits: string, callId?: string): Promise<boolean> {
    return (await this.stack?.sendDtmf(digits, callId)) ?? false;
  }

  async transfer(target: string, callId?: string): Promise<boolean> {
    return (await this.stack?.transfer(target, callId)) ?? false;
  }

  /** Simulates the WM_COPYDATA command line: `msip:` verbs and dial strings. */
  async command(input: string): Promise<string> {
    const trimmed = input.trim();
    if (trimmed.toLowerCase().startsWith("msip:")) {
      const action = trimmed.slice(5).toLowerCase();
      if (action === "answer") return String(await this.answer());
      if (action === "hangupall") {
        await this.hangupAll();
        return "ok";
      }
      if (action === "hold") return String(await this.toggleHold());
      if (action.startsWith("transfer_")) return String(await this.transfer(action.slice(9)));
      return `unsupported: ${action}`;
    }
    const call = await this.dial(trimmed);
    return call.callId;
  }

  private trackIncoming(call: Call): void {
    this.attachCall(call);
    this.events.emit("incomingCall", call.snapshot);
    this.runHook("cmdIncomingCall", call);
    this.runHook("cmdCallRing", call);
  }

  private attachCall(call: Call): void {
    if (this.wired.has(call)) return;
    this.wired.add(call);
    if (!this.tracking.has(call)) this.tracking.set(call, {});
    call.events.on("state", (snapshot) => this.onCallState(call, snapshot));
  }

  private onCallState(call: Call, snapshot: CallSnapshot): void {
    const tracking = this.tracking.get(call) ?? {};
    const name = this.contacts.nameFor(snapshot.remoteUser);
    const ensureLog = (): number => {
      if (tracking.logId !== undefined) return tracking.logId;
      tracking.logId = this.callLog.add({
        callId: snapshot.callId,
        number: snapshot.remoteUser,
        name,
        type: snapshot.direction === "out" ? CALL_TYPE.outgoing : CALL_TYPE.incoming,
        time: Math.floor(snapshot.startTime / 1000),
        duration: 0,
        info: "",
      });
      this.tracking.set(call, tracking);
      return tracking.logId;
    };

    if (snapshot.state !== "disconnected") ensureLog();

    if (snapshot.state === "confirmed") {
      this.runHook("cmdCallStart", call);
      if (tracking.commands) {
        const digits = tracking.commands.replace(/^,/, "").replace(/,/g, "");
        if (digits) void call.sendDtmf(digits);
      }
    }

    if (snapshot.direction === "in" && !tracking.answerHookSent && snapshot.state === "confirmed") {
      tracking.answerHookSent = true;
      this.runHook("cmdCallAnswer", call);
    }

    if (snapshot.state === "disconnected") {
      ensureLog();
      const record = this.callLog.get(tracking.logId as number);
      const missed =
        snapshot.direction === "in" &&
        (snapshot.connectTime === undefined || snapshot.lastStatus === 486 || snapshot.lastStatus === 603);
      this.callLog.update({
        id: tracking.logId as number,
        callId: snapshot.callId,
        number: snapshot.remoteUser,
        name,
        type:
          snapshot.direction === "out"
            ? CALL_TYPE.outgoing
            : missed
              ? CALL_TYPE.missed
              : CALL_TYPE.incoming,
        time: record?.time ?? Math.floor(snapshot.startTime / 1000),
        duration: snapshot.duration,
        info: [snapshot.codec, snapshot.reason].filter(Boolean).join(" · "),
      });
    }

    if (snapshot.state === "disconnected") {
      this.events.emit("history", this.history);
      if (snapshot.lastStatus === 486 || snapshot.lastStatus === 603) {
        this.runHook("cmdCallBusy", call);
      } else if (snapshot.connectTime !== undefined) {
        this.runHook("cmdCallEnd", call);
      } else {
        this.runHook("cmdCallEnd", call);
      }
      this.tracking.delete(call);
    }

    this.events.emit("call", snapshot);
  }

  private runHook(name: keyof MicroSipSettings, call: Call): void {
    const template = this.settings[name];
    if (typeof template !== "string" || !template) return;
    const snapshot = call.snapshot;
    const hook = resolveHook(template, {
      account: {
        server: this.account.server,
        username: this.account.username,
        password: this.account.password,
      },
      direction: snapshot.direction,
      callId: snapshot.callId,
      duration: snapshot.duration,
      callerId: snapshot.remoteDisplayName ?? snapshot.remoteUser,
      uri: {
        user: snapshot.remoteUser,
        name: snapshot.remoteDisplayName,
        domain: snapshot.remoteHost,
      },
    });
    if (!hook) return;
    this.options.onHook?.(hook);
    this.events.emit("hook", hook);
  }
}
