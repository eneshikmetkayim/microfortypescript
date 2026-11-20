/**
 * Local echo UAS: a real SIP+RTP peer on loopback UDP, no PBX involved.
 *
 * It answers an INVITE with 200 OK (PCMA + telephone-event/8000), echoes every
 * audio RTP packet back to its sender (the same behaviour as a carrier echo
 * test line) and decodes RFC 4733 telephone-event packets into digits. The
 * suites use it to verify DTMF end to end: signalling, SDP negotiation, RTP
 * destination and the event payload itself.
 */

import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import {
  buildResponse,
  parseMessage,
  type ResponseOptions,
  SipMessage,
} from "../../src/sip/message.ts";

/** RFC 4733 event codes, indexed by code. */
const EVENT_DIGITS = [
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "*",
  "#",
  "A",
  "B",
  "C",
  "D",
];

export interface DtmfPacketRecord {
  event: number;
  digit: string;
  /** Event duration so far, in RTP timestamp units. */
  duration: number;
  end: boolean;
  marker: boolean;
  volume: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
}

/** SDP the echo UAS answers with: one audio stream plus telephone-event. */
export function echoSdp(rtpPort: number): string {
  return [
    "v=0",
    "o=- 1 1 IN IP4 127.0.0.1",
    "s=EchoUAS",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    `m=audio ${rtpPort} RTP/AVP 8 101`,
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=fmtp:101 0-16",
    "a=sendrecv",
    "a=ptime:20",
    "",
  ].join("\r\n");
}

export class EchoUas {
  readonly requests: SipMessage[] = [];
  /** Digits completed by an RFC 4733 end bit, in arrival order. */
  readonly digits: string[] = [];
  readonly dtmfPackets: DtmfPacketRecord[] = [];
  /** Audio packets the UAS sent back, in arrival order. */
  readonly echoed: Buffer[] = [];
  ackReceived = false;
  byeReceived = false;
  cancelReceived = false;
  /** Digits received over SIP INFO instead of RTP (should stay empty). */
  readonly infoDigits: string[] = [];

  private readonly sip: Socket;
  private readonly rtp: Socket;
  private readonly completed = new Set<string>();
  private lastInvite: SipMessage | undefined;
  private readonly tag = "echo-uas-tag";

  private constructor() {
    this.sip = createSocket("udp4");
    this.rtp = createSocket("udp4");
  }

  static async create(): Promise<EchoUas> {
    const uas = new EchoUas();
    await uas.bind();
    return uas;
  }

  get port(): number {
    return this.sip.address().port;
  }

  get rtpPort(): number {
    return this.rtp.address().port;
  }

  private async bind(): Promise<void> {
    await Promise.all([this.bindSocket(this.sip), this.bindSocket(this.rtp)]);
    this.sip.on("message", (buffer, rinfo) => this.onSip(buffer.toString("utf8"), rinfo));
    this.rtp.on("message", (buffer, rinfo) => this.onRtp(buffer, rinfo));
    // The UAS is a test double: socket errors must not crash the test process.
    this.sip.on("error", () => undefined);
    this.rtp.on("error", () => undefined);
  }

  private bindSocket(socket: Socket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      socket.once("error", onError);
      socket.bind(0, "127.0.0.1", () => {
        socket.removeListener("error", onError);
        resolve();
      });
    });
  }

  // -------------------------------------------------------------------- SIP

  private onSip(raw: string, from: RemoteInfo): void {
    let message: SipMessage;
    try {
      message = parseMessage(raw);
    } catch {
      return;
    }
    if (message.startLine.kind !== "request") return;
    this.requests.push(message);

    switch (message.method) {
      case "INVITE": {
        if (message.toTag) {
          // In-dialog re-INVITE: keep answering with the same media port.
          this.reply(message, 200, from, echoSdp(this.rtpPort));
          return;
        }
        this.lastInvite = message;
        this.reply(message, 100, from);
        this.reply(message, 180, from);
        this.reply(message, 200, from, echoSdp(this.rtpPort));
        return;
      }
      case "ACK":
        this.ackReceived = true;
        return;
      case "BYE":
        this.reply(message, 200, from);
        this.byeReceived = true;
        return;
      case "CANCEL":
        this.reply(message, 200, from);
        if (this.lastInvite) this.reply(this.lastInvite, 487, from);
        this.cancelReceived = true;
        return;
      case "INFO": {
        const match = /Signal\s*=\s*(\S)/i.exec(message.body);
        if (match?.[1]) this.infoDigits.push(match[1]);
        this.reply(message, 200, from);
        return;
      }
      default:
        this.reply(message, 200, from);
    }
  }

  private reply(
    request: SipMessage,
    status: number,
    to: RemoteInfo,
    sdp?: string,
  ): SipMessage {
    const options: ResponseOptions = { toTag: this.tag };
    if (status === 200) options.contact = `<sip:echo@127.0.0.1:${this.port}>`;
    if (sdp !== undefined) options.sdp = sdp;
    const response = buildResponse(request, status, options);
    this.sip.send(Buffer.from(response.toString(), "utf8"), to.port, to.address);
    return response;
  }

  // -------------------------------------------------------------------- RTP

  private onRtp(packet: Buffer, from: RemoteInfo): void {
    if (packet.length < 12) return;
    const payloadType = packet.readUInt8(1) & 0x7f;

    if (payloadType === 101 && packet.length >= 16) {
      this.recordDtmf(packet);
      return;
    }

    // Audio: bounce the packet back unchanged, like a carrier echo test line.
    this.echoed.push(Buffer.from(packet));
    this.rtp.send(packet, from.port, from.address);
  }

  private recordDtmf(packet: Buffer): void {
    const event = packet.readUInt8(12);
    const flags = packet.readUInt8(13);
    const timestamp = packet.readUInt32BE(4);
    const digit = EVENT_DIGITS[event] ?? "?";
    const record: DtmfPacketRecord = {
      event,
      digit,
      duration: packet.readUInt16BE(14),
      end: (flags & 0x80) !== 0,
      marker: (packet.readUInt8(1) & 0x80) !== 0,
      volume: flags & 0x3f,
      sequence: packet.readUInt16BE(2),
      timestamp,
      ssrc: packet.readUInt32BE(8),
    };
    this.dtmfPackets.push(record);

    // One event spans several packets with the same code and start timestamp;
    // the end bit closes it exactly once.
    const key = `${event}:${timestamp}`;
    if (record.end && !this.completed.has(key)) {
      this.completed.add(key);
      this.digits.push(digit);
    }
  }

  // ------------------------------------------------------------------ close

  close(): Promise<void> {
    return Promise.all([closeSocket(this.sip), closeSocket(this.rtp)]).then(() => undefined);
  }
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
