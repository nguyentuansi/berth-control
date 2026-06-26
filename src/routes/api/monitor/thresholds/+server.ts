import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { requireUser } from '$lib/server/auth.js';
import { METRIC_DEFINITIONS } from '$lib/server/monitor/alerts.js';

// Threshold CRUD for the host monitor's alert evaluator.
//
// GET — read all threshold rows + the metric metadata (label, unit, default)
//       so the UI can render the right input field per row.
// PUT — bulk update. Body: { changes: [{ key, warn_value, cooldown_secs? }] }.
//       Only known metric keys are accepted; unknown keys silently ignored.
//
// Auth: any signed-in user can read; only admins can change. Same pattern
// as the rest of berth — viewers see, admins act.

export const GET: RequestHandler = async ({ locals }) => {
  requireUser(locals);
  const rows = db.select().from(schema.host_thresholds).all();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const merged = METRIC_DEFINITIONS.map((def) => {
    const row = byKey.get(def.key);
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      defaultWarn: def.defaultWarn,
      warn_value: row?.warn_value ?? null,
      cooldown_secs: row?.cooldown_secs ?? 900,
      last_fired_at: row?.last_fired_at?.getTime() ?? null
    };
  });
  return json({ thresholds: merged });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals);
  if (user.role !== 'admin') throw error(403, 'admin only');

  const body = (await request.json().catch(() => null)) as {
    changes?: Array<{ key?: string; warn_value?: number | null; cooldown_secs?: number }>;
  } | null;
  if (!body?.changes || !Array.isArray(body.changes)) {
    throw error(400, 'changes[] required');
  }

  const known = new Set(METRIC_DEFINITIONS.map((d) => d.key));
  const updated: string[] = [];
  for (const c of body.changes) {
    if (!c.key || !known.has(c.key)) continue;
    const warn = c.warn_value == null ? null : Number(c.warn_value);
    if (warn != null && !Number.isFinite(warn)) continue;
    const cooldown = Number.isFinite(Number(c.cooldown_secs))
      ? Math.max(60, Math.floor(Number(c.cooldown_secs)))
      : undefined;

    // Upsert: insert if missing, update if present.
    const existing = db
      .select()
      .from(schema.host_thresholds)
      .where(eq(schema.host_thresholds.key, c.key))
      .get();
    if (existing) {
      db.update(schema.host_thresholds)
        .set({
          warn_value: warn,
          cooldown_secs: cooldown ?? existing.cooldown_secs,
          updated_at: new Date()
        })
        .where(eq(schema.host_thresholds.key, c.key))
        .run();
    } else {
      db.insert(schema.host_thresholds)
        .values({
          key: c.key,
          warn_value: warn,
          cooldown_secs: cooldown ?? 900,
          last_fired_at: null,
          updated_at: new Date()
        })
        .run();
    }
    updated.push(c.key);
  }

  return json({ ok: true, updated });
};
