import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDialPlan,
  dialStringToNumber,
  formatNumber,
  getSipUri,
  isPstnNumber,
  sanitizeNumber,
} from "../src/core/dialing.ts";

const account = {
  server: "pbx.example.com",
  username: "1001",
  domain: "pbx.example.com",
  dialingPrefix: "",
  dialPlan: "",
};

test("sanitizeNumber removes the separators MicroSIP strips", () => {
  assert.equal(sanitizeNumber("0 (555) 123-45.67"), "05551234567");
  assert.equal(sanitizeNumber("+90 555 111 22 33"), "+905551112233");
});

test("isPstnNumber matches lib/MSIP.cpp:502", () => {
  assert.equal(isPstnNumber("123"), false, "shorter than 4 characters");
  assert.equal(isPstnNumber("1234"), true);
  assert.equal(isPstnNumber("+90 (555) 111-22-33"), true);
  assert.equal(isPstnNumber("sip:1002"), false);
  assert.equal(isPstnNumber("555*12#"), true);
  assert.equal(isPstnNumber("abc1234"), false);
});

test("dial plan <match:replace> rewrites the documented examples", () => {
  // <8:1555>xxxxxxx — dial 81234567, transmit 15551234567
  const first = applyDialPlan("81234567", "<8:1555>xxxxxxx");
  assert.equal(first.matched, true);
  assert.equal(first.number, "15551234567");

  // <:1>xxxxxxxxxx — dial 1234567890, transmit 11234567890
  const second = applyDialPlan("1234567890", "<:1>xxxxxxxxxx");
  assert.equal(second.matched, true);
  assert.equal(second.number, "11234567890");

  // <+:00>x. — replace + with 00, allow any other number
  const third = applyDialPlan("+905551112233", "<+:00>x.|x.");
  assert.equal(third.number, "00905551112233");
});

test("dial plan supports sets, ranges and the period wildcard", () => {
  const plan = "<:1618>[2-9]xxxxxx";
  const result = applyDialPlan("5551234", plan);
  assert.equal(result.matched, true);
  assert.equal(result.number, "16185551234");

  assert.equal(applyDialPlan("0", "01.").matched, true);
  assert.equal(applyDialPlan("0111", "01.").matched, true);
  assert.equal(applyDialPlan("999", "x.").matched, true);
});

test("a number matching no pattern is blocked", () => {
  const result = formatNumber("999", {
    account: { ...account, dialPlan: "0|00|1[2-9]xx[2-9]xxxxxx" },
  });
  assert.equal(result.blocked, true);
  assert.equal(result.uri, "");
  assert.equal(result.number, "");
});

test("dialing prefix is applied to PSTN numbers only, and strips +", () => {
  const prefixed = formatNumber("+90 (555) 111-22-33", {
    account: { ...account, dialingPrefix: "00" },
  });
  assert.equal(prefixed.number, "00905551112233");
  assert.equal(prefixed.uri, "<sip:00905551112233@pbx.example.com>");

  const short = formatNumber("123", { account: { ...account, dialingPrefix: "00" } });
  assert.equal(short.number, "123", "prefix needs more than 3 digits");

  // Faithful to global.cpp: any PSTN-looking number longer than 3 digits gets
  // the prefix, including short extensions like 1002.
  const extension = formatNumber("1002", { account: { ...account, dialingPrefix: "00" } });
  assert.equal(extension.number, "001002");

  const shortExtension = formatNumber("12", { account: { ...account, dialingPrefix: "00" } });
  assert.equal(shortExtension.number, "12");
});

test("commands after the first comma are split off", () => {
  const result = formatNumber("1002,1,2,3#", { account });
  assert.equal(result.number, "1002");
  assert.equal(result.commands, ",1,2,3#");
  assert.equal(result.uri, "<sip:1002@pbx.example.com>");
});

test("getSipUri appends the domain and wraps in angle brackets", () => {
  assert.equal(
    getSipUri("1002", { domain: "pbx.example.com" }),
    "<sip:1002@pbx.example.com>",
  );
  assert.equal(
    getSipUri("sip:1002@10.0.0.5:5060", { domain: "pbx.example.com" }),
    "<sip:1002@10.0.0.5:5060>",
  );
  assert.equal(getSipUri("<sip:1002@pbx.example.com>", { domain: "x" }), "<sip:1002@pbx.example.com>");
  // The domain is inserted before the first `;`/`?`, like CString::Insert.
  assert.equal(
    getSipUri("1002;transport=tcp", { domain: "pbx.example.com" }),
    "<sip:1002@pbx.example.com;transport=tcp>",
  );
});

test("noTransform leaves the number intact", () => {
  const result = formatNumber("+905551112233", {
    account: { ...account, dialingPrefix: "00" },
    noTransform: true,
  });
  assert.equal(result.number, "+905551112233");
});

test("dialStringToNumber strips URI schemes like DialNumberFromCommandLine", () => {
  assert.equal(dialStringToNumber("tel:1002"), "1002");
  assert.equal(dialStringToNumber("sip:1002@pbx"), "1002@pbx");
  assert.equal(dialStringToNumber("callto://1002/"), "1002");
  assert.equal(dialStringToNumber("dial:1002"), "1002");
  assert.equal(dialStringToNumber("dialpad:1002"), "1002");
  assert.equal(dialStringToNumber("1002/account:2"), "1002");
});
