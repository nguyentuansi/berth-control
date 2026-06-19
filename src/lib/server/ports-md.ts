import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { db, schema } from './db/index.js';
import { events } from './db/schema.js';

// Berth optionally bootstraps its registry from a PORTS.md file. Point it at
// your own table with the `HARBORCTL_PORTS_MD` env var; default is `~/PORTS.md`.
// (If neither exists, Berth starts with an empty registry — add apps via the UI.)
const DEFAULT_PORTS_MD =
  process.env.HARBORCTL_PORTS_MD ?? resolve(homedir(), 'PORTS.md');

export interface PortsMdRow {
  id: string;
  name: string;
  project_path: string;
  port: number | null;
  kind: string;
  notes: string | null;
  tailscale: boolean;
}

/** Best-effort guess of the run kind from the project path / notes. */
function guessKind(projectPath: string, notes: string): string {
  const n = notes.toLowerCase();
  const p = projectPath.toLowerCase();
  if (n.includes('wrangler') || n.includes('workerd')) return 'wrangler';
  if (n.includes('vite')) return 'vite';
  if (n.includes('uvicorn') || n.includes('fastapi') || n.includes('python')) return 'python';
  if (n.includes('bun')) return 'bun';
  if (n.includes('node')) return 'node';
  if (n.includes('socket.io') || n.includes('express')) return 'node';
  if (p.includes('cargo') || p.endsWith('.rs')) return 'cargo';
  return 'shell';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function expand(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

/** Strip the trailing "(apps/foo)" annotation some monorepo anchor rows carry,
 *  and capture the hint so siblings can be resolved against the same root.
 *  E.g. "~/Work/acme/platform (apps/api)" → root = "~/Work/acme/platform"
 *       remainder = "apps/api" */
function splitAnchor(raw: string): { root: string; hint: string | null } {
  const m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (m) return { root: m[1].trim(), hint: m[2].trim() };
  return { root: raw.trim(), hint: null };
}

/** Parse the markdown table rows out of PORTS.md. */
export function parsePortsMd(filePath = DEFAULT_PORTS_MD): PortsMdRow[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  const rows: PortsMdRow[] = [];
  // Anchor map: name-prefix (e.g. "acme") → most recently-seen absolute root.
  // When a sibling row has a relative path like "apps/foo", we resolve against it.
  const anchorByPrefix: Record<string, string> = {};
  for (const line of lines) {
    // Match the table-row shape: | port | project | path | proto | tailscale | systemd | notes |
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // Leading | gives empty first cell; trailing | gives empty last.
    if (cells.length < 8) continue;
    const portCell = cells[1];
    const projectCell = cells[2];
    const pathCell = cells[3];
    const tailscaleCell = cells[5] ?? '';
    const notesCell = cells[7] ?? '';
    // Skip header / separator / non-numeric port lines.
    const port = Number(portCell);
    if (!Number.isFinite(port) || port <= 0) continue;
    if (!projectCell || projectCell === 'Project') continue;
    const name = projectCell;
    // Take everything before ':' as the project prefix ("acme: api" → "acme").
    const prefix = name.split(':')[0].trim().toLowerCase();
    const { root, hint } = splitAnchor(pathCell || '');
    const expandedRoot = expand(root);
    let project_path: string;
    if (expandedRoot.startsWith('/')) {
      // Absolute → use as-is; if there was a (apps/foo) hint AND that subdir
      // exists, prefer the subdir as the actual project path.
      if (hint && existsSync(resolve(expandedRoot, hint))) {
        project_path = resolve(expandedRoot, hint);
      } else {
        project_path = expandedRoot;
      }
      // Record this absolute root as the anchor for siblings.
      anchorByPrefix[prefix] = expandedRoot;
    } else if (anchorByPrefix[prefix]) {
      // Relative + we've seen an anchor for this prefix → resolve against it.
      project_path = resolve(anchorByPrefix[prefix], expandedRoot);
    } else {
      // Relative + no anchor → leave it (will be flagged by existsSync downstream).
      project_path = expandedRoot;
    }
    rows.push({
      id: slugify(name) || `port-${port}`,
      name,
      project_path,
      port,
      kind: guessKind(project_path, notesCell),
      notes: notesCell || null,
      tailscale: /yes/i.test(tailscaleCell)
    });
  }
  return rows;
}

/** Import PORTS.md rows into the `apps` table; updates name/path/port/notes,
 *  preserves user-edited start_cmd / kind overrides if already set. */
export function importPortsMd(filePath = DEFAULT_PORTS_MD): {
  inserted: number;
  updated: number;
  total: number;
  source: string;
} {
  const rows = parsePortsMd(filePath);
  let inserted = 0;
  let updated = 0;
  const now = new Date();
  const get = db.$client.prepare('SELECT id, start_cmd, kind FROM apps WHERE id = ?');
  const ins = db.$client.prepare(
    `INSERT INTO apps (id, name, project_path, port, kind, notes, hidden, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  );
  const upd = db.$client.prepare(
    `UPDATE apps SET name = ?, project_path = ?, port = ?, notes = ?, updated_at = ? WHERE id = ?`
  );
  const tx = db.$client.transaction((rs: PortsMdRow[]) => {
    for (const r of rs) {
      const existing = get.get(r.id) as { id: string } | undefined;
      if (existing) {
        upd.run(r.name, r.project_path, r.port, r.notes, now.getTime(), r.id);
        updated++;
      } else {
        ins.run(r.id, r.name, r.project_path, r.port, r.kind, r.notes, now.getTime(), now.getTime());
        inserted++;
      }
    }
  });
  tx(rows);
  db.insert(events)
    .values({
      app_id: null,
      level: 'info',
      msg: `ports-md import: ${inserted} new, ${updated} updated (${rows.length} rows from ${filePath})`
    })
    .run();
  return { inserted, updated, total: rows.length, source: filePath };
}
