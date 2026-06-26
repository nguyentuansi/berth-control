import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { broadcastNotification } from '$lib/server/monitor/web-push.js';

// Fire a one-off "this is a test" notification to every saved subscription.
// Use case: confirming that VAPID + subscribe + service worker all line up
// without waiting for a real threshold to trip.

export const POST: RequestHandler = async ({ locals }) => {
  requireUser(locals);
  const result = await broadcastNotification({
    title: 'berth-control monitor',
    body: 'Test notification — your subscription works.',
    tag: 'monitor-test'
  });
  return json({ ok: true, ...result });
};
