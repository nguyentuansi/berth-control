import type { Handle } from '@sveltejs/kit';
import { ensureSchema } from '$lib/server/db/migrate.js';
import { reattachOnBoot } from '$lib/server/supervisor.js';
import { importPortsMd } from '$lib/server/ports-md.js';
import { identify } from '$lib/server/tailscale.js';
import { isDemoMode } from '$lib/server/demo.js';

let bootDone = false;
function bootOnce() {
  if (bootDone) return;
  bootDone = true;
  ensureSchema();
  if (isDemoMode()) {
    console.log('[berth] DEMO MODE — skipping PORTS.md import + supervisor re-attach');
    console.log('[berth] ready on http://127.0.0.1:5202 (demo)');
    return;
  }
  reattachOnBoot();
  try {
    const r = importPortsMd();
    console.log(`[berth] PORTS.md import: +${r.inserted} new, ~${r.updated} updated, ${r.total} rows`);
  } catch (e) {
    console.warn('[berth] PORTS.md import failed:', e);
  }
  console.log(`[berth] ready on http://127.0.0.1:5202`);
}

export const handle: Handle = async ({ event, resolve }) => {
  bootOnce();
  event.locals.user = identify(event);
  return resolve(event);
};
