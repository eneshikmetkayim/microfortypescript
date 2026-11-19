import test from "node:test";
import assert from "node:assert/strict";
import {
  formatNameAddr,
  formatSipUri,
  hostPort,
  isIpAddress,
  parseNameAddr,
  parseSipUri,
  removeUriParam,
  setUriParam,
  urlencode,
} from "../src/sip/uri.ts";

test("parses a full SIP URI", () => {
  const uri = parseSipUri("sip:1001:secret@pbx.example.com:5070;transport=tcp;lr?subject=test");
  assert.equal(uri.scheme, "sip");
  assert.equal(uri.user, "1001");
  assert.equal(uri.password, "secret");
  assert.equal(uri.host, "pbx.example.com");
  assert.equal(uri.port, 5070);
  assert.deepEqual(uri.params, [["transport", "tcp"], ["lr", true]]);
  assert.deepEqual(uri.headers, [["subject", "test"]]);
});

test("parses tel: URI and IPv6 authority", () => {
  const tel = parseSipUri("tel:+905551112233");
  assert.equal(tel.scheme, "tel");
  assert.equal(tel.user, "+905551112233");
  assert.equal(tel.host, "");

  const v6 = parseSipUri("sip:user@[2001:db8::1]:5060");
  assert.equal(v6.host, "[2001:db8::1]");
  assert.equal(v6.port, 5060);
});

test("round-trips and re-encodes user parts", () => {
  const uri = parseSipUri("sip:ali.veli%20x@example.com");
  assert.equal(uri.user, "ali.veli x");
  const formatted = formatSipUri(uri);
  assert.equal(formatted, "sip:ali.veli%20x@example.com");
});

test("name-addr with quoted display name and tag", () => {
  const addr = parseNameAddr('"Enes, Hikmet" <sip:1001@10.0.0.5:5060>;tag=abc123');
  assert.equal(addr.displayName, "Enes, Hikmet");
  assert.equal(addr.uri.user, "1001");
  assert.deepEqual(addr.params, [["tag", "abc123"]]);
  assert.equal(
    formatNameAddr(addr),
    '"Enes, Hikmet" <sip:1001@10.0.0.5:5060>;tag=abc123',
  );
});

test("bare addr-spec parses without brackets", () => {
  const addr = parseNameAddr("sip:200@example.com;tag=xyz");
  assert.equal(addr.uri.user, "200");
  assert.equal(addr.params[0]?.[0], "tag");
});

test("uri parameter helpers", () => {
  const uri = parseSipUri("sip:a@b");
  setUriParam(uri, "transport", "wss");
  assert.equal(uri.params[0]?.[1], "wss");
  removeUriParam(uri, "transport");
  assert.equal(uri.params.length, 0);
  assert.equal(hostPort(parseSipUri("sip:a@b:5080")), "b:5080");
  assert.equal(isIpAddress("10.1.2.3"), true);
  assert.equal(isIpAddress("pbx.local"), false);
});

test("urlencode mirrors MicroSIP global.cpp:945", () => {
  // Digits, letters and ~ ! * ' ( ) pass through; everything else is %xx with
  // the lowercase hex MicroSIP produces via char2hex().
  assert.equal(urlencode("abcABC123-_.~!*'()"), "abcABC123%2d%5f%2e~!*'()");
  assert.equal(urlencode("a b"), "a%20b");
  assert.equal(urlencode("şifre"), "%c5%9fifre");
  assert.equal(urlencode("+,&=@"), "%2b%2c%26%3d%40");
});
