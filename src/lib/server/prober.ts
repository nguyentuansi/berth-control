import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const exec = promisify(execFile);
const IS_DARWIN = process.platform === 'darwin';

export interface PortListener {
  port: number;
  /** The local-side host as ss reports it (e.g. "127.0.0.1", "0.0.0.0", "100.x.y.z" for tailnet IPs, "::1"). */
  host: string;
  pid: number | null;
  cmd: string | null;
  /** Whether this listener is bound to loopback or wildcard (i.e. the *real* app,
   *  not e.g. tailscaled's per-tailnet-IP proxy listener). */
  isLocal: boolean;
}

/** Snapshot of every TCP listener on the box. On Linux this is `ss -tlnp`
 *  (no root needed); on macOS we use `lsof -nP -iTCP -sTCP:LISTEN -F pPcnT`
 *  because `ss` doesn't exist there. The earlier Linux-only implementation
 *  silently returned [] on macOS, which broke every "what's on this port"
 *  decision in the supervisor (start, reattach, stop) — and was why a
 *  killed `bun run dev` could be reparented to launchd and re-bind the
 *  next start's port indefinitely. */
export async function listListeners(): Promise<PortListener[]> {
  try {
    if (IS_DARWIN) {
      const { stdout } = await exec(
        'lsof',
        ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pPcnT'],
        { timeout: 4000 }
      );
      return parseLsof(stdout);
    }
    const { stdout } = await exec('ss', ['-tlnp', '-H'], { timeout: 4000 });
    return parseSs(stdout);
  } catch {
    return [];
  }
}

/** Parse lsof's machine-readable `-F` output. One record per file descriptor:
 *  blocks separated by a `p<pid>` line, followed by `c<comm>`, then `f<fd>`,
 *  `P<proto>`, `n<addr>`, etc. We only emit a row for TCP LISTEN sockets, one
 *  per port:host pair to mirror what parseSs produces. */
export function parseLsof(stdout: string): PortListener[] {
  const out: PortListener[] = [];
  let pid: number | null = null;
  let cmd: string | null = null;
  let proto: string | null = null;
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const tag = raw[0];
    const val = raw.slice(1);
    if (tag === 'p') {
      pid = Number(val) || null;
      cmd = null;
    } else if (tag === 'c') {
      cmd = val || null;
    } else if (tag === 'P') {
      proto = val.toUpperCase();
    } else if (tag === 'T') {
      // T tag is per-fd state — only TCP entries with ST=LISTEN reach here
      // because of the `-sTCP:LISTEN` filter, so we don't have to gate on it.
    } else if (tag === 'n') {
      // Address forms:
      //   127.0.0.1:5202    | *:5202    | [::1]:5202    | [::]:5202
      // lsof can also emit "addr->peer" for ESTABLISHED but -sTCP:LISTEN
      // strips peers, so `n` is just the local address.
      if (proto && proto !== 'TCP') continue;
      const parsed = splitAddr(val.replace(/^\*:/, '0.0.0.0:'));
      if (!parsed) continue;
      out.push({
        port: parsed.port,
        host: parsed.host,
        pid,
        cmd,
        isLocal: isLocalBind(parsed.host)
      });
    }
  }
  return out;
}

/** True for loopback (127.x, ::1) and wildcard (0.0.0.0, ::) binds — i.e. the
 *  cases where a real local app would listen. False for tailnet IPs (100.x,
 *  fd7a:...), LAN IPs, etc., which are typically `tailscale serve` itself. */
export function isLocalBind(host: string): boolean {
  const h = host.replace(/^\[/, '').replace(/\]$/, '');
  if (h === '0.0.0.0' || h === '*' || h === '::' || h === '::1') return true;
  if (h.startsWith('127.')) return true;
  if (h.startsWith('::ffff:127.')) return true;
  return false;
}

function splitAddr(addr: string): { host: string; port: number } | null {
  if (addr.startsWith('[')) {
    const close = addr.indexOf(']');
    if (close < 0) return null;
    const host = addr.slice(1, close);
    const m = addr.slice(close + 1).match(/^:(\d+)$/);
    if (!m) return null;
    return { host, port: Number(m[1]) };
  }
  const idx = addr.lastIndexOf(':');
  if (idx < 0) return null;
  const port = Number(addr.slice(idx + 1));
  if (!Number.isFinite(port)) return null;
  return { host: addr.slice(0, idx), port };
}

export function parseSs(stdout: string): PortListener[] {
  const out: PortListener[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port [process]
    const cols = line.split(/\s+/);
    if (cols.length < 4) continue;
    const parsed = splitAddr(cols[3]);
    if (!parsed) continue;
    // pid/cmd may be in the trailing column.
    const procField = cols.slice(5).join(' ');
    const pidMatch = procField.match(/pid=(\d+)/);
    const cmdMatch = procField.match(/\("([^"]+)"/);
    out.push({
      port: parsed.port,
      host: parsed.host,
      pid: pidMatch ? Number(pidMatch[1]) : null,
      cmd: cmdMatch ? cmdMatch[1] : null,
      isLocal: isLocalBind(parsed.host)
    });
  }
  return out;
}

/** Cheap "is this PID still alive" check. Uses `kill(pid, 0)` which is
 *  POSIX and works identically on Linux + macOS: it sends signal 0 (no-op)
 *  but performs the normal permission/existence checks. Returns:
 *    - true  → process exists and we can signal it (ESRCH would have thrown).
 *    - true  → EPERM (process exists, just owned by someone else).
 *    - false → ESRCH (no such process) or invalid arg.
 *
 *  The previous implementation read `/proc/<pid>` which doesn't exist on
 *  macOS, so pidAlive() returned false for EVERY PID — convincing the
 *  supervisor that everything it had spawned was already dead and letting
 *  those processes survive as orphans on each berth restart. */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // EPERM = process exists but we lack rights to signal it. Still "alive".
    return code === 'EPERM';
  }
}

/**
 * Read /proc/<pid>/cgroup and classify what supervisor (if any) put the
 * process there. Useful for explaining why a port-bound process is running:
 * a `.service` leaf is a systemd unit (extracted as `unit`); a `.scope`
 * leaf is typically a transient/session cgroup (terminal, browser app);
 * anything else falls through to `unknown`.
 */
export type ProcOrigin = {
  kind: 'systemd' | 'scope' | 'unknown';
  unit: string | null;
  /** systemd manager that owns the unit, derived from the cgroup path's
   *  containing slice. user-level units sit under `/user.slice/...`; system
   *  units under `/system.slice/...`. null for non-systemd cgroups. */
  scope: 'user' | 'system' | null;
};
export function procOrigin(pid: number): ProcOrigin {
  try {
    // cgroup v2: "0::/user.slice/.../app.slice/jarvis-fleet.service".
    // Multiple lines on v1 hybrid; the leaf is the same on the last v2 line.
    const raw = readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
    const lastLine = raw.split('\n').pop() ?? '';
    const path = lastLine.split('::')[1] ?? lastLine;
    const leaf = path.split('/').filter(Boolean).pop() ?? '';
    const scope: 'user' | 'system' | null = path.includes('/user.slice/')
      ? 'user'
      : path.startsWith('/system.slice/')
        ? 'system'
        : null;
    if (leaf.endsWith('.service')) {
      return { kind: 'systemd', unit: leaf.slice(0, -'.service'.length), scope };
    }
    if (leaf.endsWith('.scope')) {
      return { kind: 'scope', unit: leaf.slice(0, -'.scope'.length), scope };
    }
    return { kind: 'unknown', unit: null, scope: null };
  } catch {
    return { kind: 'unknown', unit: null, scope: null };
  }
}

/** Returns { state, ppid, pgid, comm } for a PID, or null if it doesn't
 *  exist. On Linux this is parsed from /proc/<pid>/stat; on macOS it shells
 *  out to `ps -p <pid> -o state=,ppid=,pgid=,comm=` — single fork, ~3ms.
 *  Returning null on macOS (the previous behavior) hid orphans from the
 *  supervisor's reattach + descendant-walk paths, so a `bun run dev` whose
 *  ppid was reparented to 1 was invisible. */
export function pidInfo(
  pid: number
): { state: string; ppid: number; pgid: number; comm: string } | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  if (IS_DARWIN) {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'state=,ppid=,pgid=,comm='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const line = out.trim();
      if (!line) return null;
      // state is a single char ("S", "R", "Z", …), then ppid, pgid, then comm
      // which may contain spaces or a full path. We greedy-match the 3
      // numeric/state columns and treat everything after as comm.
      const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) return null;
      return {
        state: m[1],
        ppid: Number(m[2]),
        pgid: Number(m[3]),
        comm: m[4].trim()
      };
    } catch {
      return null;
    }
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // After comm (in parens) the fields are space-separated. comm can contain
    // spaces, so split on the last ')'.
    const rp = stat.lastIndexOf(')');
    const comm = stat.slice(stat.indexOf('(') + 1, rp);
    const tail = stat.slice(rp + 2).split(' ');
    return { state: tail[0], ppid: Number(tail[1]), pgid: Number(tail[2]), comm };
  } catch {
    return null;
  }
}

export interface HealthResult {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  error?: string;
}

/** Fire-and-forget healthcheck — 2s timeout, no body kept. */
export async function probeHealth(url: string): Promise<HealthResult> {
  const started = performance.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'manual' });
    return { ok: r.status < 500, status: r.status, latencyMs: Math.round(performance.now() - started) };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}
