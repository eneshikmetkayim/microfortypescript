/**
 * Panel smoke test: starts the real control panel, sends real SIP INVITEs over
 * UDP, answers one call, rejects another with 486, and checks that both end up
 * in the history with the right call type.
 *
 *   node scripts/panel-smoke.ts
 *
 * The panel runs on an ephemeral HTTP port with a throwaway ini; no PBX or
 * network access is needed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResponse, parseMessage, SipMessage } from "../src/sip/message.ts";
import { CALL_TYPE, type CallRecord } from "../src/core/calllog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.ts");
const SIP_HOST = "127.0.0.1";

const OFFER_SDP = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "c=IN IP4 127.0.0.1",
  "t=0 0",
  "m=audio 4100 RTP/AVP 8 0 101",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:101 telephone-event/8000",
  "a=fmtp:101 0-15",
  "a=sendrecv",
  "",
].join("\r\n");

class SmokeError extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeError(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new SmokeError(`timed out waiting for ${what}${detail}`);
}

function iniText(sipPort: number): string {
  return [
    "[Global]",
    "version=3.23.5",
    "",
    "[Settings]",
    "accountId=1",
    "singleMode=1",
    "maxConcurrentCalls=2",
    `sourcePort=${sipPort}`,
    "audioCodecs=PCMA/8000/1 PCMU/8000/1",
    "",
    "[Account1]",
    "label=Smoke",
    "server=",
    "username=1001",
    "transport=udp",
    "",
  ].join("\r\n");
}

async function freeUdpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolvePromise, reject) => {
    socket.once("error", reject);
    socket.bind(0, SIP_HOST, () => resolvePromise());
  });
  const { port } = socket.address();
  await new Promise<void>((resolvePromise) => socket.close(() => resolvePromise()));
  return port;
}

interface Panel {
  url: string;
  process: ChildProcess;
}

async function startPanel(workDir: string, iniPath: string): Promise<Panel> {
  const child = spawn(process.execPath, [CLI, "serve", "--port", "0", "--ini", iniPath], {
    cwd: workDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const url = await waitFor(
    "the panel to print its URL",
    () => /control panel: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1],
    15_000,
  ).catch((error: unknown) => {
    child.kill();
    const message = error instanceof Error ? error.message : String(error);
    throw new SmokeError(`${message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });

  await waitFor("the panel API to answer", async () => {
    const response = await fetch(`${url}/api/status`);
    return response.ok;
  });
  return { url, process: child };
}

async function stopPanel(panel: Panel | undefined): Promise<void> {
  if (!panel || panel.process.exitCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => panel.process.once("exit", () => resolvePromise()));
  panel.process.kill("SIGTERM");
  await Promise.race([exited, sleep(3000)]);
  if (panel.process.exitCode === null) panel.process.kill("SIGKILL");
}

interface CallSnapshot {
  id: string;
  callId: string;
  direction: "in" | "out";
  state: string;
  remoteUser: string;
}

interface StatusPayload {
  calls: CallSnapshot[];
  history: CallRecord[];
}

async function getStatus(panelUrl: string): Promise<StatusPayload> {
  const response = await fetch(`${panelUrl}/api/status`);
  check(response.ok, `GET /api/status returned ${response.status}`);
  return (await response.json()) as StatusPayload;
}

async function postJson(panelUrl: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${panelUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  check(response.ok, `POST ${path} returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

interface Invite {
  callId: string;
  cseq: number;
}

/** Minimal UAS: one UDP socket, real SIP bytes, 200/486 responses. */
class SmokeUas {
  private readonly socket: Socket;
  private readonly responses: SipMessage[] = [];
  private readonly requests: SipMessage[] = [];
  private readonly sipPort: number;

  private constructor(socket: Socket, sipPort: number) {
    this.socket = socket;
    this.sipPort = sipPort;
  }

  static async open(sipPort: number): Promise<SmokeUas> {
    const socket = createSocket("udp4");
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("error", reject);
      socket.bind(0, SIP_HOST, () => resolvePromise());
    });
    const uas = new SmokeUas(socket, sipPort);
    socket.on("message", (buffer, from) => uas.onMessage(buffer.toString("utf8"), from));
    return uas;
  }

  get port(): number {
    const address = this.socket.address();
    return typeof address === "object" ? address.port : 0;
  }

  private onMessage(raw: string, from: RemoteInfo): void {
    let message: SipMessage;
    try {
      message = parseMessage(raw);
    } catch {
      return;
    }
    if (!message.isRequest) {
      this.responses.push(message);
      return;
    }
    this.requests.push(message);
    if (message.method === "BYE") {
      this.send(buildResponse(message, 200, { toTag: message.toTag }), from.port);
    }
  }

  close(): void {
    this.socket.close();
  }

  private send(message: SipMessage, port: number): void {
    this.socket.send(Buffer.from(message.toString(), "utf8"), port, SIP_HOST);
  }

  invite(fromUser: string, toUser: string): Invite {
    const callId = `smoke-${fromUser}-${Math.random().toString(16).slice(2, 10)}`;
    const cseq = 1;
    const request = SipMessage.request("INVITE", `sip:${toUser}@${SIP_HOST}:${this.sipPort}`);
    request.addHeader(
      "Via",
      `SIP/2.0/UDP ${SIP_HOST}:${this.port};branch=z9hG4bK${Math.random().toString(16).slice(2, 12)};rport`,
    );
    request.addHeader("Max-Forwards", "70");
    request.addHeader("From", `"Smoke ${fromUser}" <sip:${fromUser}@${SIP_HOST}>;tag=smoke-${fromUser}`);
    request.addHeader("To", `<sip:${toUser}@${SIP_HOST}>`);
    request.addHeader("Call-ID", callId);
    request.addHeader("CSeq", `${cseq} INVITE`);
    request.addHeader("Contact", `<sip:${fromUser}@${SIP_HOST}:${this.port}>`);
    request.addHeader("Content-Type", "application/sdp");
    request.body = OFFER_SDP;
    this.socket.send(Buffer.from(request.toString(), "utf8"), this.sipPort, SIP_HOST);
    return { callId, cseq };
  }

  ack(invite: Invite, response: SipMessage): void {
    const ack = SipMessage.request("ACK", `sip:${SIP_HOST}`);
    ack.addHeader(
      "Via",
      `SIP/2.0/UDP ${SIP_HOST}:${this.port};branch=z9hG4bK${Math.random().toString(16).slice(2, 12)}`,
    );
    ack.addHeader("Max-Forwards", "70");
    ack.addHeader("To", response.header("to") ?? "");
    ack.addHeader("From", response.header("from") ?? "");
    ack.addHeader("Call-ID", invite.callId);
    ack.addHeader("CSeq", `${invite.cseq} ACK`);
    this.send(ack, this.sipPort);
  }

  waitResponse(callId: string, status: number, timeoutMs = 10_000): Promise<SipMessage> {
    return waitFor(
      `SIP ${status} for ${callId}`,
      () => this.responses.find((response) => response.callId === callId && response.status === status),
      timeoutMs,
    );
  }

  waitRequest(callId: string, method: string, timeoutMs = 10_000): Promise<SipMessage> {
    return waitFor(
      `${method} for ${callId}`,
      () => this.requests.find((request) => request.callId === callId && request.method === method),
      timeoutMs,
    );
  }
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "microfort-smoke-"));
  const sipPort = await freeUdpPort();
  const iniPath = join(workDir, "microsip.ini");
  await writeFile(iniPath, iniText(sipPort), "utf8");

  let panel: Panel | undefined;
  let uas: SmokeUas | undefined;
  try {
    const live = await startPanel(workDir, iniPath);
    panel = live;
    uas = await SmokeUas.open(sipPort);

    const html = await (await fetch(`${live.url}/`)).text();
    check(html.includes("MicroSIP"), "panel HTML does not render the UI");

    // --- answer: ringing -> 200/ACK -> confirmed -> hangup -> incoming history
    const answered = uas.invite("1002", "1001");
    const ringing = await waitFor("the answered call to ring", async () =>
      (await getStatus(live.url)).calls.find(
        (call) => call.callId === answered.callId && call.direction === "in" && call.state === "early",
      ),
    );
    check(ringing.remoteUser === "1002", `unexpected caller ${ringing.remoteUser}`);
    check((await postJson(live.url, "/api/answer", { callId: ringing.id })).ok === true, "answer was rejected");

    const ok = await uas.waitResponse(answered.callId, 200);
    check(ok.header("content-type")?.includes("application/sdp") === true, "200 OK has no SDP answer");
    uas.ack(answered, ok);
    await waitFor("the answered call to be confirmed", async () =>
      (await getStatus(live.url)).calls.find(
        (call) => call.callId === answered.callId && call.state === "confirmed",
      ),
    );

    await sleep(1200);
    check((await postJson(live.url, "/api/hangup", { callId: ringing.id })).ok === true, "hangup was rejected");
    await uas.waitRequest(answered.callId, "BYE");
    const answeredRow = await waitFor("the answered call in history", async () =>
      (await getStatus(live.url)).history.find(
        (row) => row.callId === answered.callId && row.type === CALL_TYPE.incoming,
      ),
    );
    check(answeredRow.number === "1002", `history number is ${answeredRow.number}`);
    check(answeredRow.duration >= 1, `answered call duration is ${answeredRow.duration}s`);
    check(answeredRow.info.includes("PCMA"), `history info is "${answeredRow.info}"`);

    // --- reject: ringing -> hangup -> 486 -> missed history
    const rejected = uas.invite("1003", "1001");
    const waiting = await waitFor("the rejected call to ring", async () =>
      (await getStatus(live.url)).calls.find(
        (call) => call.callId === rejected.callId && call.state === "early",
      ),
    );
    check((await postJson(live.url, "/api/hangup", { callId: waiting.id })).ok === true, "reject was rejected");
    const busy = await uas.waitResponse(rejected.callId, 486);
    uas.ack(rejected, busy);

    const missedRow = await waitFor("the rejected call in history", async () =>
      (await getStatus(live.url)).history.find(
        (row) => row.callId === rejected.callId && row.type === CALL_TYPE.missed,
      ),
    );
    check(missedRow.number === "1003", `history number is ${missedRow.number}`);
    check(missedRow.info.includes("Busy Here"), `history info is "${missedRow.info}"`);

    const finalStatus = await getStatus(live.url);
    check(finalStatus.calls.length === 0, `${finalStatus.calls.length} call(s) still active`);
    console.log(
      "panel smoke ok: ring/answer/hangup logged as incoming, reject logged as missed (486), pool drained",
    );
  } finally {
    uas?.close();
    await stopPanel(panel);
    await rm(workDir, { recursive: true, force: true });
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
