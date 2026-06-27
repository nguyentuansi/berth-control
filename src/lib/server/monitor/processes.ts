import { execSync } from 'node:child_process';

// Top-N processes by CPU for the dashboard's process table.
//
// Implementation: a single `ps -A -o ...` call on both platforms. This is
// the cheapest portable source — no /proc walk needed on Linux, no
// platform-specific quirks. Native /proc could be faster on Linux but adds
// ~100 LOC for marginal benefit on a list-of-20 use case.
//
// Output is shallow-typed; the row is whatever ps gives us, truncated by
// the limit param. Sorting is server-side so the client gets pre-sorted.

export interface ProcessRow {
  pid: number;
  ppid: number;
  user: string;
  cpu_pct: number;
  mem_mb: number;
  /** Command name only — first token of the command line. Avoids leaking
   *  full argv (which can include flags or paths that look like
   *  credentials). */
  comm: string;
}

export function topProcessesByCpu(limit = 25): ProcessRow[] {
  // The `ps -A -o` flags are accepted identically on Linux + macOS BSD ps.
  // %cpu and %mem are sample-time stats — they reflect the kernel's running
  // averages, not deltas we compute. Good enough for a dashboard.
  //
  // We request rss (resident set size in KB) instead of %mem alone so we
  // can show absolute memory and avoid double-querying total RAM.
  let raw: string;
  try {
    raw = execSync('ps -A -o pid=,ppid=,user=,%cpu=,rss=,comm=', {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch {
    return [];
  }

  const out: ProcessRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // The first five columns are space-separated integers/floats. The rest
    // is the command, which may contain spaces — recombine.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const user = parts[2];
    const cpuPct = Number(parts[3]);
    const rssKb = Number(parts[4]);
    // Take only the basename of the command to keep argv out of the UI.
    const fullCmd = parts.slice(5).join(' ');
    const comm = basename(fullCmd);
    if (!Number.isFinite(pid) || !Number.isFinite(cpuPct) || !Number.isFinite(rssKb)) continue;
    out.push({
      pid,
      ppid,
      user,
      cpu_pct: cpuPct,
      mem_mb: rssKb / 1024,
      comm
    });
  }

  out.sort((a, b) => b.cpu_pct - a.cpu_pct);
  return out.slice(0, limit);
}

function basename(cmd: string): string {
  // ps's comm column is usually the binary basename already, but some
  // entries (Linux kernel threads in [brackets], paths) need trimming.
  const head = cmd.split(/\s+/)[0] ?? cmd;
  const lastSlash = head.lastIndexOf('/');
  return lastSlash >= 0 ? head.slice(lastSlash + 1) : head;
}
