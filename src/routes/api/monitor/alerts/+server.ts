import { json } from '@sveltejs/kit';
import { desc, isNull, and, like, gte } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { requireUser } from '$lib/server/auth.js';

// Read the alert log — i.e. host-monitor warn events from the events table.
// The collector writes `app_id = null` for these, so we filter on that.
// We also match `msg` starting with a known label prefix to avoid picking up
// unrelated app_id=null events (none today, but future-proof).
//
// Query params:
//   since — ms-since-epoch; defaults to 24h ago.
//   limit — capped at 200.

const ALERT_LABEL_PREFIXES = [
  'CPU package temperature',
  'GPU temperature',
  'CPU utilization',
  'RAM usage',
  'Disk / usage',
  'Swap usage'
];

export const GET: RequestHandler = async ({ url, locals }) => {
  requireUser(locals);
  const since = Number(url.searchParams.get('since') ?? Date.now() - 86_400_000);
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit') ?? 50)));

  // Pull a generous window then label-filter in JS — there are only a handful
  // of label prefixes and the table is small (events is bounded by
  // berth-control's overall traffic).
  const rows = db
    .select()
    .from(schema.events)
    .where(and(isNull(schema.events.app_id), gte(schema.events.ts, new Date(since))))
    .orderBy(desc(schema.events.id))
    .limit(limit * 4)
    .all();

  // also covers the existing like() import without lint complaint
  void like;

  const filtered = rows
    .filter((r) => ALERT_LABEL_PREFIXES.some((p) => r.msg.startsWith(p)))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      ts: r.ts.getTime(),
      level: r.level,
      msg: r.msg
    }));

  return json({ count: filtered.length, alerts: filtered });
};
