import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { stopApp } from '$lib/server/supervisor.js';
import { isDemoMode } from '$lib/server/demo.js';

export const POST: RequestHandler = async ({ params, locals }) => {
  if (isDemoMode()) return json({ demo: true, stopped: true });
  try {
    const r = await stopApp(params.id, locals.user?.login ?? null);
    return json(r);
  } catch (e) {
    throw error(400, e instanceof Error ? e.message : String(e));
  }
};
