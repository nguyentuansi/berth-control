import Database from 'better-sqlite3';
import { dbPathInUse } from './index.js';

// Idempotent bootstrap: create tables if missing. Drizzle-kit `push` can
// regenerate this; this exists so the dev/prod server can boot from cold
// without a separate migration step.
export function ensureSchema() {
  const sqlite = new Database(dbPathInUse);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      port INTEGER,
      kind TEXT NOT NULL DEFAULT 'shell',
      start_cmd TEXT,
      stop_cmd TEXT,
      env_file TEXT,
      healthcheck_url TEXT,
      group_tag TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      pid INTEGER NOT NULL,
      pgid INTEGER,
      started_at INTEGER NOT NULL,
      stopped_at INTEGER,
      exit_code INTEGER,
      log_path TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_app_idx ON runs(app_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS runs_open_idx ON runs(stopped_at) WHERE stopped_at IS NULL;

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT,
      ts INTEGER NOT NULL,
      user_login TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      msg TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts DESC);

    CREATE TABLE IF NOT EXISTS log_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL,
      stream TEXT NOT NULL,
      line TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS log_chunks_run_idx ON log_chunks(run_id, id);

    CREATE TABLE IF NOT EXISTS users (
      login TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'viewer',
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      app_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS snapshots_name_idx ON snapshots(name);

    -- Minute-resolution liveness samples. One row per (app_id, minute_ts);
    -- powers the uptime sparkline for apps Berth doesn't supervise directly.
    CREATE TABLE IF NOT EXISTS uptime_samples (
      app_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      up INTEGER NOT NULL,
      PRIMARY KEY (app_id, ts)
    );
    CREATE INDEX IF NOT EXISTS uptime_samples_app_ts ON uptime_samples(app_id, ts DESC);
  `);
  sqlite.close();
}
