/**
 * MicroSIP settings model (settings.cpp / global.h).
 *
 * Reads the same `microsip.ini` the Windows build writes, keeps unknown keys,
 * and converts `[AccountN]` sections into the port's AccountConfig. Defaults
 * come from define.h and the GetPrivateProfileString fallbacks so an ini
 * without a key behaves exactly like MicroSIP.
 */

import { IniDocument } from "./ini.ts";
import { DEFAULT_CODECS_ENABLED, MICROSIP_VERSION } from "./version.ts";
import type { AccountConfig } from "../sip/registration.ts";

export type AutoAnswerMode = "button" | "number" | "all";
export type DenyIncomingMode = "button" | "all";

export interface MicroSipAccount {
  id: number;
  label: string;
  server: string;
  proxy: string;
  domain: string;
  username: string;
  password: string;
  authId: string;
  displayName: string;
  dialingPrefix: string;
  dialPlan: string;
  hideCid: boolean;
  voicemailNumber: string;
  transport: "udp" | "tcp" | "tls" | "ws" | "wss";
  registerRefresh: number;
  keepAlive: number;
  srtp: number;
  publicAddr: string;
  publish: boolean;
  allowRewrite: boolean;
  ice: boolean;
  disableSessionTimer: boolean;
  autoAnswer: AutoAnswerMode | string;
  autoAnswerDelay: number;
  autoAnswerNumber: string;
  autoAnswerCalls: string;
  forwarding: string;
  forwardingNumber: string;
  forwardingDelay: number;
  denyIncoming: string;
  localDTMF: boolean;
  audioCodecs?: string;
}

export interface MicroSipSettings {
  version: string;
  accountId: number;
  account: MicroSipAccount;
  accountLocal: MicroSipAccount;
  accounts: MicroSipAccount[];
  singleMode: boolean;
  audioCodecs: string;
  vad: boolean;
  echoCancellation: boolean;
  forceCodec: string;
  opusStereo: boolean;
  disableMessaging: boolean;
  disableVideo: boolean;
  rport: boolean;
  sourcePort: number;
  rtpPortMin: number;
  rtpPortMax: number;
  stunServer: string;
  enableStun: boolean;
  maxConcurrentCalls: number;
  noIgnoreCall: boolean;
  localDTMF: boolean;
  dtmfMethod: number;
  minimized: boolean;
  recordingPath: string;
  autoRecording: number;
  cmdOutgoingCall: string;
  cmdIncomingCall: string;
  cmdCallRing: string;
  cmdCallAnswer: string;
  cmdCallAnswerVideo: string;
  cmdCallBusy: string;
  cmdCallStart: string;
  cmdCallEnd: string;
  /** Untouched ini so saving does not drop Windows-only keys. */
  ini: IniDocument;
}

const DEFAULT_TRANSPORT = "udp" as const;

function accountFromIni(ini: IniDocument, id: number): MicroSipAccount {
  const section = id === 0 ? "Account0" : `Account${id}`;
  const get = (key: string, fallback = ""): string => ini.get(section, key, fallback);
  const num = (key: string, fallback: number): number => {
    const raw = get(key);
    if (!raw) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const transportRaw = get("transport", DEFAULT_TRANSPORT).toLowerCase();
  const transport = (["udp", "tcp", "tls", "ws", "wss"] as const).includes(
    transportRaw as (typeof DEFAULT_TRANSPORT) | "tcp" | "tls" | "ws" | "wss",
  )
    ? (transportRaw as MicroSipAccount["transport"])
    : DEFAULT_TRANSPORT;

  return {
    id,
    label: id === 0 ? get("label", "Local (call by IP address)") : get("label"),
    server: get("server"),
    proxy: get("proxy"),
    domain: get("domain"),
    username: get("username"),
    password: get("password"),
    authId: get("authID"),
    displayName: get("displayName"),
    dialingPrefix: get("dialingPrefix"),
    dialPlan: get("dialPlan"),
    hideCid: get("hideCID") === "1",
    voicemailNumber: get("voicemailNumber"),
    transport,
    registerRefresh: num("registerRefresh", 300),
    keepAlive: num("keepAlive", 15),
    srtp: num("SRTP", 0),
    publicAddr: get("publicAddr"),
    publish: get("publish") === "1",
    allowRewrite: get("allowRewrite") === "1",
    ice: get("ICE") === "1",
    disableSessionTimer: get("disableSessionTimer") === "1",
    autoAnswer: get("autoAnswer", "button"),
    autoAnswerDelay: num("autoAnswerDelay", 0),
    autoAnswerNumber: get("autoAnswerNumber"),
    autoAnswerCalls: get("autoAnswerCalls"),
    forwarding: get("forwarding"),
    forwardingNumber: get("forwardingNumber"),
    forwardingDelay: num("forwardingDelay", 0),
    denyIncoming: get("denyIncoming", "button"),
    localDTMF: get("localDTMF", "1") === "1",
    audioCodecs: get("audioCodecs") || undefined,
  };
}

export function loadMicroSipSettings(text: string): MicroSipSettings {
  const ini = IniDocument.parse(text);
  const accountId = ini.getNumber("Settings", "accountId", 1);
  const account = accountFromIni(ini, accountId > 0 ? accountId : 1);
  const accountLocal = accountFromIni(ini, 0);

  const accounts: MicroSipAccount[] = [];
  for (const name of ini.sectionNames()) {
    const match = /^account(\d+)$/i.exec(name);
    if (!match) continue;
    const id = Number(match[1]);
    if (id === 0) continue;
    accounts.push(accountFromIni(ini, id));
  }
  const activeIndex = accounts.findIndex((candidate) => candidate.id === account.id);
  if (activeIndex >= 0) accounts[activeIndex] = account;
  else accounts.unshift(account);

  return {
    version: ini.get("Global", "version", MICROSIP_VERSION),
    accountId,
    account,
    accountLocal,
    accounts,
    singleMode: ini.get("Settings", "singleMode", "1") === "1",
    audioCodecs: ini.get("Settings", "audioCodecs", DEFAULT_CODECS_ENABLED),
    vad: ini.get("Settings", "VAD") === "1",
    echoCancellation: ini.get("Settings", "EC", "1") === "1",
    forceCodec: ini.get("Settings", "forceCodec"),
    opusStereo: ini.get("Settings", "opusStereo") === "1",
    disableMessaging: ini.get("Settings", "disableMessaging") === "1",
    disableVideo: ini.get("Settings", "disableVideo") === "1",
    rport: ini.get("Settings", "rport") === "1",
    sourcePort: ini.getNumber("Settings", "sourcePort", 0),
    rtpPortMin: ini.getNumber("Settings", "rtpPortMin", 40000),
    rtpPortMax: ini.getNumber("Settings", "rtpPortMax", 45000),
    stunServer: ini.get("Settings", "STUN"),
    enableStun: ini.get("Settings", "enableSTUN") === "1",
    maxConcurrentCalls: ini.getNumber("Settings", "maxConcurrentCalls", 1),
    noIgnoreCall: ini.get("Settings", "noIgnoreCall") === "1",
    localDTMF: ini.get("Settings", "localDTMF", "1") === "1",
    dtmfMethod: ini.getNumber("Settings", "DTMFMethod", 0),
    minimized: ini.get("Settings", "minimized") === "1",
    recordingPath: ini.get("Settings", "recordingPath"),
    autoRecording: ini.getNumber("Settings", "autoRecording", 0),
    cmdOutgoingCall: ini.get("Settings", "cmdOutgoingCall"),
    cmdIncomingCall: ini.get("Settings", "cmdIncomingCall"),
    cmdCallRing: ini.get("Settings", "cmdCallRing"),
    cmdCallAnswer: ini.get("Settings", "cmdCallAnswer"),
    cmdCallAnswerVideo: ini.get("Settings", "cmdCallAnswerVideo"),
    cmdCallBusy: ini.get("Settings", "cmdCallBusy"),
    cmdCallStart: ini.get("Settings", "cmdCallStart"),
    cmdCallEnd: ini.get("Settings", "cmdCallEnd"),
    ini,
  };
}

/** Converts a MicroSIP account section into the SIP stack's AccountConfig. */
export function toAccountConfig(
  account: MicroSipAccount,
  settings?: Pick<MicroSipSettings, "audioCodecs">,
): AccountConfig {
  const codecs = (account.audioCodecs ?? settings?.audioCodecs ?? DEFAULT_CODECS_ENABLED)
    .split(/\s+/)
    .filter(Boolean);
  const config: AccountConfig = {
    id: account.id,
    label: account.label || account.username || `Account${account.id}`,
    server: account.server,
    proxy: account.proxy || undefined,
    domain: account.domain || undefined,
    username: account.username,
    password: account.password,
    authId: account.authId || undefined,
    displayName: account.displayName || undefined,
    transport: account.transport,
    registerRefresh: account.registerRefresh,
    keepAlive: account.keepAlive,
    dialingPrefix: account.dialingPrefix,
    dialPlan: account.dialPlan,
    hideCid: account.hideCid,
    voicemailNumber: account.voicemailNumber,
    audioCodecs: codecs,
  };
  return config;
}

export interface IniPathOptions {
  /** Directory containing the executable / project. */
  baseDir: string;
  /** Windows APPDATA (or equivalent). */
  appData?: string;
  /** Portable mode: `microsip.ini` next to the executable. */
  portable?: boolean;
  exists?: (path: string) => boolean;
}

/**
 * settings.cpp `Init()`: portable builds use `microsip.ini` beside the exe,
 * otherwise `%APPDATA%\MicroSIP\microsip.ini`.
 */
export function defaultIniPath(options: IniPathOptions): string {
  const join = (base: string, ...parts: string[]) =>
    [base.replace(/[\\/]+$/, ""), ...parts].join(options.baseDir.includes("\\") ? "\\" : "/");
  const portablePath = join(options.baseDir, "microsip.ini");
  if (options.portable || options.exists?.(portablePath)) return portablePath;
  const appData = options.appData ?? "";
  if (!appData) return portablePath;
  return join(appData, "MicroSIP", "microsip.ini");
}

/** Writes the parsed model back, preserving every unknown key. */
export function saveMicroSipSettings(settings: MicroSipSettings): string {
  const ini = settings.ini;
  ini.set("Global", "version", settings.version);
  ini.set("Settings", "accountId", settings.accountId);
  ini.set("Settings", "singleMode", settings.singleMode ? 1 : 0);
  ini.set("Settings", "audioCodecs", settings.audioCodecs);
  ini.set("Settings", "cmdOutgoingCall", settings.cmdOutgoingCall || undefined);
  ini.set("Settings", "cmdIncomingCall", settings.cmdIncomingCall || undefined);
  ini.set("Settings", "cmdCallRing", settings.cmdCallRing || undefined);
  ini.set("Settings", "cmdCallAnswer", settings.cmdCallAnswer || undefined);
  ini.set("Settings", "cmdCallStart", settings.cmdCallStart || undefined);
  ini.set("Settings", "cmdCallEnd", settings.cmdCallEnd || undefined);

  for (const account of settings.accounts) {
    const section = `Account${account.id}`;
    ini.set(section, "label", account.label);
    ini.set(section, "server", account.server);
    ini.set(section, "username", account.username);
    ini.set(section, "password", account.password);
    ini.set(section, "authID", account.authId || undefined);
    ini.set(section, "displayName", account.displayName || undefined);
    ini.set(section, "dialingPrefix", account.dialingPrefix || undefined);
    ini.set(section, "dialPlan", account.dialPlan || undefined);
    ini.set(section, "transport", account.transport);
    ini.set(section, "registerRefresh", account.registerRefresh);
    ini.set(section, "keepAlive", account.keepAlive);
  }
  return ini.toString();
}
