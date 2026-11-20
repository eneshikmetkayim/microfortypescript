import test from "node:test";
import assert from "node:assert/strict";
import { urlMask, URL_MASK_TOKENS } from "../src/core/urlmask.ts";
import { md5Hex } from "../src/sip/md5.ts";

const account = { server: "pbx.example.com", username: "1001", password: "secret" };

test("all tokens expand with MicroSIP values", () => {
  const url = urlMask(
    "http://crm.local/call?ext={extension}&srv={server}&pwd={password}&md5={md5_password}" +
      "&dur={duration}&t={time}&id={callid}&dir={direction}&cid={callerid}" +
      "&user={user}&num={number}&dom={domain}&name={name}",
    {
      account,
      duration: 42,
      time: 1_700_000_000,
      callId: "abc@host",
      direction: "out",
      uri: { user: "1002", name: "Ayşe", domain: "pbx.example.com" },
    },
  );
  assert.match(url, /ext=1001/);
  assert.match(url, /srv=pbx\.example\.com/);
  assert.match(url, /pwd=secret/);
  assert.match(url, new RegExp(`md5=${md5Hex("secret")}`));
  assert.match(url, /dur=42/);
  assert.match(url, /t=1700000000/);
  assert.match(url, /id=abc%40host/);
  assert.match(url, /dir=out/);
  assert.match(url, /cid=Ay%c5%9fe/);
  assert.match(url, /user=1002/);
  assert.match(url, /num=1002/);
  assert.match(url, /dom=pbx%2eexample%2ecom/);
  assert.match(url, /name=Ay%c5%9fe/);
});

test("stored callerId wins over the SIP URI name (CString::Replace order)", () => {
  const url = urlMask("?cid={callerid}", {
    account,
    callerId: "1111",
    uri: { user: "1002", name: "Display Name", domain: "pbx" },
  });
  assert.equal(url, "?cid=1111");

  const noCallerId = urlMask("?cid={callerid}", {
    account,
    uri: { user: "1002", name: "Display Name", domain: "pbx" },
  });
  assert.equal(noCallerId, "?cid=Display%20Name");

  const noName = urlMask("?cid={callerid}", {
    account,
    uri: { user: "1002", domain: "pbx" },
  });
  assert.equal(noName, "?cid=1002");
});

test("stored callerId applies when no SIP URI is given", () => {
  assert.equal(urlMask("cid={callerid}", { account, callerId: "905551112233" }), "cid=905551112233");
});

test("no account empties credentials and falls back to localhost", () => {
  const url = urlMask("{server}|{extension}|{password}|{md5_password}|{callid}|{direction}", {
    hasAccount: false,
  });
  assert.equal(url, "localhost|||||");
});

test("empty server also becomes localhost", () => {
  assert.equal(urlMask("{server}", { account: { server: "", username: "1" } }), "localhost");
});

test("missing values default to empty/zero", () => {
  const url = urlMask("dur={duration},dir={direction}", { account });
  assert.equal(url, "dur=0,dir=");
});

test("password is URL encoded and md5 is lowercase hex", () => {
  const url = urlMask("{password}|{md5_password}", {
    account: { server: "s", username: "u", password: "şifre!" },
  });
  // `!` is in MicroSIP's allow-list, `.` and `-` are not.
  assert.equal(url, "%c5%9fifre!|" + md5Hex("şifre!"));
  assert.equal(
    urlMask("{user}", { account, uri: { user: "ali.veli", domain: "pbx" } }),
    "ali%2eveli",
  );
});

test("token list covers the C++ replacements", () => {
  assert.equal(URL_MASK_TOKENS.length, 13);
});
