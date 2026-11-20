import test from "node:test";
import assert from "node:assert/strict";
import { loadMicroSipSettings, saveMicroSipSettings } from "../src/core/settings.ts";
import { applyConfig } from "../src/web/config.ts";

const INI = [
  "[Global]",
  "version=3.23.5",
  "",
  "[Settings]",
  "accountId=1",
  "singleMode=1",
  "maxConcurrentCalls=1",
  "cmdIncomingCall=http://crm.local/hook",
  "",
  "[Account1]",
  "label=Ofis",
  "server=pbx.example.com",
  "username=1001",
  "password=secret",
  "transport=udp",
  "hideCID=1",
  "",
].join("\r\n");

test("connection fields mark the stack for a reconnect", () => {
  const settings = loadMicroSipSettings(INI);
  const result = applyConfig(settings, { server: " sip.local ", username: "2002" });
  assert.equal(result.restartRequired, true);
  assert.equal(settings.account.server, "sip.local");
  assert.equal(settings.account.username, "2002");
  assert.equal(settings.accounts[0]?.server, "sip.local", "account list entry is updated too");
});

test("cosmetic fields do not force a reconnect", () => {
  const settings = loadMicroSipSettings(INI);
  const result = applyConfig(settings, { label: "Santral", displayName: "Operatör", dialPlan: "9xx" });
  assert.equal(result.restartRequired, false);
  assert.equal(settings.account.label, "Santral");
  assert.equal(settings.account.dialPlan, "9xx");
});

test("empty password keeps the stored secret and never clears it", () => {
  const settings = loadMicroSipSettings(INI);
  const result = applyConfig(settings, { password: "" });
  assert.equal(result.restartRequired, false);
  assert.equal(settings.account.password, "secret");
});

test("transport is validated and concurrency is clamped", () => {
  const settings = loadMicroSipSettings(INI);
  applyConfig(settings, { transport: "breach" as never, maxConcurrentCalls: 99 });
  assert.equal(settings.account.transport, "udp");
  assert.equal(settings.maxConcurrentCalls, 32);
  assert.equal(applyConfig(settings, { transport: "tls" }).restartRequired, true);
  assert.equal(settings.account.transport, "tls");
});

test("saving keeps unknown ini keys from the Windows build", () => {
  const settings = loadMicroSipSettings(INI);
  applyConfig(settings, { username: "1002" });
  const text = saveMicroSipSettings(settings);
  assert.match(text, /hidecid=1/);
  assert.match(text, /cmdIncomingCall=http:\/\/crm\.local\/hook/i);
  assert.match(text, /username=1002/);
});

test("saving persists the concurrency limit the setup form edits", () => {
  const settings = loadMicroSipSettings(INI);
  applyConfig(settings, { maxConcurrentCalls: 3 });
  assert.match(saveMicroSipSettings(settings), /maxConcurrentCalls=3/i);
});
