import { createLoopbackPair } from "../src/sip/transport.ts";
import { parseMessage, buildResponse } from "../src/sip/message.ts";

const loop = createLoopbackPair(["alice.invalid", "bob.invalid"]);
loop.a.setHandler(({ raw, from }) => console.log("ALICE GOT:", raw.split("\r\n")[0], "from", from));
loop.b.setHandler(({ raw, from }) => {
  console.log("BOB GOT:", raw.split("\r\n")[0], "from", from, "branch", parseMessage(raw).branch);
  const response = buildResponse(parseMessage(raw), 180, { toTag: "t1" });
  console.log("RESP:", JSON.stringify(response.toString().slice(0, 120)));
  loop.b.send(response.toString(), from);
});
loop.a.send("INVITE sip:1002@bob.invalid SIP/2.0\r\nVia: SIP/2.0/UDP alice.invalid:5060;branch=z9hG4bK1\r\nFrom: <sip:1001@alice.invalid>;tag=a\r\nTo: <sip:1002@bob.invalid>\r\nCall-ID: c1\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n", { host: "bob.invalid", port: 5060 });
console.log("queued, flushing");
loop.flush();
console.log("done");
