/**
 * SIP transports.
 *
 * MicroSIP creates UDP/TCP/TLS transports through pjsua; the port offers the
 * same message boundary semantics for:
 *   - loopback (tests / in-process UAS)
 *   - UDP (node:dgram, MicroSIP's default transport)
 *   - WebSocket (WSS to a modern PBX, browser compatible)
 */

export type TransportKind = "loopback" | "udp" | "tcp" | "tls" | "ws" | "wss";

export interface RemoteTarget {
  host: string;
  port: number;
  transport?: TransportKind;
}

export interface IncomingTransportMessage {
  raw: string;
  from: RemoteTarget;
}

export type TransportHandler = (message: IncomingTransportMessage) => void;

export interface SipTransport {
  readonly kind: TransportKind;
  readonly reliable: boolean;
  /** Local address once bound, e.g. `192.168.1.10:5060`. */
  readonly localAddress: string;
  send(raw: string, target: RemoteTarget): void | Promise<void>;
  setHandler(handler: TransportHandler): void;
  close(): Promise<void> | void;
}

export interface LoopbackTransport extends SipTransport {
  readonly kind: "loopback";
  /** Delivers everything queued so far (and anything queued while draining). */
  flush(): void;
  readonly sent: string[];
  readonly name: string;
  deliver(raw: string, from: LoopbackTransport): void;
}

interface LoopbackMessage {
  from: LoopbackTransport;
  to: LoopbackTransport;
  raw: string;
}

class LoopbackHub {
  private queue: LoopbackMessage[] = [];
  private transports: LoopbackTransportImpl[] = [];

  register(transport: LoopbackTransportImpl): void {
    this.transports.push(transport);
  }

  enqueue(message: LoopbackMessage): void {
    this.queue.push(message);
  }

  flush(): void {
    let guard = 0;
    while (this.queue.length && guard++ < 10_000) {
      const message = this.queue.shift() as LoopbackMessage;
      message.to.deliver(message.raw, message.from);
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

class LoopbackTransportImpl implements LoopbackTransport {
  readonly kind = "loopback" as const;
  readonly reliable: boolean;
  readonly localAddress: string;
  readonly sent: string[] = [];
  private handler: TransportHandler | null = null;
  private closed = false;
  private readonly hub: LoopbackHub;
  readonly name: string;

  constructor(hub: LoopbackHub, name: string, reliable = true) {
    this.hub = hub;
    this.name = name;
    this.localAddress = name;
    this.reliable = reliable;
    hub.register(this);
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(raw: string, target: RemoteTarget): void {
    if (this.closed) throw new Error(`transport ${this.name} is closed`);
    this.sent.push(raw);
    const peer = (this.hub as unknown as { transports: LoopbackTransportImpl[] }).transports.find(
      (t) => t.name === target.host || t.localAddress === `${target.host}:${target.port}`,
    );
    if (!peer) return;
    this.hub.enqueue({ from: this, to: peer, raw });
  }

  deliver(raw: string, from: LoopbackTransportImpl): void {
    this.handler?.({ raw, from: { host: from.name, port: 5060 } });
  }

  flush(): void {
    this.hub.flush();
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * Two in-memory endpoints. Nothing is delivered until `flush()`, which makes
 * request/response ordering deterministic in the conformance suites.
 */
export function createLoopbackPair(
  names: [string, string] = ["alice.invalid", "bob.invalid"],
  options: { reliable?: boolean } = {},
): { a: LoopbackTransport; b: LoopbackTransport; flush: () => void } {
  const hub = new LoopbackHub();
  const reliable = options.reliable ?? true;
  const a = new LoopbackTransportImpl(hub, names[0], reliable);
  const b = new LoopbackTransportImpl(hub, names[1], reliable);
  return { a, b, flush: () => hub.flush() };
}

/** UDP transport (one datagram per SIP message), mirroring pjsua's UDP. */
export class UdpTransport implements SipTransport {
  readonly kind = "udp" as const;
  readonly reliable = false;
  private handler: TransportHandler | null = null;
  private socket: import("node:dgram").Socket | null = null;
  private readyPromise: Promise<void> | null = null;
  private readonly bindPort: number;
  private readonly bindHost: string;
  private readonly family: "udp4" | "udp6";
  localAddress = "0.0.0.0:0";

  constructor(bindPort = 0, bindHost = "0.0.0.0", family: "udp4" | "udp6" = "udp4") {
    this.bindPort = bindPort;
    this.bindHost = bindHost;
    this.family = family;
  }

  async start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      const dgram = await import("node:dgram");
      const socket = dgram.createSocket(this.family);
      this.socket = socket;
      socket.on("message", (buffer, rinfo) => {
        this.handler?.({
          raw: buffer.toString("utf8"),
          from: { host: rinfo.address, port: rinfo.port, transport: "udp" },
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.bind(this.bindPort, this.bindHost, () => {
          socket.removeListener("error", reject);
          const addr = socket.address();
          this.localAddress = `${addr.address}:${addr.port}`;
          resolve();
        });
      });
    })();
    return this.readyPromise;
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(raw: string, target: RemoteTarget): Promise<void> {
    return this.start().then(
      () =>
        new Promise<void>((resolve, reject) => {
          const socket = this.socket;
          if (!socket) return reject(new Error("UDP socket is not open"));
          socket.send(Buffer.from(raw, "utf8"), target.port, target.host, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
  }

  close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.readyPromise = null;
    if (!socket) return Promise.resolve();
    return new Promise<void>((resolve) => socket.close(() => resolve()));
  }
}

/**
 * SIP over WebSocket (RFC 7118). Uses the runtime's global WebSocket so the
 * same class works in Node >= 22 and in the browser softphone shell.
 */
export class WebSocketTransport implements SipTransport {
  readonly kind: "ws" | "wss";
  readonly reliable = true;
  localAddress: string;
  private socket: WebSocket | null = null;
  private handler: TransportHandler | null = null;
  private queue: string[] = [];
  private opened: Promise<void> | null = null;
  private readonly url: string;
  private readonly options: { protocols?: string[]; headers?: Record<string, string> };

  constructor(
    url: string,
    options: { protocols?: string[]; headers?: Record<string, string> } = {},
  ) {
    this.url = url;
    this.options = options;
    this.kind = url.startsWith("wss:") ? "wss" : "ws";
    this.localAddress = url;
  }

  connect(): Promise<void> {
    if (this.opened) return this.opened;
    this.opened = new Promise<void>((resolve, reject) => {
      const protocols = this.options.protocols ?? ["sip"];
      const socket = new WebSocket(this.url, protocols);
      this.socket = socket;
      socket.addEventListener("open", () => {
        this.localAddress = `${new URL(this.url).host}`;
        for (const raw of this.queue.splice(0)) socket.send(raw);
        resolve();
      });
      socket.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (typeof data !== "string") return;
        this.handler?.({ raw: data, from: { host: new URL(this.url).hostname, port: 443 } });
      });
      socket.addEventListener("error", () => reject(new Error(`WebSocket error: ${this.url}`)));
      socket.addEventListener("close", () => {
        this.opened = null;
        this.socket = null;
      });
    });
    return this.opened;
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(raw: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      this.queue.push(raw);
      void this.connect().catch(() => undefined);
      return;
    }
    socket.send(raw);
  }

  close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.opened = null;
    if (!socket) return Promise.resolve();
    socket.close();
    return Promise.resolve();
  }
}
