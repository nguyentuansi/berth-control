import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { readSystemInfo } from '$lib/server/monitor/sysinfo.js';

// Static-ish system info for the dashboard's "System" card.
// Re-reads every call (cheap — node:os calls are nanoseconds; OS pretty-name
// uses a per-process cache so the macOS sw_vers spawn only fires once).

export const GET: RequestHandler = async ({ locals }) => {
  requireUser(locals);
  return json(readSystemInfo());
};
