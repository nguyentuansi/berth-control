import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { isNull, or, eq } from 'drizzle-orm';
import { suggestStartCmd } from '$lib/server/start-cmd-suggester.js';

/** Walk every app with a null/empty start_cmd, run the suggester against its
 *  project path, persist the result. Returns per-app outcomes for the UI.
 *  Querystring: ?force=1 to also overwrite existing start_cmds. */
export const POST: RequestHandler = async ({ url, locals }) => {
  const force = url.searchParams.get('force') === '1';
  const rows = force
    ? db.select().from(schema.apps).all()
    : db
        .select()
        .from(schema.apps)
        .where(or(isNull(schema.apps.start_cmd), eq(schema.apps.start_cmd, '')))
        .all();
  const results: Array<{ id: string; cmd: string | null; reason: string }> = [];
  let filled = 0;
  for (const a of rows) {
    const suggestion = suggestStartCmd(a.project_path, a.port, a.kind);
    if (suggestion) {
      db.update(schema.apps)
        .set({ start_cmd: suggestion.cmd, updated_at: new Date() })
        .where(eq(schema.apps.id, a.id))
        .run();
      filled++;
      results.push({ id: a.id, cmd: suggestion.cmd, reason: suggestion.reason });
    } else {
      results.push({ id: a.id, cmd: null, reason: 'no confident guess' });
    }
  }
  db.insert(schema.events)
    .values({
      app_id: null,
      user_login: locals.user?.login ?? null,
      level: 'info',
      msg: `backfill-start-cmds: ${filled}/${rows.length} filled${force ? ' (forced)' : ''}`
    })
    .run();
  return json({ scanned: rows.length, filled, results });
};
