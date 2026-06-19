import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from './db/index.js';
import { apps, runs, events, log_chunks, type App, type Run } from './db/schema.js';
import { pidAlive, pidInfo, listListeners, isLocalBind } from './prober.js';

const LOG_ROOT = resolve(homedir(), '.harborctl/logs');

interface LiveProc {
  app_id: string;
  run_id: number;
  pid: number;
  pgid: number | null;
  child?: ChildProcess;        // present when we own the spawn (not just re-attached)
  logStream?: WriteStream;
  ringStdout: string[];
  ringStderr: string[];
  startedAt: number;
}

const live = new Map<string, LiveProc>(); // by app_id

const RING_CAP = 1000;
function pushRing(buf: string[], s: string) {
  buf.push(s);
  if (buf.length > RING_CAP) buf.splice(0, buf.length - RING_CAP);
}

function appLogPath(appId: string, runId: number) {
  const dir = resolve(LOG_ROOT, appId);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${runId}.log`);
}

function getApp(id: string): App | undefined {
  const row = db.select().from(apps).where(eq(apps.id, id)).get();
  return row;
}

/** Start an app. Returns the new run row. Idempotent: if already live, returns the existing run. */
export async function startApp(
  appId: string,
  userLogin?: string | null
): Promise<{ run: Run; alreadyRunning: boolean }> {
  const app = getApp(appId);
  if (!app) throw new Error(`Unknown app: ${appId}`);
  const existing = live.get(appId);
  if (existing && pidAlive(existing.pid)) {
    const r = db.select().from(runs).where(eq(runs.id, existing.run_id)).get();
    if (r) return { run: r, alreadyRunning: true };
  }
  if (!app.start_cmd) throw new Error(`No start_cmd configured for ${appId}`);
  if (!existsSync(app.project_path)) {
    throw new Error(`project_path missing: ${app.project_path}`);
  }

  const runRow = db
    .insert(runs)
    .values({
      app_id: appId,
      pid: -1, // placeholder; filled in after spawn
      started_at: new Date()
    })
    .returning()
    .get();

  const logPath = appLogPath(appId, runRow.id);

  const child = spawn(app.start_cmd, {
    cwd: app.project_path,
    shell: '/bin/bash',
    env: { ...process.env, PATH: process.env.PATH, FORCE_COLOR: '0', CI: '' },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (!child.pid) {
    db.update(runs)
      .set({ stopped_at: new Date(), exit_code: -1 })
      .where(eq(runs.id, runRow.id))
      .run();
    throw new Error(`spawn failed for ${appId}`);
  }
  // Make the child its own process-group leader so SIGTERM hits children too.
  try {
    process.kill(-child.pid, 0); // probe: throws if already gone
  } catch {
    /* fine, group exists */
  }
  const pgid = child.pid; // detached → pid is pgid

  const logStream = createWriteStream(logPath, { flags: 'a' });
  const proc: LiveProc = {
    app_id: appId,
    run_id: runRow.id,
    pid: child.pid,
    pgid,
    child,
    logStream,
    ringStdout: [],
    ringStderr: [],
    startedAt: Date.now()
  };
  live.set(appId, proc);

  const onLine = (stream: 'stdout' | 'stderr', line: string) => {
    const trimmed = line.replace(/\r?\n$/, '');
    if (!trimmed) return;
    const buf = stream === 'stdout' ? proc.ringStdout : proc.ringStderr;
    pushRing(buf, trimmed);
    try {
      db.insert(log_chunks)
        .values({ run_id: proc.run_id, ts: new Date(), stream, line: trimmed })
        .run();
    } catch {
      /* swallow — DB might be locked during dev reload */
    }
    logStream.write(line);
  };
  const bind = (stream: 'stdout' | 'stderr', src: NodeJS.ReadableStream | null) => {
    if (!src) return;
    let buffer = '';
    src.setEncoding('utf8');
    src.on('data', (chunk: string) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        onLine(stream, buffer.slice(0, nl + 1));
        buffer = buffer.slice(nl + 1);
      }
    });
    src.on('end', () => {
      if (buffer) onLine(stream, buffer + '\n');
    });
  };
  bind('stdout', child.stdout);
  bind('stderr', child.stderr);

  child.on('exit', (code, signal) => {
    db.update(runs)
      .set({ stopped_at: new Date(), exit_code: code ?? (signal ? -1 : null) })
      .where(eq(runs.id, proc.run_id))
      .run();
    db.insert(events)
      .values({
        app_id: appId,
        level: code === 0 || code == null ? 'info' : 'warn',
        msg: `exit ${code ?? signal ?? '?'}`
      })
      .run();
    logStream?.end();
    if (live.get(appId)?.run_id === proc.run_id) live.delete(appId);
  });
  // Detach the child from our event loop so Berth itself can shut down without orphaning it.
  child.unref();

  db.update(runs)
    .set({ pid: child.pid, pgid, log_path: logPath })
    .where(eq(runs.id, runRow.id))
    .run();
  db.insert(events)
    .values({ app_id: appId, user_login: userLogin ?? null, level: 'info', msg: `start (pid ${child.pid})` })
    .run();

  const fresh = db.select().from(runs).where(eq(runs.id, runRow.id)).get();
  return { run: fresh!, alreadyRunning: false };
}

/** Stop an app — SIGTERM the process group, escalate to SIGKILL after 5s. */
export async function stopApp(
  appId: string,
  userLogin?: string | null
): Promise<{ stopped: boolean }> {
  const proc = live.get(appId);
  if (!proc) {
    // Maybe re-attached from a prior boot? Look up an open run.
    const open = db
      .select()
      .from(runs)
      .where(and(eq(runs.app_id, appId), isNull(runs.stopped_at)))
      .get();
    if (!open) return { stopped: false };
    return killByPid(appId, open.pid, open.pgid ?? open.pid, open.id, userLogin);
  }
  return killByPid(appId, proc.pid, proc.pgid ?? proc.pid, proc.run_id, userLogin);
}

/** Walk /proc once, build a ppid → children index, BFS down from `rootPid`.
 *  Returns every PID in the tree including `rootPid` itself. We snapshot the
 *  tree *before* signalling because once a middle-tier parent dies, its
 *  surviving children get reparented to PID 1 — at that point they no longer
 *  look like our descendants and the next walk would miss them. Tracking by
 *  PID still works because PIDs are stable until the process exits. */
function collectDescendants(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  try {
    for (const d of readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      const info = pidInfo(pid);
      if (!info) continue;
      const sibs = children.get(info.ppid);
      if (sibs) sibs.push(pid);
      else children.set(info.ppid, [pid]);
    }
  } catch {
    return [rootPid];
  }
  const out: number[] = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop()!;
    out.push(p);
    const cs = children.get(p);
    if (cs) for (const c of cs) stack.push(c);
  }
  return out;
}

async function killByPid(
  appId: string,
  pid: number,
  pgid: number,
  runId: number,
  userLogin?: string | null
): Promise<{ stopped: boolean }> {
  // Capture the whole descendant tree NOW. Process-group kill alone (-pgid)
  // doesn't reach monorepo workers — Bun, Node, and others reset their pgid
  // for child tasks (turbo's per-app `bun run dev` workers are the canonical
  // case), so the actual port-bound vite ends up in a sibling pgid and never
  // gets the signal. Signalling each PID directly handles that.
  const tree = collectDescendants(pid);

  const signalAll = (sig: NodeJS.Signals) => {
    for (const p of tree) {
      try {
        process.kill(p, sig);
      } catch {
        /* already gone */
      }
    }
    // Belt-and-braces: also pgid-kill in case the tree raced with a new spawn.
    try {
      process.kill(-pgid, sig);
    } catch {
      /* */
    }
  };

  db.insert(events)
    .values({
      app_id: appId,
      user_login: userLogin ?? null,
      level: 'info',
      msg: `stop request (root pid ${pid}, tree size ${tree.length})`
    })
    .run();
  signalAll('SIGTERM');

  // Wait up to 5s for the whole tree to die — not just the root. A web server
  // that handles SIGTERM gracefully takes a beat; turbo workers usually go
  // immediately.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (!tree.some((p) => pidAlive(p))) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const survivors = tree.filter((p) => pidAlive(p));
  if (survivors.length > 0) {
    for (const p of survivors) {
      try {
        process.kill(p, 'SIGKILL');
      } catch {
        /* */
      }
    }
    db.insert(events)
      .values({
        app_id: appId,
        level: 'warn',
        msg: `SIGKILL after 5s: ${survivors.length} survivor(s) [${survivors.slice(0, 8).join(',')}${survivors.length > 8 ? '…' : ''}]`
      })
      .run();
    await new Promise((r) => setTimeout(r, 250));
  }
  // Mark stopped if still open.
  const open = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (open && !open.stopped_at) {
    db.update(runs)
      .set({ stopped_at: new Date(), exit_code: open.exit_code ?? -1 })
      .where(eq(runs.id, runId))
      .run();
  }
  live.delete(appId);
  return { stopped: true };
}

/**
 * Kill whatever process is currently listening on `port` (loopback / wildcard
 * binds only — never the tailscaled per-tailnet-IP proxy listener). Used as
 * the fallback when the user clicks Stop on an app that wasn't started by
 * Berth, so we have no managed run to terminate.
 */
export async function stopExternalOnPort(
  port: number,
  appId: string,
  userLogin?: string | null
): Promise<{ stopped: boolean; reason?: string }> {
  const listeners = await listListeners();
  const local = listeners.find((l) => l.port === port && l.isLocal && isLocalBind(l.host));
  if (!local?.pid) return { stopped: false, reason: `No local listener on :${port}` };
  const info = pidInfo(local.pid);
  // Critical: DO NOT use negative pgid here. For Berth-supervised apps the
  // pgid kill is fine because each managed run is its own pgid leader. But
  // an *external* listener may be a child under a monorepo runner (think
  // `turbo run dev --filter=<app>` started from a single systemd unit) —
  // all of that fleet's per-app dev servers share the script's pgid. Killing
  // -pgid would take down every sibling, then `Restart=always` on the unit
  // would bring them all back. Targeting the listener PID directly stops
  // just this one app; the parent runner decides what to do, which is the
  // per-app control the user wants.
  db.insert(events)
    .values({
      app_id: appId,
      user_login: userLogin ?? null,
      level: 'info',
      msg: `stop external (pid ${local.pid}, pgid ${info?.pgid ?? '?'}, cmd ${local.cmd ?? '?'})`
    })
    .run();
  const tryKill = (sig: NodeJS.Signals) => {
    try {
      process.kill(local.pid!, sig);
    } catch {
      /* gone */
    }
  };
  tryKill('SIGTERM');
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (!pidAlive(local.pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (pidAlive(local.pid)) {
    tryKill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
  }
  if (pidAlive(local.pid)) {
    return { stopped: false, reason: `pid ${local.pid} survived SIGKILL (likely owned by another user)` };
  }
  return { stopped: true };
}

export async function restartApp(appId: string, userLogin?: string | null) {
  await stopApp(appId, userLogin);
  // Give the port a beat to free.
  await new Promise((r) => setTimeout(r, 400));
  return startApp(appId, userLogin);
}

/** Re-attach to processes that survived a Berth restart. */
export function reattachOnBoot() {
  const open = db.select().from(runs).where(isNull(runs.stopped_at)).all();
  for (const r of open) {
    if (pidAlive(r.pid)) {
      live.set(r.app_id, {
        app_id: r.app_id,
        run_id: r.id,
        pid: r.pid,
        pgid: r.pgid ?? r.pid,
        ringStdout: [],
        ringStderr: [],
        startedAt: r.started_at.getTime()
      });
      db.insert(events)
        .values({ app_id: r.app_id, level: 'info', msg: `reattached on boot (pid ${r.pid})` })
        .run();
    } else {
      db.update(runs)
        .set({ stopped_at: new Date(), exit_code: -1 })
        .where(eq(runs.id, r.id))
        .run();
      db.insert(events).values({ app_id: r.app_id, level: 'warn', msg: 'died while berth was down' }).run();
    }
  }
}

export function liveSnapshot(): Record<string, { pid: number; run_id: number; startedAt: number }> {
  const out: Record<string, { pid: number; run_id: number; startedAt: number }> = {};
  for (const [k, v] of live) {
    if (pidAlive(v.pid)) out[k] = { pid: v.pid, run_id: v.run_id, startedAt: v.startedAt };
  }
  return out;
}

export function ringFor(appId: string): { stdout: string[]; stderr: string[] } | null {
  const p = live.get(appId);
  if (!p) return null;
  return { stdout: [...p.ringStdout], stderr: [...p.ringStderr] };
}

/** Quick sanity helper for the UI. */
export function reapDead() {
  for (const [k, v] of live) {
    if (!pidAlive(v.pid)) {
      live.delete(k);
      const open = db
        .select()
        .from(runs)
        .where(and(eq(runs.app_id, k), isNull(runs.stopped_at)))
        .get();
      if (open) {
        db.update(runs).set({ stopped_at: new Date(), exit_code: -1 }).where(eq(runs.id, open.id)).run();
      }
    }
  }
}

export { pidInfo };
