import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResponse,
  parseMessage,
  parseUriHeader,
  serializeMessage,
  SipMessage,
  headerParam,
} from "../src/sip/message.ts";

const REGISTER = [
  "REGISTER sip:pbx.example.com SIP/2.0",
  "Via: SIP/2.0/WSS df7f2a1b9c.websocket;branch=z9hG4bK-524287-1---a1b2;rport",
  "Max-Forwards: 70",
  "Contact: <sip:1001@df7f2a1b9c.invalid;transport=ws>;expires=300",
  "To: <sip:1001@pbx.example.com>",
  "From: <sip:1001@pbx.example.com>;tag=8f1a2c",
  "Call-ID: 3f0b9d21a3c94a4e",
  "CSeq: 1 REGISTER",
  "Allow: INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, REFER, NOTIFY, MESSAGE",
  "Content-Length: 0",
  "",
  "",
].join("\r\n");

const INVITE = [
  "INVITE sip:1002@pbx.example.com SIP/2.0",
  "Via: SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bK776asdhds;rport",
  "Max-Forwards: 70",
  "From: \"Ali Veli\" <sip:1001@pbx.example.com>;tag=1928301774",
  "To: <sip:1002@pbx.example.com>",
  "Call-ID: a84b4c76e66710@pc33.atlanta.com",
  "CSeq: 314159 INVITE",
  "Contact: <sip:1001@192.168.1.10:5060>",
  "Content-Type: application/sdp",
  "Content-Length: 142",
  "",
  "v=0",
  "o=- 1 1 IN IP4 192.168.1.10",
  "s=-",
  "c=IN IP4 192.168.1.10",
  "t=0 0",
  "m=audio 49170 RTP/AVP 0 8 101",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:101 telephone-event/8000",
  "a=fmtp:101 0-15",
  "a=sendrecv",
  "",
].join("\r\n");

test("parses a REGISTER request", () => {
  const msg = parseMessage(REGISTER);
  assert.equal(msg.isRequest, true);
  assert.equal(msg.method, "REGISTER");
  assert.equal(msg.requestUri, "sip:pbx.example.com");
  assert.equal(msg.callId, "3f0b9d21a3c94a4e");
  assert.deepEqual(msg.cseq, { seq: 1, method: "REGISTER" });
  assert.equal(msg.fromTag, "8f1a2c");
  assert.equal(msg.branch, "z9hG4bK-524287-1---a1b2");
  assert.equal(msg.body, "");
});

test("INVITE body is cut to Content-Length and SDP survives", () => {
  const msg = parseMessage(INVITE);
  assert.equal(msg.method, "INVITE");
  assert.equal(msg.header("content-type"), "application/sdp");
  assert.match(msg.body, /^v=0\r?\n/);
  assert.match(msg.body, /a=rtpmap:0 PCMU\/8000/);
  // Declared 142 bytes pads with the final newlines; body must be <= 142 bytes.
  assert.ok(new TextEncoder().encode(msg.body).length <= 142);
});

test("serializes with CRLF and a correct Content-Length", () => {
  const msg = parseMessage(INVITE);
  const out = serializeMessage(msg);
  assert.match(out, /^INVITE sip:1002@pbx\.example\.com SIP\/2\.0\r\n/);
  assert.match(out, /\r\nContent-Length: \d+\r\n\r\n/);
  const reparsed = parseMessage(out);
  assert.equal(reparsed.body, msg.body);
});

test("parses a response and builds a matching reply", () => {
  const request = parseMessage(INVITE);
  const response = buildResponse(request, 180, { toTag: "abc", contact: "<sip:1002@10.0.0.9>" });
  const parsed = parseMessage(response.toString());
  assert.equal(parsed.status, 180);
  assert.equal(parsed.startLine.kind, "response");
  if (parsed.startLine.kind === "response") assert.equal(parsed.startLine.reason, "Ringing");
  assert.equal(parsed.toTag, "abc");
  assert.equal(parsed.header("call-id"), "a84b4c76e66710@pc33.atlanta.com");
  assert.equal(parsed.header("contact"), "<sip:1002@10.0.0.9>");
  assert.equal(parsed.header("cseq"), "314159 INVITE");
});

test("compact header forms are canonicalised", () => {
  const raw = [
    "SIP/2.0 200 OK",
    "v: SIP/2.0/UDP 10.0.0.1;branch=z9hG4bK1",
    "f: <sip:a@b>;tag=1",
    "t: <sip:c@d>;tag=2",
    "i: call-1",
    "CSeq: 1 INVITE",
    "l: 0",
    "",
  ].join("\r\n");
  const msg = parseMessage(raw);
  assert.equal(msg.header("via"), "SIP/2.0/UDP 10.0.0.1;branch=z9hG4bK1");
  assert.equal(msg.header("call-id"), "call-1");
  assert.equal(msg.toTag, "2");
  assert.equal(msg.header("content-length"), "0");
});

test("header folding is unfolded", () => {
  const raw = "OPTIONS sip:x@y SIP/2.0\r\nSubject: hello\r\n world\r\nContent-Length: 0\r\n\r\n";
  const msg = parseMessage(raw);
  assert.equal(msg.header("subject"), "hello world");
});

test("rejects malformed start lines", () => {
  assert.throws(() => parseMessage("BOGUS\r\n\r\n"), /invalid SIP/);
  assert.throws(() => parseMessage(""), /empty SIP message/);
});

test("setHeader collapses duplicate values into one", () => {
  const msg = SipMessage.request("OPTIONS", "sip:x@y");
  msg.addHeader("Via", "one").addHeader("Via", "two");
  msg.setHeader("Via", "three");
  assert.deepEqual(msg.headerValues("via"), ["three"]);
  msg.addHeader("Via", "four");
  assert.deepEqual(msg.headerValues("via"), ["three", "four"]);
  msg.removeHeader("Via");
  assert.deepEqual(msg.headerValues("via"), []);
});

test("headerParam ignores parameters inside the addr-spec", () => {
  assert.equal(headerParam("<sip:a@b;tag=inner>;tag=outer", "tag"), "outer");
  assert.equal(headerParam("sip:a@b;transport=ws", "tag"), undefined);
});

test("parseUriHeader extracts the URI part of Contact/From/To", () => {
  assert.equal(parseUriHeader('"Ad" <sip:1001@10.0.0.5>;tag=9')?.user, "1001");
  assert.equal(parseUriHeader("sip:200@10.0.0.6")?.host, "10.0.0.6");
});
