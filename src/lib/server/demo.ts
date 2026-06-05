// Demo mode — believable-but-fictional content used for marketing screenshots.
//
// Activate with BERTH_DEMO=1 (typically alongside BERTH_DB=./demo.db so it
// can't touch your real registry). When on:
//   • PORTS.md is NOT auto-imported on boot.
//   • The process supervisor doesn't try to re-attach to PIDs at startup.
//   • /api/state returns a canned snapshot instead of probing `ss -tlnp`.
//   • Start/stop endpoints succeed without actually spawning anything.
//
// Seed the matching app rows via `bun run demo:seed` (see scripts/seed-demo.ts).

export function isDemoMode(): boolean {
  return process.env.BERTH_DEMO === '1' || process.env.BERTH_DEMO === 'true';
}

export interface DemoApp {
  id: string;
  name: string;
  project_path: string;
  port: number | null;
  kind: string;
  start_cmd: string | null;
  group_tag: string;
  notes: string | null;
}

export const DEMO_TAILSCALE_HOST = 'demo-laptop.tail42a1b.ts.net';

/** The fake apps seeded into the demo database. Names + paths are obviously
 *  fictional; the mix is chosen to show every feature in one screenshot. */
export const DEMO_APPS: DemoApp[] = [
  // acme/marketing — a brand surface group
  {
    id: 'marketing-site',
    name: 'marketing site',
    project_path: '~/Work/acme/marketing/site',
    port: 3000,
    kind: 'vite',
    start_cmd: 'bun run dev',
    group_tag: 'acme/marketing',
    notes: 'Next.js landing. Funneled to share with stakeholders.'
  },
  {
    id: 'marketing-blog',
    name: 'blog',
    project_path: '~/Work/acme/marketing/blog',
    port: 3001,
    kind: 'vite',
    start_cmd: 'bun run dev',
    group_tag: 'acme/marketing',
    notes: 'Astro blog. MDX content.'
  },
  {
    id: 'marketing-docs',
    name: 'docs',
    project_path: '~/Work/acme/marketing/docs',
    port: 3002,
    kind: 'vite',
    start_cmd: 'bun run dev',
    group_tag: 'acme/marketing',
    notes: 'Public API docs.'
  },

  // acme/platform — the product surface group
  {
    id: 'platform-api',
    name: 'api',
    project_path: '~/Work/acme/platform/api',
    port: 4000,
    kind: 'bun',
    start_cmd: 'bun run dev',
    group_tag: 'acme/platform',
    notes: 'Hono + Drizzle. Healthcheck at /healthz.'
  },
  {
    id: 'platform-dashboard',
    name: 'dashboard',
    project_path: '~/Work/acme/platform/dashboard',
    port: 3100,
    kind: 'vite',
    start_cmd: 'bun run dev',
    group_tag: 'acme/platform',
    notes: 'Customer-facing SvelteKit app.'
  },
  {
    id: 'platform-admin',
    name: 'admin',
    project_path: '~/Work/acme/platform/admin',
    port: 3101,
    kind: 'vite',
    start_cmd: 'bun run dev',
    group_tag: 'acme/platform',
    notes: 'Internal admin. Restricted to tailnet.'
  },
  {
    id: 'platform-jobs',
    name: 'jobs worker',
    project_path: '~/Work/acme/platform/jobs',
    port: 4200,
    kind: 'node',
    start_cmd: 'bun run worker',
    group_tag: 'acme/platform',
    notes: 'BullMQ background queue.'
  },
  {
    id: 'platform-gateway',
    name: 'gateway',
    project_path: '~/Work/acme/platform/gateway',
    port: 4100,
    kind: 'bun',
    start_cmd: 'bun run dev',
    group_tag: 'acme/platform',
    notes: 'Edge router. Used to be flaky; watch crash count.'
  },

  // acme/data — local databases
  {
    id: 'data-postgres',
    name: 'postgres',
    project_path: '~/Work/acme/infra/databases',
    port: 5432,
    kind: 'docker',
    start_cmd: 'docker compose up postgres',
    group_tag: 'acme/data',
    notes: 'Local replica of staging.'
  },
  {
    id: 'data-redis',
    name: 'redis',
    project_path: '~/Work/acme/infra/databases',
    port: 6379,
    kind: 'docker',
    start_cmd: 'docker compose up redis',
    group_tag: 'acme/data',
    notes: 'Used by jobs + sessions.'
  },
  {
    id: 'data-clickhouse',
    name: 'clickhouse',
    project_path: '~/Work/acme/infra/databases',
    port: 8123,
    kind: 'docker',
    start_cmd: 'docker compose up clickhouse',
    group_tag: 'acme/data',
    notes: 'Analytics warehouse copy.'
  },

  // playground — experimental side stuff
  {
    id: 'play-llm-sandbox',
    name: 'llm sandbox',
    project_path: '~/Code/playground/llm-sandbox',
    port: 5000,
    kind: 'python',
    start_cmd: 'uvicorn main:app --port 5000',
    group_tag: 'playground',
    notes: 'Prompt experiments + eval harness.'
  },
  {
    id: 'play-vector-store',
    name: 'vector store demo',
    project_path: '~/Code/playground/vector-store',
    port: 5001,
    kind: 'python',
    start_cmd: 'python -m vectorstore',
    group_tag: 'playground',
    notes: 'Embeddings reproduction.'
  },
  {
    id: 'play-storybook',
    name: 'storybook',
    project_path: '~/Code/playground/ui-lab',
    port: 6006,
    kind: 'vite',
    start_cmd: 'bun run storybook',
    group_tag: 'playground',
    notes: 'Component library sandbox.'
  }
];

export interface DemoStatus {
  up: boolean;
  listenerPid: number | null;
  listenerCmd: string | null;
  managedPid: number | null;
  managedSinceAgoSec: number | null;
  tailscale: { port: number; funnel: boolean } | null;
  healthOk: boolean | null;
  latencyMs: number | null;
}

/** Hand-tuned live state for each demo app. The mix exercises every feature:
 *   • managed (Berth-supervised) vs external pids
 *   • tailnet vs no-tailnet
 *   • funnel (publicly served) for one row
 *   • stale tailscale mapping (up=false + tailscale set → "· 502" pill)
 *   • a few down apps to show the configure/start affordance
 *   • healthcheck latency badges in a realistic range */
export const DEMO_STATE: Record<string, DemoStatus> = {
  'marketing-site': {
    up: true,
    listenerPid: 11021,
    listenerCmd: 'node',
    managedPid: 11021,
    managedSinceAgoSec: 7280,
    tailscale: { port: 3000, funnel: true },     // publicly funneled
    healthOk: true,
    latencyMs: 38
  },
  'marketing-blog': {
    up: true,
    listenerPid: 11102,
    listenerCmd: 'node',
    managedPid: null,                              // running but not Berth-spawned
    managedSinceAgoSec: null,
    tailscale: { port: 3001, funnel: false },
    healthOk: true,
    latencyMs: 22
  },
  'marketing-docs': {
    up: false,
    listenerPid: null,
    listenerCmd: null,
    managedPid: null,
    managedSinceAgoSec: null,
    tailscale: null,
    healthOk: null,
    latencyMs: null
  },

  'platform-api': {
    up: true,
    listenerPid: 21001,
    listenerCmd: 'bun',
    managedPid: 21001,
    managedSinceAgoSec: 14_540,
    tailscale: { port: 4000, funnel: false },
    healthOk: true,
    latencyMs: 47
  },
  'platform-dashboard': {
    up: true,
    listenerPid: 21044,
    listenerCmd: 'node',
    managedPid: 21044,
    managedSinceAgoSec: 12_910,
    tailscale: { port: 3100, funnel: false },
    healthOk: true,
    latencyMs: 64
  },
  'platform-admin': {
    up: true,
    listenerPid: 21088,
    listenerCmd: 'node',
    managedPid: 21088,
    managedSinceAgoSec: 12_900,
    tailscale: { port: 3101, funnel: false },
    healthOk: true,
    latencyMs: 71
  },
  'platform-jobs': {
    up: true,
    listenerPid: 21133,
    listenerCmd: 'node',
    managedPid: null,                              // external
    managedSinceAgoSec: null,
    tailscale: null,
    healthOk: null,                                // no healthcheck URL
    latencyMs: null
  },
  'platform-gateway': {
    up: false,                                     // stale tailnet mapping → "502"
    listenerPid: null,
    listenerCmd: null,
    managedPid: null,
    managedSinceAgoSec: null,
    tailscale: { port: 4100, funnel: false },
    healthOk: null,
    latencyMs: null
  },

  'data-postgres': {
    up: true,
    listenerPid: 30401,
    listenerCmd: 'postgres',
    managedPid: null,
    managedSinceAgoSec: null,
    tailscale: null,
    healthOk: true,
    latencyMs: 4
  },
  'data-redis': {
    up: true,
    listenerPid: 30402,
    listenerCmd: 'redis-server',
    managedPid: null,
    managedSinceAgoSec: null,
    tailscale: null,
    healthOk: true,
    latencyMs: 2
  },
  'data-clickhouse': {
    up: true,
    listenerPid: 30403,
    listenerCmd: 'clickhouse',
    managedPid: null,
    managedSinceAgoSec: null,
    tailscale: { port: 8123, funnel: false },
    healthOk: true,
    latencyMs: 11
  },

  'play-llm-sandbox': {
    up: false,
    listenerPid: null,
    listenerCmd: null,
    managedPid: null,
    managedSinceAgoSec: null,
    tailscale: null,
    healthOk: null,
    latencyMs: null
  },
  'play-vector-store': {
    up: false,
    listenerPid: null,
    listenerCmd: null,
    managedPid: null,
    managedSinceAgoSec: null,
    tailscale: null,
    healthOk: null,
    latencyMs: null
  },
  'play-storybook': {
    up: true,
    listenerPid: 40004,
    listenerCmd: 'node',
    managedPid: 40004,
    managedSinceAgoSec: 540,
    tailscale: { port: 6006, funnel: false },
    healthOk: true,
    latencyMs: 91
  }
};
