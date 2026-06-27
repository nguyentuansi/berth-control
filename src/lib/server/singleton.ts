// Singleton-instance guard for berth-control.
//
// Why
// ---
// berth-control owns shared state per machine: a SQLite DB, a port (5202),
// a supervisor of long-running children, and a registry of Host-rewrite
// proxies on ephemeral ports. Two coexisting instances corrupt all of it,
// SILENTLY — the symptom is just "the dashboard feels slow today."
//
// During a debugging session we accumulated SEVEN zombie processes (each
// killed-but-didn't-exit because its proxy net.Server pinned the event
// loop after adapter-node closed the HTTP server). Each one independently
// polled `ss`/`lsof` every 2s, wrote to host_readings every 60s, and
// fought for the SQLite WAL. Nothing logged, nothing on a status page,
// no UI affordance to even notice the duplicates existed.
//
// This module makes that class of failure structurally impossible: a PID
// lockfile that refuses to let a second instance start while another is
// alive. Combined with the SIGTERM handler in hooks.server.ts that
// releases the lock on clean exit, and SIGKILL-leaving-stale-lock being
// detected on the next start, you can never accumulate zombies again.
//
// Lock lifecycle
// --------------
//   start:    read file → if alive+berth → REFUSE (exit 1, log loudly)
//                       → else (stale or absent) → write our pid
//   sigterm:  remove file (only if it still contains our pid)
//   sigkill:  file stays. next start detects stale, overwrites.
//   reboot:   pids reset. next start sees stale, overwrites.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

export const LOCK_PATH = resolve(homedir(), '.berth-control', 'berth-control.pid');

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // Signal 0 doesn't deliver anything — just checks that the pid exists
    // and we have permission to signal it. ESRCH means "no such process".
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // EPERM means the process exists but is owned by another user — for
    // berth-control's single-machine-single-user model we treat that as
    // a foreign process and overwrite. ESRCH means truly gone.
    if (err?.code === 'EPERM') return true;
    return false;
  }
}

function commandOf(pid: number): string {
  try {
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 500 })
      .replace(/\n/g, '')
      .trim();
  } catch {
    return '<unknown>';
  }
}

function isBerthControl(cmd: string): boolean {
  // Match the actual file the prod build lands at — this is what every
  // launchd / systemd / dev spawn invokes. If the test ever needs to be
  // more lenient (e.g. accepting `bun run start`), broaden here.
  return cmd.includes('berth-control/build/index.js');
}

export interface LockResult {
  acquired: boolean;
  /** Set when refusing — describes the live sibling. */
  conflict?: { pid: number; cmd: string };
  /** True when we wrote OVER a stale lock (previous process was SIGKILL'd
   *  or reboot-cleared). Useful to log so the user knows there was one. */
  stale?: boolean;
}

/** Try to acquire the singleton lock. Idempotent across re-imports of
 *  hooks.server.ts during HMR — if the recorded pid is our own pid, we
 *  treat it as already-acquired.
 *
 *  Caller must check `acquired` and exit immediately on false (with a
 *  loud user-facing log). */
export function acquireSingletonLock(): LockResult {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });

  if (existsSync(LOCK_PATH)) {
    const raw = readFileSync(LOCK_PATH, 'utf8').trim();
    const otherPid = Number(raw);

    // Already ours — HMR re-imported this module, no conflict.
    if (otherPid === process.pid) return { acquired: true };

    if (isAlive(otherPid)) {
      const cmd = commandOf(otherPid);
      if (isBerthControl(cmd)) {
        // Real conflict — another berth-control owns the lock.
        return { acquired: false, conflict: { pid: otherPid, cmd } };
      }
      // The pid is alive but is some OTHER program — pid was reused.
      // Treat as stale: overwrite.
    }
    // Stale lock (gone, foreign program, malformed file). Overwrite.
    writeFileSync(LOCK_PATH, String(process.pid), { mode: 0o600 });
    return { acquired: true, stale: true };
  }

  writeFileSync(LOCK_PATH, String(process.pid), { mode: 0o600 });
  return { acquired: true };
}

/** Release the lock if we still own it. Safe to call multiple times. */
export function releaseSingletonLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const recorded = Number(readFileSync(LOCK_PATH, 'utf8').trim());
    if (recorded === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    /* lock file is best-effort — never let cleanup throw at shutdown */
  }
}
