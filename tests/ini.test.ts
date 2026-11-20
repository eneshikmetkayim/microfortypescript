import test from "node:test";
import assert from "node:assert/strict";
import { IniDocument } from "../src/core/ini.ts";
import { buildCopyData, parseCommandLine, readCopyData, resolveHook } from "../src/core/commands.ts";

const SAMPLE = [
  "; MicroSIP settings",
  "[Settings]",
  "accountId=1",
  "singleMode=1",
  "audioCodecs=PCMA/8000/1 PCMU/8000/1",
  "",
  "[Account1]",
  "label=Ofis",
  "server=pbx.example.com",
  "username=1001",
  "password=s3cret",
  "dialingPrefix=00",
  "dialPlan=0|00|1[2-9]xx[2-9]xxxxxx",
  "",
].join("\r\n");

test("parses sections and keys case-insensitively", () => {
  const doc = IniDocument.parse(SAMPLE);
  assert.equal(doc.get("settings", "accountid"), "1");
  assert.equal(doc.get("ACCOUNT1", "Label"), "Ofis");
  assert.equal(doc.getNumber("Account1", "accountId", 7), 7);
  assert.equal(doc.getBool("Settings", "singleMode"), true);
  assert.deepEqual(doc.sectionNames(), ["Settings", "Account1"]);
});

test("writes MicroSIP-compatible INI and round-trips unknown keys", () => {
  const doc = IniDocument.parse(SAMPLE);
  doc.set("Account1", "registerRefresh", 300);
  doc.set("Account1", "keepAlive", 15);
  const text = doc.toString();
  assert.match(text, /\[Account1\]/);
  assert.match(text, /registerrefresh=300/);

  const reparsed = IniDocument.parse(text);
  assert.equal(reparsed.get("Account1", "password"), "s3cret");
  assert.equal(reparsed.get("Account1", "dialPlan"), "0|00|1[2-9]xx[2-9]xxxxxx");
  assert.equal(reparsed.section("Account1").size, 8);
});

test("clearing a key writes nothing for it", () => {
  const doc = IniDocument.parse(SAMPLE);
  doc.set("Account1", "label", undefined);
  assert.equal(doc.get("Account1", "label"), "");
  assert.doesNotMatch(doc.toString(), /label=/);
});

test("parses msip: actions and dial URIs", () => {
  assert.deepEqual(parseCommandLine("msip:answer"), { action: "answer" });
  assert.deepEqual(parseCommandLine("MSIP:hangupall"), { action: "hangupall" });
  assert.deepEqual(parseCommandLine("msip:transfer_1002"), {
    action: "transfer",
    actionArg: "1002",
  });
  assert.deepEqual(parseCommandLine("tel:1002"), { destination: "1002" });
  assert.deepEqual(parseCommandLine("callto://1002/"), { destination: "1002" });
  assert.deepEqual(parseCommandLine('"dial:1002"'), { destination: "1002" });
  assert.equal(parseCommandLine("   "), null);
});

test("account and password parameters are extracted", () => {
  const parsed = parseCommandLine("1002/account:2/password:abc");
  assert.ok(parsed);
  assert.equal(parsed.destination, "1002");
  assert.equal(parsed.accountId, 2);
  assert.equal(parsed.password, "abc");
});

test("WM_COPYDATA envelopes match the Windows bridge", () => {
  const sync = buildCopyData("msip:answer");
  assert.equal(sync.dwData, 1);
  assert.equal(readCopyData(sync), "msip:answer");
  const queued = buildCopyData("tel:1002", true);
  assert.equal(queued.dwData, 2);
  assert.equal(readCopyData(queued), "tel:1002");
});

test("command hooks expand the URL mask and keep RunCmdCOM params", () => {
  const hook = resolveHook("http://crm.local/call?number={number}", {
    account: { server: "pbx", username: "1001", password: "p" },
    uri: { user: "1002", domain: "pbx" },
  }, { number: "1002" });
  assert.ok(hook);
  assert.equal(hook.command, "http://crm.local/call?number=1002");
  assert.equal(hook.params, "1002");
  assert.equal(resolveHook("", {}), null);
});
