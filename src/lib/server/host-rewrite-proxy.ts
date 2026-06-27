import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';

// Tiny HTTP + WebSocket reverse proxy that rewrites the inbound `Host`
// header to a loopback value before forwarding to the dev server.
//
// Why this exists
// ---------------
// Vite (and most other dev runners) ship with an `allowedHosts` check —
// requests carrying a `Host:` header that isn't loopback get a 403. When
// `tailscale serve` forwards a tailnet URL (e.g. `foo.tail123.ts.net`)
// directly to the dev server, vite sees that tailnet hostname and rejects.
//
// The historical "fix" was to modify the user's `vite.config.ts` and
// inject `allowedHosts: ['.ts.net', ...]`. That mutates user repos —
// invasive, surprising in PRs, and prone to duplicating keys when the
// repo already configures `allowedHosts`. The user has hundreds of repos
// and reasonably refuses to change them all.
//
// This module flips the architecture: berth-control runs a per-app proxy
// on its own port. `tailscale serve` is pointed at the proxy. The proxy
// rewrites `Host:` to `localhost:<devPort>` (vite's check passes) and
// forwards. The user's repo never gets touched.
//
// Coverage
// --------
// - HTTP request/response — full streaming pipe both ways.
// - HTTP upgrade (vite HMR over WebSocket) — raw TCP socket bridge with
//   the request line rebuilt and the Host header rewritten before forward.
// - Connection lifecycle errors — silently destroy both ends; never
//   crashes berth-control's main process.
//
// What this proxy intentionally does NOT do
// ----------------------------------------
// - TLS termination — that's tailscaled's job on the tailnet side. The
//   proxy only handles plain HTTP between tailscaled and the dev server.
// - Path rewriting / virtual hosting — one proxy per dev port.
// - Header sanitization beyond Host — the dev server still sees the
//   original `X-Forwarded-For`, cookies, auth headers, etc.

export interface ProxyOptions {
  /** Destination host — almost always '127.0.0.1' for a local dev server. */
  targetHost: string;
  /** Destination port — the dev server's loopback port. */
  targetPort: number;
  /** Host header to inject downstream. Default: `localhost:<targetPort>`. */
  rewriteHost?: string;
}

export class HostRewriteProxy {
  private server: ReturnType<typeof createServer> | null = null;
  private listenPort: number = 0;
  private rewriteHost: string;

  constructor(private opts: ProxyOptions) {
    this.rewriteHost = opts.rewriteHost ?? `localhost:${opts.targetPort}`;
  }

  /** Start listening on an OS-assigned loopback port. Returns the port. */
  async start(): Promise<number> {
    this.server = createServer((req, res) => this.handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
    // A bare 'error' listener on the server itself keeps EADDRINUSE / EACCES
    // from crashing the main process when something is squatting on an
    // ephemeral port we picked.
    this.server.on('error', () => {});

    return new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.removeListener('error', onError);
        const addr = this.server!.address();
        if (typeof addr === 'object' && addr) {
          this.listenPort = addr.port;
          resolve(this.listenPort);
        } else {
          reject(new Error('listen returned unexpected address shape'));
        }
      };
      this.server!.once('error', onError);
      this.server!.once('listening', onListening);
      this.server!.listen(0, '127.0.0.1');
    });
  }

  /** Stop the proxy and free its port. Idempotent. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** The port the proxy is currently listening on. 0 before `start()`. */
  get port(): number {
    return this.listenPort;
  }

  // HTTP request handling — pipe the request body to the upstream, pipe the
  // response back, never buffer. Same memory profile regardless of payload
  // size.
  //
  // `family: 0` + `autoSelectFamily: true` makes node do happy-eyeballs on
  // the upstream connection. Many dev runners (vite, wrangler) bind only
  // IPv6 loopback `[::1]` when the config says `host: '127.0.0.1'`; the
  // hostname `'localhost'` resolves to both v4 and v6 and node picks the
  // one that actually answers. Without this, a IPv6-only-bound dev server
  // gets a 502 from the proxy.
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const headers = { ...req.headers };
    headers.host = this.rewriteHost;

    const proxyReq = httpRequest(
      {
        host: this.opts.targetHost,
        port: this.opts.targetPort,
        method: req.method,
        path: req.url,
        headers,
        family: 0,
        autoSelectFamily: true
      },
      (proxyRes) => {
        // Strip the framework-level transfer-encoding / content-length
        // tug-of-war by writing only what we got from upstream.
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', () => {
      // Common cases: ECONNREFUSED (dev server still booting), ECONNRESET
      // (vite restarted mid-request). 502 keeps the proxy alive for the
      // next request.
      if (!res.headersSent) {
        try {
          res.writeHead(502);
          res.end();
        } catch {
          /* connection was closed */
        }
      }
    });

    // Client cancellation — abort the upstream request so we don't leak
    // sockets if the browser navigated away mid-load.
    req.on('aborted', () => proxyReq.destroy());

    req.pipe(proxyReq);
  }

  // WebSocket / HTTP upgrade handling — we need to relay the upgrade
  // handshake AND the bidirectional byte stream that follows. Node's http
  // module won't do this for us; we hand-write the upstream socket.
  private handleUpgrade(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
    // Sanity: vite's HMR upgrade arrives without ever sending a response,
    // so clientSocket may have buffered head data we need to include.
    const targetSocket = new Socket();

    const cleanup = () => {
      try { targetSocket.destroy(); } catch { /* */ }
      try { clientSocket.destroy(); } catch { /* */ }
    };
    targetSocket.on('error', cleanup);
    clientSocket.on('error', cleanup);

    // Same happy-eyeballs reasoning as handleHttp — vite HMR is over WS,
    // and a IPv6-only-bound dev server would otherwise refuse our v4 dial.
    targetSocket.connect({
      host: this.opts.targetHost,
      port: this.opts.targetPort,
      family: 0,
      autoSelectFamily: true
    }, () => {
      // Rebuild the request line + headers with Host rewritten.
      const headers = { ...req.headers };
      headers.host = this.rewriteHost;
      const httpVer = req.httpVersion || '1.1';
      const lines: string[] = [`${req.method} ${req.url} HTTP/${httpVer}`];
      for (const [k, v] of Object.entries(headers)) {
        if (v == null) continue;
        if (Array.isArray(v)) {
          for (const single of v) lines.push(`${k}: ${single}`);
        } else {
          lines.push(`${k}: ${v}`);
        }
      }
      lines.push('', '');
      targetSocket.write(lines.join('\r\n'));
      if (head.length > 0) targetSocket.write(head);
      // After the handshake, both directions of the byte stream are
      // shuffled raw.
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
  }
}

// Module-level registry. The supervisor / tailscale-serve module stops the
// proxy when the matching mapping is removed; we keep the lookup here so
// the rest of berth-control never has to thread proxy handles around.
const proxiesByLocalPort = new Map<number, HostRewriteProxy>();

/** Get or create a proxy that rewrites Host → loopback for `devPort`.
 *  Returns the proxy's listen port. Subsequent calls for the same devPort
 *  return the existing proxy (idempotent). */
export async function ensureHostRewriteProxy(devPort: number): Promise<number> {
  const existing = proxiesByLocalPort.get(devPort);
  if (existing) return existing.port;
  // `localhost` (not `127.0.0.1`) so DNS returns both 127.0.0.1 and ::1;
  // combined with the http.request `family: 0` + autoSelectFamily inside
  // the proxy, node picks whichever the dev server actually bound. Vite
  // and several other runners bind ONLY [::1] when their config says
  // `host: '127.0.0.1'` — without this we'd 502.
  const proxy = new HostRewriteProxy({ targetHost: 'localhost', targetPort: devPort });
  const port = await proxy.start();
  proxiesByLocalPort.set(devPort, proxy);
  return port;
}

/** Stop the proxy associated with `devPort` if one exists. No-op otherwise. */
export async function stopHostRewriteProxy(devPort: number): Promise<void> {
  const p = proxiesByLocalPort.get(devPort);
  if (!p) return;
  proxiesByLocalPort.delete(devPort);
  await p.stop();
}

/** Diagnostic — list every (devPort, proxyPort) pair currently running. */
export function listHostRewriteProxies(): Array<{ devPort: number; proxyPort: number }> {
  return Array.from(proxiesByLocalPort.entries()).map(([devPort, p]) => ({
    devPort,
    proxyPort: p.port
  }));
}
