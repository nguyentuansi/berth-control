import type { Config } from 'drizzle-kit';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const dbPath = process.env.HARBORCTL_DB ?? resolve(homedir(), '.harborctl/harborctl.db');

export default {
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: dbPath }
} satisfies Config;
