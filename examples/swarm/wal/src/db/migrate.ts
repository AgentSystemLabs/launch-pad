/**
 * Idempotent schema migration for the swarm control plane.
 *
 * The whole control plane is a single SQLite file on the sticky volume
 * (`/data/swarm.db`). `migrate()` runs `CREATE TABLE IF NOT EXISTS` on boot and
 * is safe to call repeatedly — the volume survives container replacement, so the
 * tables (and any prior mission/WAL history) persist across deploys.
 */
import { Database } from "bun:sqlite";

/** Bump when the schema shape changes in a non-additive way. */
export const SCHEMA_VERSION = 1;

/**
 * Create (or open) the database, apply pragmas, and ensure the schema exists.
 * Pass `:memory:` in tests for an isolated, throwaway database.
 */
export function openDatabase(path: string): Database {
  const db = new Database(path, { create: true });
  // WAL journal mode keeps reads non-blocking while the single writer appends.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/** Apply the schema. Idempotent — every statement is IF NOT EXISTS. */
export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Mission history. Each Run (or Set-mission) inserts a new immutable row;
    -- control.active_mission_id points at the one currently armed.
    CREATE TABLE IF NOT EXISTS missions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    -- Singleton control row (id is pinned to 1).
    CREATE TABLE IF NOT EXISTS control (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      paused            INTEGER NOT NULL DEFAULT 0,
      state             TEXT NOT NULL DEFAULT 'idle',   -- 'idle' | 'running'
      active_mission_id INTEGER,
      updated_at        TEXT NOT NULL,
      updated_by        TEXT,
      FOREIGN KEY (active_mission_id) REFERENCES missions(id)
    );

    -- Append-only activity log shown in the operator UI.
    CREATE TABLE IF NOT EXISTS wal_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         TEXT NOT NULL,
      agent      TEXT NOT NULL,
      event      TEXT NOT NULL,   -- boot | working | done | stdout | system
      summary    TEXT NOT NULL,
      report     TEXT,
      loop       TEXT,
      json_extra TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wal_ts ON wal_entries(id);
    CREATE INDEX IF NOT EXISTS idx_wal_agent ON wal_entries(agent, id);

    -- Live per-agent registry (one row per worker, upserted on heartbeat).
    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,           -- hostname / container id
      last_seen       TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'sleeping', -- sleeping | working | idle | paused
      current_summary TEXT,
      current_loop    TEXT,
      replica_index   INTEGER
    );

    -- Streamed worker stdout, capped per agent (see appendStdout).
    CREATE TABLE IF NOT EXISTS stdout_chunks (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      ts    TEXT NOT NULL,
      line  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stdout_agent ON stdout_chunks(agent, id);

    -- File-scope locks (replaces the old locks.json).
    CREATE TABLE IF NOT EXISTS locks (
      path       TEXT PRIMARY KEY,
      holder     TEXT NOT NULL,
      expires_at INTEGER NOT NULL   -- epoch ms
    );
  `);

  // Seed the singleton control row exactly once.
  db.query(
    `INSERT OR IGNORE INTO control (id, paused, state, updated_at, updated_by)
     VALUES (1, 0, 'idle', ?, 'system')`,
  ).run(new Date().toISOString());

  db.query(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION),
  );
}
