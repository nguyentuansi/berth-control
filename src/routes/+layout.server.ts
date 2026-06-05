import type { LayoutServerLoad } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { eq, asc } from 'drizzle-orm';

export const load: LayoutServerLoad = ({ locals }) => {
  const allApps = db
    .select({
      id: schema.apps.id,
      name: schema.apps.name,
      port: schema.apps.port,
      project_path: schema.apps.project_path
    })
    .from(schema.apps)
    .where(eq(schema.apps.hidden, false))
    .orderBy(asc(schema.apps.name))
    .all();
  return { user: locals.user, allApps };
};
