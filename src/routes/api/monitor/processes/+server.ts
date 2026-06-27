import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { topProcessesByCpu } from '$lib/server/monitor/processes.js';

// Top processes by CPU. Polled by the dashboard on its own cadence —
// intentionally NOT pushed via SSE because the list churns at every tick
// and most of the time the same names show up. Cheap on-demand fetch is
// the right shape.

export const GET: RequestHandler = async ({ url, locals }) => {
  requireUser(locals);
  const limit = Math.min(100, Math.max(5, Number(url.searchParams.get('limit') ?? 25)));
  const procs = topProcessesByCpu(limit);
  return json({ count: procs.length, processes: procs });
};
