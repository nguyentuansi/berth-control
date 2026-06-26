import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { getVapidPublicKey, pushStatus } from '$lib/server/monitor/web-push.js';

// Hand the public VAPID key to the browser. The page uses it as the
// `applicationServerKey` when calling pushManager.subscribe().
//
// Returns { publicKey: null, reason: '...' } when push isn't configured
// (no BERTH_CONTROL_MONITOR_PUSH_CONTACT in env). The UI hides the enable
// button in that case and shows the reason inline.

export const GET: RequestHandler = async ({ locals }) => {
  requireUser(locals);
  const publicKey = await getVapidPublicKey();
  const status = pushStatus();
  return json({ publicKey, ready: status.ready, reason: status.reason });
};
