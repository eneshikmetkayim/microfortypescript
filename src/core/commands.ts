/**
 * Port of MicroSIP's command surface:
 *   - `CmainDlg::CommandLine` / `DialNumberFromCommandLine` (mainDlg.cpp:4438)
 *   - the `cmdOutgoingCall`/`cmdIncomingCall`/... hooks from settings.cpp
 *   - `MSIP::RunCmdCOM` invocation shape (command + params, optional wait)
 *   - the WM_COPYDATA envelope (`dwData` 1 = synchronous, 2 = queued)
 *
 * Executing the hook is the caller's job (CLI, web server, or a Windows shim);
 * this module produces exactly the argv MicroSIP would hand to ShellExecuteEx.
 */

import { urlMask, type UrlMaskContext } from "./urlmask.ts";

export type CommandHookName =
  | "cmdOutgoingCall"
  | "cmdIncomingCall"
  | "cmdCallRing"
  | "cmdCallAnswer"
  | "cmdCallAnswerVideo"
  | "cmdCallBusy"
  | "cmdCallStart"
  | "cmdCallEnd";

export interface CommandHookSettings {
  cmdOutgoingCall?: string;
  cmdIncomingCall?: string;
  cmdCallRing?: string;
  cmdCallAnswer?: string;
  cmdCallAnswerVideo?: string;
  cmdCallBusy?: string;
  cmdCallStart?: string;
  cmdCallEnd?: string;
}

export interface HookInvocation {
  /** Resolved command line, URL mask already expanded. */
  command: string;
  /** Parameter appended by RunCmdCOM (the number for outgoing calls). */
  params: string;
  /** RunCmdCOM waits 10s unless noWait is set. */
  noWait: boolean;
}

export function resolveHook(
  template: string | undefined,
  context: UrlMaskContext,
  options: { number?: string; noWait?: boolean } = {},
): HookInvocation | null {
  if (!template) return null;
  const command = urlMask(template, context);
  return {
    command,
    params: options.number ?? "",
    noWait: options.noWait ?? true,
  };
}

export interface ParsedCommandLine {
  /** `msip:` actions, or null when the input is a dial string/URI. */
  action?: string;
  actionArg?: string;
  destination?: string;
  accountId?: number;
  password?: string;
}

const SCHEME_PREFIXES = ["tel:", "sip:", "callto:", "dialpad:", "dial:"];

/**
 * `CommandLine()`: handles `msip:` verbs and normalises dial URIs.
 * Returns null for empty input (MicroSIP ignores it).
 */
export function parseCommandLine(input: string): ParsedCommandLine | null {
  let params = input.trim();
  if (!params) return null;
  if (params.startsWith('"') && params.endsWith('"') && params.length >= 2) {
    params = params.slice(1, -1);
  }
  if (!params) return null;

  const lower = params.toLowerCase();
  if (lower.startsWith("msip:")) {
    const command = params.slice(5);
    const separator = command.indexOf("_");
    if (command.startsWith("transfer_")) {
      return { action: "transfer", actionArg: command.slice("transfer_".length) };
    }
    return { action: command.toLowerCase() };
  }

  for (const prefix of SCHEME_PREFIXES) {
    if (lower.startsWith(prefix)) {
      params = params.slice(prefix.length);
      break;
    }
  }

  // `//host/` form used by callto links.
  if (params.startsWith("//")) {
    params = params.slice(2);
    if (params.endsWith("/")) params = params.slice(0, -1);
  }

  // `/account:N` and `/password:...` suffixes.
  let accountId: number | undefined;
  let password: string | undefined;
  const accountIndex = params.indexOf("/account:");
  if (accountIndex >= 0) {
    const rest = params.slice(accountIndex + "/account:".length);
    const value = /^\d+/.exec(rest)?.[0] ?? "";
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) accountId = parsed;
    const passwordIndex = params.indexOf("/password:");
    if (passwordIndex >= 0) password = params.slice(passwordIndex + "/password:".length);
    params = params.slice(0, accountIndex);
  }

  const destination = params.trim();
  if (!destination) return null;
  const result: ParsedCommandLine = { destination };
  if (accountId !== undefined) result.accountId = accountId;
  if (password !== undefined) result.password = password;
  return result;
}

/** `msip:` verbs handled by the Windows UI, kept for feature parity. */
export const MSIP_ACTIONS = [
  "minimize",
  "answer",
  "hangupall",
  "hold",
  "transfer",
  "micmute",
  "micunmute",
  "speakmute",
  "speakunmute",
  "micmuteclick",
  "speakmuteclick",
  "micup",
  "micdown",
  "speakup",
  "speakdown",
] as const;

export interface CopyDataEnvelope {
  /** 1 = handle synchronously, 2 = post to the UI queue. */
  dwData: 1 | 2;
  /** NUL-terminated UTF-16 payload as sent by MicroSIP. */
  lpData: string;
}

/**
 * Mirrors how other apps drive MicroSIP on Windows (WM_COPYDATA, class
 * "MicroSIP"). A TS client cannot send window messages, but it can emit the
 * exact payload for an interop bridge, and the CLI accepts the same strings.
 */
export function buildCopyData(commandLine: string, queued = false): CopyDataEnvelope {
  return { dwData: queued ? 2 : 1, lpData: `${commandLine}\0` };
}

/** Reverse of buildCopyData, useful for a bridge process. */
export function readCopyData(envelope: CopyDataEnvelope): string {
  return envelope.lpData.replace(/\0+$/, "");
}

export function buildMsipCommand(action: string, argument?: string): string {
  if (action === "transfer" && argument) return `msip:transfer_${argument}`;
  return `msip:${action}`;
}
