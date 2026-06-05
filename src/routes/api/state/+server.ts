import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { eq } from 'drizzle-orm';
import { listListeners, probeHealth } from '$lib/server/prober.js';
import { liveSnapshot, reapDead } from '$lib/server/supervisor.js';
import { getServeStatus, mappingsByLocalPort } from '$lib/server/tailscale-serve.js';
import { isDemoMode, DEMO_STATE, DEMO_TAILSCALE_HOST } from '$lib/server/demo.js';

interface LiveStatus {
  up: boolean;
  listenerPid: number | null;
  listenerCmd: string | null;
  managedPid: number | null;
  managedSince: number | null;
  healthOk: boolean | null;
  latencyMs: number | null;
  /** Tailscale serve mapping for this app's local port, if any. */
  tailscale: { port: number; funnel: boolean } | null;
}

interface Snapshot {
  ts: number;
  byApp: Record<string, LiveStatus>;
  /** The tailnet hostname (for building click-through URLs on the client). */
  tailscaleHost: string | null;
  /** Whether the tailscale daemon is reachable + we can read serve status. */
  tailscaleAvailable: boolean;
}

async function snapshot(): Promise<Snapshot> {
  if (isDemoMode()) return demoSnapshot();
  reapDead();
  const [listeners, ts] = await Promise.all([listListeners(), getServeStatus()]);
  // Only count loopback/wildcard binds as "the app". Tailnet-IP binds are
  // tailscaled's serve proxy listening for the public side — not a sign the
  // backend behind the proxy is alive (see :2300 → HTTP 502 case).
  const byPort = new Map<number, { pid: number | null; cmd: string | null }>();
  for (const l of listeners) {
    if (l.isLocal) byPort.set(l.port, { pid: l.pid, cmd: l.cmd });
  }
  const tsByLocal = mappingsByLocalPort(ts.mappings);
  const apps = db.select().from(schema.apps).where(eq(schema.apps.hidden, false)).all();
  const managed = liveSnapshot();
  const byApp: Record<string, LiveStatus> = {};
  // Healthchecks run in parallel but capped — only for up listeners with a URL.
  const healthJobs: Promise<void>[] = [];
  for (const a of apps) {
    const listener = a.port ? byPort.get(a.port) ?? null : null;
    const m = managed[a.id] ?? null;
    const up = !!listener || !!m;
    const tsMap = a.port ? tsByLocal.get(a.port) : undefined;
    const st: LiveStatus = {
      up,
      listenerPid: listener?.pid ?? null,
      listenerCmd: listener?.cmd ?? null,
      managedPid: m?.pid ?? null,
      managedSince: m?.startedAt ?? null,
      healthOk: null,
      latencyMs: null,
      tailscale: tsMap ? { port: tsMap.tailscalePort, funnel: tsMap.funnel } : null
    };
    byApp[a.id] = st;
    if (up && a.healthcheck_url) {
      healthJobs.push(
        probeHealth(a.healthcheck_url).then((h) => {
          st.healthOk = h.ok;
          st.latencyMs = h.latencyMs ?? null;
        })
      );
    }
  }
  await Promise.allSettled(healthJobs);
  return {
    ts: Date.now(),
    byApp,
    tailscaleHost: ts.host,
    tailscaleAvailable: ts.available
  };
}

/** Demo SSE payload — built from DEMO_STATE in src/lib/server/demo.ts. No
 *  real probing happens; the dashboard renders as if everything were live. */
function demoSnapshot(): Snapshot {
  const apps = db.select().from(schema.apps).where(eq(schema.apps.hidden, false)).all();
  const byApp: Record<string, LiveStatus> = {};
  for (const a of apps) {
    const d = DEMO_STATE[a.id];
    if (!d) {
      byApp[a.id] = {
        up: false,
        listenerPid: null,
        listenerCmd: null,
        managedPid: null,
        managedSince: null,
        healthOk: null,
        latencyMs: null,
        tailscale: null
      };
      continue;
    }
    byApp[a.id] = {
      up: d.up,
      listenerPid: d.listenerPid,
      listenerCmd: d.listenerCmd,
      managedPid: d.managedPid,
      managedSince:
        d.managedSinceAgoSec != null ? Date.now() - d.managedSinceAgoSec * 1000 : null,
      healthOk: d.healthOk,
      latencyMs: d.latencyMs,
      tailscale: d.tailscale
    };
  }
  return {
    ts: Date.now(),
    byApp,
    tailscaleHost: DEMO_TAILSCALE_HOST,
    tailscaleAvailable: true
  };
}

export const GET: RequestHandler = async ({ request }) => {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (obj: unknown) => {
        if (closed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const tick = async () => {
        try {
          const s = await snapshot();
          send(s);
        } catch (e) {
          send({ error: e instanceof Error ? e.message : String(e) });
        }
      };
      await tick();
      const iv = setInterval(tick, 2000);
      const ka = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(`: ka\n\n`));
      }, 15_000);
      request.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(iv);
        clearInterval(ka);
        try {
          controller.close();
        } catch {
          /* */
        }
      });
    }
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
};
