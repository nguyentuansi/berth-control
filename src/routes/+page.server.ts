import { db, schema } from '$lib/server/db/index.js';
import { asc, eq, isNull, desc } from 'drizzle-orm';
import { getUptimeBuckets } from '$lib/server/uptime.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async () => {
  const list = db
    .select()
    .from(schema.apps)
    .where(eq(schema.apps.hidden, false))
    .orderBy(asc(schema.apps.port))
    .all();
  // Open runs by app_id → for "since" badge.
  const openRuns = db
    .select()
    .from(schema.runs)
    .where(isNull(schema.runs.stopped_at))
    .all();
  const openByApp: Record<string, (typeof openRuns)[number]> = {};
  for (const r of openRuns) openByApp[r.app_id] = r;
  // Latest event per app.
  const latestEvent = db
    .select()
    .from(schema.events)
    .orderBy(desc(schema.events.ts))
    .limit(50)
    .all();
  // 24-bucket up-fraction over the last 24h for each app — sparkline data.
  const uptime: Record<string, number[]> = {};
  for (const a of list) uptime[a.id] = getUptimeBuckets(a.id);
  return { apps: list, openByApp, latestEvent, uptime };
};
