// Persistent berth-control runtime config.
//
// One JSON file per OS user that runs berth-control — it points at the DB
// location and (optionally) the default projects directory used by the
// Git-clone-and-register flow.
//
// Lookup order for the DB path:
//   1. `db_path` in this config file — set by /setup or the Storage UI;
//      represents the user's deliberate choice and wins over everything.
//   2. `BERTH_CONTROL_DB` env var — used for bootstrapping (the LaunchAgent
//      plist sets this so a cold boot before any config exists still
//      works).
//   3. Default fallback at `~/.berth-control/berth-control.db`.
//
// The config lives in the OS user's home (NOT in the DB dir), so the user
// who runs berth-control owns it. If the same DB is shared by multiple
// users (Option B layout), each one writes their own `.config.json` that
// points at the same shared DB path.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface RuntimeConfig {
  db_path?: string;
  projects_dir?: string;
}

const CONFIG_DIR = resolve(homedir(), '.berth-control');
const CONFIG_PATH = resolve(CONFIG_DIR, '.config.json');

let cached: RuntimeConfig | null = null;
let cachedAt = 0;
const TTL_MS = 30_000;

export function readConfig(force = false): RuntimeConfig {
  if (!force && cached && Date.now() - cachedAt < TTL_MS) return cached;
  let cfg: RuntimeConfig = {};
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, 'utf8');
      cfg = JSON.parse(raw) as RuntimeConfig;
    }
  } catch {
    cfg = {};
  }
  cached = cfg;
  cachedAt = Date.now();
  return cfg;
}

export function writeConfig(next: RuntimeConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const merged: RuntimeConfig = { ...readConfig(true), ...next };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  cached = merged;
  cachedAt = Date.now();
}

/** Resolve the DB path the way the runtime should see it. Config file wins
 *  over env var — the user's deliberate UI choice trumps a bootstrap
 *  default. */
export function resolveDbPath(): string {
  const cfg = readConfig();
  if (cfg.db_path) return cfg.db_path;
  const envPath = process.env.BERTH_CONTROL_DB?.trim();
  if (envPath) return envPath;
  return resolve(homedir(), '.berth-control/berth-control.db');
}

/** Default destination root for `Add app from Git URL`. Same priority. */
export function resolveProjectsDir(): string {
  const cfg = readConfig();
  if (cfg.projects_dir) return cfg.projects_dir;
  const envPath = process.env.BERTH_CONTROL_PROJECTS_DIR?.trim();
  if (envPath) return envPath;
  return resolve(homedir(), 'Development');
}

/** What the runtime decided to use, plus where it came from. The Storage
 *  UI surfaces the source so the user knows whether they have an env-var
 *  pin (LaunchAgent) or a config file or just the default. */
export interface ResolvedPath {
  path: string;
  source: 'config' | 'env' | 'default';
}

export function resolveDbPathWithSource(): ResolvedPath {
  const cfg = readConfig();
  if (cfg.db_path) return { path: cfg.db_path, source: 'config' };
  const envPath = process.env.BERTH_CONTROL_DB?.trim();
  if (envPath) return { path: envPath, source: 'env' };
  return { path: resolve(homedir(), '.berth-control/berth-control.db'), source: 'default' };
}

export function resolveProjectsDirWithSource(): ResolvedPath {
  const cfg = readConfig();
  if (cfg.projects_dir) return { path: cfg.projects_dir, source: 'config' };
  const envPath = process.env.BERTH_CONTROL_PROJECTS_DIR?.trim();
  if (envPath) return { path: envPath, source: 'env' };
  return { path: resolve(homedir(), 'Development'), source: 'default' };
}

/** Has the user finished the first-run setup wizard? `true` when the
 *  config file exists at all — even an empty one counts (means the user
 *  reached the end of `/setup` and we wrote it deliberately). */
export function isConfigured(): boolean {
  return existsSync(CONFIG_PATH);
}

export const CONFIG_FILE_PATH = CONFIG_PATH;
