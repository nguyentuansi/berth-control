import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { listServices } from '$lib/server/monitor/services.js';

// Service inventory for the Services tab. Polled by the dashboard on a
// slow cadence (every 30s) — shelling out to systemctl/launchctl on every
// SSE tick would be wasteful since service state changes are rare.

export const GET: RequestHandler = async ({ locals }) => {
  requireUser(locals);
  const services = listServices();
  return json({ count: services.length, services });
};
