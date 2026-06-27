import { execSync } from 'node:child_process';

// System service inventory for the dashboard's Services tab.
//
// Linux: systemctl list-units --type=service --all --no-pager --plain
//   columns: UNIT LOAD ACTIVE SUB DESCRIPTION
//
// macOS: launchctl list
//   columns: PID Status Label  (one row per job; Status is exit code, "-"
//   if running, the label is reverse-DNS like com.apple.foo)
//
// We return a flattened cross-platform shape. Fields specific to one OS
// are surfaced as best-effort (e.g. `description` exists on Linux only;
// `pid` exists on macOS when the job is running).
//
// IMPORTANT: This shells out to systemctl/launchctl on every call. They're
// not free (50-200 ms) so the dashboard polls on a slower cadence than
// processes. We don't push via SSE.

export interface ServiceRow {
  name: string;
  status: 'running' | 'stopped' | 'failed' | 'unknown';
  /** Linux: SUB column (e.g. "running", "dead", "exited"). macOS: numeric
   *  exit code as a string ("0", "1", ...) or "running". Free text — for
   *  display only. */
  sub: string;
  /** Linux only — the systemd unit description. macOS leaves it null. */
  description: string | null;
  /** macOS only — the running PID. Linux leaves it null (you can find it
   *  via systemctl status if needed). */
  pid: number | null;
}

export function listServices(): ServiceRow[] {
  if (process.platform === 'linux') return listLinuxServices();
  if (process.platform === 'darwin') return listMacServices();
  return [];
}

function listLinuxServices(): ServiceRow[] {
  let raw: string;
  try {
    raw = execSync(
      "systemctl list-units --type=service --all --no-pager --plain --no-legend",
      { encoding: 'utf8', timeout: 4000, maxBuffer: 4 * 1024 * 1024 }
    );
  } catch {
    return [];
  }
  const out: ServiceRow[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Columns are whitespace-separated but the description may contain
    // spaces — take the first 4 tokens, recombine the tail.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    const [unit, load, active, sub] = parts;
    const description = parts.slice(4).join(' ') || null;
    out.push({
      name: unit.replace(/\.service$/, ''),
      status: deriveStatus(active, sub),
      sub,
      description,
      pid: null
    });
    void load; // available in the raw row; we don't need it for the UI
  }
  out.sort((a, b) => statusOrder(a.status) - statusOrder(b.status) || a.name.localeCompare(b.name));
  return out;
}

function listMacServices(): ServiceRow[] {
  let raw: string;
  try {
    raw = execSync('launchctl list', {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024
    });
  } catch {
    return [];
  }
  const out: ServiceRow[] = [];
  for (const line of raw.split('\n').slice(1)) {
    // launchctl format:  PID   Status   Label
    //                    -     0        com.apple.foo
    //                    1234  -        com.apple.bar
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const pidStr = parts[0];
    const statusStr = parts[1];
    const name = parts.slice(2).join(' ');
    const pid = pidStr === '-' ? null : Number(pidStr);
    // launchctl status: '-' while running, integer exit code after a stop.
    // We can't reliably distinguish "succeeded once and stopped" from
    // "failed once and stopped" without more state — anything non-zero is
    // reported as failed; '0' is stopped.
    let status: ServiceRow['status'] = 'unknown';
    if (pidStr !== '-' && Number.isFinite(pid)) status = 'running';
    else if (statusStr === '0') status = 'stopped';
    else if (statusStr !== '-' && Number(statusStr) !== 0) status = 'failed';
    out.push({
      name,
      status,
      sub: pidStr === '-' ? `exit ${statusStr}` : 'running',
      description: null,
      pid
    });
  }
  out.sort(
    (a, b) => statusOrder(a.status) - statusOrder(b.status) || a.name.localeCompare(b.name)
  );
  return out;
}

function deriveStatus(active: string, sub: string): ServiceRow['status'] {
  if (active === 'active' && sub === 'running') return 'running';
  if (active === 'failed') return 'failed';
  if (active === 'inactive' || sub === 'dead' || sub === 'exited') return 'stopped';
  return 'unknown';
}

function statusOrder(s: ServiceRow['status']): number {
  // Sort: failed first (most actionable), then running, then stopped,
  // then unknown.
  switch (s) {
    case 'failed':
      return 0;
    case 'running':
      return 1;
    case 'stopped':
      return 2;
    default:
      return 3;
  }
}
