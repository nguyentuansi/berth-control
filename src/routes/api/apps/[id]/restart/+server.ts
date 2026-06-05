import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { restartApp } from '$lib/server/supervisor.js';
import { isDemoMode } from '$lib/server/demo.js';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (isDemoMode()) return json({ demo: true, restarted: true });
  try {
    const r = await restartApp(params.id, locals.user?.login ?? null);
    return json(r);
  } catch (e) {
    throw error(400, e instanceof Error ? e.message : String(e));
  }
};
