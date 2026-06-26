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
      owner_login TEXT,
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_grants (
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      user_login TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      granted_by TEXT,
      PRIMARY KEY (app_id, user_login)
    );
    CREATE INDEX IF NOT EXISTS app_grants_user_idx ON app_grants(user_login);

    CREATE TABLE IF NOT EXISTS repo_states (
      app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
      default_branch TEXT,
      local_sha TEXT,
      remote_sha TEXT,
      commits_behind INTEGER NOT NULL DEFAULT 0,
      commits_ahead INTEGER NOT NULL DEFAULT 0,
      fetch_status TEXT NOT NULL DEFAULT 'idle',
      fetch_error TEXT,
      last_fetched_at INTEGER,
      last_pulled_at INTEGER,
      new_subapp_paths TEXT
    );

    -- additive ALTER for upgraders
    -- (sqlite is happy with multiple ALTERs; we swallow duplicates below)

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

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_login TEXT NOT NULL REFERENCES users(login) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_login);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS login_tokens (
      token TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_by TEXT,
      consumed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS login_tokens_expires_idx ON login_tokens(expires_at);

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

    -- Host monitoring time-series. One row per sample tick. Wide-flat schema
    -- with JSON columns for variable-length arrays (per-core temps, per-iface
    -- net counters, hardware-specific misc temps) so adding new sensors
    -- doesn't require an ALTER. All metric columns nullable — what's
    -- collectable varies by platform and by hardware.
    CREATE TABLE IF NOT EXISTS host_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      cpu_util_total REAL,
      cpu_util_cores TEXT,
      cpu_pkg_temp REAL,
      cpu_core_temps TEXT,
      gpu_temp REAL,
      gpu_power_w REAL,
      gpu_mem_used_mb REAL,
      gpu_mem_total_mb REAL,
      gpu_fan_pct REAL,
      gpu_util_pct REAL,
      mem_total_mb REAL,
      mem_available_mb REAL,
      mem_buffers_mb REAL,
      mem_cached_mb REAL,
      swap_total_mb REAL,
      swap_free_mb REAL,
      disk_total_gb REAL,
      disk_used_gb REAL,
      disk_avail_gb REAL,
      net_per_iface TEXT,
      misc_temps TEXT
    );
    CREATE INDEX IF NOT EXISTS host_readings_ts_idx ON host_readings(ts DESC);

    -- User-configurable per-metric warn thresholds. Single row per metric
    -- key. set warn_value to NULL to disable a check.
    CREATE TABLE IF NOT EXISTS host_thresholds (
      key TEXT PRIMARY KEY,
      warn_value REAL,
      cooldown_secs INTEGER NOT NULL DEFAULT 900,
      last_fired_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    -- Browser push subscriptions for host-monitor alerts. The endpoint is a
    -- per-device URL the browser hands us; we treat it as a credential
    -- (encrypted with p256dh + auth keys at send time).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh_key TEXT NOT NULL,
      auth_key TEXT NOT NULL,
      user_agent TEXT,
      created_at INTEGER NOT NULL
    );

    -- VAPID keys for signing push payloads. Single row enforced via CHECK.
    CREATE TABLE IF NOT EXISTS vapid_keys (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  // Additive ALTERs for users — these may already exist on upgraded DBs, so
  // each is wrapped in its own try/catch and the duplicate-column error
  // (sqlite_error code 1, message "duplicate column name") is swallowed.
  const userCols: Array<[string, string]> = [
    ['display_name', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['created_at', 'INTEGER'],
    ['tour_completed_at', 'INTEGER']
  ];
  for (const [col, type] of userCols) {
    try {
      sqlite.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
    } catch (e) {
      if (!String(e).includes('duplicate column name')) throw e;
    }
  }

  // Same idempotent ALTERs for apps.
  const appCols: Array<[string, string]> = [
    ['owner_login', 'TEXT'],
    ['visibility', "TEXT NOT NULL DEFAULT 'private'"],
    ['parent_id', 'TEXT'],
    ['is_monorepo', 'INTEGER NOT NULL DEFAULT 0'],
    ['prebuild_cmd', 'TEXT']
  ];
  const repoCols: Array<[string, string]> = [['new_subapp_paths', 'TEXT']];
  for (const [col, type] of repoCols) {
    try {
      sqlite.exec(`ALTER TABLE repo_states ADD COLUMN ${col} ${type}`);
    } catch (e) {
      if (!String(e).includes('duplicate column name')) throw e;
    }
  }
  for (const [col, type] of appCols) {
    try {
      sqlite.exec(`ALTER TABLE apps ADD COLUMN ${col} ${type}`);
    } catch (e) {
      if (!String(e).includes('duplicate column name')) throw e;
    }
  }

  // Backfill owner_login on any pre-existing apps — first admin we find is
  // a reasonable default. Safe to re-run; only acts on NULL owners.
  try {
    sqlite.exec(`
      UPDATE apps
      SET owner_login = (SELECT login FROM users WHERE role='admin' ORDER BY created_at ASC LIMIT 1)
      WHERE owner_login IS NULL
    `);
  } catch {
    /* no users yet or first migration — nothing to backfill */
  }

  sqlite.close();
}
