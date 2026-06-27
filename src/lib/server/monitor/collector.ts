import { db } from '../db/index.js';
import { host_readings } from '../db/schema.js';
import { lt } from 'drizzle-orm';
import { linuxSensors } from './sensors-linux.js';
import { macosSensors } from './sensors-macos.js';
import type { HostSample, SensorModule } from './sensors-shared.js';
import { ensureDefaultThresholds, evaluateAlerts, type FiredAlert } from './alerts.js';
import { broadcastNotification, ensureWebPushReady } from './web-push.js';

// In-process host-monitoring collector.
//
// Picks the platform module at boot (linuxSensors vs macosSensors, additive
// per the cross-platform rule — never substitute), then setIntervals on the
// user-configured cadence. Adaptive cadence: when RAM is under pressure (>=
// adaptive_threshold_pct used), the sample rate switches from `intervalSecs`
// to `fastIntervalSecs` so the time-series shows the pressure ramp clearly.
//
// Configuration via env (all with safe defaults — no .env required to boot):
//   BERTH_CONTROL_MONITOR_INTERVAL_SECS       (default 60) normal cadence
//   BERTH_CONTROL_MONITOR_FAST_INTERVAL_SECS  (default 10) under-pressure cadence
//   BERTH_CONTROL_MONITOR_RAM_PRESSURE_PCT    (default 80) trigger for fast mode
//   BERTH_CONTROL_MONITOR_RETENTION_DAYS      (default 90) drop rows older than this
//
// NEVER hardcode any user-specific value (hostname, tailnet domain, IPs,
// interfaces). Anything machine-specific is discovered at runtime by the
// platform sensor module.

interface Config {
  intervalSecs: number;
  fastIntervalSecs: number;
  ramPressurePct: number;
  retentionDays: number;
}

function loadConfig(): Config {
  const num = (k: string, d: number): number => {
    const v = Number(process.env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    intervalSecs: num('BERTH_CONTROL_MONITOR_INTERVAL_SECS', 60),
    fastIntervalSecs: num('BERTH_CONTROL_MONITOR_FAST_INTERVAL_SECS', 10),
    ramPressurePct: num('BERTH_CONTROL_MONITOR_RAM_PRESSURE_PCT', 80),
    retentionDays: num('BERTH_CONTROL_MONITOR_RETENTION_DAYS', 90)
  };
}

function selectModule(): SensorModule {
  if (process.platform === 'linux') return linuxSensors;
  if (process.platform === 'darwin') return macosSensors;
  // Unsupported platform — return a stub module so the rest of the pipeline
  // still works (it just writes nulls forever).
  return {
    init: async () => ({ availability: {}, notes: [`unsupported platform: ${process.platform}`] }),
    sample: async () => ({}) as HostSample
  };
}

/** Last snapshot for the SSE feed in Phase C. Updated on every successful
 *  sample tick; null until the first tick lands. */
let latestSample: { ts: number; sample: HostSample } | null = null;

export interface TickSnapshot {
  ts: number;
  sample: HostSample;
  /** Alerts that fired on THIS tick. Empty array for normal ticks. */
  fired: FiredAlert[];
}

/** Listeners notified after each tick — drives the SSE feed without a
 *  separate poll. Subscribers are responsible for removing themselves with
 *  the returned unsubscribe function. */
const listeners = new Set<(snapshot: TickSnapshot) => void>();

let running = false;
let stopRequested = false;
let activeTimer: NodeJS.Timeout | null = null;

export function getLatestSample(): { ts: number; sample: HostSample } | null {
  return latestSample;
}

export function subscribeToSamples(fn: (snapshot: TickSnapshot) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Start the in-process collector. Idempotent — calling twice is a no-op so
 *  bootOnce can re-call without thinking about it. */
export async function startHostMonitor(): Promise<void> {
  if (running) return;
  running = true;
  stopRequested = false;

  const cfg = loadConfig();
  const sensors = selectModule();
  ensureDefaultThresholds();
  // Lazy: this prints a one-line note if BERTH_CONTROL_MONITOR_PUSH_CONTACT
  // is unset (push stays disabled but berth still boots). When set, the
  // VAPID keypair is generated on first call and persisted.
  void ensureWebPushReady().then((ready) => {
    if (ready) console.log('[monitor] web push enabled');
  });

  try {
    const { availability, notes } = await sensors.init();
    console.log(
      `[monitor] platform=${process.platform} ` +
        `cadence=${cfg.intervalSecs}s (fast ${cfg.fastIntervalSecs}s @ RAM>=${cfg.ramPressurePct}%) ` +
        `retention=${cfg.retentionDays}d`
    );
    for (const n of notes) console.log(`[monitor] ${n}`);
    const availList = Object.entries(availability)
      .map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`)
      .join(' ');
    if (availList) console.log(`[monitor] availability ${availList}`);
  } catch (e) {
    console.warn('[monitor] sensor init failed:', e instanceof Error ? e.message : String(e));
  }

  const tick = async () => {
    if (stopRequested) return;
    try {
      const sample = await sensors.sample();
      const ts = Date.now();
      latestSample = { ts, sample };
      persistSample(ts, sample);

      // Evaluate alerts AFTER persisting so the threshold check sees the
      // same snapshot the dashboard does. Any fired alerts get dispatched
      // to phase E's push subscribers (no-op for now — the export is empty
      // until phase E lands its hook).
      let fired: FiredAlert[] = [];
      try {
        fired = evaluateAlerts(sample);
      } catch (e) {
        console.warn(
          '[monitor] alert evaluation failed:',
          e instanceof Error ? e.message : String(e)
        );
      }

      // Dispatch push notifications for each fired alert. Best-effort:
      // failures are absorbed inside broadcastNotification so the tick
      // never stalls on a slow push service. Skipped if push isn't
      // configured (no PUSH_CONTACT in env or no subscribers yet).
      for (const a of fired) {
        void broadcastNotification({
          title: `${a.label} alert`,
          body: `${a.value.toFixed(1)}${a.unit} (threshold ${a.threshold}${a.unit})`,
          tag: `monitor-${a.key}`
        }).catch(() => {
          /* never let push failures break the tick */
        });
      }

      for (const fn of listeners) {
        try {
          fn({ ts, sample, fired });
        } catch {
          /* listener errors must never break the tick */
        }
      }
    } catch (e) {
      console.warn('[monitor] sample tick failed:', e instanceof Error ? e.message : String(e));
    }

    if (stopRequested) return;
    const next = adaptiveDelayMs(cfg);
    activeTimer = setTimeout(tick, next);
    activeTimer.unref();
  };

  // Retention sweep — matches pcmonitor's once-per-day cadence so an idle
  // berth-control machine doesn't churn the DB. Also runs once at boot so
  // a long-stopped install doesn't carry forward weeks of stale rows; an
  // empty / fresh DB just deletes 0 rows, which is harmless.
  runRetentionSweep(cfg.retentionDays);
  const retentionSweep = setInterval(
    () => runRetentionSweep(cfg.retentionDays),
    86_400_000
  );
  retentionSweep.unref();

  // Kick the first tick on a short delay so it doesn't race with bootOnce's
  // other work.
  activeTimer = setTimeout(tick, 1500);
  activeTimer.unref();
}

export function stopHostMonitor(): void {
  stopRequested = true;
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  running = false;
}

function adaptiveDelayMs(cfg: Config): number {
  if (!latestSample) return cfg.intervalSecs * 1000;
  const s = latestSample.sample;
  if (s.mem_total_mb != null && s.mem_available_mb != null && s.mem_total_mb > 0) {
    const usedPct = ((s.mem_total_mb - s.mem_available_mb) / s.mem_total_mb) * 100;
    if (usedPct >= cfg.ramPressurePct) return cfg.fastIntervalSecs * 1000;
  }
  return cfg.intervalSecs * 1000;
}

/** Delete host_readings older than `retentionDays`. Logs the deleted row
 *  count (info if > 0, otherwise silent — pcmonitor's pattern). Errors are
 *  warned and swallowed so a corrupt DB or locked file can't crash the
 *  collector loop. */
function runRetentionSweep(retentionDays: number): void {
  try {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const result = db
      .delete(host_readings)
      .where(lt(host_readings.ts, new Date(cutoff)))
      .run();
    const deleted = (result as { changes?: number }).changes ?? 0;
    if (deleted > 0) {
      console.log(
        `[monitor] retention: deleted ${deleted} row(s) older than ${retentionDays}d`
      );
    }
  } catch (e) {
    console.warn(
      '[monitor] retention sweep failed:',
      e instanceof Error ? e.message : String(e)
    );
  }
}

function persistSample(ts: number, s: HostSample): void {
  const j = (v: unknown) => (v == null ? null : JSON.stringify(v));
  try {
    db.insert(host_readings)
      .values({
        ts: new Date(ts),
        cpu_util_total: s.cpu_util_total,
        cpu_util_cores: j(s.cpu_util_cores),
        cpu_pkg_temp: s.cpu_pkg_temp,
        cpu_core_temps: j(s.cpu_core_temps),
        gpu_temp: s.gpu_temp,
        gpu_power_w: s.gpu_power_w,
        gpu_mem_used_mb: s.gpu_mem_used_mb,
        gpu_mem_total_mb: s.gpu_mem_total_mb,
        gpu_fan_pct: s.gpu_fan_pct,
        gpu_util_pct: s.gpu_util_pct,
        mem_total_mb: s.mem_total_mb,
        mem_available_mb: s.mem_available_mb,
        mem_buffers_mb: s.mem_buffers_mb,
        mem_cached_mb: s.mem_cached_mb,
        swap_total_mb: s.swap_total_mb,
        swap_free_mb: s.swap_free_mb,
        disk_total_gb: s.disk_total_gb,
        disk_used_gb: s.disk_used_gb,
        disk_avail_gb: s.disk_avail_gb,
        net_per_iface: j(s.net_per_iface),
        misc_temps: j(s.misc_temps)
      })
      .run();
  } catch (e) {
    console.warn('[monitor] persist failed:', e instanceof Error ? e.message : String(e));
  }
}

