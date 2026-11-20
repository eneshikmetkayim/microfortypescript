import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultIniPath,
  loadMicroSipSettings,
  saveMicroSipSettings,
  toAccountConfig,
} from "../src/core/settings.ts";

const INI = [
  "[Global]",
  "version=3.23.5",
  "",
  "[Settings]",
  "accountId=1",
  "singleMode=1",
  "audioCodecs=PCMA/8000/1 PCMU/8000/1",
  "EC=1",
  "registerRefresh=300",
  "cmdIncomingCall=http://crm.local/call?number={number}",
  "",
  "[Account0]",
  "server=",
  "username=",
  "",
  "[Account1]",
  "label=Ofis",
  "server=pbx.example.com",
  "username=1001",
  "authID=1001_auth",
  "password=secret",
  "domain=example.com",
  "displayName=Enes",
  "dialingPrefix=00",
  "dialPlan=0|00|1[2-9]xx[2-9]xxxxxx",
  "transport=tls",
  "registerRefresh=120",
  "keepAlive=30",
  "hideCID=1",
  "",
  "[Account2]",
  "label=Yedek",
  "server=pbx2.example.com",
  "username=2001",
  "password=x",
  "",
].join("\r\n");

test("loads the active account and every account section", () => {
  const settings = loadMicroSipSettings(INI);
  assert.equal(settings.accountId, 1);
  assert.equal(settings.account.label, "Ofis");
  assert.equal(settings.account.username, "1001");
  assert.equal(settings.account.authId, "1001_auth");
  assert.equal(settings.account.transport, "tls");
  assert.equal(settings.account.registerRefresh, 120);
  assert.equal(settings.account.keepAlive, 30);
  assert.equal(settings.account.hideCid, true);
  assert.equal(settings.accounts.length, 2);
  assert.equal(settings.accounts[1]?.username, "2001");
  assert.equal(settings.cmdIncomingCall, "http://crm.local/call?number={number}");
});

test("defaults match define.h when keys are missing", () => {
  const settings = loadMicroSipSettings("[Account1]\nserver=pbx\nusername=1\n");
  assert.equal(settings.audioCodecs, "PCMA/8000/1 PCMU/8000/1");
  assert.equal(settings.echoCancellation, true);
  assert.equal(settings.singleMode, true);
  assert.equal(settings.account.registerRefresh, 300);
  assert.equal(settings.account.keepAlive, 15);
  assert.equal(settings.account.transport, "udp");
  assert.equal(settings.account.label, "", "an empty Account1 label stays empty");
});

test("local account keeps MicroSIP's default label", () => {
  const settings = loadMicroSipSettings("[Account0]\nserver=\n");
  assert.equal(settings.accountLocal.label, "Local (call by IP address)");
});

test("toAccountConfig splits codecs and keeps credential fields", () => {
  const settings = loadMicroSipSettings(INI);
  const config = toAccountConfig(settings.account, settings);
  assert.deepEqual(config.audioCodecs, ["PCMA/8000/1", "PCMU/8000/1"]);
  assert.equal(config.authId, "1001_auth");
  assert.equal(config.transport, "tls");
  assert.equal(config.dialPlan?.includes("1[2-9]"), true);
});

test("saving preserves unknown keys and updates known ones", () => {
  const settings = loadMicroSipSettings(INI + "customKey=keepMe\r\n");
  settings.account.displayName = "Yeni İsim";
  const text = saveMicroSipSettings(settings);
  assert.match(text, /customkey=keepMe/i);
  const reparsed = loadMicroSipSettings(text);
  assert.equal(reparsed.account.displayName, "Yeni İsim");
  assert.equal(reparsed.accounts.length, 2);
});

test("defaultIniPath uses portable ini or APPDATA", () => {
  const exists = (path: string) => path.endsWith("microsip.ini");
  assert.equal(
    defaultIniPath({ baseDir: "C:\\Apps\\MicroSIP", appData: "C:\\Users\\e\\AppData\\Roaming", exists }),
    "C:\\Apps\\MicroSIP\\microsip.ini",
  );
  assert.equal(
    defaultIniPath({
      baseDir: "C:\\Apps\\MicroSIP",
      appData: "C:\\Users\\e\\AppData\\Roaming",
      portable: true,
    }),
    "C:\\Apps\\MicroSIP\\microsip.ini",
  );
  assert.equal(
    defaultIniPath({
      baseDir: "C:\\Apps\\MicroSIP",
      appData: "C:\\Users\\e\\AppData\\Roaming",
      exists: () => false,
    }),
    "C:\\Users\\e\\AppData\\Roaming\\MicroSIP\\microsip.ini",
  );
});
