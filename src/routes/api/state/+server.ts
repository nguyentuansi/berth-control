import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { eq } from 'drizzle-orm';
import { listListeners, probeHealth, procOrigin, pidInfo } from '$lib/server/prober.js';
import { liveSnapshot, reapDead } from '$lib/server/supervisor.js';
import { getServeStatus, mappingsByLocalPort } from '$lib/server/tailscale-serve.js';
import { snapshotProcStats } from '$lib/server/proc-stats.js';
import { isDemoMode, DEMO_STATE, DEMO_TAILSCALE_HOST } from '$lib/server/demo.js';
import { readAllRepoStates } from '$lib/server/repo-fetcher.js';

interface LiveStatus {
  up: boolean;
  /** True iff a TCP listener is bound on the app's configured port. Set
   *  independently of `listenerPid` because the OS sometimes won't reveal
   *  the owning PID — happens whenever the listener is owned by a different
   *  user (root services, ollama, postgres, system-scope systemd units).
   *  The dashboard keys the green/amber/red dot on this, not on the PID. */
  serving: boolean;
  listenerPid: number | null;
  listenerCmd: string | null;
  managedPid: number | null;
  managedSince: number | null;
  healthOk: boolean | null;
  latencyMs: number | null;
  /** Tailscale serve mapping for this app's local port, if any. */
  tailscale: { port: number; funnel: boolean } | null;
  /** Whole-pgid CPU % over the last 2s. null = not measurable yet. */
  cpuPct: number | null;
  /** Whole-pgid resident memory in MB. */
  ramMB: number | null;
  /** Whole-pgid GPU memory in MB (nvidia-smi), null if not on GPU. */
  gpuMB: number | null;
  /** Where this row's listener PID lives. 'managed' = Berth spawned it
   *  directly via the supervisor; 'systemd' = a systemd unit owns it
   *  (`unit` carries the name without the `.service` suffix); 'scope' =
   *  transient cgroup (terminal, browser app); null = not currently up.
   *
   *  Berth's *own* dashboard row falls into 'systemd' because it runs under
   *  `berth.service`; the 'managed' label is reserved for non-Berth apps the
   *  control panel happens to be running, so the column doesn't read "berth"
   *  for things unrelated to the Berth project. */
  origin: {
    kind: 'managed' | 'systemd' | 'scope' | 'unknown';
    unit: string | null;
    scope: 'user' | 'system' | null;
  } | null;
}

interface Snapshot {
  ts: number;
  byApp: Record<string, LiveStatus>;
  /** The tailnet hostname (for building click-through URLs on the client). */
  tailscaleHost: string | null;
  /** Whether the tailscale daemon is reachable + we can read serve status. */
  tailscaleAvailable: boolean;
  /** Per-app cached git sync state — updated by the background sweep + the
   *  manual fetch endpoint. Cards render the `↑N` badge + Pull button from
   *  this; nothing in the SSE tick path triggers any git work. */
  repos: Record<
    string,
    {
      default_branch: string | null;
      commits_behind: number;
      commits_ahead: number;
      fetch_status: string;
      fetch_error: string | null;
      last_fetched_at: number | null;
      local_sha: string | null;
      remote_sha: string | null;
    }
  >;
}

/** Walk ppid up from `pid`, returning true if `target` is somewhere in the
 *  chain. Memoised across hops so a forest of children with the same root
 *  costs only one /proc read per intermediate PID. Capped at 12 hops. */
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

// `_`-prefixed so SvelteKit allows the export from a +server.ts file
// (only HTTP method names + underscore-prefixed helpers are permitted).
// Exported so `+page.server.ts` can hydrate the dashboard's `livestate`
// on the initial server render — without this, every app shows a "Start"
// button for the first 100-300ms while the client waits for the first SSE
// frame, even if the app is actually running.
export async function _snapshot(): Promise<Snapshot> {
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
  // Build the (app → root PID) map up-front so proc-stats can do one /proc
  // walk for the whole snapshot. The root is whatever process represents the
  // app's tree — Berth's managed PID if we own it, else the external listener.
  const pidByApp = new Map<string, number>();
  for (const a of apps) {
    const listener = a.port ? byPort.get(a.port) ?? null : null;
    const m = managed[a.id] ?? null;
    // `up` reflects the user-facing question "is the app actually serving
    // right now?". Counting a managed PID-without-listener as "up" was the
    // source of the inverse-bug: a `bun run dev` shell that's alive but
    // whose vite child died showed as up=true with green dot + Stop button
    // for hours, while logs clearly said the dev server exited. Listener
    // presence is the only honest signal. The "managed but not serving"
    // case is still reachable for the UI via `managedPid + !serving` —
    // the dashboard uses that combo to show an amber warn dot and route
    // the action button to Stop (so a stuck managed process can be torn
    // down without needing a new Start that the supervisor would refuse).
    const up = !!listener;
    const tsMap = a.port ? tsByLocal.get(a.port) : undefined;
    const st: LiveStatus = {
      up,
      serving: !!listener,
      listenerPid: listener?.pid ?? null,
      listenerCmd: listener?.cmd ?? null,
      managedPid: m?.pid ?? null,
      managedSince: m?.startedAt ?? null,
      healthOk: null,
      latencyMs: null,
      tailscale: tsMap ? { port: tsMap.tailscalePort, funnel: tsMap.funnel } : null,
      cpuPct: null,
      ramMB: null,
      gpuMB: null,
      origin: null
    };
    byApp[a.id] = st;
    if (up) {
      const pid = m?.pid ?? listener?.pid ?? null;
      if (pid) pidByApp.set(a.id, pid);
      // Berth-managed wins over cgroup inspection — managed processes inherit
      // berth.service's cgroup, so cgroup alone would mis-label them.
      if (m) {
        st.origin = { kind: 'managed', unit: null, scope: null };
      } else if (pid) {
        st.origin = procOrigin(pid);
      }
    }
    if (up && a.healthcheck_url) {
      healthJobs.push(
        probeHealth(a.healthcheck_url).then((h) => {
          st.healthOk = h.ok;
          st.latencyMs = h.latencyMs ?? null;
        })
      );
    }
  }
  // Auto-correct: if Berth managed something but the configured port has no
  // listener, scan the listener list for any TCP socket owned by a
  // descendant of the managed root (think `bun run dev` → vite picking 5173
  // when we allocated 5172). Persist the real port back to `apps.port` so
  // the dashboard, the prober, and any later tailnet ops all line up.
  const corrections: { id: string; port: number }[] = [];
  const ancestorCache = new Map<number, Map<number, boolean>>();
  for (const a of apps) {
    const st = byApp[a.id];
    if (st.serving) continue;
    if (st.managedPid == null) continue;
    let myCache = ancestorCache.get(st.managedPid);
    if (!myCache) {
      myCache = new Map();
      ancestorCache.set(st.managedPid, myCache);
    }
    let chosen: { port: number; pid: number; cmd: string | null } | null = null;
    for (const l of listeners) {
      if (!l.isLocal || !l.pid) continue;
      if (isAncestor(l.pid, st.managedPid, myCache)) {
        chosen = { port: l.port, pid: l.pid, cmd: l.cmd };
        break;
      }
    }
    if (chosen && chosen.port !== a.port) {
      corrections.push({ id: a.id, port: chosen.port });
      st.serving = true;
      st.listenerPid = chosen.pid;
      st.listenerCmd = chosen.cmd;
      const tsMap = tsByLocal.get(chosen.port);
      if (tsMap) st.tailscale = { port: tsMap.tailscalePort, funnel: tsMap.funnel };
    }
  }
  if (corrections.length > 0) {
    for (const c of corrections) {
      db.update(schema.apps)
        .set({ port: c.port, updated_at: new Date() })
        .where(eq(schema.apps.id, c.id))
        .run();
    }
  }
  // Stats walk and healthchecks both go to the OS in parallel.
  const statsJob = snapshotProcStats(pidByApp);
  await Promise.allSettled(healthJobs);
  const stats = await statsJob;
  for (const [appId, s] of stats) {
    const live = byApp[appId];
    if (!live) continue;
    live.cpuPct = s.cpuPct;
    live.ramMB = s.ramMB;
    live.gpuMB = s.gpuMB;
  }
  return {
    ts: Date.now(),
    byApp,
    tailscaleHost: ts.host,
    tailscaleAvailable: ts.available,
    repos: readAllRepoStates()
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
        serving: false,
        listenerPid: null,
        listenerCmd: null,
        managedPid: null,
        managedSince: null,
        healthOk: null,
        latencyMs: null,
        tailscale: null,
        cpuPct: null,
        ramMB: null,
        gpuMB: null,
        origin: null
      };
      continue;
    }
    byApp[a.id] = {
      up: d.up,
      serving: d.up && d.listenerPid != null,
      listenerPid: d.listenerPid,
      listenerCmd: d.listenerCmd,
      managedPid: d.managedPid,
      managedSince:
        d.managedSinceAgoSec != null ? Date.now() - d.managedSinceAgoSec * 1000 : null,
      healthOk: d.healthOk,
      latencyMs: d.latencyMs,
      tailscale: d.tailscale,
      cpuPct: null,
      ramMB: null,
      gpuMB: null,
      origin: null
    };
  }
  return {
    ts: Date.now(),
    byApp,
    tailscaleHost: DEMO_TAILSCALE_HOST,
    tailscaleAvailable: true,
    repos: {}
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
          const s = await _snapshot();
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
