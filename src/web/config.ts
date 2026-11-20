/**
 * Panel setup form -> microsip.ini account fields.
 *
 * The web shell never edits `[Settings]` hooks or credentials it does not
 * render; it applies the handful of fields the operator sees, keeps the ini's
 * unknown keys, and reports whether the SIP stack must reconnect.
 */

import type { MicroSipAccount, MicroSipSettings } from "../core/settings.ts";

export type SipTransportName = MicroSipAccount["transport"];

export interface ConfigPatch {
  label?: string;
  server?: string;
  username?: string;
  password?: string;
  displayName?: string;
  dialPlan?: string;
  transport?: SipTransportName;
  maxConcurrentCalls?: number;
}

export interface ConfigResult {
  restartRequired: boolean;
}

const TRANSPORTS: readonly SipTransportName[] = ["udp", "tcp", "tls", "ws", "wss"];

function connectionFingerprint(settings: MicroSipSettings): string {
  const account = settings.account;
  return [
    account.server,
    account.username,
    account.password,
    account.transport,
    settings.maxConcurrentCalls,
  ].join("\u0000");
}

/**
 * Applies a partial patch in place. Empty password means "keep the stored
 * one", so the panel can show `hasPassword` without ever receiving the value.
 */
export function applyConfig(settings: MicroSipSettings, patch: ConfigPatch): ConfigResult {
  const account = settings.account;
  const before = connectionFingerprint(settings);
  const assign = <K extends keyof MicroSipAccount>(key: K, value: MicroSipAccount[K]): void => {
    account[key] = value;
    const sibling = settings.accounts.find((candidate) => candidate.id === account.id);
    if (sibling && sibling !== account) sibling[key] = value;
  };

  if (typeof patch.label === "string") assign("label", patch.label.trim());
  if (typeof patch.server === "string") assign("server", patch.server.trim());
  if (typeof patch.username === "string") assign("username", patch.username.trim());
  if (typeof patch.displayName === "string") assign("displayName", patch.displayName.trim());
  if (typeof patch.dialPlan === "string") assign("dialPlan", patch.dialPlan.trim());
  if (typeof patch.password === "string" && patch.password.length > 0) {
    assign("password", patch.password);
  }
  if (patch.transport !== undefined && TRANSPORTS.includes(patch.transport)) {
    assign("transport", patch.transport);
  }
  if (
    typeof patch.maxConcurrentCalls === "number" &&
    Number.isFinite(patch.maxConcurrentCalls)
  ) {
    settings.maxConcurrentCalls = Math.min(32, Math.max(1, Math.round(patch.maxConcurrentCalls)));
  }

  return { restartRequired: before !== connectionFingerprint(settings) };
}
