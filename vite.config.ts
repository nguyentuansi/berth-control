import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Allow Berth to be reached from custom hostnames (LAN, reverse proxies, etc).
// `.ts.net` is always permitted because that's Tailscale's universal TLD —
// every tailnet lives under it (e.g. `your-machine.tailXXXXX.ts.net`), so
// allowing the suffix covers Tailscale users out of the box without leaking
// any particular user's tailnet name into the source.
// Add more via BERTH_CONTROL_ALLOWED_HOSTS="foo.local,.example.com" (comma-separated;
// leading dot matches any subdomain).
const extraHosts = (process.env.BERTH_CONTROL_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: Number(process.env.BERTH_CONTROL_PORT ?? 5202),
    strictPort: true,
    host: process.env.BERTH_CONTROL_HOST ?? '127.0.0.1',
    allowedHosts: ['localhost', '127.0.0.1', '.ts.net', ...extraHosts]
  },
  // better-sqlite3 is a native module — keep Vite from bundling it.
  optimizeDeps: { exclude: ['better-sqlite3'] },
  ssr: { external: ['better-sqlite3'] }
});
