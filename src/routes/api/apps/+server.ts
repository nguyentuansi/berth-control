import { json, error } from '@sveltejs/kit';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { db, schema } from '$lib/server/db/index.js';
import { suggestStartCmd } from '$lib/server/start-cmd-suggester.js';
import { suggestPort } from '$lib/server/port-picker.js';
import { isDemoMode } from '$lib/server/demo.js';

/** Detect what kind of project a directory holds by the presence of marker
 *  files. Matches the discriminator used in `apps.kind`. */
function sniffKind(path: string): string {
  if (existsSync(resolve(path, 'wrangler.toml')) || existsSync(resolve(path, 'wrangler.jsonc'))) {
    return 'wrangler';
  }
  if (existsSync(resolve(path, 'vite.config.ts')) || existsSync(resolve(path, 'vite.config.js'))) {
    return 'vite';
  }
  if (existsSync(resolve(path, 'bun.lock')) || existsSync(resolve(path, 'bunfig.toml'))) {
    return 'bun';
  }
  if (existsSync(resolve(path, 'Cargo.toml'))) return 'cargo';
  if (existsSync(resolve(path, 'gradlew')) || existsSync(resolve(path, 'build.gradle'))) {
    return 'gradle';
  }
  if (existsSync(resolve(path, 'pom.xml'))) return 'java';
  if (existsSync(resolve(path, 'package.json'))) return 'node';
  if (existsSync(resolve(path, 'docker-compose.yml')) || existsSync(resolve(path, 'Dockerfile'))) {
    return 'docker';
  }
  if (
    existsSync(resolve(path, 'requirements.txt')) ||
    existsSync(resolve(path, 'pyproject.toml')) ||
    existsSync(resolve(path, 'main.py'))
  ) {
    return 'python';
  }
  return 'shell';
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'app'
  );
}

/** Sniff a path — used by the Add modal to prefill form fields before the
 *  user commits. No DB writes. Path must exist + be a directory. */
export const GET: RequestHandler = async ({ url }) => {
  const path = url.searchParams.get('path');
  if (!path) throw error(400, 'path query param required');
  const abs = resolve(path);
  if (!existsSync(abs)) throw error(404, `${abs} does not exist`);
  if (!statSync(abs).isDirectory()) throw error(400, `${abs} is not a directory`);
  const kind = sniffKind(abs);
  const name = basename(abs);
  const port = await suggestPort(abs, kind);
  // Re-suggest start_cmd now that we have a port — kind-based vite/wrangler
  // fallbacks bake the port into the command string.
  const cmd = suggestStartCmd(abs, port, kind);
  return json({
    path: abs,
    name,
    kind,
    port,
    start_cmd: cmd?.cmd ?? null,
    start_cmd_reason: cmd?.reason ?? null
  });
};

interface CreateBody {
  project_path?: string;
  name?: string;
  port?: number | null;
  kind?: string;
  start_cmd?: string | null;
  group_tag?: string | null;
  healthcheck_url?: string | null;
}

/** Register a new app. Path must exist; name and id are derived from the
 *  body, with a collision-safe slug for the id. */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (isDemoMode()) throw error(403, 'demo mode is read-only');
  const body = (await request.json().catch(() => null)) as CreateBody | null;
  if (!body?.project_path || !body.name) {
    throw error(400, 'project_path and name are required');
  }
  const abs = resolve(body.project_path);
  if (!existsSync(abs)) throw error(400, `${abs} does not exist`);
  if (!statSync(abs).isDirectory()) throw error(400, `${abs} is not a directory`);

  // Pick an id from the slugified name; if it collides, append -2, -3, ...
  const base = slugify(body.name);
  let id = base;
  let n = 2;
  while (db.select().from(schema.apps).where(eq(schema.apps.id, id)).get()) {
    id = `${base}-${n++}`;
    if (n > 999) throw error(500, 'could not allocate a unique id');
  }
  const kind = body.kind ?? sniffKind(abs);
  let port = body.port != null ? Math.floor(Number(body.port)) : null;
  if (port != null && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    throw error(400, 'port must be 1..65535');
  }
  // No port given → ask the picker. Keeps the row immediately useful for the
  // dashboard's listener-matching, uptime tracking, and tailnet ops.
  if (port == null) {
    port = await suggestPort(abs, kind);
  }
  db.insert(schema.apps)
    .values({
      id,
      name: body.name,
      project_path: abs,
      port,
      kind,
      start_cmd: body.start_cmd ?? null,
      group_tag: body.group_tag ?? null,
      healthcheck_url: body.healthcheck_url ?? null,
      hidden: false
    })
    .run();
  db.insert(schema.events)
    .values({
      app_id: id,
      user_login: locals.user?.login ?? null,
      level: 'info',
      msg: `registered app from ${abs}`
    })
    .run();
  const row = db.select().from(schema.apps).where(eq(schema.apps.id, id)).get();
  return json({ app: row });
};
