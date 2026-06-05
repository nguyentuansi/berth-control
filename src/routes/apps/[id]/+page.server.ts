import { error } from '@sveltejs/kit';
import { db, schema } from '$lib/server/db/index.js';
import { eq, desc, and, isNull } from 'drizzle-orm';
import type { PageServerLoad, Actions } from './$types.js';

export const load: PageServerLoad = async ({ params }) => {
  const app = db.select().from(schema.apps).where(eq(schema.apps.id, params.id)).get();
  if (!app) throw error(404, 'unknown app');
  const recentRuns = db
    .select()
    .from(schema.runs)
    .where(eq(schema.runs.app_id, params.id))
    .orderBy(desc(schema.runs.id))
    .limit(10)
    .all();
  const recentEvents = db
    .select()
    .from(schema.events)
    .where(eq(schema.events.app_id, params.id))
    .orderBy(desc(schema.events.ts))
    .limit(50)
    .all();
  const openRun = db
    .select()
    .from(schema.runs)
    .where(and(eq(schema.runs.app_id, params.id), isNull(schema.runs.stopped_at)))
    .get();
  return { app, recentRuns, recentEvents, openRun };
};

export const actions: Actions = {
  save: async ({ params, request, locals }) => {
    const form = await request.formData();
    const updates = {
      name: String(form.get('name') ?? ''),
      project_path: String(form.get('project_path') ?? ''),
      port: form.get('port') ? Number(form.get('port')) : null,
      kind: String(form.get('kind') ?? 'shell'),
      start_cmd: (form.get('start_cmd') ?? null) as string | null,
      stop_cmd: (form.get('stop_cmd') ?? null) as string | null,
      healthcheck_url: (form.get('healthcheck_url') ?? null) as string | null,
      group_tag: (form.get('group_tag') ?? null) as string | null,
      env_file: (form.get('env_file') ?? null) as string | null,
      notes: (form.get('notes') ?? null) as string | null,
      hidden: form.get('hidden') === 'on',
      updated_at: new Date()
    };
    db.update(schema.apps).set(updates).where(eq(schema.apps.id, params.id)).run();
    db.insert(schema.events)
      .values({
        app_id: params.id,
        user_login: locals.user?.login ?? null,
        level: 'info',
        msg: 'app config saved'
      })
      .run();
    return { ok: true };
  }
};
