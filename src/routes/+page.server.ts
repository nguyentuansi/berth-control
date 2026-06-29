import { db, schema } from '$lib/server/db/index.js';
import { asc, and, eq, isNull, desc } from 'drizzle-orm';
import { getUptimeBuckets } from '$lib/server/uptime.js';
import { visibilityFilter, grantedAppIds } from '$lib/server/visibility.js';
import { _snapshot as liveSnapshot } from './api/state/+server.js';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user;
  // No user (shouldn't happen — hooks redirect to /login) → empty list.
  if (!user) {
    return {
      apps: [],
      openByApp: {},
      latestEvent: [],
      uptime: {},
      grants: {},
      initialLive: null,
      tourCompleted: null,
      user: null
    };
  }
  const list = db
    .select()
    .from(schema.apps)
    .where(and(eq(schema.apps.hidden, false), visibilityFilter(user.login)))
    .orderBy(asc(schema.apps.port))
    .all();
  // Open runs by app_id → for "since" badge.
  const openRuns = db.select().from(schema.runs).where(isNull(schema.runs.stopped_at)).all();
  const openByApp: Record<string, (typeof openRuns)[number]> = {};
  for (const r of openRuns) openByApp[r.app_id] = r;
  // Latest event per app — same filter, no scope tightening (events don't
  // expose anything beyond "stuff happened to your apps").
  const latestEvent = db
    .select()
    .from(schema.events)
    .orderBy(desc(schema.events.ts))
    .limit(50)
    .all();
  // 24-bucket up-fraction over the last 24h for each app — sparkline data.
  const uptime: Record<string, number[]> = {};
  for (const a of list) uptime[a.id] = getUptimeBuckets(a.id);
  // Which apps the user has been granted on — used to show a "shared with you"
  // marker vs "you own this" on the card.
  const grants: Record<string, boolean> = {};
  for (const id of grantedAppIds(user.login)) grants[id] = true;
  // Hydrate the dashboard's livestate from the same snapshot the SSE feed
  // uses, so the first render reflects reality. Without this, every app
  // shows "Start" for the ~100-300ms the client takes to receive its first
  // SSE frame — even apps that are actually up (foreign listeners that
  // berth correctly detected). Best-effort: if snapshot() throws, fall
  // back to null and the client gets the brief flash but doesn't crash.
  let initialLive: Awaited<ReturnType<typeof liveSnapshot>> | null = null;
  try {
    initialLive = await liveSnapshot();
  } catch (e) {
    console.warn('[dashboard] initial livestate snapshot failed:', e instanceof Error ? e.message : String(e));
  }
  // Each onboarding affordance has its own dismiss state — the user can
  // finish the tour while still using the checklist as a milestones
  // tracker, or dismiss the checklist while keeping the tour for later.
  // Either column being null = that component still renders.
  const me = db
    .select({
      tour_completed_at: schema.users.tour_completed_at,
      checklist_dismissed_at: schema.users.checklist_dismissed_at
    })
    .from(schema.users)
    .where(eq(schema.users.login, user.login))
    .get();
  const tourCompleted = me?.tour_completed_at ?? null;
  const checklistDismissed = me?.checklist_dismissed_at ?? null;

  return {
    apps: list,
    openByApp,
    latestEvent,
    uptime,
    grants,
    initialLive,
    tourCompleted,
    checklistDismissed,
    user
  };
};
