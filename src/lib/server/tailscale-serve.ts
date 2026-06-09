import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface TailscaleMapping {
  /** The port the proxy is exposed on the tailnet host. */
  tailscalePort: number;
  /** The loopback port being proxied. */
  localPort: number;
  /** Was this entry under "Funnel on" (publicly reachable, not tailnet-only)? */
  funnel: boolean;
  /** The tailnet hostname, e.g. `your-machine.your-tailnet.ts.net` */
  host: string;
}

export interface ServeStatus {
  ts: number;
  mappings: TailscaleMapping[];
  host: string | null;
  available: boolean;
}

let cache: ServeStatus = { ts: 0, mappings: [], host: null, available: false };

/** Snapshot of `tailscale serve status`, cached for `maxAgeMs`. */
export async function getServeStatus(maxAgeMs = 5000): Promise<ServeStatus> {
  if (Date.now() - cache.ts < maxAgeMs) return cache;
  try {
    const { stdout } = await exec('tailscale', ['serve', 'status'], { timeout: 4000 });
    const parsed = parseServeStatus(stdout);
    cache = { ts: Date.now(), available: true, ...parsed };
  } catch {
    // Tailscale not installed / daemon down / user not authorized — fall through with empty state.
    cache = { ts: Date.now(), mappings: [], host: null, available: false };
  }
  return cache;
}

export function parseServeStatus(stdout: string): {
  mappings: TailscaleMapping[];
  host: string | null;
} {
  const mappings: TailscaleMapping[] = [];
  let host: string | null = null;
  // Output is blocks like:
  //   https://<host>[:<port>] (tailnet only)
  //   |-- / proxy http://127.0.0.1:<localPort>
  // separated by blank lines. The "(Funnel on)" variant marks public entries.
  const blocks = stdout.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.length < 2) continue;
    const head = lines[0].match(/^https:\/\/([^/:\s]+)(?::(\d+))?\s*\(([^)]+)\)/);
    if (!head) continue;
    const tsHost = head[1];
    const tsPort = head[2] ? Number(head[2]) : 443;
    const note = head[3];
    const funnel = /funnel/i.test(note);
    host = tsHost;
    for (const line of lines.slice(1)) {
      // The proxy line: "|-- <path> proxy http(s)[+insecure]://<host>:<port>"
      const m = line.match(/proxy\s+https?(?:\+insecure)?:\/\/[^:/\s]+:(\d+)/);
      if (m) mappings.push({ tailscalePort: tsPort, localPort: Number(m[1]), funnel, host: tsHost });
    }
  }
  return { mappings, host };
}

/**
 * Add a `tailscale serve --bg --https=<port> http://127.0.0.1:<port>` mapping
 * and bust the status cache so the next SSE tick reflects it. Uses `sudo -n`
 * because `tailscale serve` needs root unless the user has been set as
 * `tailscale set --operator`. Errors propagate.
 */
export async function addServeMapping(localPort: number): Promise<void> {
  await exec(
    'sudo',
    ['-n', 'tailscale', 'serve', '--bg', `--https=${localPort}`, `http://127.0.0.1:${localPort}`],
    { timeout: 8000 }
  );
  cache = { ts: 0, mappings: [], host: null, available: false };
}

/**
 * Remove the `tailscale serve` mapping that publishes a given tailnet-side
 * HTTPS port. Runs `tailscale serve --https=<port> off`. Idempotent: tailscale
 * exits non-zero if there's no such mapping, which we treat as success.
 */
export async function removeServeMapping(tailscalePort: number): Promise<void> {
  try {
    await exec('sudo', ['-n', 'tailscale', 'serve', `--https=${tailscalePort}`, 'off'], {
      timeout: 8000
    });
  } catch (e) {
    // If the mapping never existed tailscale exits with a "not currently
    // serving" error — swallow it; the desired end-state holds either way.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not currently serving|no such|not found/i.test(msg)) throw e;
  }
  cache = { ts: 0, mappings: [], host: null, available: false };
}

export function mappingsByLocalPort(mappings: TailscaleMapping[]): Map<number, TailscaleMapping> {
  const m = new Map<number, TailscaleMapping>();
  for (const mp of mappings) {
    // If two mappings share a local port, prefer the Funnel one (it's the "louder" claim).
    const existing = m.get(mp.localPort);
    if (!existing || (!existing.funnel && mp.funnel)) m.set(mp.localPort, mp);
  }
  return m;
}
