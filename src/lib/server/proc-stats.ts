import { readdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Linux _SC_CLK_TCK = 100 on every distro I've seen this run on. If we ever
// hit a system where it isn't, /proc/timer_list or a native add-on would
// confirm — for now this is a sound default.
const CLK_TCK = 100;
const PAGE_KB = 4;

export interface ProcStats {
  /** Whole-pgid CPU percent over the last sampling interval. May exceed 100
   *  for multi-core. null = no data yet (first sample of a new pgid). */
  cpuPct: number | null;
  /** Whole-pgid resident memory, MB. */
  ramMB: number | null;
  /** Whole-pgid VRAM use from nvidia-smi, MB. null = no GPU usage / no GPU. */
  gpuMB: number | null;
}

interface PidEntry {
  ppid: number;
  pgid: number;
  cpuTicks: number;
  rssKB: number;
}

// Per-app cumulative CPU-tick cache → enables delta-based CPU% calculation.
const cpuCache = new Map<string, { ticks: number; ts: number }>();

function readPidEntry(pid: number): PidEntry | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parens — split off the last ')' to be safe.
    const rp = stat.lastIndexOf(')');
    const tail = stat.slice(rp + 2).split(' ');
    // After comm: state(0), ppid(1), pgrp(2), session(3), tty_nr(4), tpgid(5),
    // flags(6), minflt(7), cminflt(8), majflt(9), cmajflt(10),
    // utime(11), stime(12), cutime(13), cstime(14), priority(15), nice(16),
    // num_threads(17), itrealvalue(18), starttime(19), vsize(20), rss(21).
    const ppid = Number(tail[1]);
    const pgid = Number(tail[2]);
    const utime = Number(tail[11]);
    const stime = Number(tail[12]);
    const rssPages = Number(tail[21]);
    return { ppid, pgid, cpuTicks: utime + stime, rssKB: rssPages * PAGE_KB };
  } catch {
    return null;
  }
}

let nvidiaAvailable: boolean | null = null;

async function nvidiaPresent(): Promise<boolean> {
  if (nvidiaAvailable !== null) return nvidiaAvailable;
  try {
    await exec('nvidia-smi', ['-L'], { timeout: 1500 });
    nvidiaAvailable = true;
  } catch {
    nvidiaAvailable = false;
  }
  return nvidiaAvailable;
}

async function readGpuByPid(): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!(await nvidiaPresent())) return out;
  try {
    const { stdout } = await exec(
      'nvidia-smi',
      ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'],
      { timeout: 1500 }
    );
    for (const line of stdout.split('\n')) {
      const [pidStr, memStr] = line.split(',').map((s) => s.trim());
      if (!pidStr) continue;
      const pid = Number(pidStr);
      const mem = Number(memStr);
      if (Number.isFinite(pid) && Number.isFinite(mem)) {
        out.set(pid, (out.get(pid) ?? 0) + mem);
      }
    }
  } catch {
    /* graphics processes only, or one-off failure — ignore */
  }
  return out;
}

/**
 * Snapshot CPU / RAM / GPU for the given (appId → rootPid) map. Walks /proc
 * exactly once, builds a ppid→children index, then BFS from each root to
 * collect the whole descendant tree (matters for `bun run dev` → `turbo run
 * dev` → per-app `bun`/`vite` workers, where turbo's children set their own
 * pgid). Cost is O(total processes) + one nvidia-smi exec.
 */
export async function snapshotProcStats(
  pidByApp: Map<string, number>
): Promise<Map<string, ProcStats>> {
  const out = new Map<string, ProcStats>();
  if (pidByApp.size === 0) return out;

  let dirs: string[];
  try {
    dirs = readdirSync('/proc');
  } catch {
    return out;
  }
  const entries = new Map<number, PidEntry>();
  const children = new Map<number, number[]>();
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    const e = readPidEntry(pid);
    if (!e) continue;
    entries.set(pid, e);
    const sibs = children.get(e.ppid);
    if (sibs) sibs.push(pid);
    else children.set(e.ppid, [pid]);
  }

  const gpu = await readGpuByPid();
  const now = Date.now();
  for (const cachedAppId of cpuCache.keys()) {
    if (!pidByApp.has(cachedAppId)) cpuCache.delete(cachedAppId);
  }

  for (const [appId, rootPid] of pidByApp) {
    const root = entries.get(rootPid);
    if (!root) {
      out.set(appId, { cpuPct: null, ramMB: null, gpuMB: null });
      cpuCache.delete(appId);
      continue;
    }
    let ticks = 0;
    let rssKB = 0;
    const treePids: number[] = [];
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop()!;
      const e = entries.get(pid);
      if (!e) continue;
      treePids.push(pid);
      ticks += e.cpuTicks;
      rssKB += e.rssKB;
      const cs = children.get(pid);
      if (cs) for (const c of cs) stack.push(c);
    }

    const prev = cpuCache.get(appId);
    cpuCache.set(appId, { ticks, ts: now });
    let cpuPct: number | null = null;
    if (prev) {
      const dt = (now - prev.ts) / 1000;
      const dticks = ticks - prev.ticks;
      if (dt > 0 && dticks >= 0) {
        cpuPct = ((dticks / CLK_TCK) / dt) * 100;
      }
    }
    let gpuMB: number | null = null;
    for (const p of treePids) {
      const g = gpu.get(p);
      if (g != null) gpuMB = (gpuMB ?? 0) + g;
    }
    out.set(appId, { cpuPct, ramMB: rssKB / 1024, gpuMB });
  }
  return out;
}
