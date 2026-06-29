import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';
import { resolveDbPath } from '../config.js';

// Resolution priority (config.ts → resolveDbPath):
//   1. `.config.json#db_path` — deliberate UI/file choice
//   2. `BERTH_CONTROL_DB` env var — bootstrap path used by launchd
//   3. default `~/.berth-control/berth-control.db`
//
// Reading only the env var here was a real bug: the user had set
// `db_path` to `/Users/Shared/.berth-control/berth-control.db` in
// `.config.json`, but the runtime silently opened the empty home-dir DB
// and the dashboard reported `0 apps registered` despite all the data
// being present in the shared file.
const dbPath = resolveDbPath();
mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');

export const db = drizzle(sqlite, { schema });
export { schema };
export const dbPathInUse = dbPath;
