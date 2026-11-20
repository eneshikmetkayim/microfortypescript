import test from "node:test";
import assert from "node:assert/strict";
import { createSocket, type Socket } from "node:dgram";
import { buildDtmfPacket, DTMF_EVENT_CODES, RtpDtmfSender } from "../src/sip/rtp.ts";

test("RFC 4733 packets carry a valid RTP header and event block", () => {
  const packet = buildDtmfPacket({
    payloadType: 101,
    sequence: 0x1234,
    timestamp: 0xdeadbeef,
    ssrc: 0x01020304,
    event: 5,
    duration: 320,
    marker: true,
  });

  assert.equal(packet.length, 16);
  assert.equal(packet.readUInt8(0), 0x80); // version 2, no padding/extension
  assert.equal(packet.readUInt8(1), 0x80 | 101); // marker bit plus payload type
  assert.equal(packet.readUInt16BE(2), 0x1234);
  assert.equal(packet.readUInt32BE(4), 0xdeadbeef);
  assert.equal(packet.readUInt32BE(8), 0x01020304);
  assert.equal(packet.readUInt8(12), 5); // event code
  assert.equal(packet.readUInt8(13) & 0x3f, 10); // default volume
  assert.equal(packet.readUInt8(13) & 0x80, 0); // end bit clear while the digit is held
  assert.equal(packet.readUInt16BE(14), 320);

  const ended = buildDtmfPacket({
    payloadType: 101,
    sequence: 1,
    timestamp: 1,
    ssrc: 1,
    event: 5,
    duration: 320,
    end: true,
  });
  assert.equal(ended.readUInt8(13) & 0x80, 0x80);
  assert.equal(ended.readUInt8(1) & 0x80, 0); // no marker on continuations
});

test("digit to event mapping covers the keypad and A-D", () => {
  assert.equal(DTMF_EVENT_CODES["0"], 0);
  assert.equal(DTMF_EVENT_CODES["9"], 9);
  assert.equal(DTMF_EVENT_CODES["*"], 10);
  assert.equal(DTMF_EVENT_CODES["#"], 11);
  assert.equal(DTMF_EVENT_CODES["A"], 12);
  assert.equal(DTMF_EVENT_CODES["d"], undefined);
  assert.equal(DTMF_EVENT_CODES["D"], 15);
});

async function listener(): Promise<{ socket: Socket; port: number; packets: Buffer[] }> {
  const socket = createSocket("udp4");
  const packets: Buffer[] = [];
  socket.on("message", (buffer) => packets.push(buffer));
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { socket, port: socket.address().port, packets };
}

test("sender emits marker, rising timestamps and a repeated end bit", async () => {
  const { socket, port, packets } = await listener();
  const sender = new RtpDtmfSender({ address: "127.0.0.1", port }, { payloadType: 101, ssrc: 42 });
  try {
    assert.equal(await sender.send("5", 40), true);
    assert.equal(packets.length, 2 + 3); // two 20 ms steps plus three end packets

    const first = packets[0] as Buffer;
    assert.equal(first.readUInt8(1) & 0x80, 0x80); // marker on the first packet only
    assert.equal(first.readUInt8(12), 5);
    assert.equal(first.readUInt16BE(14), 160);
    assert.equal((packets[1] as Buffer).readUInt16BE(14), 320);
    assert.equal((packets[1] as Buffer).readUInt8(1) & 0x80, 0);

    const last = packets[packets.length - 1] as Buffer;
    assert.equal(last.readUInt8(13) & 0x80, 0x80);
    assert.equal(last.readUInt16BE(14), 320);
    assert.equal(last.readUInt32BE(8), 42);

    const sequences = packets.map((packet) => packet.readUInt16BE(2));
    for (let index = 1; index < sequences.length; index++) {
      assert.equal((sequences[index] as number) & 0xffff, ((sequences[index - 1] as number) + 1) & 0xffff);
    }
  } finally {
    sender.close();
    socket.close();
  }
});

test("sender rejects characters that are not DTMF digits", async () => {
  const { socket, port, packets } = await listener();
  const sender = new RtpDtmfSender({ address: "127.0.0.1", port }, { payloadType: 101 });
  try {
    assert.equal(await sender.send("5x"), false);
    assert.equal(packets.length, 0);
  } finally {
    sender.close();
    socket.close();
  }
});
