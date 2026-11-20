import test from "node:test";
import assert from "node:assert/strict";
import { FakeTimers } from "../src/util/clock.ts";
import { TransactionLayer, TransactionTimeoutError, newBranch } from "../src/sip/transaction.ts";
import { buildResponse, parseMessage, SipMessage } from "../src/sip/message.ts";
import type { RemoteTarget, SipTransport, TransportHandler } from "../src/sip/transport.ts";

class CaptureTransport implements SipTransport {
  readonly kind = "udp" as const;
  readonly reliable = false;
  readonly localAddress = "10.0.0.10:5060";
  sent: Array<{ raw: string; target: RemoteTarget }> = [];
  handler: TransportHandler | null = null;

  send(raw: string, target: RemoteTarget): void {
    this.sent.push({ raw, target });
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  close(): void {}

  get messages(): SipMessage[] {
    return this.sent.map((entry) => parseMessage(entry.raw));
  }
}

function request(method: string, targetMethod = method): SipMessage {
  const message = SipMessage.request(method, "sip:bob@10.0.0.20:5060");
  message.addHeader("Max-Forwards", "70");
  message.addHeader("To", "<sip:bob@10.0.0.20>");
  message.addHeader("From", "<sip:alice@10.0.0.10>;tag=alice-tag");
  message.addHeader("Call-ID", "tx-test-call");
  message.addHeader("CSeq", `1 ${targetMethod}`);
  return message;
}

test("retransmits INVITE with Timer A backoff and times out with 408", async () => {
  const timers = new FakeTimers();
  const transport = new CaptureTransport();
  const layer = new TransactionLayer(transport, { timers, t1: 500, t2: 4000, timeout: 4000 });

  const pending = layer.send(request("INVITE"), { target: { host: "10.0.0.20", port: 5060 } });
  assert.equal(transport.sent.length, 1);

  timers.advance(4000);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof TransactionTimeoutError);
    assert.equal((error as TransactionTimeoutError).status, 408);
    return true;
  });
  // t=0, 500, 1500, 3500 then Timer B at 4000.
  assert.equal(transport.sent.length, 4);
  assert.equal(layer.pendingCount, 0);
});

test("reliable transports are not retransmitted", async () => {
  const timers = new FakeTimers();
  const transport = new CaptureTransport();
  Object.defineProperty(transport, "reliable", { value: true });
  const layer = new TransactionLayer(transport, { timers, timeout: 2000 });

  const pending = layer.send(request("OPTIONS"), { target: { host: "10.0.0.20", port: 5060 } });
  timers.advance(1999);
  assert.equal(transport.sent.length, 1);
  timers.advance(1);
  await assert.rejects(pending, /timed out/);
});

test("a response resolves the transaction and stops timers", async () => {
  const timers = new FakeTimers();
  const transport = new CaptureTransport();
  const layer = new TransactionLayer(transport, { timers, t1: 500, timeout: 8000 });

  const pending = layer.send(request("REGISTER"), { target: { host: "10.0.0.20", port: 5060 } });
  const sent = transport.messages[0] as SipMessage;
  const ok = buildResponse(sent, 200, { toTag: "bob-tag", extraHeaders: [["Expires", "60"]] });

  assert.equal(layer.handle(ok), true);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(timers.pending, 0);
  assert.equal(transport.sent.length, 1);
});

test("responses with a foreign branch are ignored", async () => {
  const timers = new FakeTimers();
  const transport = new CaptureTransport();
  const layer = new TransactionLayer(transport, { timers, timeout: 2000 });
  const pending = layer.send(request("OPTIONS"), { target: { host: "10.0.0.20", port: 5060 } });

  const sent = transport.messages[0] as SipMessage;
  const foreign = buildResponse(sent, 200, { toTag: "x" });
  const via = foreign.header("via") ?? "";
  foreign.setHeader("Via", via.replace(/branch=[^;]+/, `branch=${newBranch()}`));
  assert.equal(layer.handle(foreign), true);
  assert.equal(layer.pendingCount, 1);

  timers.advance(2000);
  await assert.rejects(pending, /timed out/);
});

test("non-2xx INVITE responses are ACKed on the same branch", async () => {
  const timers = new FakeTimers();
  const transport = new CaptureTransport();
  const layer = new TransactionLayer(transport, { timers, timeout: 4000 });
  const pending = layer.send(request("INVITE"), { target: { host: "10.0.0.20", port: 5060 } });

  const invite = transport.messages[0] as SipMessage;
  const busy = buildResponse(invite, 486, { toTag: "bob-tag" });
  layer.handle(busy);
  const response = await pending;
  assert.equal(response.status, 486);

  const ack = transport.messages.find((m) => m.method === "ACK");
  assert.ok(ack, "ACK must be generated for a non-2xx final response");
  assert.equal(ack.branch, invite.branch);
  assert.equal(ack.cseq?.seq, 1);
  assert.equal(ack.header("to"), busy.header("to"));
});

test("provisional responses reach the callback without ending the transaction", async () => {
  const timers = new FakeTimers();
  const transport = new CaptureTransport();
  const layer = new TransactionLayer(transport, { timers, timeout: 5000 });
  const statuses: number[] = [];
  const pending = layer.send(request("INVITE"), {
    target: { host: "10.0.0.20", port: 5060 },
    onProvisional: (response) => statuses.push(response.status ?? 0),
  });

  const invite = transport.messages[0] as SipMessage;
  layer.handle(buildResponse(invite, 100, { toTag: "bob-tag" }));
  layer.handle(buildResponse(invite, 180, { toTag: "bob-tag" }));
  layer.handle(buildResponse(invite, 200, { toTag: "bob-tag" }));
  await pending;
  assert.deepEqual(statuses, [100, 180]);
});

test("abort rejects a pending transaction and clears it", async () => {
  const timers = new FakeTimers();
  const transport = new CaptureTransport();
  const layer = new TransactionLayer(transport, { timers, timeout: 4000 });
  const pending = layer.send(request("MESSAGE"), { target: { host: "10.0.0.20", port: 5060 } });
  const branch = (transport.messages[0] as SipMessage).branch as string;
  layer.abort(branch, new Error("cancelled by caller"));
  await assert.rejects(pending, /cancelled by caller/);
  assert.equal(layer.pendingCount, 0);
});
