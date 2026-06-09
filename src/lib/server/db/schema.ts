import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** A managed app. One row = one dev server Berth knows about. */
export const apps = sqliteTable('apps', {
  id: text('id').primaryKey(),               // slug, stable
  name: text('name').notNull(),
  project_path: text('project_path').notNull(),
  port: integer('port'),                      // null if the app doesn't expose a port
  kind: text('kind').notNull().default('shell'), // vite|wrangler|bun|node|cargo|gradle|java|shell|docker
  start_cmd: text('start_cmd'),
  stop_cmd: text('stop_cmd'),
  env_file: text('env_file'),
  healthcheck_url: text('healthcheck_url'),
  group_tag: text('group_tag'),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

/** A single run (start → stop) of an app. */
export const runs = sqliteTable('runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  app_id: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  pid: integer('pid').notNull(),
  pgid: integer('pgid'),                      // process-group id; SIGTERM here kills the whole tree
  started_at: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  stopped_at: integer('stopped_at', { mode: 'timestamp_ms' }),
  exit_code: integer('exit_code'),
  log_path: text('log_path')
});

/** Audit trail. */
export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  app_id: text('app_id'),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  user_login: text('user_login'),
  level: text('level').notNull().default('info'), // info|warn|error
  msg: text('msg').notNull()
});

/** Rolling log buffer (last ~1000 lines per run kept here; full log on disk). */
export const log_chunks = sqliteTable('log_chunks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  run_id: integer('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
  ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
  stream: text('stream').notNull(),           // stdout|stderr
  line: text('line').notNull()
});

/** Tailnet user identities seen by Berth. */
export const users = sqliteTable('users', {
  login: text('login').primaryKey(),
  role: text('role').notNull().default('viewer'), // admin|viewer
  last_seen: integer('last_seen', { mode: 'timestamp_ms' })
});

/** Saved "profile" of which apps should be up — e.g. "frontend stack" or "review mode". */
export const snapshots = sqliteTable('snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  app_ids: text('app_ids').notNull(),    // JSON array of app ids
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  created_by: text('created_by')
});

/**
 * Minute-resolution liveness samples. The server heartbeat (uptime.ts) writes
 * one row per (app_id, minute) recording whether the app's port had a local
 * listener at the time of polling. Powers the uptime sparkline for apps
 * Berth doesn't directly supervise (e.g. external systemd units).
 *
 * Conflict policy on (app_id, ts): `up = MAX(existing, new)` — any 'up'
 * reading within a minute makes that minute count as up.
 */
export const uptime_samples = sqliteTable('uptime_samples', {
  app_id: text('app_id').notNull(),
  ts: integer('ts').notNull(),
  up: integer('up').notNull()
});

export type App = typeof apps.$inferSelect;
export type NewApp = typeof apps.$inferInsert;
export type Run = typeof runs.$inferSelect;
export type Event = typeof events.$inferSelect;
export type LogChunk = typeof log_chunks.$inferSelect;
export type User = typeof users.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;
