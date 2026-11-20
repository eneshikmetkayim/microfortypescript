/**
 * Scripted UAS/UAC used by the conformance suites. It speaks real SIP bytes
 * over the loopback transport, so every test exercises parsing, transaction
 * matching and dialog handling — not mocks of our own abstractions.
 */

import { buildResponse, parseMessage, SipMessage } from "../../src/sip/message.ts";
import type { LoopbackTransport, RemoteTarget } from "../../src/sip/transport.ts";
import { parseNameAddr } from "../../src/sip/uri.ts";

export const OFFER_SDP = [
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

export function answerSdp(port = 4200): string {
  return [
    "v=0",
    "o=- 2 2 IN IP4 127.0.0.1",
    "s=-",
    "c=IN IP4 127.0.0.1",
    "t=0 0",
    "m=audio " + port + " RTP/AVP 8 101",
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:101 telephone-event/8000",
    "a=fmtp:101 0-15",
    "a=sendrecv",
    "",
  ].join("\r\n");
}

export interface UasRequest {
  message: SipMessage;
  from: RemoteTarget;
}

export type UasHandler = (request: UasRequest, uas: ScriptedUas) => void;

export class ScriptedUas {
  readonly requests: SipMessage[] = [];
  readonly responses: SipMessage[] = [];
  readonly sent: string[] = [];
  handler: UasHandler | null = null;
  toTag = "uas-tag-1";

  readonly transport: LoopbackTransport;

  constructor(transport: LoopbackTransport) {
    this.transport = transport;
    transport.setHandler(({ raw, from }) => {
      let message: SipMessage;
      try {
        message = parseMessage(raw);
      } catch {
        return;
      }
      if (message.startLine.kind === "response") this.responses.push(message);
      else this.requests.push(message);
      this.handler?.({ message, from }, this);
    });
  }

  get last(): SipMessage | undefined {
    return this.requests[this.requests.length - 1];
  }

  requestsOf(method: string): SipMessage[] {
    return this.requests.filter((r) => r.method === method);
  }

  reply(
    request: SipMessage,
    status: number,
    options: {
      toTag?: string;
      sdp?: string;
      extra?: Array<[string, string]>;
      from?: RemoteTarget;
    } = {},
  ): void {
    const response = buildResponse(request, status, {
      toTag: options.toTag ?? this.toTag,
      contact: `<sip:1002@${this.transport.localAddress}:5060>`,
      sdp: options.sdp,
      extraHeaders: options.extra,
    });
    this.send(response, options.from ?? this.targetFor(request));
  }

  send(message: SipMessage, target: RemoteTarget): void {
    if (message.startLine.kind === "request" && !message.header("via")) {
      // Real UACs always send a Via; the helper adds one so the SUT can reply.
      message.addHeader(
        "Via",
        `SIP/2.0/UDP ${this.transport.localAddress}:5060;branch=z9hG4bK${Math.random().toString(16).slice(2, 12)}`,
      );
    }
    this.sent.push(message.toString());
    this.transport.send(message.toString(), target);
  }

  responseTo(method: string, status: number): SipMessage | undefined {
    return this.responses.find(
      (response) => response.status === status && response.cseq?.method === method,
    );
  }

  /** Sends an in-dialog request using the stored INVITE as dialog state. */
  dialogRequest(
    invite: SipMessage,
    method: string,
    options: { cseq?: number; body?: string; contentType?: string; extra?: Array<[string, string]> } = {},
  ): SipMessage {
    const from = invite.header("from") ?? "";
    const to = invite.header("to") ?? "";
    const parsed = parseNameAddr(from);
    const remoteUri = `${parsed.uri.scheme}:${parsed.uri.user ?? ""}@${parsed.uri.host}`;
    const request = SipMessage.request(method, remoteUri);
    request.addHeader("Max-Forwards", "70");
    request.addHeader("To", `${from}`);
    request.addHeader("From", `${to};tag=${this.toTag}`);
    request.addHeader("Call-ID", invite.callId ?? "");
    request.addHeader("CSeq", `${options.cseq ?? 2} ${method}`);
    if (options.contentType) request.addHeader("Content-Type", options.contentType);
    for (const [name, value] of options.extra ?? []) request.addHeader(name, value);
    if (options.body) request.body = options.body;
    return request;
  }

  targetFor(request: SipMessage): RemoteTarget {
    const via = request.header("via") ?? "";
    const sentBy = /SIP\/2\.0\/\S+\s+([^;\s]+)/.exec(via)?.[1] ?? "127.0.0.1:5060";
    const [host, port] = sentBy.split(":");
    return { host: host as string, port: Number(port ?? 5060) };
  }

  /** Builds a fresh out-of-dialog INVITE towards the SUT. */
  inviteTo(
    target: RemoteTarget,
    options: {
      callId?: string;
      fromUser?: string;
      toUser?: string;
      sdp?: string;
      cseq?: number;
    } = {},
  ): SipMessage {
    const callId = options.callId ?? `uas-${Math.random().toString(16).slice(2)}`;
    const fromUser = options.fromUser ?? "1002";
    const toUser = options.toUser ?? "1001";
    const request = SipMessage.request("INVITE", `sip:${toUser}@${target.host}`);
    request.addHeader("Max-Forwards", "70");
    request.addHeader("From", `"Caller" <sip:${fromUser}@${target.host}>;tag=from-tag-1`);
    request.addHeader("To", `<sip:${toUser}@${target.host}>`);
    request.addHeader("Call-ID", callId);
    request.addHeader("CSeq", `${options.cseq ?? 1} INVITE`);
    request.addHeader("Contact", `<sip:${fromUser}@${this.transport.localAddress}:5060>`);
    request.addHeader("Content-Type", "application/sdp");
    request.body = options.sdp ?? OFFER_SDP;
    return request;
  }
}
