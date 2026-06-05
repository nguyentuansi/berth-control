import { db, schema } from '$lib/server/db/index.js';
import { desc } from 'drizzle-orm';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
  const snapshots = db
    .select()
    .from(schema.snapshots)
    .orderBy(desc(schema.snapshots.id))
    .all();
  const apps = db.select().from(schema.apps).all();
  const byId = Object.fromEntries(apps.map((a) => [a.id, a.name]));
  return { snapshots, byId };
};
