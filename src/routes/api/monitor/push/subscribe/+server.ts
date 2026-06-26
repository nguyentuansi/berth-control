import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { recordSubscription } from '$lib/server/monitor/web-push.js';

// Persist a browser push subscription. Body shape mirrors the JSON the
// browser's PushSubscription.toJSON() emits, so the client can forward it
// verbatim:
//   { endpoint: '...', keys: { p256dh: '...', auth: '...' } }
//
// The endpoint is the push provider's URL — it's a credential. Logged only
// as its short id (sub_<base36>), never in full.

export const POST: RequestHandler = async ({ request, locals }) => {
  requireUser(locals);

  const body = (await request.json().catch(() => null)) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  } | null;
  if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    throw error(400, 'endpoint, keys.p256dh, keys.auth required');
  }

  const ua = request.headers.get('user-agent');
  const result = recordSubscription({
    endpoint: body.endpoint,
    p256dh: body.keys.p256dh,
    auth: body.keys.auth,
    userAgent: ua
  });

  return json({ ok: true, id: result.id });
};
