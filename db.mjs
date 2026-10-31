// SQLite storage for one studio. All times are the studio's local time as 'YYYY-MM-DD HH:MM' strings,
// so they sort and compare as text; Russia has no daylight saving, so a fixed zone is safe.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS masters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'master')),
  takes_bookings INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  tg_chat_id INTEGER,
  link_code TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  price INTEGER NOT NULL,
  price_from INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS master_services (
  master_id INTEGER NOT NULL REFERENCES masters(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  PRIMARY KEY (master_id, service_id)
);
-- The usual week; a weekday with no row is a day off. 0 is Monday.
CREATE TABLE IF NOT EXISTS week_hours (
  master_id INTEGER NOT NULL REFERENCES masters(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  PRIMARY KEY (master_id, weekday)
);
-- One date differs from the usual week: other hours, or start NULL for a day off.
CREATE TABLE IF NOT EXISTS day_overrides (
  master_id INTEGER NOT NULL REFERENCES masters(id),
  date TEXT NOT NULL,
  start TEXT,
  end TEXT,
  PRIMARY KEY (master_id, date)
);
-- Hours closed inside a working day: a break, a personal errand.
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES masters(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  tg_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  link_code TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES masters(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  client_id INTEGER NOT NULL REFERENCES clients(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  source TEXT NOT NULL CHECK (source IN ('telegram', 'cabinet', 'site')),
  note TEXT NOT NULL DEFAULT '',
  reminded_day INTEGER NOT NULL DEFAULT 0,
  reminded_soon INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_master_time ON bookings (master_id, start_at);
CREATE INDEX IF NOT EXISTS bookings_reminders ON bookings (status, start_at);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  master_id INTEGER NOT NULL REFERENCES masters(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_state (
  tg_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL
);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn in a write transaction, so a check and the insert after it cannot interleave with another booking.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
