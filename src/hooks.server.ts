import type { Handle } from '@sveltejs/kit';
import { ensureSchema } from '$lib/server/db/migrate.js';
import { reattachOnBoot } from '$lib/server/supervisor.js';
import { importPortsMd } from '$lib/server/ports-md.js';
import { identify } from '$lib/server/tailscale.js';
import { isDemoMode } from '$lib/server/demo.js';
import { startUptimeHeartbeat } from '$lib/server/uptime.js';
import { pruneExpired } from '$lib/server/auth.js';
import { startBackgroundSweep } from '$lib/server/repo-fetcher.js';
import { startHostMonitor } from '$lib/server/monitor/collector.js';

// Adapter-node's static-file handler streams files off disk with a Node
// ReadStream; when a browser asks for an asset that no longer exists (a
// stale chunk hash after a redeploy), the stream emits an unhandled 'error'
// event which crashes the process. The crash wipes the in-memory supervisor
// state, so every redeploy + stale-tab combo took berth offline. Catch
// ENOENT at the process level and ignore — those errors are equivalent to a
// 404 we never got to write. Other unhandled errors still propagate.
process.on('uncaughtException', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'ENOENT' && typeof e.path === 'string' && e.path.includes('/_app/')) {
    console.warn('[berth] swallowed stale-asset ENOENT:', e.path);
    return;
  }
  // Re-throw on the next tick so we don't loop, and so node's default
  // handler (and any other listeners) still get to see it.
  setImmediate(() => { throw e; });
});

let bootDone = false;
function bootOnce() {
  if (bootDone) return;
  bootDone = true;
  ensureSchema();
  pruneExpired();
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
  startUptimeHeartbeat();
  startBackgroundSweep();
  // Host monitoring — single in-process collector. Internally idempotent, so
  // a re-call after a hot-reload is safe. Failures inside startup don't
  // propagate; they're logged and the rest of berth boots normally.
  void startHostMonitor();
  console.log(`[berth] ready on http://127.0.0.1:5202`);
}

/** Paths reachable while signed out (the login UI itself, the phone-side QR
 *  claim, and the endpoints those pages call). Everything else redirects to
 *  /login when there's no resolved user. Static assets and SvelteKit's
 *  internal endpoints (/_app/*) are also let through. */
function isPublic(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname === '/setup') return true;
  if (pathname.startsWith('/auth/qr/')) return true;
  if (pathname === '/api/auth/password-login') return true;
  if (pathname === '/api/auth/logout') return true;
  if (pathname.startsWith('/api/auth/qr/')) return true;
  if (pathname === '/api/setup') return true;
  if (pathname.startsWith('/_app/')) return true;
  if (pathname === '/favicon.ico' || pathname === '/logo.png') return true;
  return false;
}

export const handle: Handle = async ({ event, resolve }) => {
  bootOnce();
  event.locals.user = identify(event);
  if (!event.locals.user && !isPublic(event.url.pathname)) {
    return new Response(null, {
      status: 303,
      headers: { location: `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}` }
    });
  }
  return resolve(event);
};
