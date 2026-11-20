/**
 * RFC 4733 telephone-event ("RFC 2833") DTMF.
 *
 * pjsua sends digits as RTP events when the peer negotiates
 * `telephone-event/8000`; this module reproduces the packet layout
 * (RTP header + 4-byte event block) and the 20 ms retransmission pattern with
 * the end bit repeated three times.
 */

export const DTMF_EVENT_CODES: Record<string, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "*": 10,
  "#": 11,
  A: 12,
  B: 13,
  C: 14,
  D: 15,
};

export interface DtmfPacketOptions {
  /** Dynamic payload type negotiated for telephone-event (often 101). */
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  /** Event code 0-15 (`DTMF_EVENT_CODES`). */
  event: number;
  /** Event duration so far, in RTP timestamp units. */
  duration: number;
  /** Volume in dBm0 (0-63); pjsua uses 10. */
  volume?: number;
  /** RTP marker bit: set on the first packet of an event. */
  marker?: boolean;
  /** RFC 4733 end bit: the digit stopped, duration is final. */
  end?: boolean;
}

/** 12-byte RTP header plus the 4-byte telephone-event block. */
export function buildDtmfPacket(options: DtmfPacketOptions): Buffer {
  const packet = Buffer.alloc(16);
  packet[0] = 0x80; // version 2, no padding/extension/CSRC
  packet[1] = (options.marker ? 0x80 : 0) | (options.payloadType & 0x7f);
  packet.writeUInt16BE(options.sequence & 0xffff, 2);
  packet.writeUInt32BE(options.timestamp >>> 0, 4);
  packet.writeUInt32BE(options.ssrc >>> 0, 8);
  packet[12] = options.event & 0xff;
  packet[13] = (options.end ? 0x80 : 0) | ((options.volume ?? 10) & 0x3f);
  packet.writeUInt16BE(options.duration & 0xffff, 14);
  return packet;
}

export interface RtpTarget {
  address: string;
  port: number;
}

export interface RtpDtmfOptions {
  payloadType: number;
  /** Event clock rate from SDP; 8000 for telephone-event/8000. */
  clockRate?: number;
  volume?: number;
  ssrc?: number;
  /** Packet spacing; RFC 4733 uses 20 ms. */
  stepMs?: number;
  /** Packets with the end bit sent for each digit (pjsua sends three). */
  endPackets?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends DTMF digits as RFC 4733 events to a negotiated RTP endpoint.
 * One socket per call, kept open so repeated digits reuse the same SSRC.
 */
export class RtpDtmfSender {
  private socket: import("node:dgram").Socket | null = null;
  private sequence: number;
  private timestamp: number;
  private readonly ssrc: number;
  private readonly clockRate: number;
  private readonly stepMs: number;
  private readonly endPackets: number;
  private readonly target: RtpTarget;
  private readonly options: RtpDtmfOptions;

  constructor(target: RtpTarget, options: RtpDtmfOptions) {
    this.target = target;
    this.options = options;
    this.sequence = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = options.ssrc ?? Math.floor(Math.random() * 0xffffffff);
    this.clockRate = options.clockRate ?? 8000;
    this.stepMs = options.stepMs ?? 20;
    this.endPackets = options.endPackets ?? 3;
  }

  private async socketFor(): Promise<import("node:dgram").Socket> {
    if (this.socket) return this.socket;
    const dgram = await import("node:dgram");
    const socket = dgram.createSocket("udp4");
    // DTMF is fire-and-forget: an unroutable target must not crash the process.
    socket.on("error", () => undefined);
    // A softphone must not keep the process alive for DTMF traffic.
    socket.unref();
    this.socket = socket;
    return socket;
  }

  async send(digits: string, durationMs = 160): Promise<boolean> {
    const events: number[] = [];
    for (const digit of digits.toUpperCase()) {
      const code = DTMF_EVENT_CODES[digit];
      if (code === undefined) return false;
      events.push(code);
    }
    if (!events.length) return false;

    const socket = await this.socketFor();
    const samplesPerStep = Math.round((this.clockRate * this.stepMs) / 1000);
    const steps = Math.max(1, Math.round(durationMs / this.stepMs));

    const emit = (
      event: number,
      timestamp: number,
      duration: number,
      marker: boolean,
      end: boolean,
    ) => {
      const packet = buildDtmfPacket({
        payloadType: this.options.payloadType,
        sequence: this.sequence,
        timestamp,
        ssrc: this.ssrc,
        event,
        duration,
        marker,
        end,
        ...(this.options.volume === undefined ? {} : { volume: this.options.volume }),
      });
      this.sequence = (this.sequence + 1) & 0xffff;
      socket.send(packet, this.target.port, this.target.address);
    };

    for (const event of events) {
      const start = this.timestamp;
      let duration = 0;
      // RFC 4733 §2.5.1: every packet of an event carries the timestamp of the
      // event start; only the duration grows while the digit is held.
      for (let step = 0; step < steps; step++) {
        duration += samplesPerStep;
        emit(event, start, duration, step === 0, false);
        if (step + 1 < steps) await sleep(this.stepMs);
      }
      for (let index = 0; index < this.endPackets; index++) {
        emit(event, start, duration, false, true);
        if (index + 1 < this.endPackets) await sleep(this.stepMs);
      }
      // The next digit starts after this event's duration plus the inter-digit gap.
      this.timestamp = (start + duration + samplesPerStep) >>> 0;
      await sleep(this.stepMs);
    }
    return true;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}
