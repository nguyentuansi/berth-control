import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, createWriteStream, readdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from './db/index.js';
import { apps, runs, events, log_chunks, type App, type Run } from './db/schema.js';
import { pidAlive, pidInfo, listListeners, isLocalBind } from './prober.js';
import { removeServeMapping } from './tailscale-serve.js';

const LOG_ROOT = resolve(homedir(), '.berth-control/logs');

/** Build a PATH for spawned children that excludes any specific-Node-version
 *  directory that may be pinned in berth's OWN process environment.
 *
 *  Why: berth-control's `better_sqlite3.node` is compiled against a specific
 *  NODE_MODULE_VERSION, so the berth process is launched with a specific Node
 *  (e.g. `/opt/homebrew/opt/node@22/bin/node`) and that directory is prefixed
 *  into PATH. But user apps often have native modules compiled against a
 *  DIFFERENT Node version (whatever was active when they ran `bun install`
 *  or `npm install`). If we leak berth's pinned Node down to the child, the
 *  child loads native modules that mismatch and fails at runtime with
 *  `NODE_MODULE_VERSION X is required, got Y`.
 *
 *  Strategy: strip any `**\/node@\d+/bin` or `**\/node\d+/bin` directory from
 *  PATH so children resolve `node` via their normal precedence (system
 *  default, asdf/nvm shim, etc.) — matching whatever the user used at install
 *  time. We only filter version-pinned paths; generic `/opt/homebrew/bin`
 *  with the default `node` symlink stays. */
function childPathWithoutPinnedNode(): string {
  const sep = process.platform === 'win32' ? ';' : ':';
  const entries = (process.env.PATH ?? '').split(sep);
  const pinned = /\/node@?\d+(\.\d+)*\/bin\/?$/;
  return entries.filter((e) => !pinned.test(e)).join(sep);
}

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

  // Prebuild — runs synchronously before the spawn. Same shell, same cwd,
  // same childPathWithoutPinnedNode() PATH as the start_cmd so e.g. a vite
  // build that needs Node 26 finds the right binary. Use cases: "build all
  // workspace packages before serving" (vontigo-style), "svelte-kit sync"
  // / "drizzle push" / "wrangler types".
  if (app.prebuild_cmd && app.prebuild_cmd.trim()) {
    const cmd = app.prebuild_cmd.trim();
    db.insert(events)
      .values({
        app_id: appId,
        user_login: userLogin ?? null,
        level: 'info',
        msg: `prebuild: ${cmd.slice(0, 200)}`
      })
      .run();
    const code: number = await new Promise((resolve) => {
      const child = spawn(cmd, {
        cwd: app.project_path,
        shell: '/bin/bash',
        env: { ...process.env, PATH: childPathWithoutPinnedNode(), FORCE_COLOR: '0', CI: '' },
        stdio: 'inherit'
      });
      child.on('exit', (c) => resolve(c ?? -1));
      child.on('error', () => resolve(-1));
    });
    if (code !== 0) {
      db.insert(events)
        .values({
          app_id: appId,
          level: 'warn',
          msg: `prebuild exited ${code}; aborting start`
        })
        .run();
      throw new Error(`prebuild_cmd failed with exit ${code}`);
    }
  }

  // Pre-clean any leftover `tailscale serve` mapping pointing at this app's
  // port. The mapping survives prior runs/crashes/berth restarts, and while
  // it lives `tailscaled` holds the tailnet IPv4 + IPv6 wildcards on this
  // port. vite 8's `isPortAvailable` ALWAYS preflights `0.0.0.0` and `::`
  // regardless of `server.host` — see vite/dist/.../node.js `isPortAvailable`
  // iterating `wildcardHosts` — so even a `host: '127.0.0.1'` config still
  // returns EADDRINUSE here. Without this pre-clean, "Start with tailnet"
  // is broken whenever a previous run left a mapping behind.
  if (app.port) {
    try {
      await removeServeMapping(app.port);
    } catch {
      /* idempotent — if there was no mapping, or perms blocked, fall through. */
    }
  }

  // Claim the TCP port BEFORE spawn. If a stale process is still bound to
  // this app's port — usually a `bun run dev` whose parent berth thought
  // was dead and which got reparented to launchd/init — vite/wrangler will
  // fail with EADDRINUSE the moment we spawn, and the user sees "Start
  // does nothing." We've seen runs survive berth restarts as orphans
  // (especially on macOS, where the old pidAlive read /proc and always
  // returned false, so reattach decided everything was already exited).
  // Resolution: if the squatter's cmdline references THIS app's project
  // path, it's our own orphan — kill its tree. If it's foreign (an
  // unrelated app the user is running), surface a clear error rather than
  // silently murdering their other work.
  if (app.port) {
    await claimPort(appId, app, userLogin ?? null);
  }

  // Tailnet Host-header handling is fully out-of-process now: when a user
  // adds a `tailscale serve` mapping, tailscale-serve.ts stands up a
  // Host-rewrite proxy (src/lib/server/host-rewrite-proxy.ts) so the dev
  // server only ever sees `Host: localhost:<port>`. No vite.config edits,
  // ever — works on any repo without touching its source.

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
    env: { ...process.env, PATH: childPathWithoutPinnedNode(), FORCE_COLOR: '0', CI: '' },
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

  // If the app declares a port, wait for it to actually appear on loopback
  // before returning. Otherwise the caller (the "Start with tailnet" UI flow
  // does POST /start → await OK → POST /tailscale-serve) races vite's bind:
  // tailscale serve binds the tailnet IPv4 + IPv6 on the same port, and
  // vite 8's `isPortAvailable` preflight always probes 0.0.0.0/:: regardless
  // of `server.host`, so an early tailnet POST kills the vite spawn that
  // hasn't yet finished its preflight. Polling here closes that race.
  if (app.port) {
    const ok = await waitForListener(app.port, child.pid, 25_000);
    if (!ok) {
      const stillAlive = pidAlive(child.pid);
      db.insert(events)
        .values({
          app_id: appId,
          level: 'warn',
          msg: stillAlive
            ? `start: process alive but no listener on :${app.port} within 25s`
            : `start: process died before binding :${app.port}`
        })
        .run();
      // Do not throw — return the run row so the UI can show logs. The
      // caller already gets `exit_code` from the live snapshot to detect death.
    }
  }

  const fresh = db.select().from(runs).where(eq(runs.id, runRow.id)).get();
  return { run: fresh!, alreadyRunning: false };
}

/** Poll for a loopback (or wildcard) listener on `port` owned by the spawned
 *  tree, up to `timeoutMs`. Resolves true once a listener appears, false on
 *  timeout OR if the root pid dies first. Polls cheaply (every 200ms). */
async function waitForListener(port: number | null, rootPid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(rootPid)) return false;
    try {
      const listeners = await listListeners();
      // The "any listener owned by the spawn tree" check is the load-bearing
      // one: the user's app may bind a port that doesn't match berth's
      // configured app.port (vite ignores `app.port=8220` and uses its own
      // default 5173 unless server.port is set). Returning early as soon as
      // ANY descendant pid is listening means: (a) Start returns in <1s
      // instead of the 25s timeout, and (b) tailscale-serve POST can read
      // the actually-bound port via the same listing.
      const descendants = collectDescendants(rootPid);
      const owned = listeners.some((l) => l.pid != null && descendants.includes(l.pid));
      if (owned) return true;
      // Fall back to exact port match in case the listener PID is unknown
      // (lsof flake, kernel race) — that path used to be the only one.
      if (port != null && listeners.some((l) => l.port === port)) return true;
    } catch {
      /* listListeners can flake briefly on macOS during a bursty start; just retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
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
    if (!open) {
      // No run at all — but a tailnet mapping might still be hanging from a
      // prior incarnation. Release it so the next start isn't blocked.
      await releaseTailnetMapping(appId);
      return { stopped: false };
    }
    const res = await killByPid(appId, open.pid, open.pgid ?? open.pid, open.id, userLogin);
    await releaseTailnetMapping(appId);
    return res;
  }
  const res = await killByPid(appId, proc.pid, proc.pgid ?? proc.pid, proc.run_id, userLogin);
  await releaseTailnetMapping(appId);
  return res;
}

/** Release the tailscale-serve mapping that points at this app's local port,
 *  if any. Idempotent and best-effort: a leftover mapping survives berth
 *  restarts and keeps tailscaled bound to the tailnet IPv4 + IPv6 on that
 *  port; on the next vite start the wildcard preflight then sees EADDRINUSE
 *  even though loopback is empty. Calling this on every stop keeps the port
 *  truly free between runs. Logged but never thrown — a tailnet hiccup must
 *  not surface as "stop failed". */
async function releaseTailnetMapping(appId: string): Promise<void> {
  const app = getApp(appId);
  if (!app?.port) return;
  try {
    await removeServeMapping(app.port);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.insert(events)
      .values({
        app_id: appId,
        level: 'warn',
        msg: `tailscale serve cleanup failed: ${msg.slice(0, 200)}`
      })
      .run();
  }
}

/** Build a ppid → children index for every process on the box. Source of
 *  truth differs by OS:
 *    - Linux  → walks /proc, parses /proc/<pid>/stat per entry
 *    - macOS  → shells out to `ps -A -o pid=,ppid=` (single fork, ~3ms)
 *  Either way the shape is `Map<ppid, pid[]>`. */
function buildChildrenIndex(): Map<number, number[]> {
  const children = new Map<number, number[]>();
  const add = (ppid: number, pid: number) => {
    const sibs = children.get(ppid);
    if (sibs) sibs.push(pid);
    else children.set(ppid, [pid]);
  };
  if (process.platform === 'linux') {
    try {
      for (const d of readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        const pid = Number(d);
        const info = pidInfo(pid);
        if (!info) continue;
        add(info.ppid, pid);
      }
    } catch {
      /* fall through */
    }
    return children;
  }
  // macOS / fallback path
  try {
    const out = execSync('ps -A -o pid=,ppid=', { encoding: 'utf8', timeout: 2000 });
    for (const raw of out.split('\n')) {
      const m = raw.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      add(Number(m[2]), Number(m[1]));
    }
  } catch {
    /* */
  }
  return children;
}

/** Snapshot the descendant tree of `rootPid` (including itself) so we can
 *  signal every PID directly. We snapshot *before* signalling because once a
 *  middle-tier parent dies, its surviving children get reparented to PID 1
 *  and the next walk would miss them; tracking by PID still works because
 *  PIDs stay stable until the process exits. */
function collectDescendants(rootPid: number): number[] {
  const children = buildChildrenIndex();
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

/** Evict any orphan from `app.port` BEFORE we attempt to spawn. Returns
 *  silently if the port is free or if the squatter dies cleanly. Throws
 *  if a foreign (non-berth-spawned) process is holding the port — we don't
 *  want a Start to murder the user's unrelated work, so we surface that
 *  case instead of acting on it.
 *
 *  "Is this our orphan?" heuristic: lsof's cmdline for the squatter root
 *  must mention `app.project_path` or one of its parent segments — a
 *  `bun run dev` we spawned will always have that cwd (or its vite child
 *  will reference `node_modules/.bin/vite` under it). Anything else is
 *  treated as foreign. The heuristic is intentionally narrow; we'd rather
 *  fail the Start with a useful message than wrongly kill. */
async function claimPort(
  appId: string,
  app: App,
  userLogin: string | null
): Promise<void> {
  if (!app.port) return;
  const listeners = await listListeners();
  // Dedupe by listener PID — a single dev server can bind v4 + v6 on the
  // same port. Different listener PIDs on the same port are extraordinary
  // (SO_REUSEPORT) but we handle them by classifying each independently.
  const byPid = new Map<number, (typeof listeners)[number]>();
  for (const l of listeners) {
    if (l.port !== app.port || !l.isLocal || !l.pid) continue;
    if (!byPid.has(l.pid)) byPid.set(l.pid, l);
  }
  if (byPid.size === 0) return;

  // Classify each squatter as "ours" (orphan from a prior run) or
  // "foreign" (some other user app on this port). The test: walk the
  // listener's whole descendant tree — not just direct children — and
  // check whether the cmdline of ANY process in that tree references the
  // app's project_path. vite's bin path is resolved by the npm scripts
  // runner to an absolute path under the project's node_modules, so a
  // vite child anywhere in the tree will match. We batch a single `ps`
  // across the whole tree to keep cost flat.
  const projectMarker = app.project_path.replace(/\/+$/, '');
  const orphanRoots: number[] = [];
  const foreign: Array<{ pid: number; cmd: string | null }> = [];
  for (const [rootPid, l] of byPid) {
    const tree = collectDescendants(rootPid);
    let claimed = false;
    if (tree.length > 0) {
      try {
        const out = execSync(`ps -o pid=,command= -p ${tree.join(',')}`, {
          encoding: 'utf8',
          timeout: 2000
        });
        claimed = out.includes(projectMarker);
      } catch {
        /* fall through: treat as foreign */
      }
    }
    if (claimed) orphanRoots.push(rootPid);
    else foreign.push({ pid: rootPid, cmd: l.cmd });
  }

  // Foreign squatters with NO orphan tree found → user has something
  // unrelated on this port. Surfacing this is the right call: we'd rather
  // refuse a Start with a useful error than murder unrelated work.
  if (orphanRoots.length === 0 && foreign.length > 0) {
    const f = foreign[0];
    const msg = `port ${app.port} held by foreign pid ${f.pid} (${f.cmd ?? '?'}) — not killing; resolve manually`;
    db.insert(events).values({ app_id: appId, user_login: userLogin, level: 'warn', msg }).run();
    throw new Error(msg);
  }
  if (foreign.length > 0) {
    // Mixed case: an orphan AND a foreign process on this port. We kill
    // only the orphans, log the foreigns so the user knows why Start
    // might still fail.
    const flist = foreign.map((f) => `${f.pid}(${f.cmd ?? '?'})`).join(',');
    db.insert(events)
      .values({
        app_id: appId,
        user_login: userLogin,
        level: 'warn',
        msg: `claimPort: leaving foreign listeners alone [${flist}]; killing orphans only`
      })
      .run();
  }

  // SIGTERM every PID in every orphan tree (snapshot taken just above —
  // re-snapshot anyway since classification may have taken hundreds of
  // ms during the ps fork). Then wait for the port to free; if SIGTERM
  // doesn't release it, escalate to SIGKILL across the re-walked tree.
  const allOrphans = new Set<number>();
  for (const root of orphanRoots) {
    for (const p of collectDescendants(root)) allOrphans.add(p);
  }
  db.insert(events)
    .values({
      app_id: appId,
      user_login: userLogin,
      level: 'info',
      msg: `claimPort: evicting ${orphanRoots.length} orphan root(s), ${allOrphans.size} pid(s) total`
    })
    .run();
  for (const p of allOrphans) {
    try {
      process.kill(p, 'SIGTERM');
    } catch {
      /* */
    }
  }

  // Wait up to 4s for the port to free. Re-poll listListeners (the actual
  // signal we care about: is the port free?) rather than pidAlive, because
  // a zombie or unkillable-state PID can hold "alive" forever even after
  // the port is released by the kernel.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const still = (await listListeners()).filter((l) => l.port === app.port && l.isLocal);
    if (still.length === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Still bound → re-walk each orphan root once more (children may have
  // spawned during the wait) and SIGKILL the union.
  const kgroup = new Set<number>(allOrphans);
  for (const root of orphanRoots) {
    for (const p of collectDescendants(root)) kgroup.add(p);
  }
  for (const p of kgroup) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* */
    }
  }
  await new Promise((r) => setTimeout(r, 300));

  const final = (await listListeners()).filter((l) => l.port === app.port && l.isLocal);
  if (final.length > 0) {
    const msg = `port ${app.port} still bound after SIGKILL (pid ${final[0].pid}); start will likely fail`;
    db.insert(events).values({ app_id: appId, user_login: userLogin, level: 'warn', msg }).run();
  }
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

  // Wait up to 5s for the whole tree to die. RE-DISCOVER descendants on
  // every poll for two reasons:
  //   (a) Spawn-after-snapshot: a vite watcher reload or bun worker fork
  //       can create a child AFTER our initial collectDescendants(pid),
  //       so it won't be in `tree` and would survive the SIGTERM.
  //   (b) Reparenting: once the root dies, any surviving grandchild is
  //       reparented to PID 1, so collectDescendants(root) ALONE would
  //       miss them. We walk descendants of EVERY still-alive seen PID,
  //       so each branch keeps its own re-discovery path even after its
  //       parent dies.
  // Zombies (state 'Z') report pidAlive=true forever — they're waiting
  // for their parent to wait() on them. Treat them as effectively dead
  // for "is the tree gone?" purposes; the kernel/init reaps them.
  const isDeadOrZombie = (p: number) => {
    if (!pidAlive(p)) return true;
    const info = pidInfo(p);
    return info?.state === 'Z';
  };
  const start = Date.now();
  const allSeen = new Set(tree);
  while (Date.now() - start < 5000) {
    const living = [...allSeen].filter((p) => !isDeadOrZombie(p));
    for (const live of living) {
      for (const desc of collectDescendants(live)) {
        if (allSeen.has(desc)) continue;
        allSeen.add(desc);
        try {
          process.kill(desc, 'SIGTERM');
        } catch {
          /* */
        }
      }
    }
    if (living.length === 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const survivors = [...allSeen].filter((p) => !isDeadOrZombie(p));
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
      // Process is gone but its tailnet mapping persists — release it so the
      // next start doesn't trip vite's EADDRINUSE preflight.
      releaseTailnetMapping(r.app_id).catch(() => {});
    }
  }
}

export function liveSnapshot(): Record<
  string,
  { pid: number; pgid: number | null; run_id: number; startedAt: number }
> {
  const out: Record<
    string,
    { pid: number; pgid: number | null; run_id: number; startedAt: number }
  > = {};
  for (const [k, v] of live) {
    // Two acceptance criteria: the root spawn is alive (the normal case),
    // OR the spawn has detached + the bash root died but children kept
    // running (the bun-managed case — bash exits as soon as bun takes
    // over, children get reparented to PID 1). We keep the entry around
    // because the *pgid* is still the right grouping key for matching
    // listeners owned by this run.
    if (pidAlive(v.pid) || v.pgid != null) {
      out[k] = { pid: v.pid, pgid: v.pgid, run_id: v.run_id, startedAt: v.startedAt };
    }
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
        // Without this, an externally-killed app dies SILENTLY (no exit
        // event, no stop event). The user then sees the dashboard go red
        // and has no idea why. Reap is the catch-all for any death that
        // bypassed our spawn's `child.on('exit')` (because berth itself
        // restarted, or the child was SIGKILL'd outside its pgid). Log it.
        db.insert(events)
          .values({
            app_id: k,
            level: 'warn',
            msg: `reaped: pid ${v.pid} died outside berth's spawn (no exit handler fired) — likely SIGKILL or berth restarted`
          })
          .run();
      }
      // The app died on its own (crash, ctrl-c outside berth, exited 0). The
      // tailnet mapping doesn't follow — release it so it isn't dangling.
      releaseTailnetMapping(k).catch(() => {});
    }
  }
}

export { pidInfo };
