/**
 * Local control panel server: static UI, JSON API and Server-Sent Events.
 *
 * Bound to loopback by default and rejects cross-origin mutations, because the
 * endpoints can place real calls with the configured SIP credentials.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Softphone } from "../core/softphone.ts";

export interface ControlServerOptions {
  host?: string;
  port?: number;
  staticDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export class ControlServer {
  private server: Server;
  private clients = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly staticDir: string;
  private readonly phone: Softphone;

  constructor(phone: Softphone, options: ControlServerOptions = {}) {
    this.phone = phone;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 4173;
    this.staticDir =
      options.staticDir ??
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    });
    this.wireEvents();
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : this.requestedPort;
  }

  listen(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.requestedPort, this.host, () => {
        this.server.removeListener("error", reject);
        this.heartbeat = setInterval(() => {
          for (const client of this.clients) client.write(": ping\n\n");
        }, 25_000);
        this.heartbeat.unref?.();
        resolvePromise();
      });
    });
  }

  close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
    return new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
  }

  private wireEvents(): void {
    const forward = (event: string, payload: unknown) => this.broadcast(event, payload);
    this.phone.events.on("registration", (snapshot) => forward("registration", snapshot));
    this.phone.events.on("call", (call) => forward("call", call));
    this.phone.events.on("incomingCall", (call) => forward("incomingCall", call));
    this.phone.events.on("history", (history) => forward("history", history));
    this.phone.events.on("hook", (hook) => forward("hook", hook));
    this.phone.events.on("message", (message) => forward("message", message));
    this.phone.events.on("error", (error) => forward("error", { message: error.message }));
  }

  private broadcast(event: string, payload: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await this.handleApi(request, response, url);
      return;
    }
    await this.serveStatic(response, url.pathname);
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const method = request.method ?? "GET";

    if (url.pathname === "/api/events" && method === "GET") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write(": connected\n\n");
      this.clients.add(response);
      request.on("close", () => this.clients.delete(response));
      return;
    }

    if (method === "POST" && !this.isSameOrigin(request)) {
      this.sendJson(response, 403, { error: "cross-origin request rejected" });
      return;
    }

    if (url.pathname === "/api/status" && method === "GET") {
      this.sendJson(response, 200, {
        started: this.phone.isStarted,
        account: {
          id: this.phone.account.id,
          label: this.phone.account.label,
          username: this.phone.account.username,
          server: this.phone.account.server,
          domain: this.phone.account.domain,
          transport: this.phone.account.transport,
          displayName: this.phone.account.displayName,
          voicemailNumber: this.phone.account.voicemailNumber,
          dialPlan: this.phone.account.dialPlan,
        },
        registration: this.phone.registration,
        calls: this.phone.activeCalls.map((call) => call.snapshot),
        history: this.phone.history,
        settings: {
          singleMode: this.phone.settings.singleMode,
          audioCodecs: this.phone.settings.audioCodecs,
          maxConcurrentCalls: this.phone.settings.maxConcurrentCalls,
          userIdle: true,
        },
      });
      return;
    }

    if (url.pathname === "/api/history" && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? "100");
      const query = url.searchParams.get("q");
      const rows = query ? this.phone.callLog.search(query, limit) : this.phone.callLog.list(limit);
      this.sendJson(response, 200, { rows });
      return;
    }

    if (url.pathname === "/api/contacts" && method === "GET") {
      const query = url.searchParams.get("q");
      const rows = query ? this.phone.contacts.search(query) : this.phone.contacts.list();
      this.sendJson(response, 200, { rows });
      return;
    }

    if (method !== "POST") {
      this.sendJson(response, 405, { error: "method not allowed" });
      return;
    }

    const body = await readJson(request);
    const callId = typeof body["callId"] === "string" ? body["callId"] : undefined;

    switch (url.pathname) {
      case "/api/dial": {
        const number = String(body["number"] ?? "").trim();
        if (!number) {
          this.sendJson(response, 400, { error: "number is required" });
          return;
        }
        const call = await this.phone.dial(number);
        this.sendJson(response, 200, { callId: call.callId, state: call.state });
        return;
      }
      case "/api/answer":
        this.sendJson(response, 200, { ok: await this.phone.answer(callId) });
        return;
      case "/api/hangup":
        this.sendJson(response, 200, { ok: await this.phone.hangup(callId) });
        return;
      case "/api/hangup-all":
        await this.phone.hangupAll();
        this.sendJson(response, 200, { ok: true });
        return;
      case "/api/hold":
        this.sendJson(response, 200, { ok: await this.phone.toggleHold(callId) });
        return;
      case "/api/dtmf": {
        const digits = String(body["digits"] ?? "");
        if (!digits) {
          this.sendJson(response, 400, { error: "digits is required" });
          return;
        }
        this.sendJson(response, 200, { ok: await this.phone.sendDtmf(digits, callId) });
        return;
      }
      case "/api/transfer": {
        const target = String(body["target"] ?? "").trim();
        if (!target) {
          this.sendJson(response, 400, { error: "target is required" });
          return;
        }
        this.sendJson(response, 200, { ok: await this.phone.transfer(target, callId) });
        return;
      }
      case "/api/command": {
        const input = String(body["input"] ?? "").trim();
        if (!input) {
          this.sendJson(response, 400, { error: "input is required" });
          return;
        }
        this.sendJson(response, 200, { result: await this.phone.command(input) });
        return;
      }
      default:
        this.sendJson(response, 404, { error: "unknown endpoint" });
    }
  }

  private isSameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true; // same-origin fetches and curl
    const host = request.headers.host;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  private async serveStatic(response: ServerResponse, pathname: string): Promise<void> {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = normalize(join(this.staticDir, relative));
    if (!target.startsWith(this.staticDir)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const data = await readFile(target);
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(data);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
    }
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createControlServer(
  phone: Softphone,
  options: ControlServerOptions = {},
): ControlServer {
  return new ControlServer(phone, options);
}
