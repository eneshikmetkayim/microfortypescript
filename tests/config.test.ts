import test from "node:test";
import assert from "node:assert/strict";
import { loadMicroSipSettings, saveMicroSipSettings } from "../src/core/settings.ts";
import { applyConfig, ConfigError } from "../src/web/config.ts";

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

const base = (extra = {}) => ({
  accountId: 1,
  accounts: [
    {
      id: 1,
      label: "Ofis",
      server: "pbx.example.com",
      username: "1001",
      password: "",
      transport: "udp" as const,
    },
  ],
  ...extra,
});

test("connection changes require a reconnect, cosmetic ones do not", () => {
  const settings = loadMicroSipSettings(INI);
  assert.equal(applyConfig(settings, base({ accounts: [{ ...base().accounts[0], server: "sip.local" }] })).restartRequired, true);
  assert.equal(settings.account.server, "sip.local");

  assert.equal(
    applyConfig(settings, base({ accounts: [{ ...base().accounts[0], server: "sip.local", label: "Santral" }] }))
      .restartRequired,
    false,
  );
  assert.equal(settings.account.label, "Santral");
});

test("adds a second sip user with the next free id and persists it", () => {
  const settings = loadMicroSipSettings(INI);
  const result = applyConfig(
    settings,
    base({
      maxConcurrentCalls: 2,
      accounts: [
        base().accounts[0],
        { label: "Destek", server: "pbx.example.com", username: "2002", password: "p2", transport: "tcp" },
      ],
    }),
  );
  assert.equal(result.restartRequired, true);
  assert.equal(settings.accounts.length, 2);
  assert.equal(settings.accounts[1]?.id, 2);
  assert.equal(settings.accounts[1]?.username, "2002");
  assert.equal(settings.maxConcurrentCalls, 2);

  const text = saveMicroSipSettings(settings);
  assert.match(text, /\[account2\]/i);
  assert.match(text, /username=2002/);
  assert.match(text, /maxConcurrentCalls=2/i);
  assert.match(text, /hidecid=1/, "unknown ini keys survive");
});

test("switches the active user and removes a deleted one", () => {
  const settings = loadMicroSipSettings(INI);
  applyConfig(
    settings,
    base({
      accounts: [
        base().accounts[0],
        { label: "Destek", server: "pbx.example.com", username: "2002", password: "p2", transport: "udp" },
      ],
    }),
  );
  applyConfig(settings, {
    accountId: 2,
    maxConcurrentCalls: 1,
    accounts: [
      { id: 1, server: "pbx.example.com", username: "1001" },
      { id: 2, server: "pbx.example.com", username: "2002" },
    ],
  });
  assert.equal(settings.accountId, 2);
  assert.equal(settings.account.username, "2002");
  assert.equal(settings.account.password, "p2", "empty password keeps the stored one");

  const removed = applyConfig(settings, {
    accountId: 1,
    maxConcurrentCalls: 1,
    accounts: [{ id: 1, server: "pbx.example.com", username: "1001" }],
  });
  assert.equal(removed.restartRequired, true);
  assert.equal(settings.accounts.length, 1);
  assert.doesNotMatch(saveMicroSipSettings(settings), /account2/i);
});

test("rejects incomplete users and unknown active ids", () => {
  const settings = loadMicroSipSettings(INI);
  assert.throws(
    () => applyConfig(settings, { accountId: 1, accounts: [{ id: 1, server: "", username: "1001" }] }),
    ConfigError,
  );
  assert.throws(() => applyConfig(settings, { accountId: 9, accounts: base().accounts }), ConfigError);
  assert.throws(() => applyConfig(settings, { accountId: 1, accounts: [] }), ConfigError);
  assert.equal(settings.accounts.length, 1, "a rejected patch leaves the model untouched");
});
