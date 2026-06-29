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

  // Visibility defense: tailscaled's TLS terminator can get into a wedged
  // state where TCP accepts but the handshake aborts with a generic
  // `internal_error` alert. The user sees a browser that spins forever and
  // has no way to know it's tailscaled, not their app. Probe ONCE after
  // publish, log a loud remediation hint if it fails. Fire-and-forget — the
  // tailnet hostname is fetched lazily, the probe is bounded.
  void verifyServeReachable(localPort).catch(() => {});
}

/** Best-effort post-publish probe: confirm the tailnet HTTPS endpoint
 *  actually completes a TLS handshake. We dial the tailnet IPv4 directly
 *  (avoiding node's DNS resolver, which doesn't know about MagicDNS) but
 *  pass the hostname as the SNI/servername so tailscaled's TLS terminator
 *  selects the right cert. That exercises the same handshake path the
 *  user's browser hits when navigating to the tailnet URL — if the daemon
 *  is wedged, we catch it; if it's healthy, we get a 200/3xx/401 (any
 *  response means the TLS handshake completed, which is what we care
 *  about). On failure, log a banner with the exact remediation command. */
async function verifyServeReachable(localPort: number): Promise<void> {
  const status = await getServeStatus(0);
  const host = status.host;
  if (!host) {
    console.warn(
      `[tailscale] published serve mapping for :${localPort} but no tailnet ` +
        `hostname is known yet; skipping reachability probe`
    );
    return;
  }

  // Resolve the tailnet IPv4 ourselves so DNS isn't a confound — node's
  // system resolver doesn't know MagicDNS, but the tailnet IP is always
  // routable and the cert validates against `host` via SNI.
  let tailnetIp: string | null = null;
  try {
    const { stdout } = await exec('tailscale', ['ip', '-4'], { timeout: 2000 });
    tailnetIp = stdout.trim().split('\n')[0] || null;
  } catch {
    /* leave null — probe will fall back to hostname */
  }

  const probe = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    import('node:https')
      .then((https) => {
        const req = https.request(
          {
            host: tailnetIp ?? host,
            port: localPort,
            path: '/',
            method: 'HEAD',
            // Force SNI to the tailnet hostname so tailscaled selects the
            // Let's Encrypt cert for it. Without this, IP-based dial would
            // get a default cert that fails verification.
            servername: host,
            rejectUnauthorized: true,
            timeout: 4500
          },
          (res) => {
            res.destroy();
            resolve({ ok: true });
          }
        );
        req.on('error', (e: NodeJS.ErrnoException) => {
          resolve({ ok: false, error: e?.message ?? String(e) });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ ok: false, error: 'probe timed out after 4.5s' });
        });
        req.end();
      })
      .catch((e) => resolve({ ok: false, error: String(e) }));
  });

  const result = await probe;
  if (result.ok) {
    console.log(
      `[tailscale] reachable: https://${host}:${localPort}/ — TLS handshake ok`
    );
    return;
  }

  // Failure path — emit a banner so the user can grep `[tailscale]` in the
  // log and immediately see the remediation. The exact LibreSSL/tlsv1
  // "internal error" string is what curl prints; if we see it (or any TLS-
  // shaped error), explain the tailscaled-restart fix.
  const looksLikeTlsWedge = /tls|ssl|handshake|certificate|alert/i.test(result.error ?? '');
  console.warn('');
  console.warn(`[tailscale] ⚠  TAILNET HTTPS UNREACHABLE for :${localPort}`);
  console.warn(`[tailscale]    target:    https://${host}:${localPort}/`);
  console.warn(`[tailscale]    error:     ${result.error}`);
  if (looksLikeTlsWedge) {
    console.warn(
      `[tailscale]    cause:     stale per-binding state in tailscaled's TLS layer.`
    );
    console.warn(
      `[tailscale]               TCP accepts, the cert is healthy, but this port's`
    );
    console.warn(`[tailscale]               TLS terminator can't complete a handshake.`);
    console.warn(`[tailscale]    fix:       re-publish the mapping (no sudo, no daemon restart):`);
    console.warn(`[tailscale]                 tailscale serve --https=${localPort} off`);
    console.warn(`[tailscale]                 tailscale serve --bg --https=${localPort} http://localhost:${localPort}`);
    console.warn(`[tailscale]               If that doesn't clear it, restart tailscaled:`);
    if (process.platform === 'darwin') {
      console.warn(
        `[tailscale]                 sudo launchctl kickstart -k system/com.tailscale.tailscaled`
      );
    } else {
      console.warn(`[tailscale]                 sudo systemctl restart tailscaled`);
    }
  } else {
    console.warn(
      `[tailscale]    fix:       check 'tailscale status' and 'tailscale serve status'.`
    );
  }
  console.warn('');
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

/** On berth-control boot, repair tailscale serve mappings whose Host-rewrite
 *  proxy was lost when the previous berth process died.
 *
 *  Problem this fixes: proxiesByLocalPort is an in-memory Map that doesn't
 *  survive a restart. But `tailscale serve` mappings DO survive — they
 *  live in tailscaled's persistent config. So after every berth restart,
 *  every tailnet URL berth had published was pointing at a 127.0.0.1:<port>
 *  that has no listener anymore, and the user got "connection refused" on
 *  every tailnet URL until they manually re-published each app.
 *
 *  Fix: walk the current mappings. For each one, the parsed `localPort`
 *  is the OLD proxy port. If nothing is listening there, the proxy is
 *  gone — call addServeMapping(tsPort) which spins up a fresh proxy and
 *  rewrites the tailscale serve mapping to point at it. Idempotent: if
 *  the proxy already exists (e.g. ensureHostRewriteProxy returns the
 *  cached one), addServeMapping still removes+republishes the tailscale
 *  side, which heals stale mappings from any cause. */
export async function reattachProxiesOnBoot(): Promise<void> {
  const { default: net } = await import('node:net');
  const probe = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = net.createConnection({ host: '127.0.0.1', port, timeout: 400 });
      const done = (alive: boolean) => {
        try {
          s.destroy();
        } catch {
          /* */
        }
        resolve(alive);
      };
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
      s.on('timeout', () => done(false));
    });

  let status: ServeStatus;
  try {
    status = await getServeStatus(0);
  } catch {
    return;
  }
  if (!status.available || status.mappings.length === 0) return;

  let repaired = 0;
  for (const m of status.mappings) {
    const proxyAlive = await probe(m.localPort);
    if (proxyAlive) continue;
    try {
      // addServeMapping uses m.tailscalePort as BOTH the app's listen
      // port AND the key into ensureHostRewriteProxy — that matches the
      // invariant the original addServeMapping established (see line ~88).
      await addServeMapping(m.tailscalePort);
      repaired++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `[tailscale] reattachProxiesOnBoot: failed to repair :${m.tailscalePort} → ${msg.slice(0, 200)}`
      );
    }
  }
  if (repaired > 0) {
    console.log(`[tailscale] reattachProxiesOnBoot: repaired ${repaired} mapping(s)`);
  }
}
