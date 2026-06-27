import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import type { App } from './db/schema.js';
import { inspectPath } from './monorepo-detector.js';

/**
 * Single-worker FIFO queue for `git fetch` against managed app repos.
 *
 * Why a queue at all: fetching every repo when the dashboard loads would
 * spike bandwidth + CPU + dashboard latency for no reason — most repos
 * haven't changed since the last check. So we:
 *   1. Cache fetch results in the `repo_states` table; the dashboard reads
 *      cached state only and renders instantly
 *   2. A background sweep enqueues every git-backed app every 30 minutes
 *   3. The user can manually request a fresh fetch per-app via the kebab
 *      menu — this just enqueues; they don't wait
 *
 * Why one fetch at a time: each `git fetch` opens a network connection.
 * Doing 10 in parallel would saturate a residential uplink and trigger
 * remote rate-limits. Serialised with a 2-second gap between fetches is
 * a much friendlier neighbour.
 *
 * Why in-memory: process restart is a non-issue here — the queue is
 * cheap to repopulate from the schedule, and any "in-flight" fetch on
 * restart would have been near-instant anyway. Persistence would be
 * pure ceremony.
 */

/** Time between consecutive fetches in milliseconds. */
const INTER_FETCH_GAP_MS = 2_000;
/** Per-fetch timeout — generous for large repos but bounded. */
const FETCH_TIMEOUT_MS = 60_000;
/** Background sweep cadence. */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
/** Debounce: refuse manual fetch requests if last successful fetch is younger
 *  than this. Prevents click-spam from queue floods. */
const MANUAL_DEBOUNCE_MS = 30_000;

interface Job {
  appId: string;
  source: 'manual' | 'background';
  queuedAt: number;
}

const queue: Job[] = [];
const queuedIds = new Set<string>();
let workerRunning = false;

/** Find a working `git` binary. Falls back to plain `git` if neither
 *  Homebrew location is present (works on Linux via PATH). */
function gitBin(): string {
  for (const p of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    if (existsSync(p)) return p;
  }
  return 'git';
}

/** Run `git ...` in `cwd` with no terminal prompts (so we never hang on a
 *  credential prompt over HTTPS) and a hard timeout. Returns the trimmed
 *  stdout; throws on non-zero exit. */
async function runGit(cwd: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolveP, rejectP) => {
    let timedOut = false;
    const child = execFile(
      gitBin(),
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (timedOut) {
          rejectP(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`));
          return;
        }
        if (err) {
          rejectP(new Error((stderr || err.message).trim().slice(0, 400)));
          return;
        }
        resolveP(stdout.trim());
      }
    );
    child.on('error', (e) => rejectP(e));
    setTimeout(() => {
      if (!child.killed) {
        timedOut = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* */
        }
      }
    }, FETCH_TIMEOUT_MS + 500);
  });
}

function hasGitDir(projectPath: string): boolean {
  return existsSync(resolve(projectPath, '.git'));
}

/** Resolve the default branch from `origin/HEAD`, falling back to `main` /
 *  `master` discovery. Returns null if origin/HEAD isn't set up yet. */
async function detectDefaultBranch(cwd: string): Promise<string | null> {
  try {
    const out = await runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    // "origin/main" → "main"
    return out.replace(/^origin\//, '') || null;
  } catch {
    // Try the common defaults
    for (const b of ['main', 'master']) {
      try {
        await runGit(cwd, ['rev-parse', `origin/${b}`]);
        return b;
      } catch {
        /* not found */
      }
    }
    return null;
  }
}

interface FetchOutcome {
  default_branch: string | null;
  local_sha: string | null;
  remote_sha: string | null;
  commits_behind: number;
  commits_ahead: number;
}

/** Do the actual work: fetch + read SHAs + count behind/ahead. */
async function fetchOnce(app: App): Promise<FetchOutcome> {
  const cwd = app.project_path;
  if (!hasGitDir(cwd)) throw new Error('not a git repo (no .git directory)');

  // Step 1: `git fetch --prune --no-tags` is the cheapest thing that updates
  // remote refs reliably.
  await runGit(cwd, ['fetch', '--prune', '--no-tags', 'origin']);

  // Step 2: figure out which branch to compare against.
  const branch = await detectDefaultBranch(cwd);
  if (!branch) {
    return {
      default_branch: null,
      local_sha: null,
      remote_sha: null,
      commits_behind: 0,
      commits_ahead: 0
    };
  }

  // Step 3: SHAs.
  const localSha = await runGit(cwd, ['rev-parse', 'HEAD']).catch(() => '');
  const remoteSha = await runGit(cwd, ['rev-parse', `origin/${branch}`]).catch(() => '');

  // Step 4: counts. `rev-list --left-right --count` returns "ahead\tbehind".
  let behind = 0;
  let ahead = 0;
  if (localSha && remoteSha && localSha !== remoteSha) {
    try {
      const out = await runGit(cwd, [
        'rev-list',
        '--left-right',
        '--count',
        `HEAD...origin/${branch}`
      ]);
      const [a, b] = out.split(/\s+/).map((x) => Number(x) || 0);
      ahead = a;
      behind = b;
    } catch {
      /* fall through with 0/0 */
    }
  }

  return {
    default_branch: branch,
    local_sha: localSha || null,
    remote_sha: remoteSha || null,
    commits_behind: behind,
    commits_ahead: ahead
  };
}

/** Upsert a repo_states row. The schema's `timestamp_ms` columns want Date
 *  objects (drizzle calls `.getTime()` on the value), so we normalise raw
 *  millisecond numbers up front. */
interface StatePatch {
  default_branch?: string | null;
  local_sha?: string | null;
  remote_sha?: string | null;
  commits_behind?: number;
  commits_ahead?: number;
  fetch_status?: string;
  fetch_error?: string | null;
  last_fetched_at?: number | null;
  last_pulled_at?: number | null;
  new_subapp_paths?: string | null;
}

function upsertState(appId: string, patch: StatePatch): void {
  // Normalise timestamps: ms-number → Date | null
  const normalised: Record<string, unknown> = {};
  for (const k of Object.keys(patch) as Array<keyof StatePatch>) {
    const v = patch[k];
    if (k === 'last_fetched_at' || k === 'last_pulled_at') {
      normalised[k] = typeof v === 'number' ? new Date(v) : null;
    } else {
      normalised[k] = v;
    }
  }
  // For brand-new rows: ensure missing-from-patch fields default to safe values
  if (!('new_subapp_paths' in normalised)) {
    /* drizzle's insert defaults handle missing fields, this branch is just
     * here to keep the field list explicit for readers. */
  }
  const existing = db
    .select()
    .from(schema.repo_states)
    .where(eq(schema.repo_states.app_id, appId))
    .get();
  if (existing) {
    db.update(schema.repo_states)
      .set(normalised)
      .where(eq(schema.repo_states.app_id, appId))
      .run();
  } else {
    db.insert(schema.repo_states)
      .values({
        app_id: appId,
        default_branch: (normalised.default_branch as string | null | undefined) ?? null,
        local_sha: (normalised.local_sha as string | null | undefined) ?? null,
        remote_sha: (normalised.remote_sha as string | null | undefined) ?? null,
        commits_behind: (normalised.commits_behind as number | undefined) ?? 0,
        commits_ahead: (normalised.commits_ahead as number | undefined) ?? 0,
        fetch_status: (normalised.fetch_status as string | undefined) ?? 'idle',
        fetch_error: (normalised.fetch_error as string | null | undefined) ?? null,
        last_fetched_at: (normalised.last_fetched_at as Date | null | undefined) ?? null,
        last_pulled_at: (normalised.last_pulled_at as Date | null | undefined) ?? null,
        new_subapp_paths: (normalised.new_subapp_paths as string | null | undefined) ?? null
      })
      .run();
  }
}

/** For monorepo roots: after a successful fetch, re-run the workspace
 *  inspector against the on-disk repo and compare against existing children.
 *  Records the set of paths that exist in the inspect result but are NOT
 *  yet registered (parent_id != this root). */
function detectNewSubapps(app: App): string[] {
  if (!app.is_monorepo) return [];
  const info = inspectPath(app.project_path);
  if (!info.isMonorepo) return [];
  const known = new Set(
    db
      .select({ p: schema.apps.project_path })
      .from(schema.apps)
      .where(eq(schema.apps.parent_id, app.id))
      .all()
      .map((r) => r.p)
  );
  return info.subapps.map((s) => s.path).filter((p) => !known.has(p));
}

function getApp(appId: string): App | undefined {
  return db.select().from(schema.apps).where(eq(schema.apps.id, appId)).get();
}

async function worker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      queuedIds.delete(job.appId);
      const app = getApp(job.appId);
      if (!app) continue;
      if (!hasGitDir(app.project_path)) {
        // Mark idle with a tiny explanatory error so the UI can suppress the
        // fetch affordance entirely.
        upsertState(job.appId, {
          fetch_status: 'idle',
          fetch_error: 'not a git repo'
        });
        continue;
      }
      upsertState(job.appId, { fetch_status: 'fetching', fetch_error: null });
      try {
        const outcome = await fetchOnce(app);
        // For monorepo roots, also re-run inspect + diff vs registered
        // children. Any new paths get persisted so the dashboard can
        // surface them as "↑N new subapps".
        let newSubappPathsJson: string | null = null;
        if (app.is_monorepo) {
          const newPaths = detectNewSubapps(app);
          if (newPaths.length > 0) newSubappPathsJson = JSON.stringify(newPaths);
        }
        upsertState(job.appId, {
          ...outcome,
          fetch_status: 'idle',
          fetch_error: null,
          last_fetched_at: Date.now(),
          new_subapp_paths: newSubappPathsJson
        });
      } catch (e) {
        upsertState(job.appId, {
          fetch_status: 'error',
          fetch_error: e instanceof Error ? e.message : String(e),
          last_fetched_at: Date.now()
        });
      }
      // Inter-fetch gap so we don't slam network/CPU.
      if (queue.length > 0) {
        await new Promise((r) => setTimeout(r, INTER_FETCH_GAP_MS));
      }
    }
  } finally {
    workerRunning = false;
  }
}

/** Enqueue a fetch job. Idempotent — if the app is already queued, this is
 *  a no-op. Returns `{queued, position}` where queued is whether anything
 *  changed. The worker is started lazily on the first enqueue. */
export function enqueueFetch(
  appId: string,
  source: 'manual' | 'background' = 'manual'
): { queued: boolean; position: number; reason?: string } {
  // Debounce manual requests against very recent fetches.
  if (source === 'manual') {
    const row = db
      .select()
      .from(schema.repo_states)
      .where(eq(schema.repo_states.app_id, appId))
      .get();
    if (row?.last_fetched_at && Date.now() - row.last_fetched_at.getTime() < MANUAL_DEBOUNCE_MS) {
      return {
        queued: false,
        position: -1,
        reason: `last fetch was ${Math.round(
          (Date.now() - row.last_fetched_at.getTime()) / 1000
        )}s ago`
      };
    }
  }
  if (queuedIds.has(appId)) {
    return { queued: false, position: queue.findIndex((j) => j.appId === appId), reason: 'already queued' };
  }
  queue.push({ appId, source, queuedAt: Date.now() });
  queuedIds.add(appId);
  upsertState(appId, { fetch_status: 'queued', fetch_error: null });
  // Start worker without awaiting.
  void worker();
  return { queued: true, position: queue.length - 1 };
}

/** Enqueue every git-backed app. Used by the background sweep. */
export function enqueueSweep(): number {
  const all = db.select().from(schema.apps).all();
  let n = 0;
  for (const app of all) {
    if (!hasGitDir(app.project_path)) continue;
    const r = enqueueFetch(app.id, 'background');
    if (r.queued) n++;
  }
  return n;
}

/** Pull origin/<default-branch> with `--ff-only` (refuses to merge — surfaces
 *  conflicts loudly instead of producing a merge commit). Returns the new
 *  local SHA, or throws. */
export async function pullFastForward(appId: string): Promise<{ ok: true; new_sha: string }> {
  const app = getApp(appId);
  if (!app) throw new Error('unknown app');
  if (!hasGitDir(app.project_path)) throw new Error('not a git repo');
  upsertState(appId, { fetch_status: 'pulling', fetch_error: null });
  try {
    const branch =
      (
        db
          .select()
          .from(schema.repo_states)
          .where(eq(schema.repo_states.app_id, appId))
          .get()
      )?.default_branch ?? (await detectDefaultBranch(app.project_path));
    if (!branch) throw new Error('no default branch configured');
    await runGit(app.project_path, ['pull', '--ff-only', 'origin', branch]);
    const newSha = await runGit(app.project_path, ['rev-parse', 'HEAD']);
    upsertState(appId, {
      local_sha: newSha,
      remote_sha: newSha,
      commits_behind: 0,
      commits_ahead: 0,
      fetch_status: 'idle',
      fetch_error: null,
      last_pulled_at: Date.now(),
      last_fetched_at: Date.now()
    });
    db.insert(schema.events)
      .values({ app_id: appId, level: 'info', msg: `git pull → ${newSha.slice(0, 8)}` })
      .run();
    return { ok: true, new_sha: newSha };
  } catch (e) {
    upsertState(appId, {
      fetch_status: 'error',
      fetch_error: e instanceof Error ? e.message : String(e)
    });
    throw e;
  }
}

/** Read every repo state row keyed by app_id. Snapshot for the SSE state. */
export function readAllRepoStates(): Record<
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
    new_subapps: string[];
  }
> {
  const rows = db.select().from(schema.repo_states).all();
  const out: Record<string, ReturnType<typeof toShape>> = {};
  for (const r of rows) out[r.app_id] = toShape(r);
  return out;
}

function toShape(r: typeof schema.repo_states.$inferSelect) {
  let newSubapps: string[] = [];
  if (r.new_subapp_paths) {
    try {
      const parsed = JSON.parse(r.new_subapp_paths) as unknown;
      if (Array.isArray(parsed)) newSubapps = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      /* */
    }
  }
  return {
    default_branch: r.default_branch,
    commits_behind: r.commits_behind,
    commits_ahead: r.commits_ahead,
    fetch_status: r.fetch_status,
    fetch_error: r.fetch_error,
    last_fetched_at: r.last_fetched_at ? r.last_fetched_at.getTime() : null,
    local_sha: r.local_sha,
    remote_sha: r.remote_sha,
    new_subapps: newSubapps
  };
}

/** Spin up the background sweep timer. Called once from bootOnce. */
let sweepStarted = false;
export function startBackgroundSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  // Initial delay: don't slam the network the second the server boots —
  // wait a minute so the user can interact with the dashboard first.
  //
  // BOTH timers are unref'd. Without unref they ALONE keep the event loop
  // alive forever — even after SIGTERM closes the HTTP server + stops the
  // monitor + tears down the proxies, this setInterval would pin the
  // process. That was one of the root causes of the zombie pileup the
  // singleton lockfile + SIGTERM handler had to clean up after.
  const initial = setTimeout(() => {
    const n = enqueueSweep();
    if (n > 0) console.log(`[repo-fetcher] background sweep queued ${n} repo${n === 1 ? '' : 's'}`);
  }, 60_000);
  initial.unref();
  const recurring = setInterval(() => {
    const n = enqueueSweep();
    if (n > 0) console.log(`[repo-fetcher] background sweep queued ${n} repo${n === 1 ? '' : 's'}`);
  }, SWEEP_INTERVAL_MS);
  recurring.unref();
}
