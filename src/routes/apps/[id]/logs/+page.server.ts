import { error } from '@sveltejs/kit';
import { db, schema } from '$lib/server/db/index.js';
import { eq, desc, and, isNull } from 'drizzle-orm';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
  const app = db.select().from(schema.apps).where(eq(schema.apps.id, params.id)).get();
  if (!app) throw error(404, 'unknown app');
  const openRun = db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.app_id, params.id), isNull(schema.runs.stopped_at)))
    .get();
  const recent = db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.app_id, params.id))
    .orderBy(desc(schema.runs.id))
    .limit(20)
    .all();
  return { app, openRun, recent };
};
