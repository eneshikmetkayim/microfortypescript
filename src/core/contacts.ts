/**
 * Contacts repository (Data/ContactsRepository.cpp): table `contacts` with
 * `number`, `name`, `info`, plus the lookup rules MicroSIP uses to label a
 * call ("name" in the call log and the incoming-call popup).
 */

import type { DatabaseSync } from "node:sqlite";

export interface Contact {
  id: number;
  number: string;
  name: string;
  info: string;
}

export type NewContact = Omit<Contact, "id"> & { id?: number };

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  name TEXT NOT NULL,
  info TEXT NOT NULL
)`;

export class Contacts {
  private readonly db: DatabaseSync;
  private readonly readOnly: boolean;

  constructor(db: DatabaseSync, options: { readOnly?: boolean } = {}) {
    this.db = db;
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) this.db.exec(CREATE_TABLE);
  }

  add(contact: NewContact): number {
    const result = this.db
      .prepare("INSERT INTO contacts (number, name, info) VALUES (?, ?, ?)")
      .run(contact.number, contact.name, contact.info);
    return Number(result.lastInsertRowid);
  }

  update(contact: Contact): void {
    this.db
      .prepare("UPDATE contacts SET number=?, name=?, info=? WHERE id=?")
      .run(contact.number, contact.name, contact.info, contact.id);
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM contacts WHERE id=?").run(id);
  }

  deleteAll(): void {
    this.db.exec("DELETE FROM contacts;");
  }

  get(id: number): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id=?").get(id);
    return row ? mapRow(row) : null;
  }

  getByNumber(number: string): Contact | null {
    const row = this.db.prepare("SELECT * FROM contacts WHERE number=?").get(number);
    return row ? mapRow(row) : null;
  }

  list(): Contact[] {
    return this.db.prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE").all().map(mapRow);
  }

  search(text: string, limit = 50): Contact[] {
    const like = `%${text}%`;
    return this.db
      .prepare(
        "SELECT * FROM contacts WHERE number LIKE ? OR name LIKE ? ORDER BY name COLLATE NOCASE LIMIT ?",
      )
      .all(like, like, limit)
      .map(mapRow);
  }

  /** Display name for a number, or the number itself (MicroSIP's lookup). */
  nameFor(number: string): string {
    return this.getByNumber(number)?.name || number;
  }

  /** Bulk import used by the "Import" dialog (CSV: number,name[,info]). */
  importCsv(text: string): number {
    let imported = 0;
    this.db.exec("BEGIN TRANSACTION");
    try {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [number, name, info = ""] = line.split(",").map((part) => part.trim());
        if (!number) continue;
        if (this.getByNumber(number)) continue;
        this.add({ number, name: name ?? number, info });
        imported++;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return imported;
  }

  exportCsv(): string {
    return this.list()
      .map((contact) => `${contact.number},${contact.name},${contact.info}`)
      .join("\r\n");
  }
}

function mapRow(row: Record<string, unknown>): Contact {
  return {
    id: Number(row.id),
    number: String(row.number ?? ""),
    name: String(row.name ?? ""),
    info: String(row.info ?? ""),
  };
}
