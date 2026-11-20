/**
 * RFC 4733 DTMF end to end, without a PBX: a local echo UAS on real loopback
 * UDP sockets answers the INVITE, echoes audio RTP and decodes the DTMF events
 * our softphone sends. This is the same path a live trunk echo test exercises
 * (INVITE → 200 OK → ACK → RTP telephone-event → BYE), so a regression in SDP
 * negotiation, RTP targeting or the event layout fails here first.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { SipStack } from "../src/sip/stack.ts";
import { UdpTransport } from "../src/sip/transport.ts";
import { EchoUas } from "./helpers/echo-uas.ts";

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${description}`);
}

test("DTMF reaches a local echo UAS as RFC 4733 events (no PBX)", async () => {
  const uas = await EchoUas.create();
  const transport = new UdpTransport(0, "127.0.0.1");
  await transport.start();

  const stack = new SipStack({
    account: {
      id: 1,
      label: "Echo UAS",
      server: `127.0.0.1:${uas.port}`,
      username: "1001",
      password: "secret",
      transport: "udp",
      audioCodecs: ["PCMA/8000/1", "PCMU/8000/1"],
      dtmfMethod: 2,
    },
    transport,
    localAddress: transport.localAddress,
    mediaAddress: "127.0.0.1",
    keepAlive: 0,
  });

  try {
    await stack.start({ register: false });
    const call = await stack.dial(`sip:echo@127.0.0.1:${uas.port}`);
    await waitFor(() => call.state === "confirmed", 4000, "call confirmed");
    assert.equal(call.snapshot.codec, "PCMA");
    // The ACK is a separate datagram; wait for it instead of assuming the
    // local state transition and its arrival are ordered.
    await waitFor(() => uas.ackReceived, 2000, "ACK at the echo UAS");

    // The UAS answered with telephone-event/8000, so the offer/answer picked
    // payload type 101 for DTMF.
    const invite = uas.requests.find((request) => request.method === "INVITE");
    assert.ok(invite);
    assert.match(invite.body, /a=rtpmap:101 telephone-event\/8000/);

    // Echo path: one audio packet in, the identical packet back out.
    const probe = createSocket("udp4");
    await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", resolve));
    try {
      const audio = Buffer.alloc(12 + 160, 0xaa);
      audio.writeUInt8(0x80, 0);
      audio.writeUInt8(0x08, 1); // PCMA
      audio.writeUInt16BE(1, 2);
      audio.writeUInt32BE(160, 4);
      audio.writeUInt32BE(0x1234, 8);
      const returned = new Promise<Buffer>((resolve) => probe.once("message", resolve));
      probe.send(audio, uas.rtpPort, "127.0.0.1");
      const echo = await Promise.race([
        returned,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("echo UAS did not return the RTP packet")), 2000),
        ),
      ]);
      assert.equal(echo.equals(audio), true, "echo UAS must return the audio unchanged");
    } finally {
      probe.close();
    }

    await call.sendDtmf("123#");
    await waitFor(() => uas.digits.length === 4, 5000, "four RFC 4733 digits");

    assert.deepEqual(uas.digits, ["1", "2", "3", "#"]);
    // The end packet is repeated (pjsua sends three), so compare the set of
    // events that carried an end bit rather than every retransmission.
    assert.deepEqual(
      [...new Set(uas.dtmfPackets.filter((packet) => packet.end).map((packet) => packet.event))],
      [1, 2, 3, 11],
    );
    assert.deepEqual(uas.infoDigits, [], "RFC 4733 mode must not also send SIP INFO");

    // Every event starts with the marker bit and ends with the end bit, all
    // packets share one SSRC and the sequence numbers are contiguous.
    const ssrc = uas.dtmfPackets[0]?.ssrc;
    for (let index = 0; index < uas.dtmfPackets.length; index++) {
      const packet = uas.dtmfPackets[index] as (typeof uas.dtmfPackets)[number];
      assert.equal(packet.ssrc, ssrc);
      assert.equal(packet.volume, 10);
      if (index > 0) {
        const previous = uas.dtmfPackets[index - 1] as (typeof uas.dtmfPackets)[number];
        assert.equal(packet.sequence, (previous.sequence + 1) & 0xffff);
      }
    }
    assert.equal(
      uas.dtmfPackets.filter((packet) => packet.marker).length,
      4,
      "one marker packet per digit",
    );
    // RFC 4733 §2.5.1: one start timestamp per digit, shared by all of its packets.
    assert.equal(new Set(uas.dtmfPackets.map((packet) => packet.timestamp)).size, 4);

    const hanging = call.hangup();
    await waitFor(() => uas.byeReceived, 3000, "BYE at the echo UAS");
    await hanging;
    assert.equal(call.state, "disconnected");
  } finally {
    await stack.stop();
    await uas.close();
  }
});
