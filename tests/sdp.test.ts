import test from "node:test";
import assert from "node:assert/strict";
import {
  audioMedia,
  buildAudioAnswer,
  buildAudioOffer,
  codecsOf,
  DEFAULT_AUDIO_CODECS,
  mediaDirection,
  negotiateAudio,
  parseSdp,
  rtpmaps,
} from "../src/sip/sdp.ts";
import { DEFAULT_CODECS_ENABLED } from "../src/core/version.ts";
import { OFFER_SDP, answerSdp } from "./helpers/uas.ts";

test("parses an offer with rtpmap and fmtp", () => {
  const session = parseSdp(OFFER_SDP);
  const audio = audioMedia(session);
  assert.ok(audio);
  assert.equal(audio.port, 4100);
  assert.deepEqual(audio.formats, ["8", "0", "101"]);
  assert.deepEqual(
    rtpmaps(audio).map((m) => `${m.payloadType}:${m.encoding}`),
    ["8:PCMA", "0:PCMU", "101:TELEPHONE-EVENT"],
  );
  assert.equal(mediaDirection(audio), "sendrecv");
});

test("codecOf maps static payloads without rtpmap", () => {
  const session = parseSdp(["v=0", "m=audio 5000 RTP/AVP 0 8 9", ""].join("\r\n"));
  const audio = audioMedia(session);
  assert.ok(audio);
  assert.deepEqual(
    codecsOf(audio).map((c) => c.name),
    ["PCMU", "PCMA", "G722"],
  );
});

test("default offer uses MicroSIP's PCMA/PCMU order", () => {
  assert.equal(DEFAULT_CODECS_ENABLED, "PCMA/8000/1 PCMU/8000/1");
  assert.deepEqual(DEFAULT_AUDIO_CODECS.slice(0, 2), ["PCMA/8000/1", "PCMU/8000/1"]);

  const sdp = buildAudioOffer({ address: "192.0.2.10", port: 4000, sessionId: 7 });
  const audio = audioMedia(parseSdp(sdp));
  assert.ok(audio);
  assert.equal(audio.port, 4000);
  assert.deepEqual(
    codecsOf(audio).map((c) => c.name),
    ["PCMA", "PCMU", "G722", "GSM", "ILBC", "SPEEX", "OPUS", "TELEPHONE-EVENT"],
  );
  assert.match(sdp, /a=sendrecv/);
  assert.match(sdp, /a=rtpmap:101 telephone-event\/8000/);
});

test("answers keep the offerer's payload numbers and order", () => {
  const offer = parseSdp(OFFER_SDP);
  const answerText = buildAudioAnswer(offer, { address: "192.0.2.10", port: 4002 });
  const answer = parseSdp(answerText);
  const answerAudio = audioMedia(answer);
  assert.ok(answerAudio);
  assert.deepEqual(answerAudio.formats, ["8", "0", "101"]);

  const filtered = parseSdp(
    buildAudioAnswer(offer, { address: "192.0.2.10", port: 4002, codecs: ["PCMA/8000/1"] }),
  );
  assert.deepEqual(audioMedia(filtered)?.formats, ["8", "101"]);

  const negotiated = negotiateAudio(offer, answer);
  assert.ok(negotiated);
  assert.deepEqual(
    negotiated.codecs.map((c) => c.name),
    ["PCMA", "PCMU", "TELEPHONE-EVENT"],
  );
  assert.equal(negotiated.dtmfPayloadType, 101);
});

test("intersection drops codecs the answer does not accept", () => {
  const offer = parseSdp(OFFER_SDP);
  const narrow = parseSdp(answerSdp());
  const negotiated = negotiateAudio(offer, narrow);
  assert.deepEqual(
    negotiated?.codecs.map((c) => c.name),
    ["PCMA", "TELEPHONE-EVENT"],
  );
});

test("hold is signalled as a=sendonly", () => {
  const sdp = buildAudioOffer({ address: "192.0.2.10", direction: "sendonly" });
  const audio = audioMedia(parseSdp(sdp));
  assert.ok(audio);
  assert.equal(mediaDirection(audio), "sendonly");
});

test("round-trips SDP including session attributes", () => {
  const text = [
    "v=0",
    "o=- 1 1 IN IP4 10.0.0.1",
    "s=MicroSIP",
    "c=IN IP4 10.0.0.1",
    "t=0 0",
    "a=ice-ufrag:abc",
    "m=audio 4000 RTP/AVP 8",
    "a=rtpmap:8 PCMA/8000",
    "",
  ].join("\r\n");
  const parsed = parseSdp(text);
  assert.equal(parsed.sessionName, "MicroSIP");
  assert.deepEqual(parsed.attributes, [{ name: "ice-ufrag", value: "abc" }]);
  const rebuilt = parseSdp(
    [
      "v=0",
      "o=" + parsed.origin,
      "s=" + parsed.sessionName,
      "c=" + parsed.connection,
      "t=" + parsed.timing,
      "a=ice-ufrag:abc",
      "m=audio 4000 RTP/AVP 8",
      "a=rtpmap:8 PCMA/8000",
      "",
    ].join("\r\n"),
  );
  assert.equal(audioMedia(rebuilt)?.port, 4000);
});
