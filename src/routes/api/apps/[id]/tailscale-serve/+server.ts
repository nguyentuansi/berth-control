import { json, error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { addServeMapping, removeServeMapping } from '$lib/server/tailscale-serve.js';
import { listListeners, isLocalBind, pidInfo } from '$lib/server/prober.js';
import { liveSnapshot, ringFor } from '$lib/server/supervisor.js';
import { isDemoMode } from '$lib/server/demo.js';

/**
 * Find a local listening port belonging to the managed PID *or any of its
 * descendants*. Matters for monorepo runners — e.g. `bun run dev` → `turbo
 * run dev` → per-app `bun` workers → `vite`. Each `bun run dev` task turbo
 * launches gets its own process group (Bun calls setpgid for child tasks),
 * so a pgid check misses them. Walking the parent chain via /proc/<pid>/stat
 * back to the managed PID does work. Polls because cold-start with codegen
 * can take 5–15 s.
 */
async function awaitPortForPid(pid: number, attempts = 30, intervalMs = 500): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const listeners = await listListeners();
    const ancestorCache = new Map<number, boolean>();
    for (const l of listeners) {
      if (!l.isLocal || !isLocalBind(l.host) || !l.pid) continue;
      if (isAncestor(l.pid, pid, ancestorCache)) return l.port;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/** Is `target` somewhere in the parent chain of `pid` (or equal to it)?
 *  Memoised per-call so a forest of children with the same ancestor only
 *  costs one /proc read each. Capped at 12 hops for runaway safety. */
function isAncestor(pid: number, target: number, cache: Map<number, boolean>): boolean {
  let cur = pid;
  const visited: number[] = [];
  for (let hop = 0; hop < 12; hop++) {
    if (cur === target) {
      for (const v of visited) cache.set(v, true);
      return true;
    }
    if (cur <= 1) break;
    const memo = cache.get(cur);
    if (memo !== undefined) {
      for (const v of visited) cache.set(v, memo);
      return memo;
    }
    visited.push(cur);
    const info = pidInfo(cur);
    if (!info) break;
    cur = info.ppid;
  }
  for (const v of visited) cache.set(v, false);
  return false;
}

/** Last few non-empty lines from the managed run's log rings, joined for
 *  inclusion in an error message. Prefers stderr (where build errors live). */
function tailLogs(appId: string, n = 6): string {
  const ring = ringFor(appId);
  if (!ring) return '';
  const pick = (lines: string[]) =>
    lines
      .map((l) => l.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim())
      .filter(Boolean)
      .slice(-n);
  const errs = pick(ring.stderr);
  const outs = pick(ring.stdout);
  const out = [...errs, ...outs].slice(-n);
  return out.join('\n');
}

export const POST: RequestHandler = async ({ params }) => {
  if (isDemoMode()) return json({ demo: true });
  const app = db.select().from(schema.apps).where(eq(schema.apps.id, params.id)).get();
  if (!app) throw error(404, 'Unknown app');

  let port = app.port;
  // Apps registered without a port still need one to be tailscale-served. If
  // Berth is currently supervising a run for this app, watch for its listener
  // to come up, then persist the detected port back to the row so future
  // tailnet ops (and the dashboard) all see the right number.
  if (!port) {
    const managed = liveSnapshot()[app.id];
    if (!managed) {
      throw error(
        400,
        'App has no port configured and no managed run to detect one from. Set a port in the app config, or start the app via Berth first.'
      );
    }
    const detected = await awaitPortForPid(managed.pid);
    if (!detected) {
      const tail = tailLogs(app.id);
      throw error(
        400,
        `Process is running (pid ${managed.pid}) but didn't bind a TCP port within 15s. Check the start command and project setup.` +
          (tail ? `\n\nRecent log output:\n${tail}` : '')
      );
    }
    db.update(schema.apps)
      .set({ port: detected, updated_at: new Date() })
      .where(eq(schema.apps.id, app.id))
      .run();
    port = detected;
  }

  try {
    await addServeMapping(port);
    return json({ ok: true, port, autoDetected: app.port == null });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw error(500, `tailscale serve failed: ${msg}`);
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  if (isDemoMode()) return json({ demo: true });
  const app = db.select().from(schema.apps).where(eq(schema.apps.id, params.id)).get();
  if (!app) throw error(404, 'Unknown app');
  if (!app.port) throw error(400, 'App has no port — nothing to remove');
  try {
    await removeServeMapping(app.port);
    return json({ ok: true, port: app.port });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw error(500, `tailscale serve off failed: ${msg}`);
  }
};
