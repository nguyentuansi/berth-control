import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RequestHandler } from './$types.js';
import { reapDead } from '$lib/server/supervisor.js';
import { db } from '$lib/server/db/index.js';
import { events } from '$lib/server/db/schema.js';

const exec = promisify(execFile);

/** Reap orphans:
 *  1) clear stale runs whose PIDs are gone
 *  2) kill known offender patterns (workerd-from-wrangler is the usual cruft) */
export const POST: RequestHandler = async ({ locals }) => {
  reapDead();
  const patterns = ['workerd'];
  const killed: string[] = [];
  for (const pat of patterns) {
    try {
      await exec('pkill', ['-9', '-f', pat]);
      killed.push(pat);
    } catch {
      // pkill exits 1 when no matches; treat as benign.
    }
  }
  db.insert(events)
    .values({
      app_id: null,
      user_login: locals.user?.login ?? null,
      level: 'info',
      msg: `reap orphans: pkill -9 ${killed.join(', ') || '(no patterns matched)'}`
    })
    .run();
  return new Response(`Reaped. Patterns killed: ${killed.join(', ') || '(none)'}`, {
    headers: { 'content-type': 'text/plain' }
  });
};
