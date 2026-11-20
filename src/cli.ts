#!/usr/bin/env node
/**
 * microforts — headless shell for the MicroSIP TypeScript port.
 *
 * Commands:
 *   version                       versions and build info
 *   config [--ini path] [--json]  accounts and settings from microsip.ini
 *   history [--db path] [--json]  call_log.db contents
 *   dial <number> [--seconds n]   place a real call and print events
 *   serve [--port n]              local web control panel
 *   init [--path file]            write a starter microsip.ini
 *   help
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadMicroSipSettings, defaultIniPath, type MicroSipSettings } from "./core/settings.ts";
import { CallLog } from "./core/calllog.ts";
import { Softphone } from "./core/softphone.ts";
import { MICROSIP_VERSION, USER_AGENT } from "./core/version.ts";
import { createControlServer } from "./web/server.ts";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

function flag(name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1]?.startsWith("--")) return argv[index + 1];
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

function numFlag(name: string, fallback: number): number {
  const raw = flag(name);
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function positional(): string | undefined {
  return argv.slice(1).find((arg) => !arg.startsWith("--"));
}

function iniPath(): string {
  return resolve(flag("ini") ?? defaultIniPath({
    baseDir: process.cwd(),
    appData: process.env["APPDATA"] ?? process.env["XDG_CONFIG_HOME"] ?? "",
    portable: hasFlag("portable"),
    exists: existsSync,
  }));
}

function loadSettings(): { settings: MicroSipSettings; path: string } {
  const path = iniPath();
  if (!existsSync(path)) {
    console.error(`microsip.ini not found: ${path}`);
    console.error("Run `microforts init` to create a starter file, or pass --ini <path>.");
    process.exit(2);
  }
  return { settings: loadMicroSipSettings(readFileSync(path, "utf8")), path };
}

// ------------------------------------------------------------------- commands

function printVersion(): void {
  console.log(`MicroSIP ${MICROSIP_VERSION} — TypeScript port (microfortypescript)`);
  console.log(`user-agent: ${USER_AGENT}`);
  console.log(`node: ${process.version}`);
}

function printConfig(): void {
  const { settings, path } = loadSettings();
  if (hasFlag("json")) {
    const { ini, ...rest } = settings;
    void ini;
    console.log(JSON.stringify({ iniPath: path, ...rest }, null, 2));
    return;
  }
  console.log(`ini: ${path}`);
  console.log(`active account: ${settings.account.id} (${settings.account.label || settings.account.username})`);
  for (const account of settings.accounts) {
    console.log(
      `  [Account${account.id}] ${account.username || "-"}@${account.server || "-"} transport=${account.transport}` +
        ` register=${account.registerRefresh}s keepAlive=${account.keepAlive}s` +
        (account.dialPlan ? ` dialPlan=${account.dialPlan}` : ""),
    );
  }
  console.log(`audioCodecs: ${settings.audioCodecs}`);
  console.log(`singleMode: ${settings.singleMode}  maxConcurrentCalls: ${settings.maxConcurrentCalls}`);
  console.log(`cmdOutgoingCall: ${settings.cmdOutgoingCall || "-"}`);
  console.log(`cmdIncomingCall: ${settings.cmdIncomingCall || "-"}`);
}

function printHistory(): void {
  const path = resolve(flag("db") ?? "call_log.db");
  if (!existsSync(path)) {
    console.error(`call log not found: ${path}`);
    process.exit(2);
  }
  const log = new CallLog({ path, readOnly: true });
  try {
    const rows = log.list(numFlag("limit", 50));
    if (hasFlag("json")) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(`call_log: ${path} (${log.count()} rows)`);
      for (const row of rows) {
        const when = new Date(row.time * 1000).toISOString().replace("T", " ").slice(0, 19);
        console.log(
          `${String(row.type).padEnd(2)} ${when}  ${row.number.padEnd(18)} ${row.name.padEnd(20)} ${String(row.duration).padStart(5)}s  ${row.info}`,
        );
      }
    }
  } finally {
    log.close();
  }
}

async function dial(): Promise<void> {
  const number = positional();
  if (!number) {
    console.error("usage: microforts dial <number> [--seconds 15] [--ini path]");
    process.exit(2);
  }
  const { settings } = loadSettings();
  const phone = new Softphone({
    settings,
    accountId: numFlag("account", settings.accountId),
    mediaAddress: flag("media-address", "127.0.0.1"),
  });

  const log = (label: string, detail = "") => console.log(`[${new Date().toISOString()}] ${label} ${detail}`);
  phone.events.on("registration", (snapshot) => log("registration", `${snapshot.state} ${snapshot.reason ?? ""}`));
  phone.events.on("call", (call) =>
    log("call", `${call.direction} ${call.remoteUser} ${call.state} ${call.reason ?? ""} ${call.duration}s`),
  );
  phone.events.on("hook", (hook) => log("hook", hook.command));
  phone.events.on("error", (error) => log("error", error.message));

  await phone.start();
  const call = await phone.dial(number);
  log("dial", `${call.callId} -> ${call.remoteUri}`);

  const seconds = numFlag("seconds", 15);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, seconds * 1000));
  if (call.state === "early") await phone.answer();
  await phone.hangup();
  await phone.stop();
}

async function init(): Promise<void> {
  const path = resolve(flag("path") ?? "microsip.ini");
  if (existsSync(path) && !hasFlag("force")) {
    console.error(`refusing to overwrite ${path} (use --force)`);
    process.exit(2);
  }
  const sample = [
    "[Global]",
    `version=${MICROSIP_VERSION}`,
    "",
    "[Settings]",
    "accountId=1",
    "singleMode=1",
    "audioCodecs=PCMA/8000/1 PCMU/8000/1",
    "registerRefresh=300",
    "keepAlive=15",
    "localDTMF=1",
    "",
    "[Account0]",
    "label=Local (call by IP address)",
    "server=",
    "username=",
    "",
    "[Account1]",
    "label=Ofis",
    "server=pbx.example.com",
    "username=1001",
    "password=change-me",
    "domain=pbx.example.com",
    "displayName=",
    "transport=udp",
    "registerRefresh=300",
    "keepAlive=15",
    "",
  ].join("\r\n");
  writeFileSync(path, sample, "utf8");
  console.log(`wrote ${path}`);
}

async function serve(): Promise<void> {
  const { settings, path } = loadSettings();
  const phone = new Softphone({
    settings,
    accountId: numFlag("account", settings.accountId),
    mediaAddress: flag("media-address", "127.0.0.1"),
    awaitRegistration: false,
  });

  const port = numFlag("port", 4173);
  const host = flag("host", "127.0.0.1");
  const server = createControlServer(phone, { host, port, settingsPath: path });
  await server.listen();
  console.log(`microforts control panel: http://${host}:${server.port}`);
  console.log(`ini: ${path}  account: ${phone.account.username || "-"}@${phone.account.server || "-"}`);
  console.log("press Ctrl+C to stop");

  void phone.start().catch((error: unknown) => {
    console.error("startup failed:", error instanceof Error ? error.message : error);
  });

  const shutdown = async () => {
    console.log("\nshutting down…");
    await server.close();
    await phone.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function help(): void {
  console.log(`microforts — MicroSIP ${MICROSIP_VERSION} TypeScript port

usage:
  microforts <command> [options]

commands:
  version                        print component versions
  config [--ini path] [--json]    show accounts/settings
  history [--db path] [--json]    print call_log.db rows
  dial <number> [--seconds 15]    place a call over the configured account
  serve [--port 4173]             local web control panel (SSE + JSON API)
  init [--path microsip.ini]      write a starter ini
  help

options:
  --ini <path>        microsip.ini to use (default: portable or APPDATA)
  --portable          force the portable ini location
  --account <id>      AccountN to activate
  --transport ws|wss  only for accounts whose ini already says so
  --media-address <ip>  advertised SDP address (default 127.0.0.1)
`);
}

switch (command) {
  case "version":
    printVersion();
    break;
  case "config":
    printConfig();
    break;
  case "history":
    printHistory();
    break;
  case "dial":
    await dial();
    break;
  case "serve":
    await serve();
    break;
  case "init":
    await init();
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`unknown command: ${command}`);
    help();
    process.exit(2);
}
