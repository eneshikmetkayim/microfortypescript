import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorization,
  challengeFromResponse,
  parseChallenge,
} from "../src/sip/digest.ts";

// RFC 2617 §3.5 example values (modified to the "Mufasa" SIP-style test).
const CHALLENGE =
  'Digest realm="testrealm@host.com", qop="auth,auth-int", ' +
  'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';

test("parses a Digest challenge", () => {
  const challenge = parseChallenge(CHALLENGE);
  assert.ok(challenge);
  assert.equal(challenge.realm, "testrealm@host.com");
  assert.equal(challenge.nonce, "dcd98b7102dd2f0e8b11d0f600bfb0c093");
  assert.deepEqual(challenge.qop, ["auth", "auth-int"]);
  assert.equal(challenge.algorithm, "MD5");
  assert.equal(challenge.opaque, "5ccc069c403ebaf9f0171e9517f40e41");
});

test("ignores non-digest challenges", () => {
  assert.equal(parseChallenge('Basic realm="x"'), null);
  assert.equal(parseChallenge(undefined), null);
  assert.equal(parseChallenge('Digest nonce="x"'), null);
});

test("computes the RFC 2617 qop=auth response", () => {
  const challenge = parseChallenge(CHALLENGE);
  assert.ok(challenge);
  const auth = buildAuthorization({
    challenge,
    credentials: { username: "Mufasa", password: "Circle Of Life" },
    method: "GET",
    uri: "/dir/index.html",
    cnonce: "0a4f113b",
    nc: 1,
  });
  assert.equal(auth.response, "6629fae49393a05397450978507c4ef1");
  assert.match(auth.value, /^Digest username="Mufasa"/);
  assert.match(auth.value, /qop=auth/);
  assert.match(auth.value, /nc=00000001/);
  assert.match(auth.value, /cnonce="0a4f113b"/);
  assert.match(auth.value, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test("supports authID, MD5-sess and challenge replay for 401 vs 407", () => {
  const challenge = parseChallenge(CHALLENGE);
  assert.ok(challenge);
  const auth = buildAuthorization({
    challenge,
    credentials: { username: "1001", password: "p", authId: "auth1001" },
    method: "REGISTER",
    uri: "sip:pbx.example.com",
    nc: 2,
  });
  assert.match(auth.value, /username="auth1001"/);
  assert.match(auth.value, /nc=00000002/);

  const sess = buildAuthorization({
    challenge: { ...challenge, algorithm: "MD5-SESS" },
    credentials: { username: "1001", password: "p" },
    method: "REGISTER",
    uri: "sip:pbx.example.com",
    cnonce: "deadbeef",
  });
  assert.match(sess.value, /algorithm=MD5-SESS/);

  const unauthorized = challengeFromResponse(401, CHALLENGE, undefined);
  assert.equal(unauthorized?.headerName, "Authorization");
  const proxy = challengeFromResponse(407, undefined, CHALLENGE);
  assert.equal(proxy?.headerName, "Proxy-Authorization");
  assert.equal(challengeFromResponse(200, CHALLENGE, CHALLENGE), null);
});

test("no-qop challenge uses the legacy response formula", () => {
  const challenge = parseChallenge('Digest realm="r", nonce="n"');
  assert.ok(challenge);
  const auth = buildAuthorization({
    challenge,
    credentials: { username: "u", password: "p" },
    method: "REGISTER",
    uri: "sip:r",
  });
  assert.doesNotMatch(auth.value, /qop=/);
  assert.match(auth.value, /algorithm=MD5/);
  assert.equal(auth.response.length, 32);
});
