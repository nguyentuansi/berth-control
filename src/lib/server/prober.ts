import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';

const exec = promisify(execFile);

export interface PortListener {
  port: number;
  /** The local-side host as ss reports it (e.g. "127.0.0.1", "0.0.0.0", "100.78.34.73", "::1"). */
  host: string;
  pid: number | null;
  cmd: string | null;
  /** Whether this listener is bound to loopback or wildcard (i.e. the *real* app,
   *  not e.g. tailscaled's per-tailnet-IP proxy listener). */
  isLocal: boolean;
}

/** Snapshot of every TCP listener on the box. Uses `ss -tlnp` — fast, no root needed. */
export async function listListeners(): Promise<PortListener[]> {
  try {
    const { stdout } = await exec('ss', ['-tlnp', '-H'], { timeout: 4000 });
    return parseSs(stdout);
  } catch {
    return [];
  }
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

/** Cheap "is this PID still alive" check — reads /proc/<pid>/stat. */
export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return existsSync(`/proc/${pid}`);
}

/** Returns one line of /proc/<pid>/stat parsed to { state, ppid, pgid }. */
export function pidInfo(
  pid: number
): { state: string; ppid: number; pgid: number; comm: string } | null {
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
