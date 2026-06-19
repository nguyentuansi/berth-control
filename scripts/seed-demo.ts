#!/usr/bin/env bun
// Seed the demo SQLite with believable-but-fictional apps for screenshots.
//
//   HARBORCTL_DB=./demo.db bun run scripts/seed-demo.ts
//
// Then start the dev server with HARBORCTL_DEMO=1 HARBORCTL_DB=./demo.db
// (or `bun run demo:dev` from package.json).

// Note: this script runs under Bun (the rest of the app runs under Node via
// adapter-node). Bun has a known incompatibility with the native better-sqlite3
// module (see oven-sh/bun#4290), so we use Bun's built-in bun:sqlite here. The
// schema we create is byte-compatible with what `src/lib/server/db/migrate.ts`
// produces, so the runtime app can open this DB without issue.
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEMO_APPS } from '../src/lib/server/demo.js';

const dbPath = process.env.HARBORCTL_DB ?? resolve(process.cwd(), 'demo.db');
mkdirSync(dirname(resolve(dbPath)), { recursive: true });

const sqlite = new Database(dbPath, { create: true });
sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA foreign_keys = ON');

// Idempotent schema bootstrap (same DDL as src/lib/server/db/migrate.ts).
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
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT,
    ts INTEGER NOT NULL,
    user_login TEXT,
    level TEXT NOT NULL DEFAULT 'info',
    msg TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS log_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    stream TEXT NOT NULL,
    line TEXT NOT NULL
  );
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
`);

// Wipe and reseed atomically.
const tx = sqlite.transaction(() => {
  sqlite.prepare('DELETE FROM events').run();
  sqlite.prepare('DELETE FROM log_chunks').run();
  sqlite.prepare('DELETE FROM runs').run();
  sqlite.prepare('DELETE FROM apps').run();
  sqlite.prepare('DELETE FROM snapshots').run();
  const now = Date.now();
  const ins = sqlite.prepare(
    `INSERT INTO apps (id, name, project_path, port, kind, start_cmd, group_tag, notes, hidden, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  for (const a of DEMO_APPS) {
    ins.run(a.id, a.name, a.project_path, a.port, a.kind, a.start_cmd, a.group_tag, a.notes, now, now);
  }
  // Sample saved snapshot — shows the snapshots page off in screenshots.
  sqlite.prepare(
    `INSERT INTO snapshots (name, app_ids, created_at, created_by)
     VALUES (?, ?, ?, ?)`
  ).run(
    'platform review mode',
    JSON.stringify(['platform-api', 'platform-dashboard', 'platform-admin', 'data-postgres', 'data-redis']),
    now - 86_400_000,
    'demo@example.com'
  );
  // Sample admin user so the header pill renders something interesting.
  sqlite.prepare(
    `INSERT OR REPLACE INTO users (login, role, last_seen) VALUES (?, 'admin', ?)`
  ).run('demo@example.com', now);
});
tx();

console.log(`Seeded ${DEMO_APPS.length} demo apps to ${dbPath}`);
console.log(`Run: HARBORCTL_DEMO=1 HARBORCTL_DB=${dbPath} bun run dev`);
sqlite.close();
