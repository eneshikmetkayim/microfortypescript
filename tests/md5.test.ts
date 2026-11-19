import test from "node:test";
import assert from "node:assert/strict";
import { md5Hex, md5Bytes, utf8 } from "../src/sip/md5.ts";

test("md5 matches RFC 1321 test vectors", () => {
  assert.equal(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex("a"), "0cc175b9c0f1b6a831c399e269772661");
  assert.equal(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(md5Hex("message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
  assert.equal(md5Hex("abcdefghijklmnopqrstuvwxyz"), "c3fcd3d76192e4007dfb496cca67e13b");
  assert.equal(
    md5Hex("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
    "d174ab98d277d9f5a5611c2c9f419d9f",
  );
  assert.equal(
    md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
    "57edf4a22be3c955ac49da2e2107b67a",
  );
});

test("md5 handles multi-byte UTF-8 and long inputs", () => {
  // Turkish password as MicroSIP stores it (UTF-8 before hashing).
  assert.equal(md5Hex("şifre"), md5Hex(utf8("şifre")));
  assert.equal(md5Hex("x".repeat(1000)).length, 32);
  assert.notEqual(md5Hex("x".repeat(55)), md5Hex("x".repeat(56)));
});

test("md5Bytes returns 16 raw bytes", () => {
  const digest = md5Bytes(utf8("abc"));
  assert.equal(digest.length, 16);
  assert.deepEqual(Array.from(digest.slice(0, 4)), [0x90, 0x01, 0x50, 0x98]);
});
