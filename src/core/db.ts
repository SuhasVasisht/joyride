// Disposable SQLite index. Everything here can be rebuilt from source stores,
// authored files and the event log; delete .joyride/index.sqlite to rebuild.
import Database from "better-sqlite3";
import { paths } from "../shared/paths.ts";
import { ensureDir } from "./util.ts";
import path from "node:path";

export type DB = Database.Database;

const CORE = `
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_offsets (file TEXT PRIMARY KEY, off INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL,
  session TEXT, agent TEXT, cwd TEXT, pane TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_session ON events(session, ts);
CREATE INDEX IF NOT EXISTS events_type ON events(type, ts);
CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied TEXT NOT NULL);
`;

export function openDb(file = paths.index): DB {
  if (file !== ":memory:") ensureDir(path.dirname(file));
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(CORE);
  return db;
}

export function migrate(db: DB, name: string, sql: string) {
  const done = db.prepare("SELECT 1 FROM migrations WHERE name = ?").get(name);
  if (done) return;
  db.exec(sql);
  db.prepare("INSERT INTO migrations(name, applied) VALUES (?, datetime('now'))").run(name);
}

export function kvGet<T>(db: DB, k: string, fallback: T): T {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return row ? JSON.parse(row.v) : fallback;
}
export function kvSet(db: DB, k: string, v: unknown) {
  db.prepare("INSERT INTO kv(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
}
