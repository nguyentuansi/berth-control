// Truth test for the Host-rewrite proxy:
//   1. Spin up a "fake vite" that rejects any non-loopback Host header (the
//      precise behavior real vite has when `allowedHosts` is its default).
//   2. Hit it DIRECTLY with a tailnet-style Host → must 403.
//   3. Spin up HostRewriteProxy in front, hit it via the proxy with the same
//      tailnet Host → must 200 and the body must show the rewritten Host.
//
// If either step fails, Approach A is broken and we'd be back to needing the
// vite-config-patcher.

import { createServer, request as httpRequest } from 'node:http';
import { HostRewriteProxy } from '../src/lib/server/host-rewrite-proxy.js';

interface Response { status: number; body: string }

function get(port: number, path: string, hostHeader: string): Promise<Response> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

const fakeVite = createServer((req, res) => {
  const host = req.headers.host ?? '';
  const isLoopback = host.startsWith('localhost:') || host.startsWith('127.0.0.1:');
  if (!isLoopback) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end(`forbidden: Host '${host}' not in allowedHosts`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`ok from fake-vite, Host=${host}, url=${req.url}`);
});
const devPort = await new Promise<number>((r) =>
  fakeVite.listen(0, '127.0.0.1', () => r((fakeVite.address() as { port: number }).port))
);
console.log(`fake-vite listening on 127.0.0.1:${devPort}`);

const direct = await get(devPort, '/', 'example-host.tailfake1234.ts.net');
console.log(`[direct ]  status=${direct.status}  body="${direct.body}"`);

const proxy = new HostRewriteProxy({ targetHost: '127.0.0.1', targetPort: devPort });
const proxyPort = await proxy.start();
console.log(`proxy listening on 127.0.0.1:${proxyPort} → 127.0.0.1:${devPort}`);

const proxied = await get(proxyPort, '/hello', 'example-host.tailfake1234.ts.net');
console.log(`[proxied]  status=${proxied.status}  body="${proxied.body}"`);

await proxy.stop();
fakeVite.close();

const ok =
  direct.status === 403 &&
  proxied.status === 200 &&
  proxied.body.includes(`localhost:${devPort}`);

console.log();
console.log(
  ok
    ? '✓ PROXY WORKS — direct blocked (403), proxied accepted (200) with Host rewritten to localhost'
    : '✗ FAILED'
);
process.exit(ok ? 0 : 1);
