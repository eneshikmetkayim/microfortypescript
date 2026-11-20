import test from "node:test";
import assert from "node:assert/strict";
import { SipStack } from "../src/sip/stack.ts";
import { createLoopbackPair } from "../src/sip/transport.ts";
import { SipMessage } from "../src/sip/message.ts";
import { createSocket } from "node:dgram";
import type { Call } from "../src/sip/call.ts";
import { answerSdp, ScriptedUas, OFFER_SDP } from "./helpers/uas.ts";

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function pump(flush: () => void, predicate: () => boolean, attempts = 8): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    flush();
    await tick();
    if (predicate()) return;
  }
}

async function stopStack(stack: SipStack, flush: () => void): Promise<void> {
  stack.registration.stop();
  const stopping = stack.stop();
  for (let i = 0; i < 3; i++) {
    flush();
    await tick();
  }
  await stopping;
}

function setup(
  options: { autoAnswer?: boolean; reject?: number; dtmfMethod?: number; answerPort?: number } = {},
) {
  const autoAnswer = options.autoAnswer ?? true;
  const answerPort = options.answerPort ?? 4200;
  const loop = createLoopbackPair(["alice.invalid", "bob.invalid"]);
  const uas = new ScriptedUas(loop.b);
  const stack = new SipStack({
    account: {
      id: 1,
      label: "Test",
      server: "bob.invalid",
      username: "1001",
      password: "secret",
      displayName: "Alice",
      transport: "udp",
      audioCodecs: ["PCMA/8000/1", "PCMU/8000/1"],
      ...(options.dtmfMethod === undefined ? {} : { dtmfMethod: options.dtmfMethod }),
    },
    transport: loop.a,
    localAddress: "alice.invalid:5060",
    mediaAddress: "192.0.2.10",
    mediaPort: 4000,
    keepAlive: 0,
  });

  uas.handler = ({ message, from }, u) => {
    if (message.method === "INVITE" && !message.toTag) {
      if (options.reject) {
        u.reply(message, options.reject, { from });
        return;
      }
      if (!autoAnswer) return;
      u.reply(message, 180, { from });
      u.reply(message, 200, { sdp: answerSdp(answerPort), from });
      return;
    }
    if (message.method === "INVITE") {
      u.reply(message, 200, { sdp: answerSdp(4210), from });
      return;
    }
    if (["BYE", "INFO", "OPTIONS", "MESSAGE", "NOTIFY", "REFER"].includes(message.method ?? "")) {
      u.reply(message, 200, { from });
    }
  };

  return { ...loop, uas, stack };
}

test("outgoing call reaches CONFIRMED, negotiates PCMA and ACKs", async () => {
  const { flush, uas, stack } = setup();
  const call = await stack.dial("1002");
  assert.equal(call.state, "calling");

  await pump(flush, () => call.state === "confirmed");
  assert.equal(call.state, "confirmed");
  assert.equal(call.snapshot.direction, "out");
  assert.equal(call.snapshot.remoteUser, "1002");
  assert.equal(call.snapshot.codec, "PCMA");
  assert.ok(call.snapshot.connectTime);

  const invite = uas.requestsOf("INVITE")[0] as SipMessage;
  assert.match(invite.body, /m=audio 4000 RTP\/AVP/);
  assert.match(invite.body, /a=rtpmap:8 PCMA\/8000/);
  assert.equal(invite.header("contact"), "<sip:1001@alice.invalid:5060>");

  flush();
  await tick();
  const ack = uas.requestsOf("ACK")[0];
  assert.ok(ack);
  assert.equal(ack.cseq?.seq, 1);
  assert.equal(ack.branch !== invite.branch, true);

  const statuses: string[] = [];
  call.events.on("state", (snapshot) => statuses.push(snapshot.state));
  const hanging = call.hangup();
  await pump(flush, () => call.state === "disconnected");
  await hanging;
  assert.equal(call.state, "disconnected");
  assert.equal(uas.requestsOf("BYE").length, 1);
  assert.deepEqual(statuses, ["disconnected"]);

  await stopStack(stack, flush);
});

test("busy response ends the call with the SIP reason", async () => {
  const { flush, stack } = setup({ reject: 486 });
  const call = await stack.dial("1002");
  await pump(flush, () => call.state === "disconnected");
  assert.equal(call.state, "disconnected");
  assert.equal(call.snapshot.lastStatus, 486);
  assert.equal(call.snapshot.reason, "486 Busy Here");
  await stopStack(stack, flush);
});

test("CANCEL before answer terminates the call and the INVITE", async () => {
  const { flush, uas, stack } = setup({ autoAnswer: false });
  const call = await stack.dial("1002");
  flush();
  await tick();
  assert.equal(uas.requestsOf("INVITE").length, 1);

  const invite = uas.requestsOf("INVITE")[0] as SipMessage;
  const hanging = call.hangup();
  flush();
  await tick();

  const cancel = uas.requestsOf("CANCEL")[0];
  assert.ok(cancel, "CANCEL must be sent for a pending INVITE");
  assert.equal(cancel.branch, invite.branch);

  uas.reply(cancel, 200, { from: uas.targetFor(cancel) });
  uas.reply(invite, 487, { from: uas.targetFor(invite) });
  flush();
  await tick();
  await hanging;

  assert.equal(call.state, "disconnected");
  assert.equal(call.snapshot.reason, "Call cancelled");
  await stopStack(stack, flush);
});

test("incoming call rings, answers, confirms on ACK and ends on BYE", async () => {
  const { flush, uas, stack } = setup();
  const incoming: Call[] = [];
  stack.events.on("incomingCall", (call) => incoming.push(call));

  const target = { host: "alice.invalid", port: 5060 };
  const invite = uas.inviteTo(target);
  uas.send(invite, target);
  flush();
  await tick();

  assert.equal(incoming.length, 1);
  const call = incoming[0] as Call;
  assert.equal(call.state, "early");
  assert.equal(call.direction, "in");
  assert.equal(call.snapshot.remoteUser, "1002");
  assert.equal(call.snapshot.remoteDisplayName, "Caller");

  const ringing = uas.responseTo("INVITE", 180);
  assert.ok(ringing);
  assert.match(ringing.header("to") ?? "", /;tag=/);

  const answering = stack.answer();
  await pump(flush, () => uas.responseTo("INVITE", 200) !== undefined);
  await answering;

  const ok = uas.responseTo("INVITE", 200) as SipMessage;
  assert.match(ok.body, /m=audio 4000 RTP\/AVP 8 0 101/);
  assert.equal(call.state, "connecting");

  const ack = SipMessage.request("ACK", `sip:1001@alice.invalid:5060`);
  ack.addHeader("Max-Forwards", "70");
  ack.addHeader("To", ok.header("to") ?? "");
  ack.addHeader("From", invite.header("from") ?? "");
  ack.addHeader("Call-ID", invite.callId ?? "");
  ack.addHeader("CSeq", "1 ACK");
  uas.send(ack, target);
  flush();
  await tick();
  assert.equal(call.state, "confirmed");
  assert.ok(call.snapshot.connectTime);

  const bye = SipMessage.request("BYE", "sip:1001@alice.invalid:5060");
  bye.addHeader("Max-Forwards", "70");
  bye.addHeader("To", ok.header("to") ?? "");
  bye.addHeader("From", invite.header("from") ?? "");
  bye.addHeader("Call-ID", invite.callId ?? "");
  bye.addHeader("CSeq", "2 BYE");
  uas.send(bye, target);
  flush();
  await tick();
  assert.equal(call.state, "disconnected");
  assert.equal(call.snapshot.reason, "Remote hangup");

  await stopStack(stack, flush);
});

test("declining an incoming call sends 486", async () => {
  const { flush, uas, stack } = setup();
  const incoming: Call[] = [];
  stack.events.on("incomingCall", (call) => incoming.push(call));

  const target = { host: "alice.invalid", port: 5060 };
  const invite = uas.inviteTo(target);
  uas.send(invite, target);
  flush();
  await tick();

  (incoming[0] as Call).decline(486);
  flush();
  await tick();
  assert.equal((incoming[0] as Call).state, "disconnected");
  const busy = uas.responseTo("INVITE", 486);
  assert.ok(busy);
  await stopStack(stack, flush);
});

test("hold re-INVITEs with sendonly, DTMF uses INFO when configured, and transfer sends REFER", async () => {
  const { flush, uas, stack } = setup({ dtmfMethod: 1 });
  const call = await stack.dial("1002");
  await pump(flush, () => call.state === "confirmed");

  const holding = call.hold();
  await pump(flush, () => uas.requestsOf("INVITE").some((m) => m.toTag));
  await holding;
  const reinvite = uas.requestsOf("INVITE").find((m) => m.toTag);
  assert.ok(reinvite);
  assert.match(reinvite.body, /a=sendonly/);
  assert.equal(call.snapshot.held, true);

  const dtmf = call.sendDtmf("12");
  await pump(flush, () => uas.requestsOf("INFO").length >= 2);
  await dtmf;
  const infos = uas.requestsOf("INFO");
  assert.equal(infos.length, 2);
  assert.equal(infos[0]?.header("content-type"), "application/dtmf-relay");
  assert.match(infos[0]?.body ?? "", /Signal=1/);
  assert.match(infos[1]?.body ?? "", /Signal=2/);

  const transferring = call.transfer("sip:1003@bob.invalid");
  await pump(flush, () => uas.requestsOf("REFER").length === 1);
  await transferring;
  const refer = uas.requestsOf("REFER")[0];
  assert.equal(refer?.header("refer-to"), "<sip:1003@bob.invalid>");

  await stopStack(stack, flush);
});

test("DTMF goes out as RFC 4733 events when telephone-event is negotiated", async () => {
  const listener = createSocket("udp4");
  const packets: Buffer[] = [];
  listener.on("message", (buffer) => packets.push(buffer));
  await new Promise<void>((resolve) => listener.bind(0, "127.0.0.1", resolve));
  const answerPort = listener.address().port;

  const { flush, uas, stack } = setup({ answerPort });
  try {
    const call = await stack.dial("1002");
    await pump(flush, () => call.state === "confirmed");

    await call.sendDtmf("5");

    assert.ok(packets.length >= 4, `expected RFC 4733 packets, got ${packets.length}`);
    const first = packets[0] as Buffer;
    assert.equal(first.readUInt8(0) >> 6, 2); // RTP version
    assert.equal(first.readUInt8(1) & 0x7f, 101); // negotiated telephone-event payload
    assert.equal(first.readUInt8(1) & 0x80, 0x80); // marker on the first packet of the event
    assert.equal(first.readUInt8(12), 5); // event code for digit 5
    const last = packets[packets.length - 1] as Buffer;
    assert.equal(last.readUInt8(12), 5);
    assert.equal(last.readUInt8(13) & 0x80, 0x80); // end bit
    assert.equal(uas.requestsOf("INFO").length, 0);
  } finally {
    listener.close();
    await stopStack(stack, flush);
  }
});

test("incoming INFO raises DTMF events", async () => {
  const { flush, uas, stack } = setup();
  const incoming: Call[] = [];
  stack.events.on("incomingCall", (call) => incoming.push(call));
  const target = { host: "alice.invalid", port: 5060 };
  const invite = uas.inviteTo(target);
  uas.send(invite, target);
  flush();
  await tick();

  const call = incoming[0] as Call;
  const digits: string[] = [];
  call.events.on("dtmf", (event) => digits.push(event.digit));

  const info = SipMessage.request("INFO", "sip:1001@alice.invalid:5060");
  info.addHeader("Max-Forwards", "70");
  info.addHeader("To", `<sip:1001@alice.invalid>;tag=alice-local`);
  info.addHeader("From", invite.header("from") ?? "");
  info.addHeader("Call-ID", invite.callId ?? "");
  info.addHeader("CSeq", "2 INFO");
  info.addHeader("Content-Type", "application/dtmf-relay");
  info.body = "Signal=7\r\nDuration=160\r\n";
  uas.send(info, target);
  flush();
  await tick();
  assert.deepEqual(digits, ["7"]);
  await stopStack(stack, flush);
});

test("OPTIONS and MESSAGE are answered at stack level", async () => {
  const { flush, uas, stack } = setup();
  const target = { host: "alice.invalid", port: 5060 };

  const options = SipMessage.request("OPTIONS", "sip:1001@alice.invalid");
  options.addHeader("To", "<sip:1001@alice.invalid>");
  options.addHeader("From", "<sip:1002@bob.invalid>;tag=opt");
  options.addHeader("Call-ID", "options-1");
  options.addHeader("CSeq", "1 OPTIONS");
  uas.send(options, target);
  flush();
  await tick();
  assert.equal(uas.responseTo("OPTIONS", 200)?.header("allow")?.includes("INVITE"), true);

  const message = SipMessage.request("MESSAGE", "sip:1001@alice.invalid");
  message.addHeader("To", "<sip:1001@alice.invalid>");
  message.addHeader("From", "<sip:1002@bob.invalid>;tag=msg");
  message.addHeader("Call-ID", "message-1");
  message.addHeader("CSeq", "1 MESSAGE");
  message.addHeader("Content-Type", "text/plain");
  message.body = "merhaba";
  uas.send(message, target);
  flush();
  await tick();
  assert.equal(uas.responseTo("MESSAGE", 200) !== undefined, true);
  await stopStack(stack, flush);
});

test("media negotiation ignores an unknown offer direction", async () => {
  const { flush, uas, stack } = setup();
  const call = await stack.dial("1002");
  await pump(flush, () => call.state === "confirmed");
  assert.ok(OFFER_SDP.includes("a=sendrecv"));
  assert.deepEqual(call.negotiatedCodecs, ["PCMA", "TELEPHONE-EVENT"]);
  await stopStack(stack, flush);
});
