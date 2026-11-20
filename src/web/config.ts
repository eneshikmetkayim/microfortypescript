/**
 * Setup wizard -> microsip.ini accounts.
 *
 * The panel manages `[AccountN]` sections as sip users: one is active, the
 * rest stay configured for later. Unknown ini keys are preserved, passwords
 * are write-only, and the result reports whether the stack must reconnect.
 */

import { createAccount, type MicroSipAccount, type MicroSipSettings } from "../core/settings.ts";

export type SipTransportName = MicroSipAccount["transport"];

export interface AccountInput {
  /** Existing `[AccountN]` id, or 0/omitted for a new user. */
  id?: number;
  label?: string;
  server?: string;
  username?: string;
  /** Empty keeps the stored password. */
  password?: string;
  displayName?: string;
  dialPlan?: string;
  transport?: SipTransportName;
}

export interface ConfigPatch {
  accountId: number;
  accounts: AccountInput[];
  maxConcurrentCalls?: number;
}

export interface ConfigResult {
  restartRequired: boolean;
}

/** Invalid operator input; the API maps it to 400. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TRANSPORTS: readonly SipTransportName[] = ["udp", "tcp", "tls", "ws", "wss"];

function fingerprint(settings: MicroSipSettings): string {
  return JSON.stringify({
    accountId: settings.accountId,
    maxConcurrentCalls: settings.maxConcurrentCalls,
    accounts: settings.accounts
      .filter((account) => account.id > 0)
      .map((account) => [account.id, account.server, account.username, account.password, account.transport])
      .sort((a, b) => Number(a[0]) - Number(b[0])),
  });
}

function nextFreeId(taken: Set<number>): number {
  let id = 1;
  while (taken.has(id)) id += 1;
  return id;
}

function applyFields(account: MicroSipAccount, input: AccountInput): void {
  if (typeof input.label === "string") account.label = input.label.trim();
  if (typeof input.displayName === "string") account.displayName = input.displayName.trim();
  if (typeof input.dialPlan === "string") account.dialPlan = input.dialPlan.trim();
  account.server = (input.server ?? "").trim();
  account.username = (input.username ?? "").trim();
  if (typeof input.password === "string" && input.password.length > 0) {
    account.password = input.password;
  }
  if (input.transport !== undefined && TRANSPORTS.includes(input.transport)) {
    account.transport = input.transport;
  }
}

export function applyConfig(settings: MicroSipSettings, patch: ConfigPatch): ConfigResult {
  const before = fingerprint(settings);

  if (!Array.isArray(patch.accounts) || patch.accounts.length === 0) {
    throw new ConfigError("en az bir kullanıcı gerekli");
  }

  const existing = new Map(
    settings.accounts.filter((account) => account.id > 0).map((account) => [account.id, account]),
  );
  const taken = new Set<number>();
  const next: MicroSipAccount[] = [];

  for (const input of patch.accounts) {
    const server = (input.server ?? "").trim();
    const username = (input.username ?? "").trim();
    if (!server || !username) {
      throw new ConfigError("her kullanıcı için sunucu ve kullanıcı adı gerekli");
    }
    const requested = Number.isInteger(input.id) && (input.id as number) > 0 ? (input.id as number) : 0;
    if (requested && taken.has(requested)) {
      throw new ConfigError(`kullanıcı kimliği tekrar etti: ${requested}`);
    }
    const known = requested ? existing.get(requested) : undefined;
    const id = known?.id ?? (requested && !taken.has(requested) ? requested : nextFreeId(taken));
    const account = known ?? createAccount(id);
    applyFields(account, input);
    taken.add(id);
    next.push(account);
  }

  const active = next.find((account) => account.id === patch.accountId);
  if (!active) {
    throw new ConfigError("aktif kullanıcı seçilmedi");
  }

  for (const old of existing.values()) {
    if (!taken.has(old.id)) settings.ini.removeSection(`Account${old.id}`);
  }

  settings.accounts = next;
  settings.account = active;
  settings.accountId = active.id;

  if (
    typeof patch.maxConcurrentCalls === "number" &&
    Number.isFinite(patch.maxConcurrentCalls)
  ) {
    settings.maxConcurrentCalls = Math.min(32, Math.max(1, Math.round(patch.maxConcurrentCalls)));
  }

  return { restartRequired: before !== fingerprint(settings) };
}
