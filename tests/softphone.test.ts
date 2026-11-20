import test from "node:test";
import assert from "node:assert/strict";
import { createLoopbackPair } from "../src/sip/transport.ts";
import { loadMicroSipSettings } from "../src/core/settings.ts";
import { Softphone } from "../src/core/softphone.ts";
import { CallLog, CALL_TYPE } from "../src/core/calllog.ts";
import { Contacts } from "../src/core/contacts.ts";
import { answerSdp, ScriptedUas } from "./helpers/uas.ts";
import type { HookInvocation } from "../src/core/commands.ts";

const INI = [
  "[Settings]",
  "accountId=1",
  "audioCodecs=PCMA/8000/1 PCMU/8000/1",
  "cmdOutgoingCall=http://crm.local/out?number={number}&callid={callid}",
  "cmdIncomingCall=http://crm.local/in?number={number}",
  "cmdCallStart=http://crm.local/start?callid={callid}",
  "cmdCallEnd=http://crm.local/end?callid={callid}&duration={duration}",
  "",
  "[Account1]",
  "label=Test",
  "server=bob.invalid",
  "username=1001",
  "password=secret",
  "displayName=Alice",
  "",
].join("\r\n");

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function pump(flush: () => void, predicate: () => boolean, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    flush();
    await tick();
    if (predicate()) return;
  }
}

async function setup() {
  const loop = createLoopbackPair(["alice.invalid", "bob.invalid"]);
  const uas = new ScriptedUas(loop.b);
  const hooks: HookInvocation[] = [];
  const settings = loadMicroSipSettings(INI);
  const callLog = new CallLog();
  const contacts = new Contacts(callLog.db);
  contacts.add({ number: "1002", name: "Ayşe", info: "" });

  const phone = new Softphone({
    settings,
    transport: loop.a,
    localAddress: "alice.invalid:5060",
    mediaAddress: "192.0.2.10",
    callLog,
    contacts,
    onHook: (hook) => hooks.push(hook),
  });

  uas.handler = ({ message, from }, u) => {
    if (message.method === "REGISTER") {
      u.reply(message, 200, {
        from,
        extra: [["Contact", `<sip:1001@alice.invalid:5060>;expires=120`]],
      });
      return;
    }
    if (message.method === "INVITE" && !message.toTag) {
      u.reply(message, 180, { from });
      u.reply(message, 200, { sdp: answerSdp(), from });
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

  return { ...loop, uas, phone, hooks, callLog };
}

async function startPhone(phone: Softphone, flush: () => void): Promise<void> {
  const starting = phone.start();
  await pump(flush, () => phone.registration.state === "registered" || phone.registration.state === "failed");
  await starting;
}

async function stopPhone(phone: Softphone, flush: () => void): Promise<void> {
  const stopping = phone.stop();
  for (let i = 0; i < 3; i++) {
    flush();
    await tick();
  }
  await stopping;
}

test("softphone registers, dials, logs the call and fires hooks", async () => {
  const { flush, uas, phone, hooks, callLog } = await setup();
  await startPhone(phone, flush);
  assert.equal(phone.registration.state, "registered");

  const call = await phone.dial("1002");
  await pump(flush, () => call.state === "confirmed");
  assert.equal(call.state, "confirmed");
  assert.match(call.remoteUri, /1002/);

  const hanging = phone.hangup();
  await pump(flush, () => uas.requestsOf("BYE").length === 1);
  await hanging;
  flush();
  await tick();

  const history = phone.history;
  assert.equal(history.length, 1);
  const record = history[0];
  assert.ok(record);
  assert.equal(record.number, "1002");
  assert.equal(record.name, "Ayşe", "contact name labels the call log row");
  assert.equal(record.type, CALL_TYPE.outgoing);
  assert.match(record.info, /PCMA/);

  const hookNames = hooks.map((hook) => new URL(hook.command).pathname);
  assert.deepEqual(hookNames.slice(0, 3), ["/out", "/start", "/end"]);
  assert.match(hooks[0]?.command ?? "", /number=1002/);
  assert.ok(callLog.count() >= 1);

  await stopPhone(phone, flush);
});

test("declined incoming call is logged as missed", async () => {
  const { flush, uas, phone } = await setup();
  await startPhone(phone, flush);

  const incoming: string[] = [];
  phone.events.on("incomingCall", (snapshot) => incoming.push(snapshot.remoteUser));

  const target = { host: "alice.invalid", port: 5060 };
  const invite = uas.inviteTo(target, { fromUser: "1009", toUser: "1001" });
  uas.send(invite, target);
  await pump(flush, () => incoming.length === 1);
  assert.deepEqual(incoming, ["1009"]);

  const hanging = phone.hangup();
  await pump(flush, () => uas.responseTo("INVITE", 486) !== undefined);
  await hanging;
  flush();
  await tick();

  const record = phone.history[0];
  assert.ok(record);
  assert.equal(record.type, CALL_TYPE.missed);
  assert.equal(record.number, "1009");
  await stopPhone(phone, flush);
});

test("blocked dial plan numbers never reach the network", async () => {
  const { phone, flush } = await setup();
  phone.account.dialPlan = "0|00";
  await startPhone(phone, flush);
  await assert.rejects(phone.dial("9999"), /dial plan/);
  assert.equal(phone.activeCalls.length, 0);
  await stopPhone(phone, flush);
});

test("msip: command verbs map to call actions", async () => {
  const { phone, flush } = await setup();
  await startPhone(phone, flush);
  const call = await phone.dial("1002");
  await pump(flush, () => call.state === "confirmed");

  const holding = phone.command("msip:hold");
  await pump(flush, () => call.snapshot.held);
  assert.equal(await holding, "true");
  assert.equal(call.snapshot.held, true);

  const hangingUp = phone.command("msip:hangupall");
  await pump(flush, () => call.state === "disconnected");
  await hangingUp;
  assert.equal(await phone.command("msip:unknown"), "unsupported: unknown");
  await stopPhone(phone, flush);
});
