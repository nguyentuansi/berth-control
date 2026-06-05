import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { desc, eq, isNull } from 'drizzle-orm';
import { startApp, stopApp } from '$lib/server/supervisor.js';

export const GET: RequestHandler = async () => {
  const list = db.select().from(schema.snapshots).orderBy(desc(schema.snapshots.id)).all();
  return json(list);
};

/** body: { action: 'save', name } — captures currently-up managed apps
 *       | { action: 'apply', id } — starts every app in the snapshot
 *       | { action: 'delete', id } */
export const POST: RequestHandler = async ({ request, locals }) => {
  const body = (await request.json()) as { action: string; id?: number; name?: string };
  if (body.action === 'save') {
    if (!body.name) throw error(400, 'name required');
    const openRuns = db
      .select({ app_id: schema.runs.app_id })
      .from(schema.runs)
      .where(isNull(schema.runs.stopped_at))
      .all();
    const ids = Array.from(new Set(openRuns.map((r) => r.app_id)));
    const ins = db
      .insert(schema.snapshots)
      .values({
        name: body.name,
        app_ids: JSON.stringify(ids),
        created_at: new Date(),
        created_by: locals.user?.login ?? null
      })
      .returning()
      .get();
    return json(ins);
  }
  if (body.action === 'delete') {
    if (!body.id) throw error(400, 'id required');
    db.delete(schema.snapshots).where(eq(schema.snapshots.id, body.id)).run();
    return json({ ok: true });
  }
  if (body.action === 'apply') {
    if (!body.id) throw error(400, 'id required');
    const snap = db.select().from(schema.snapshots).where(eq(schema.snapshots.id, body.id)).get();
    if (!snap) throw error(404, 'snapshot not found');
    const ids = JSON.parse(snap.app_ids) as string[];
    const results: Record<string, { ok: boolean; msg?: string }> = {};
    for (const id of ids) {
      try {
        await startApp(id, locals.user?.login ?? null);
        results[id] = { ok: true };
      } catch (e) {
        results[id] = { ok: false, msg: e instanceof Error ? e.message : String(e) };
      }
    }
    return json({ count: ids.length, results });
  }
  if (body.action === 'stop') {
    if (!body.id) throw error(400, 'id required');
    const snap = db.select().from(schema.snapshots).where(eq(schema.snapshots.id, body.id)).get();
    if (!snap) throw error(404, 'snapshot not found');
    const ids = JSON.parse(snap.app_ids) as string[];
    for (const id of ids) {
      try {
        await stopApp(id, locals.user?.login ?? null);
      } catch {
        /* ignore */
      }
    }
    return json({ count: ids.length });
  }
  throw error(400, 'unknown action');
};
