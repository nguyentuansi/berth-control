import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { eq, inArray } from 'drizzle-orm';
import { startApp, stopApp } from '$lib/server/supervisor.js';

/** Bulk start/stop. Body: { action: 'start' | 'stop', ids?: string[], group?: string } */
export const POST: RequestHandler = async ({ request, locals }) => {
  const body = (await request.json()) as { action?: string; ids?: string[]; group?: string };
  if (body.action !== 'start' && body.action !== 'stop') throw error(400, 'action must be start|stop');
  let ids: string[] = [];
  if (body.ids?.length) ids = body.ids;
  else if (body.group) {
    ids = db
      .select({ id: schema.apps.id })
      .from(schema.apps)
      .where(eq(schema.apps.group_tag, body.group))
      .all()
      .map((r) => r.id);
  } else {
    throw error(400, 'pass ids[] or group');
  }
  const results: Record<string, { ok: boolean; msg?: string }> = {};
  for (const id of ids) {
    try {
      if (body.action === 'start') await startApp(id, locals.user?.login ?? null);
      else await stopApp(id, locals.user?.login ?? null);
      results[id] = { ok: true };
    } catch (e) {
      results[id] = { ok: false, msg: e instanceof Error ? e.message : String(e) };
    }
  }
  return json({ count: ids.length, results });
};
