import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Contacts } from "../src/core/contacts.ts";

function repo(): { db: DatabaseSync; contacts: Contacts } {
  const db = new DatabaseSync(":memory:");
  return { db, contacts: new Contacts(db) };
}

test("adds and finds contacts by number", () => {
  const { contacts } = repo();
  const id = contacts.add({ number: "1002", name: "Ayşe", info: "Ofis" });
  assert.ok(id > 0);
  const found = contacts.getByNumber("1002");
  assert.ok(found);
  assert.equal(found.name, "Ayşe");
  assert.equal(contacts.nameFor("1002"), "Ayşe");
  assert.equal(contacts.nameFor("9999"), "9999");
});

test("updates, deletes and searches", () => {
  const { contacts } = repo();
  contacts.add({ number: "1002", name: "Ayşe", info: "" });
  contacts.add({ number: "1003", name: "Bob", info: "" });
  const first = contacts.getByNumber("1002");
  assert.ok(first);
  contacts.update({ ...first, name: "Ayşe Y." });
  assert.equal(contacts.get(first.id)?.name, "Ayşe Y.");

  assert.equal(contacts.search("bo").length, 1);
  contacts.delete(first.id);
  assert.equal(contacts.list().length, 1);
  contacts.deleteAll();
  assert.equal(contacts.list().length, 0);
});

test("imports CSV skipping duplicates and exports it back", () => {
  const { contacts } = repo();
  const imported = contacts.importCsv("1002,Ayşe,Ofis\r\n1003,Bob\r\n1002,Tekrar\r\n");
  assert.equal(imported, 2);
  assert.equal(contacts.list().length, 2);
  assert.match(contacts.exportCsv(), /1002,Ayşe,Ofis/);
  assert.match(contacts.exportCsv(), /1003,Bob,/);
});
