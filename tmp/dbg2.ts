import { SipStack } from "../src/sip/stack.ts";
import { createLoopbackPair } from "../src/sip/transport.ts";
import { ScriptedUas } from "../tests/helpers/uas.ts";

const loop = createLoopbackPair(["alice.invalid", "bob.invalid"]);
const uas = new ScriptedUas(loop.b);
const stack = new SipStack({
  account: { id: 1, label: "t", server: "bob.invalid", username: "1001", password: "x", transport: "udp" },
  transport: loop.a, localAddress: "alice.invalid:5060", keepAlive: 0,
});
const call = await stack.dial("1002");
loop.flush();
await new Promise(r => setTimeout(r, 5));
console.log("uas got", uas.requests.map(m => m.method));
console.log("state", call.state);
const hanging = call.hangup();
console.log("after hangup call, sent:", loop.a.sent.map(s => s.split("\r\n")[0]));
loop.flush();
await new Promise(r => setTimeout(r, 5));
console.log("uas got2", uas.requests.map(m => m.method));
process.exit(0);
