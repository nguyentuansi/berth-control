import type { Config } from 'drizzle-kit';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const dbPath = process.env.BERTH_CONTROL_DB ?? resolve(homedir(), '.berth-control/berth-control.db');

export default {
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: dbPath }
} satisfies Config;
