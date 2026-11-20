/**
 * Call history repository — the same SQLite schema MicroSIP creates in
 * `Data/Database.cpp InitCalls()`:
 *
 *   call_log(id INTEGER PRIMARY KEY AUTOINCREMENT, callId TEXT NOT NULL,
 *            number TEXT NOT NULL, name TEXT NOT NULL, type INTEGER,
 *            time INTEGER, duration INTEGER, info TEXT NOT NULL)
 *   UNIQUE INDEX idx_call_log_callId_unique ON call_log(callId)
 *   trim to the newest 1000 rows
 *
 * Uses the built-in `node:sqlite` driver, so an existing MicroSIP
 * `call_log.db` can be opened read-only and inspected by the port.
 */

import { DatabaseSync } from "node:sqlite";
import { CALL_LOG_LIMIT } from "./version.ts";

/** Domain/Call.h:22 */
export const CALL_TYPE = {
  outgoing: 0,
  incoming: 1,
  missed: 2,
  answeredElsewhere: 3,
} as const;

export type CallType = (typeof CALL_TYPE)[keyof typeof CALL_TYPE];

export const CALL_TYPE_LABEL: Record<number, string> = {
  0: "outgoing",
  1: "incoming",
  2: "missed",
  3: "answered_elsewhere",
};

export interface CallRecord {
  id: number;
  callId: string;
  number: string;
  name: string;
  type: number;
  /** Unix seconds. */
  time: number;
  /** Seconds. */
  duration: number;
  info: string;
}

export type NewCallRecord = Omit<CallRecord, "id"> & { id?: number };

export interface CallLogOptions {
  /** `:memory:` for tests, a file path for persistence. */
  path?: string;
  /** Do not modify the file (used when reading MicroSIP's database). */
  readOnly?: boolean;
  limit?: number;
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  callId TEXT NOT NULL,
  number TEXT NOT NULL,
  name TEXT NOT NULL,
  type INTEGER,
  time INTEGER,
  duration INTEGER,
  info TEXT NOT NULL
)`;

const CREATE_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_call_log_callId_unique ON call_log(callId)";

const TRIM = `DELETE FROM call_log
  WHERE (SELECT COUNT(*) FROM call_log) > ?
  AND id <= (SELECT id FROM call_log ORDER BY id DESC LIMIT 1 OFFSET ?)`;

export class CallLog {
  readonly db: DatabaseSync;
  private readonly limit: number;
  private readonly readOnly: boolean;

  constructor(options: CallLogOptions = {}) {
    this.limit = options.limit ?? CALL_LOG_LIMIT;
    this.readOnly = options.readOnly ?? false;
    this.db = new DatabaseSync(options.path ?? ":memory:", {
      readOnly: this.readOnly,
    });
    this.db.exec("PRAGMA busy_timeout=5000;");
    if (!this.readOnly) this.init();
  }

  init(): void {
    this.db.exec(CREATE_TABLE);
    this.db.exec(CREATE_INDEX);
    this.trim();
  }

  trim(): void {
    if (this.readOnly) return;
    this.db.prepare(TRIM).run(this.limit, this.limit);
  }

  add(record: NewCallRecord): number {
    const statement = this.db.prepare(
      "INSERT INTO call_log (callId, number, name, type, time, duration, info) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const result = statement.run(
      record.callId,
      record.number,
      record.name,
      record.type,
      record.time,
      record.duration,
      record.info,
    );
    this.trim();
    return Number(result.lastInsertRowid);
  }

  /** Insert-or-update by callId, mirroring `Calls::Add` followed by `SetDuration`. */
  upsert(record: NewCallRecord): number {
    const existing = this.getByCallId(record.callId);
    if (existing) {
      this.update({ ...record, id: existing.id });
      return existing.id;
    }
    return this.add(record);
  }

  update(record: CallRecord): void {
    this.db
      .prepare(
        "UPDATE call_log SET callId=?, number=?, name=?, type=?, time=?, duration=?, info=? WHERE id=?",
      )
      .run(
        record.callId,
        record.number,
        record.name,
        record.type,
        record.time,
        record.duration,
        record.info,
        record.id,
      );
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM call_log WHERE id=?").run(id);
  }

  deleteMany(ids: number[]): void {
    if (!ids.length) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(`DELETE FROM call_log WHERE id IN (${placeholders})`).run(...ids);
  }

  deleteAll(): void {
    this.db.exec("DELETE FROM call_log;");
  }

  get(id: number): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM call_log WHERE id=?").get(id);
    return row ? mapRow(row) : null;
  }

  getByCallId(callId: string): CallRecord | null {
    const row = this.db.prepare("SELECT * FROM call_log WHERE callId=?").get(callId);
    return row ? mapRow(row) : null;
  }

  list(limit = 100, offset = 0): CallRecord[] {
    return this.db
      .prepare("SELECT * FROM call_log ORDER BY id DESC LIMIT ? OFFSET ?")
      .all(limit, offset)
      .map(mapRow);
  }

  search(text: string, limit = 100): CallRecord[] {
    const like = `%${text}%`;
    return this.db
      .prepare("SELECT * FROM call_log WHERE number LIKE ? OR name LIKE ? ORDER BY id DESC LIMIT ?")
      .all(like, like, limit)
      .map(mapRow);
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM call_log").get() as
      | { c: number }
      | undefined;
    return Number(row?.c ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

function mapRow(row: Record<string, unknown>): CallRecord {
  return {
    id: Number(row.id),
    callId: String(row.callId ?? ""),
    number: String(row.number ?? ""),
    name: String(row.name ?? ""),
    type: Number(row.type ?? 0),
    time: Number(row.time ?? 0),
    duration: Number(row.duration ?? 0),
    info: String(row.info ?? ""),
  };
}

export function callTypeFromDirection(direction: "in" | "out", missed = false): number {
  if (direction === "out") return CALL_TYPE.outgoing;
  return missed ? CALL_TYPE.missed : CALL_TYPE.incoming;
}
