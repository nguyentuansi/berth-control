import { eq, and, gt, gte, isNull, or, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { runs, apps, uptime_samples } from './db/schema.js';
import { listListeners, isLocalBind } from './prober.js';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * Bucketed up-fraction of an app over a recent window. Returns one number
 * per bucket, oldest → newest, each in [0,1].
 *
 * Source priority per bucket: if the heartbeat has any minute samples for
 * this bucket, they win — samples reflect actually-observed listener health
 * (port responded). Otherwise fall back to the `runs` ledger so buckets
 * predating the samples table still render. Empty in both → 0 / grey.
 */
export function getUptimeBuckets(
  appId: string,
  hours = 24,
  buckets = 24
): number[] {
  const r = bucketsFromRuns(appId, hours, buckets);
  const { fraction: s, counts } = bucketsFromSamples(appId, hours, buckets);
  return r.map((rv, i) => (counts[i] > 0 ? s[i] : rv));
}

function bucketsFromRuns(appId: string, hours: number, buckets: number): number[] {
  const now = Date.now();
  const windowMs = hours * HOUR_MS;
  const windowStart = now - windowMs;
  const bucketMs = windowMs / buckets;
  const out = new Array(buckets).fill(0);

  const rows = db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.app_id, appId),
        or(isNull(runs.stopped_at), gt(runs.stopped_at, new Date(windowStart)))
      )
    )
    .all();

  for (const r of rows) {
    const startMs = r.started_at.getTime();
    const stopMs = r.stopped_at ? r.stopped_at.getTime() : now;
    if (stopMs <= windowStart) continue;
    const s = Math.max(startMs, windowStart);
    const e = Math.min(stopMs, now);
    for (let b = 0; b < buckets; b++) {
      const bs = windowStart + b * bucketMs;
      const be = bs + bucketMs;
      const overlap = Math.max(0, Math.min(e, be) - Math.max(s, bs));
      if (overlap > 0) out[b] = Math.min(1, out[b] + overlap / bucketMs);
    }
  }
  return out;
}

function bucketsFromSamples(
  appId: string,
  hours: number,
  buckets: number
): { fraction: number[]; counts: number[] } {
  const now = Date.now();
  const windowMs = hours * HOUR_MS;
  const windowStart = now - windowMs;
  const bucketMs = windowMs / buckets;

  const rows = db
    .select()
    .from(uptime_samples)
    .where(and(eq(uptime_samples.app_id, appId), gte(uptime_samples.ts, windowStart)))
    .all();

  // Per-bucket: up_count and total_count. Fraction = up / total — the share
  // of polls in this bucket that observed "up". A freshly-booted Berth shows
  // the rightmost bucket as green immediately after the first poll instead
  // of crawling from 1/60 over the full hour.
  const up = new Array(buckets).fill(0);
  const total = new Array(buckets).fill(0);
  for (const r of rows) {
    const b = Math.floor((r.ts - windowStart) / bucketMs);
    if (b < 0 || b >= buckets) continue;
    total[b]++;
    if (r.up) up[b]++;
  }
  return {
    fraction: up.map((u, i) => (total[i] > 0 ? u / total[i] : 0)),
    counts: total
  };
}

let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
let lastRetentionRun = 0;
const RETENTION_DAYS = 30;

/**
 * Start the background uptime heartbeat. Every `intervalMs` it polls all
 * apps (via `ss -tlnp` + the loopback/wildcard filter, same source the live
 * dashboard uses), then UPSERTs one (app_id, current_minute, up) row each.
 * The "MAX(up, excluded.up)" conflict policy means any 'up' reading within a
 * given minute makes that minute count as up — robust against single-tick
 * blips during restarts.
 *
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function startUptimeHeartbeat(intervalMs = 30_000): void {
  if (heartbeatHandle) return;
  const tick = async () => {
    try {
      await sampleOnce();
    } catch (e) {
      console.warn('[berth] uptime heartbeat error:', e);
    }
  };
  // Fire immediately so we don't wait `intervalMs` for the first row.
  void tick();
  heartbeatHandle = setInterval(tick, intervalMs);
  if (typeof heartbeatHandle === 'object' && 'unref' in heartbeatHandle) {
    (heartbeatHandle as { unref: () => void }).unref();
  }
}

async function sampleOnce(): Promise<void> {
  const listeners = await listListeners();
  const localPorts = new Set<number>();
  for (const l of listeners) {
    if (l.isLocal && isLocalBind(l.host)) localPorts.add(l.port);
  }
  const allApps = db.select().from(apps).all();
  const minuteTs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const upsert = db.$client.prepare(
    `INSERT INTO uptime_samples (app_id, ts, up) VALUES (?, ?, ?)
     ON CONFLICT(app_id, ts) DO UPDATE SET up = MAX(up, excluded.up)`
  );
  const writeMany = db.$client.transaction((rows: { id: string; up: number }[]) => {
    for (const r of rows) upsert.run(r.id, minuteTs, r.up);
  });
  const payload = allApps
    .filter((a) => a.port !== null)
    .map((a) => ({ id: a.id, up: localPorts.has(a.port!) ? 1 : 0 }));
  if (payload.length > 0) writeMany(payload);

  // Trim history once an hour. RETENTION_DAYS days back is plenty for the
  // sparkline (only 24h is rendered) but gives headroom for future widgets.
  if (Date.now() - lastRetentionRun > HOUR_MS) {
    lastRetentionRun = Date.now();
    const cutoff = Date.now() - RETENTION_DAYS * 24 * HOUR_MS;
    db.run(sql`DELETE FROM uptime_samples WHERE ts < ${cutoff}`);
  }
}
