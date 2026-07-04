import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { enqueueFetch } from '$lib/server/repo-fetcher.js';
import { isDemoMode } from '$lib/server/demo.js';

// POST /api/apps/:id/repo/fetch
//
// Enqueue a `git fetch --prune` for this app. Returns immediately —
// the actual fetch runs in the background worker (single-worker FIFO
// queue in repo-fetcher.ts). SSE state pushes fetch_status = 'queued'
// → 'fetching' → 'idle' | 'error' as the worker progresses.
//
// Manual requests are debounced against very recent fetches; if a
// fetch just ran, we return `{ queued: false, reason }` so the UI can
// show "already fresh" instead of misleading "queued".

export const POST: RequestHandler = async ({ params, locals }) => {
  if (isDemoMode()) return json({ queued: false, reason: 'demo mode' });
  if (!locals.user) throw error(401, 'auth required');
  try {
    const r = enqueueFetch(params.id, 'manual');
    return json(r);
  } catch (e) {
    throw error(400, e instanceof Error ? e.message : String(e));
  }
};
