import type { PageServerLoad } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { dbPathInUse } from '$lib/server/db/index.js';

export const load: PageServerLoad = async () => {
  const users = db.select().from(schema.users).all();
  return { users, dbPath: dbPathInUse };
};
