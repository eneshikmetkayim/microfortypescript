import test from "node:test";
import assert from "node:assert/strict";
import { SipStack } from "../src/sip/stack.ts";
import { createLoopbackPair } from "../src/sip/transport.ts";
import { ScriptedUas } from "./helpers/uas.ts";

const DIGEST_CHALLENGE =
  'Digest realm="bob.invalid", nonce="abcdef012345", qop="auth", algorithm=MD5';

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

async function pump(
  flush: () => void,
  predicate: () => boolean,
  attempts = 8,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    flush();
    await tick();
    if (predicate()) return;
  }
}

function makeStack(challenge = true) {
  const loop = createLoopbackPair(["alice.invalid", "bob.invalid"]);
  const uas = new ScriptedUas(loop.b);
  const stack = new SipStack({
    account: {
      id: 1,
      label: "Test",
      server: "bob.invalid",
      username: "1001",
      password: "secret",
      displayName: "Test User",
      transport: "udp",
      audioCodecs: ["PCMA/8000/1", "PCMU/8000/1"],
    },
    transport: loop.a,
    localAddress: "alice.invalid:5060",
    mediaAddress: "127.0.0.1",
    keepAlive: 0,
  });

  uas.handler = ({ message, from }, u) => {
    if (message.method !== "REGISTER") return;
    if (challenge && !message.header("authorization")) {
      u.reply(message, 401, {
        toTag: "reg-tag",
        extra: [["WWW-Authenticate", DIGEST_CHALLENGE]],
        from,
      });
      return;
    }
    u.reply(message, 200, {
      toTag: "reg-tag",
      extra: [["Contact", "<sip:1001@alice.invalid:5060>;expires=120"]],
      from,
    });
  };

  return { ...loop, uas, stack };
}

test("REGISTER retries with a digest Authorization and becomes registered", async () => {
  const { flush, uas, stack } = makeStack();
  const starting = stack.start();
  await pump(flush, () => stack.registration.snapshot.state === "registered");
  await starting;

  assert.equal(stack.registration.snapshot.state, "registered");
  assert.equal(stack.registration.snapshot.expires, 120);

  const registers = uas.requestsOf("REGISTER");
  assert.equal(registers.length, 2);
  const first = registers[0] as (typeof registers)[number];
  const second = registers[1] as (typeof registers)[number];
  assert.equal(first.header("authorization"), undefined);
  const auth = second.header("authorization") ?? "";
  assert.match(auth, /^Digest username="1001"/);
  assert.match(auth, /realm="bob\.invalid"/);
  assert.match(auth, /qop=auth/);
  assert.match(auth, /nc=00000001/);
  assert.match(auth, /uri="sip:bob\.invalid"/);
  assert.equal(second.callId, first.callId, "REGISTER retry keeps the Call-ID");
  assert.equal(second.header("contact")?.includes("expires=300"), true);
  assert.match(second.header("user-agent") ?? "", /MicroSIP\/3\.23\.5/);

  await stopStack(stack, flush);
});

test("failed registration reports the SIP reason", async () => {
  const loop = createLoopbackPair(["alice.invalid", "bob.invalid"]);
  const uas = new ScriptedUas(loop.b);
  const stack = new SipStack({
    account: { id: 1, label: "T", server: "bob.invalid", username: "1001", password: "x" },
    transport: loop.a,
    localAddress: "alice.invalid:5060",
    keepAlive: 0,
  });
  uas.handler = ({ message, from }, u) => u.reply(message, 403, { toTag: "t", from });

  const starting = stack.start();
  await pump(loop.flush, () => stack.registration.snapshot.state === "failed");
  await starting;

  assert.equal(stack.registration.snapshot.state, "failed");
  assert.equal(stack.registration.snapshot.reason, "403 Forbidden");
  await stopStack(stack, loop.flush);
});

test("unregister sends Contact expires=0", async () => {
  const { flush, uas, stack } = makeStack();
  const starting = stack.start();
  await pump(flush, () => stack.registration.snapshot.state === "registered");
  await starting;

  const unregistering = stack.registration.unregister();
  await pump(flush, () => uas.requestsOf("REGISTER").length >= 3);
  await unregistering;

  const last = uas.requestsOf("REGISTER").at(-1);
  assert.ok(last);
  assert.match(last.header("contact") ?? "", /expires=0/);
  assert.equal(stack.registration.snapshot.state, "unregistered");
  await stopStack(stack, flush);
});
