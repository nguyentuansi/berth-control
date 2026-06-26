import { db } from '../db/index.js';
import { events, host_thresholds } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import type { HostSample } from './sensors-shared.js';

// Threshold-driven alerting.
//
// Per-metric warn levels are stored in host_thresholds. Every collector tick
// passes through evaluateAlerts(), which:
//   1. Computes the current value for each known metric key from the sample.
//   2. Compares to the stored warn_value (skipped if null = disabled).
//   3. If exceeded AND we're past the cooldown window from the last fire,
//      writes a 'warn' event to the events table and updates last_fired_at.
//
// No external notifier in phase D — the events table IS the alert log; the
// dashboard page reads it in Phase D's UI. Push notification dispatch lives
// in phase E and hooks the same evaluator.

/** Names of the metrics the evaluator understands. Each maps to a (sample) →
 *  current-value-or-null extractor. Keeping it data-driven means adding a
 *  new threshold needs one row here and one default insert in
 *  ensureDefaultThresholds. */
export const METRIC_DEFINITIONS: Array<{
  key: string;
  label: string;
  unit: string;
  defaultWarn: number | null;
  extract: (s: HostSample) => number | null;
}> = [
  {
    key: 'cpu_temp',
    label: 'CPU package temperature',
    unit: '°C',
    defaultWarn: 80,
    extract: (s) => s.cpu_pkg_temp
  },
  {
    key: 'gpu_temp',
    label: 'GPU temperature',
    unit: '°C',
    defaultWarn: 85,
    extract: (s) => s.gpu_temp
  },
  {
    key: 'cpu_util',
    label: 'CPU utilization',
    unit: '%',
    defaultWarn: 95,
    extract: (s) => s.cpu_util_total
  },
  {
    key: 'ram_pct',
    label: 'RAM usage',
    unit: '%',
    defaultWarn: 90,
    extract: (s) => {
      if (s.mem_total_mb == null || s.mem_available_mb == null || s.mem_total_mb <= 0) return null;
      return ((s.mem_total_mb - s.mem_available_mb) / s.mem_total_mb) * 100;
    }
  },
  {
    key: 'disk_pct',
    label: 'Disk / usage',
    unit: '%',
    defaultWarn: 90,
    extract: (s) => {
      if (s.disk_total_gb == null || s.disk_used_gb == null || s.disk_total_gb <= 0) return null;
      return (s.disk_used_gb / s.disk_total_gb) * 100;
    }
  },
  {
    key: 'swap_pct',
    label: 'Swap usage',
    unit: '%',
    defaultWarn: 50,
    extract: (s) => {
      if (s.swap_total_mb == null || s.swap_free_mb == null || s.swap_total_mb <= 0) return null;
      return ((s.swap_total_mb - s.swap_free_mb) / s.swap_total_mb) * 100;
    }
  }
];

const labelByKey = new Map(METRIC_DEFINITIONS.map((d) => [d.key, d]));

/** Ensure every well-known threshold key has a row. Idempotent — called once
 *  at collector boot. Default values are chosen conservatively; users tune
 *  them on the /monitor page. */
export function ensureDefaultThresholds(): void {
  const existing = new Set(
    db
      .select({ k: host_thresholds.key })
      .from(host_thresholds)
      .all()
      .map((r) => r.k)
  );
  for (const def of METRIC_DEFINITIONS) {
    if (existing.has(def.key)) continue;
    db.insert(host_thresholds)
      .values({
        key: def.key,
        warn_value: def.defaultWarn,
        cooldown_secs: 900,
        last_fired_at: null,
        updated_at: new Date()
      })
      .run();
  }
}

export interface FiredAlert {
  key: string;
  label: string;
  unit: string;
  value: number;
  threshold: number;
}

/** Evaluate the sample against all enabled thresholds; fire (i.e. write an
 *  events row and update last_fired_at) for each exceeded one that's past
 *  its cooldown. Returns the fired set so phase E can dispatch push
 *  notifications without re-querying. */
export function evaluateAlerts(sample: HostSample): FiredAlert[] {
  const rows = db.select().from(host_thresholds).all();
  if (rows.length === 0) return [];
  const now = Date.now();
  const fired: FiredAlert[] = [];

  for (const row of rows) {
    if (row.warn_value == null) continue;
    const def = labelByKey.get(row.key);
    if (!def) continue;
    const value = def.extract(sample);
    if (value == null) continue;
    if (value < row.warn_value) continue;
    if (row.last_fired_at && now - row.last_fired_at.getTime() < row.cooldown_secs * 1000) continue;

    // Fire.
    db.update(host_thresholds)
      .set({ last_fired_at: new Date(now), updated_at: new Date() })
      .where(eq(host_thresholds.key, row.key))
      .run();
    db.insert(events)
      .values({
        app_id: null,
        level: 'warn',
        msg: `${def.label} ${value.toFixed(1)}${def.unit} ≥ threshold ${row.warn_value}${def.unit}`
      })
      .run();
    fired.push({
      key: row.key,
      label: def.label,
      unit: def.unit,
      value,
      threshold: row.warn_value
    });
  }
  return fired;
}
