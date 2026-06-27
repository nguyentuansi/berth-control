import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureHostRewriteProxy, stopHostRewriteProxy } from './host-rewrite-proxy.js';

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
 * and bust the status cache so the next SSE tick reflects it.
 *
 * Privilege model differs by OS:
 *   - macOS    — `tailscale serve` works without sudo for any admin-group user
 *   - Linux    — needs root unless the user has been set as
 *                `tailscale set --operator`; we fall back to `sudo -n`
 *
 * Strategy: try unprivileged first; only fall back to `sudo -n` if the
 * direct call fails with a permission-shaped error. That way macOS never
 * hits sudo, and Linux users without NOPASSWD get a clear error instead
 * of a silent prompt-block.
 */
export async function addServeMapping(localPort: number): Promise<void> {
  // Self-clean first. A previously-set mapping survives berth-control restarts
  // and survives stopApp() — and while it lives, tailscaled is bound to the
  // tailnet IPv4 + IPv6 on this port. The next vite that tries to listen
  // wildcard (vite 8's preflight bind-check does this regardless of the
  // server.host config) gets EADDRINUSE *even though loopback is empty*.
  // remove-then-add gives a clean slate every time.
  try {
    await removeServeMapping(localPort);
  } catch {
    /* idempotent — nothing to remove, or permission. Add will surface the real error. */
  }
  // Stand up a sidecar Host-rewrite proxy in front of the dev server.
  // tailscaled forwards the tailnet HTTPS request to the proxy on
  // 127.0.0.1:<proxyPort>; the proxy rewrites `Host:` to
  // `localhost:<localPort>` so the dev server's allowedHosts check
  // never sees a tailnet hostname. This replaces the legacy
  // vite-config-patcher path — no user-repo modification needed.
  const proxyPort = await ensureHostRewriteProxy(localPort);

  // Use `localhost` (not `127.0.0.1`) so tailscaled's dialer can reach
  // either IPv4 (127.0.0.1) or IPv6 (::1). Vite, wrangler, and several
  // other dev runners bind IPv6-loopback by default — when we proxied
  // to a hardcoded 127.0.0.1 the tailnet URL returned 502 because the
  // IPv4 dial got connection-refused. Go's net/http dialer in tailscaled
  // does happy-eyeballs over /etc/hosts entries for localhost. The proxy
  // itself listens on 127.0.0.1 only (no IPv6) since it's purely a
  // berth-control internal hop, never reachable from the tailnet.
  const args = [
    'serve',
    '--bg',
    `--https=${localPort}`,
    `http://127.0.0.1:${proxyPort}`
  ];
  try {
    await exec('tailscale', args, { timeout: 8000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (process.platform === 'linux' && /permission|denied|root|operator/i.test(msg)) {
      // Last-chance escalation on Linux. macOS users hit the `else` and see
      // the real error (which will mention what tailscale actually needs).
      await exec('sudo', ['-n', 'tailscale', ...args], { timeout: 8000 });
    } else {
      throw e;
    }
  }
  cache = { ts: 0, mappings: [], host: null, available: false };
}

/**
 * Remove the `tailscale serve` mapping that publishes a given tailnet-side
 * HTTPS port. Runs `tailscale serve --https=<port> off`. Idempotent: tailscale
 * exits non-zero if there's no such mapping, which we treat as success.
 */
export async function removeServeMapping(tailscalePort: number): Promise<void> {
  const args = ['serve', `--https=${tailscalePort}`, 'off'];
  const benign = (m: string) => /not currently serving|no such|not found/i.test(m);
  try {
    await exec('tailscale', args, { timeout: 8000 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (benign(msg)) {
      /* mapping wasn't there — idempotent no-op */
    } else if (process.platform === 'linux' && /permission|denied|root|operator/i.test(msg)) {
      try {
        await exec('sudo', ['-n', 'tailscale', ...args], { timeout: 8000 });
      } catch (e2) {
        const m2 = e2 instanceof Error ? e2.message : String(e2);
        if (!benign(m2)) throw e2;
      }
    } else {
      throw e;
    }
  }
  // Stop the matching Host-rewrite proxy if one is up. Convention from
  // addServeMapping: tailscalePort == the local dev port == the key the
  // proxy registry is indexed by. Idempotent — no proxy means no-op.
  await stopHostRewriteProxy(tailscalePort);
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
