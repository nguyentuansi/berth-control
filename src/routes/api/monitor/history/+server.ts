import { json, error } from '@sveltejs/kit';
import { gte, lte, and, asc } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { requireUser } from '$lib/server/auth.js';

// Time-range query for the charts page.
//
// Query params:
//   from   — ms-since-epoch (defaults to 1h ago)
//   to     — ms-since-epoch (defaults to now)
//   max    — cap on rows returned. We downsample server-side to keep the
//            response shape predictable for the client; default 600.
//
// Why downsample on the server: a 90-day window at 60-second granularity is
// ~130k rows. The chart renderer (Chart.js) chokes past ~2k points, and the
// network transfer is wasteful — most adjacent samples are nearly identical.
// We bucket-sample: divide the requested window into `max` evenly-spaced
// buckets and pick one sample per bucket (the median timestamp's row).
//
// JSON columns (cpu_util_cores, net_per_iface, misc_temps, cpu_core_temps)
// are returned parsed so the client doesn't re-JSON-parse each row.

export const GET: RequestHandler = async ({ url, locals }) => {
  requireUser(locals);

  const now = Date.now();
  const from = Number(url.searchParams.get('from') ?? now - 3_600_000);
  const to = Number(url.searchParams.get('to') ?? now);
  const max = Math.min(2000, Math.max(50, Number(url.searchParams.get('max') ?? 600)));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw error(400, 'invalid range');
  }

  const rows = db
    .select()
    .from(schema.host_readings)
    .where(and(gte(schema.host_readings.ts, new Date(from)), lte(schema.host_readings.ts, new Date(to))))
    .orderBy(asc(schema.host_readings.ts))
    .all();

  // Server-side bucket downsample. Picks the first row whose timestamp lands
  // in each bucket. For empty buckets we just emit nothing — gaps in the
  // chart honestly reflect missing data instead of inventing a value.
  const bucketed: typeof rows = [];
  if (rows.length <= max) {
    bucketed.push(...rows);
  } else {
    const bucketWidthMs = (to - from) / max;
    let cursor = from;
    let idx = 0;
    for (let b = 0; b < max && idx < rows.length; b++) {
      const bucketEnd = cursor + bucketWidthMs;
      // First row whose ts falls in [cursor, bucketEnd).
      while (idx < rows.length && rows[idx].ts.getTime() < cursor) idx++;
      if (idx < rows.length && rows[idx].ts.getTime() < bucketEnd) {
        bucketed.push(rows[idx]);
        idx++;
      }
      cursor = bucketEnd;
    }
  }

  // Parse JSON columns so the client doesn't need to. The DB-side column is
  // TEXT — Drizzle gives it back as a string.
  const parseJson = (v: unknown): unknown => {
    if (v == null) return null;
    if (typeof v !== 'string') return v;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };

  const samples = bucketed.map((r) => ({
    ts: r.ts.getTime(),
    cpu_util_total: r.cpu_util_total,
    cpu_util_cores: parseJson(r.cpu_util_cores),
    cpu_pkg_temp: r.cpu_pkg_temp,
    cpu_core_temps: parseJson(r.cpu_core_temps),
    gpu_temp: r.gpu_temp,
    gpu_power_w: r.gpu_power_w,
    gpu_mem_used_mb: r.gpu_mem_used_mb,
    gpu_mem_total_mb: r.gpu_mem_total_mb,
    gpu_fan_pct: r.gpu_fan_pct,
    gpu_util_pct: r.gpu_util_pct,
    mem_total_mb: r.mem_total_mb,
    mem_available_mb: r.mem_available_mb,
    mem_buffers_mb: r.mem_buffers_mb,
    mem_cached_mb: r.mem_cached_mb,
    swap_total_mb: r.swap_total_mb,
    swap_free_mb: r.swap_free_mb,
    disk_total_gb: r.disk_total_gb,
    disk_used_gb: r.disk_used_gb,
    disk_avail_gb: r.disk_avail_gb,
    net_per_iface: parseJson(r.net_per_iface),
    misc_temps: parseJson(r.misc_temps)
  }));

  return json({ from, to, count: samples.length, samples });
};
