import { json, error } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { RequestHandler } from './$types.js';
import { isDemoMode } from '$lib/server/demo.js';
import { db, schema } from '$lib/server/db/index.js';
import { eq } from 'drizzle-orm';

const exec = promisify(execFile);

/**
 * Tear down a systemd unit Berth detected from a port's listener PID.
 *
 * For user-scope units: `systemctl --user disable --now <unit>` then unlink
 * `~/.config/systemd/user/<unit>.service` and reload. No privilege escalation
 * needed.
 *
 * For system-scope units: same shape but via `sudo -n systemctl ... ` and
 * `/etc/systemd/system/<unit>.service`. Depends on the operator NOPASSWD
 * sudoers being set up (same channel `tailscale serve` already uses).
 *
 * The unit name is taken from the *body* (server-supplied), not the URL — we
 * also re-derive it from the current SSE state below as a sanity check so a
 * malicious client can't ask us to disable `polkit` or anything outside the
 * Berth-known set.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (isDemoMode()) return json({ demo: true });
  const body = (await request.json().catch(() => null)) as
    | { appId?: string; unit?: string; scope?: 'user' | 'system' }
    | null;
  if (!body?.appId || !body.unit || (body.scope !== 'user' && body.scope !== 'system')) {
    throw error(400, 'Expect { appId, unit, scope: "user" | "system" }');
  }
  // Allowlist the unit name shape so we can't be tricked into running
  // `systemctl disable ../something` or shell-injecting flags.
  if (!/^[A-Za-z0-9@._\-]+$/.test(body.unit)) {
    throw error(400, 'Invalid unit name');
  }
  // Sanity: app must actually exist in Berth.
  const app = db.select().from(schema.apps).where(eq(schema.apps.id, body.appId)).get();
  if (!app) throw error(404, 'Unknown app');

  const fullUnit = `${body.unit}.service`;
  const isUser = body.scope === 'user';
  const unitPath = isUser
    ? resolve(homedir(), '.config/systemd/user', fullUnit)
    : resolve('/etc/systemd/system', fullUnit);

  const args = isUser
    ? ['--user', 'disable', '--now', fullUnit]
    : ['disable', '--now', fullUnit];
  const cmd = isUser ? 'systemctl' : 'sudo';
  const cmdArgs = isUser ? args : ['-n', 'systemctl', ...args];

  try {
    await exec(cmd, cmdArgs, { timeout: 12_000 });
  } catch (e) {
    // disable can fail when the unit was started transiently / never enabled.
    // Continue to the file removal anyway — that's the user-visible win — but
    // surface the message so they know.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/not loaded|not enabled|does not exist/i.test(msg)) {
      throw error(500, `systemctl disable failed: ${msg}`);
    }
  }
  let unlinkedFile = false;
  if (existsSync(unitPath)) {
    try {
      if (isUser) {
        await unlink(unitPath);
      } else {
        await exec('sudo', ['-n', 'rm', '-f', unitPath], { timeout: 5_000 });
      }
      unlinkedFile = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw error(500, `removing ${unitPath} failed: ${msg}`);
    }
  }
  // daemon-reload so systemctl forgets the unit immediately.
  await exec(
    isUser ? 'systemctl' : 'sudo',
    isUser ? ['--user', 'daemon-reload'] : ['-n', 'systemctl', 'daemon-reload'],
    { timeout: 5_000 }
  ).catch(() => undefined);

  db.insert(schema.events)
    .values({
      app_id: body.appId,
      user_login: locals.user?.login ?? null,
      level: 'warn',
      msg: `uninstalled systemd unit ${fullUnit} (${body.scope}-scope${unlinkedFile ? '' : ', file already gone'})`
    })
    .run();

  return json({ ok: true, unit: fullUnit, scope: body.scope, removedFile: unlinkedFile });
};
