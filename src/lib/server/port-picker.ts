import { db } from './db/index.js';
import { apps as appsTable } from './db/schema.js';
import { listListeners } from './prober.js';

/**
 * Pick the next sensible port for a new app:
 *
 *  1. If existing apps live under the same *project root* as `projectPath`
 *     (siblings — same parent past workspace dirs like `Development`), keep
 *     the new app contiguous with them: take `max(siblings.port) + 1` and
 *     advance until a free port is found.
 *  2. Otherwise fall back to a kind-specific range matching the conventions
 *     I see in the user's existing apps:
 *         vite/wrangler → 5170–5299
 *         bun/node      → 8200–8299
 *         python        → 8000–8099
 *         cargo         → 8500–8599
 *         gradle/java   → 8080–8179
 *         docker        → 9000–9099
 *         else (shell)  → 5170–5299
 *     Return the lowest free port in that range.
 *
 * "Free" means: not in any row's `apps.port` and not currently bound by a
 * local listener (so a port a user is hand-running on doesn't get suggested
 * and immediately clash on Start).
 *
 * Returns `null` only if every candidate range is saturated, which should
 * not happen in practice.
 */
export async function suggestPort(projectPath: string, kind: string): Promise<number | null> {
  const used = await collectUsedPorts();
  const myRoot = projectRoot(projectPath);

  if (myRoot) {
    const siblingPorts = db
      .select()
      .from(appsTable)
      .all()
      .filter((a) => a.port != null && a.project_path && projectRoot(a.project_path) === myRoot)
      .map((a) => a.port!) as number[];

    if (siblingPorts.length > 0) {
      // Group consecutive-ish siblings into clusters (gap ≤ 20). For e.g.
      // my-monorepo (13 apps at 2300-2312 plus one stray at 7784) we
      // want to append to the dense 2300s cluster, not after the outlier.
      const bestCluster = densestCluster(siblingPorts);
      const start = Math.max(...bestCluster) + 1;
      for (let p = start; p < start + 60; p++) {
        if (isPickable(p, used)) return p;
      }
      // Cluster is wedged — also try just below it.
      const low = Math.min(...bestCluster);
      for (let p = low - 1; p >= Math.max(1024, low - 30); p--) {
        if (isPickable(p, used)) return p;
      }
      // Fall through to the kind range.
    }
  }

  const [lo, hi] = defaultRangeForKind(kind);
  for (let p = lo; p <= hi; p++) {
    if (isPickable(p, used)) return p;
  }
  return null;
}

async function collectUsedPorts(): Promise<Set<number>> {
  const used = new Set<number>();
  for (const a of db.select().from(appsTable).all()) {
    if (a.port != null) used.add(a.port);
  }
  for (const l of await listListeners()) {
    if (l.isLocal) used.add(l.port);
  }
  return used;
}

/** Largest contiguous-ish cluster of ports (gap ≤ 20 between neighbours).
 *  Ties broken by higher max port — the more "active" range. */
function densestCluster(ports: number[]): number[] {
  const sorted = [...ports].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let current: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= 20) current.push(sorted[i]);
    else {
      clusters.push(current);
      current = [sorted[i]];
    }
  }
  clusters.push(current);
  clusters.sort(
    (a, b) => b.length - a.length || b[b.length - 1] - a[a.length - 1]
  );
  return clusters[0];
}

function isPickable(port: number, used: Set<number>): boolean {
  if (port < 1024 || port > 65535) return false;
  if (used.has(port)) return false;
  // Skip a few well-known service ports even if they're free right now, so
  // a future Postgres/Redis/etc. installation doesn't collide with the app.
  return !WELL_KNOWN.has(port);
}

// Common service ports inside the dev ranges we propose. Padded with a few
// SQL/cache/queue defaults so suggestions don't land on them.
const WELL_KNOWN = new Set<number>([
  3000, 3001, 3306, 4000, 4200, 5000, 5432, 5984, 6379, 6443,
  8000, 8080, 8081, 8443, 9092, 9200, 9300, 11211, 27017
]);

/**
 * Identify the "project root" for a path — the segment immediately past the
 * user's workspace containers (Development, Work, etc.). For
 * `~/Development/sample-monorepo/apps/x` this returns `/home/<user>/Development/sample-monorepo`;
 * for `~/Development/brokr` it returns the same.
 */
function projectRoot(path: string): string {
  const segs = path.replace(/[\\/]+$/, '').split('/').filter(Boolean);
  const SKIPS = new Set([
    'home', 'Development', 'Work', 'Projects', 'Code', 'repos',
    'src', 'opt', 'usr', 'var'
  ]);
  let i = 0;
  while (i < segs.length && (SKIPS.has(segs[i]) || (i === 1 && segs[0] === 'home'))) i++;
  if (i >= segs.length) return '';
  return '/' + segs.slice(0, i + 1).join('/');
}

function defaultRangeForKind(kind: string): [number, number] {
  switch (kind) {
    case 'vite':
    case 'wrangler':
      return [5170, 5299];
    case 'bun':
    case 'node':
      return [8200, 8299];
    case 'python':
      return [8000, 8099];
    case 'cargo':
      return [8500, 8599];
    case 'gradle':
    case 'java':
      return [8100, 8179];
    case 'docker':
      return [9000, 9099];
    case 'shell':
    default:
      return [5170, 5299];
  }
}
