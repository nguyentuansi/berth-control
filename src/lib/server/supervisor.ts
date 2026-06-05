import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from './db/index.js';
import { apps, runs, events, log_chunks, type App, type Run } from './db/schema.js';
import { pidAlive, pidInfo } from './prober.js';

const LOG_ROOT = resolve(homedir(), '.berth/logs');

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

async function killByPid(
  appId: string,
  pid: number,
  pgid: number,
  runId: number,
  userLogin?: string | null
): Promise<{ stopped: boolean }> {
  const tryKill = (sig: NodeJS.Signals) => {
    try {
      // Negative pid → process group.
      process.kill(-pgid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    }
  };

  db.insert(events)
    .values({ app_id: appId, user_login: userLogin ?? null, level: 'info', msg: `stop request (pid ${pid})` })
    .run();
  tryKill('SIGTERM');

  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (!pidAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (pidAlive(pid)) {
    tryKill('SIGKILL');
    db.insert(events).values({ app_id: appId, level: 'warn', msg: 'SIGKILL after 5s timeout' }).run();
    await new Promise((r) => setTimeout(r, 200));
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
