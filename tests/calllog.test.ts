import test from "node:test";
import assert from "node:assert/strict";
import { CallLog, CALL_TYPE, CALL_TYPE_LABEL, callTypeFromDirection } from "../src/core/calllog.ts";

test("creates the exact MicroSIP call_log schema", () => {
  const log = new CallLog();
  const table = log.db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='call_log'")
    .get() as { sql: string };
  assert.match(table.sql, /callId TEXT NOT NULL/);
  assert.match(table.sql, /number TEXT NOT NULL/);
  assert.match(table.sql, /name TEXT NOT NULL/);
  assert.match(table.sql, /type INTEGER/);
  assert.match(table.sql, /time INTEGER/);
  assert.match(table.sql, /duration INTEGER/);
  assert.match(table.sql, /info TEXT NOT NULL/);

  const index = log.db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_call_log_callId_unique'")
    .get();
  assert.ok(index);
  log.close();
});

test("insert, update and unique callId lookup", () => {
  const log = new CallLog();
  const id = log.add({
    callId: "call-1",
    number: "1002",
    name: "Ayşe",
    type: CALL_TYPE.outgoing,
    time: 1_700_000_000,
    duration: 0,
    info: "",
  });
  assert.ok(id > 0);

  const record = log.getByCallId("call-1");
  assert.ok(record);
  assert.equal(record.number, "1002");

  log.update({ ...record, duration: 61, info: "G722" });
  assert.equal(log.get(id)?.duration, 61);
  assert.equal(log.count(), 1);
  log.close();
});

test("upsert keeps one row per callId", () => {
  const log = new CallLog();
  log.upsert({
    callId: "c-2",
    number: "1003",
    name: "",
    type: CALL_TYPE.incoming,
    time: 1,
    duration: 0,
    info: "",
  });
  log.upsert({
    callId: "c-2",
    number: "1003",
    name: "Bob",
    type: CALL_TYPE.incoming,
    time: 1,
    duration: 15,
    info: "",
  });
  assert.equal(log.count(), 1);
  assert.equal(log.getByCallId("c-2")?.duration, 15);
  log.close();
});

test("trims to the newest 1000 rows like Database.cpp", () => {
  const log = new CallLog();
  for (let i = 0; i < 1005; i++) {
    log.add({
      callId: `bulk-${i}`,
      number: String(1000 + i),
      name: "",
      type: CALL_TYPE.outgoing,
      time: i,
      duration: 0,
      info: "",
    });
  }
  assert.equal(log.count(), 1000);
  assert.equal(log.getByCallId("bulk-4"), null);
  assert.ok(log.getByCallId("bulk-5"));
  assert.ok(log.getByCallId("bulk-1004"));
  log.close();
});

test("list, search and delete helpers", () => {
  const log = new CallLog();
  log.add({ callId: "a", number: "1002", name: "Ayşe", type: 1, time: 1, duration: 3, info: "" });
  log.add({ callId: "b", number: "2001", name: "Bob", type: 0, time: 2, duration: 8, info: "" });

  assert.deepEqual(log.list().map((r) => r.callId), ["b", "a"]);
  assert.deepEqual(log.search("Ayşe").map((r) => r.callId), ["a"]);
  assert.deepEqual(log.search("200").map((r) => r.callId), ["b"]);

  log.deleteMany([log.getByCallId("a")!.id]);
  assert.equal(log.count(), 1);
  log.deleteAll();
  assert.equal(log.count(), 0);
  log.close();
});

test("type codes match Domain/Call.h", () => {
  assert.deepEqual(CALL_TYPE, { outgoing: 0, incoming: 1, missed: 2, answeredElsewhere: 3 });
  assert.equal(CALL_TYPE_LABEL[3], "answered_elsewhere");
  assert.equal(callTypeFromDirection("out"), 0);
  assert.equal(callTypeFromDirection("in"), 1);
  assert.equal(callTypeFromDirection("in", true), 2);
});
