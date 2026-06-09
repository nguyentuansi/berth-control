import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { stopApp, stopExternalOnPort } from '$lib/server/supervisor.js';
import { db, schema } from '$lib/server/db/index.js';
import { isDemoMode } from '$lib/server/demo.js';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (isDemoMode()) return json({ demo: true, stopped: true });
  try {
    // First try to stop a managed run (process Berth started or re-attached).
    const r = await stopApp(params.id, locals.user?.login ?? null);
    if (r.stopped) return json({ ...r, external: false });
    // Fallback: kill whoever is listening on this app's port. Covers
    // externally-started servers (other systemd units, ad-hoc `bun run dev`,
    // etc.) so the Stop button works for them too.
    const app = db
      .select()
      .from(schema.apps)
      .where(eq(schema.apps.id, params.id))
      .get();
    if (!app?.port) {
      throw error(400, 'No managed run and no port to probe an external listener');
    }
    const k = await stopExternalOnPort(app.port, params.id, locals.user?.login ?? null);
    if (!k.stopped) throw error(400, k.reason ?? 'Could not stop external listener');
    return json({ stopped: true, external: true });
  } catch (e) {
    if (e instanceof Error && 'status' in e) throw e; // re-throw SvelteKit errors
    throw error(400, e instanceof Error ? e.message : String(e));
  }
};
