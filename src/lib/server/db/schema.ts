import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

/** A managed app. One row = one dev server Berth knows about. */
export const apps = sqliteTable('apps', {
  id: text('id').primaryKey(),               // slug, stable
  name: text('name').notNull(),
  project_path: text('project_path').notNull(),
  port: integer('port'),                      // null if the app doesn't expose a port
  kind: text('kind').notNull().default('shell'), // vite|wrangler|bun|node|cargo|gradle|java|shell|docker
  start_cmd: text('start_cmd'),
  stop_cmd: text('stop_cmd'),
  /** Run before start_cmd every time the app starts. Same shell, same cwd.
   *  Use for "build the workspace deps before serving" / "generate routes"
   *  / "run db push" — anything that has to be one-shot in front of the
   *  serve loop. Failure here aborts the start and surfaces in the mini-log. */
  prebuild_cmd: text('prebuild_cmd'),
  env_file: text('env_file'),
  healthcheck_url: text('healthcheck_url'),
  group_tag: text('group_tag'),
  hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  notes: text('notes'),
  /** Who created this app. Drives the private/invited visibility model —
   *  see app_grants below for the delegate list. */
  owner_login: text('owner_login'),
  /** `private` (owner only, loopback) · `invited` (owner + grants, tailnet
   *  exposed) · `public` (everyone signed in, tailnet exposed). */
  visibility: text('visibility', { enum: ['private', 'invited', 'public'] })
    .notNull()
    .default('private'),
  /** When non-null, this row is a subapp inside a monorepo whose root row is
   *  the parent. The dashboard nests children under their parent in the UI;
   *  the supervisor still treats each row as an independent process. */
  parent_id: text('parent_id'),
  /** When true, this row is a monorepo root with children. Cards for these
   *  rows expose a "Start all subapps" action. */
  is_monorepo: integer('is_monorepo', { mode: 'boolean' }).notNull().default(false),
  created_at: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updated_at: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date())
});

/** Per-app repo sync state. One row per app that has a git workspace at
 *  `project_path/.git`. Updated by the background fetcher + manual fetch
 *  endpoint; read by the dashboard SSE snapshot so cards can show
 *  "↑N behind" badges without doing any git work per render. */
export const repo_states = sqliteTable('repo_states', {
  app_id: text('app_id')
    .primaryKey()
    .references(() => apps.id, { onDelete: 'cascade' }),
  default_branch: text('default_branch'),                                            // e.g. "main"
  local_sha: text('local_sha'),
  remote_sha: text('remote_sha'),
  commits_behind: integer('commits_behind').notNull().default(0),
  commits_ahead: integer('commits_ahead').notNull().default(0),
  /** idle · queued · fetching · pulling · error */
  fetch_status: text('fetch_status').notNull().default('idle'),
  fetch_error: text('fetch_error'),
  last_fetched_at: integer('last_fetched_at', { mode: 'timestamp_ms' }),
  last_pulled_at: integer('last_pulled_at', { mode: 'timestamp_ms' }),
  /** For monorepo apps: JSON array of detected-but-not-yet-registered subapp
   *  paths from the most recent inspect after fetch. Lets the dashboard show
   *  "↑3 new subapps" so the user can register the new ones in one click. */
  new_subapp_paths: text('new_subapp_paths')
});

/** Per-app delegate grants for `visibility = 'invited'`. Each row = "this
 *  user can see + start/stop this app". The owner row itself is implicit
 *  (apps.owner_login) and not duplicated here. */
export const app_grants = sqliteTable('app_grants', {
  app_id: text('app_id').notNull().references(() => apps.id, { onDelete: 'cascade' }),
  user_login: text('user_login').notNull(),
  granted_at: integer('granted_at', { mode: 'timestamp_ms' }).notNull(),
  granted_by: text('granted_by')
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

// ── host monitoring (system-wide CPU/RAM/temps/GPU/net time-series) ──
// Ported from pcmonitor / SysWatch. One row per sample tick (every 10–60s).
// All columns are nullable because metric availability varies by platform
// (e.g. no /sys/class/hwmon on macOS, no nvidia-smi without an NVIDIA GPU,
// no powermetrics without sudo). The collector writes whatever it could read;
// the UI hides nulls instead of plotting them as zero.
//
// Storage rationale: a wide-flat schema beats a tall key/value schema for
// time-series under SQLite — the BRIN-style ts index lookups stay O(log n)
// and the charts page can pull 90 days × ~1 minute granularity (~130k rows)
// in one SELECT without a JOIN or pivot.
export const host_readings = sqliteTable('host_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),

  // CPU utilization 0..100 (% busy across the sample window).
  cpu_util_total: real('cpu_util_total'),
  /** JSON array of per-core utilization (length = core count, discovered at runtime). */
  cpu_util_cores: text('cpu_util_cores'),

  // CPU temperatures (°C). Discovered at runtime from /sys/class/hwmon or
  // powermetrics; null if no source on this platform / kernel.
  cpu_pkg_temp: real('cpu_pkg_temp'),
  /** JSON array of per-core temps; same length as cpu_util_cores when present. */
  cpu_core_temps: text('cpu_core_temps'),

  // GPU (nvidia-smi on Linux with NVIDIA; powermetrics gpu_power on macOS).
  gpu_temp: real('gpu_temp'),
  gpu_power_w: real('gpu_power_w'),
  gpu_mem_used_mb: real('gpu_mem_used_mb'),
  gpu_mem_total_mb: real('gpu_mem_total_mb'),
  gpu_fan_pct: real('gpu_fan_pct'),
  gpu_util_pct: real('gpu_util_pct'),

  // Memory (MB).
  mem_total_mb: real('mem_total_mb'),
  mem_available_mb: real('mem_available_mb'),
  mem_buffers_mb: real('mem_buffers_mb'),
  mem_cached_mb: real('mem_cached_mb'),
  swap_total_mb: real('swap_total_mb'),
  swap_free_mb: real('swap_free_mb'),

  // Disk at / (GB).
  disk_total_gb: real('disk_total_gb'),
  disk_used_gb: real('disk_used_gb'),
  disk_avail_gb: real('disk_avail_gb'),

  // Network bytes-per-second per interface, deltaed from the previous sample.
  // Stored as a JSON object: { "<iface>": { "rx_bps": number, "tx_bps": number } }.
  // Interfaces are discovered at runtime from /proc/net/dev (Linux) or
  // netstat -ib (macOS). NEVER hardcode names like `eno1` or `tailscale0`.
  net_per_iface: text('net_per_iface'),

  // Motherboard / NVMe / WiFi / ACPI temperatures. JSON of name → °C so
  // platform-specific sensor layouts (which vary by hardware AND OS) stay
  // expressive without a schema change.
  // Example Linux: {"nvme_composite": 42.0, "acpi_temp1": 31.0}
  // Example macOS: {"smc_thermal_pressure": 0.0}
  misc_temps: text('misc_temps')
});

/** Browser push subscriptions for host-monitor alerts. One row per device
 *  the user has authorized via the browser's PushManager API. The endpoint
 *  is unique (browsers won't issue duplicate endpoints for the same origin),
 *  so we use it as the natural key. */
export const push_subscriptions = sqliteTable('push_subscriptions', {
  /** Stable id (used as the de-dup key in the UI). */
  id: text('id').primaryKey(),
  /** The push service URL the browser hands us. NEVER displayed; treated as
   *  a credential. Goes only to web-push at send time. */
  endpoint: text('endpoint').notNull().unique(),
  /** Cryptographic keys derived by the browser. Required by web-push for
   *  payload encryption. */
  p256dh_key: text('p256dh_key').notNull(),
  auth_key: text('auth_key').notNull(),
  /** User-agent string for the operator's reference — lets them recognize
   *  which device a row belongs to. Optional. */
  user_agent: text('user_agent'),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
});

/** Single-row table for VAPID keys. The VAPID public key is shared with
 *  browsers as part of the subscribe flow; the private key signs each push.
 *  Generated once at first boot and persisted so subscriptions survive
 *  restarts. A row with id=1 is enforced via a CHECK constraint. */
export const vapid_keys = sqliteTable('vapid_keys', {
  id: integer('id').primaryKey(),
  public_key: text('public_key').notNull(),
  private_key: text('private_key').notNull(),
  created_at: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
});

/** User-configurable alert thresholds. Single row per metric so the UI can
 *  CRUD them without a join. Per-metric warn level only — alerting is
 *  triggered when the latest sample exceeds the threshold, with a cooldown
 *  period to avoid storms. Set warn_value to null to disable that metric. */
export const host_thresholds = sqliteTable('host_thresholds', {
  /** Logical metric key. Examples: 'cpu_temp', 'gpu_temp', 'disk_pct',
   *  'ram_pct'. The collector evaluates against the named metric from each
   *  sample tick. */
  key: text('key').primaryKey(),
  warn_value: real('warn_value'),
  /** Suppress repeat alerts for the same key for this many seconds. */
  cooldown_secs: integer('cooldown_secs').notNull().default(900),
  /** When the most recent alert for this key fired. Updated by the collector
   *  on dispatch. Persists across restarts so cooldowns don't reset on boot. */
  last_fired_at: integer('last_fired_at', { mode: 'timestamp_ms' }),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
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

/** User identities. Identity may come from a Tailscale serve header (loopback
 *  only), a password login, or an OS-user fallback on direct loopback. */
export const users = sqliteTable('users', {
  login: text('login').primaryKey(),
  role: text('role').notNull().default('viewer'),     // admin|viewer
  display_name: text('display_name'),
  password_hash: text('password_hash'),               // null = Tailscale/OS-only
  created_at: integer('created_at', { mode: 'timestamp_ms' }),
  tour_completed_at: integer('tour_completed_at', { mode: 'timestamp_ms' }),
  // Independent from `tour_completed_at`: the checklist and the spotlight
  // tour are two distinct onboarding affordances and the user can dismiss
  // them separately. "Got it" on the tour stamps tour_completed_at only;
  // closing the checklist's X button stamps this one only.
  checklist_dismissed_at: integer('checklist_dismissed_at', { mode: 'timestamp_ms' }),
  last_seen: integer('last_seen', { mode: 'timestamp_ms' })
});

/** Opaque session id stored in the `berth_session` cookie. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),                                                  // 64-char hex
  user_login: text('user_login').notNull().references(() => users.login, { onDelete: 'cascade' }),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expires_at: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  source: text('source').notNull(),                                             // password|tailscale-header|qr|os-user
  user_agent: text('user_agent')
});

/** One-shot login tokens. Used by QR sign-in: desktop mints a token, phone
 *  claims it via the tailnet, desktop swaps the claim for a real session. */
export const login_tokens = sqliteTable('login_tokens', {
  token: text('token').primaryKey(),                                            // 64-char hex
  kind: text('kind').notNull(),                                                 // qr
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expires_at: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  claimed_by: text('claimed_by'),                                               // login of phone-side claimer
  consumed: integer('consumed', { mode: 'boolean' }).notNull().default(false)
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
export type AppGrant = typeof app_grants.$inferSelect;
export type RepoState = typeof repo_states.$inferSelect;
export type Visibility = 'private' | 'invited' | 'public';
export type Run = typeof runs.$inferSelect;
export type Event = typeof events.$inferSelect;
export type LogChunk = typeof log_chunks.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type LoginToken = typeof login_tokens.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;
