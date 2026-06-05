import type { RequestEvent } from '@sveltejs/kit';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';

/**
 * Resolve the requesting user from Tailscale serve identity headers.
 *
 *   `Tailscale-User-Login`  — email-style login (e.g. you@example.com)
 *   `Tailscale-User-Name`   — display name
 *
 * We trust these ONLY when the request arrived via loopback (which means it
 * passed through `tailscale serve`, the only thing on the box that adds them).
 * Direct non-loopback requests are rejected at the hook layer.
 *
 * First visitor wins: if the users table is empty, they're promoted to admin.
 */
export function identify(event: RequestEvent): App.Locals['user'] {
  const login = event.request.headers.get('tailscale-user-login') ?? '';
  if (!login) {
    // Local-only fallback: when hitting Berth directly on 127.0.0.1 (e.g. from
    // a terminal on the same box), trust the OS user. Tailscale headers are
    // absent in that path because serve isn't involved.
    if (isLoopback(event)) {
      const osUser = process.env.USER ?? 'local';
      return upsertUser(`${osUser}@localhost`);
    }
    return null;
  }
  return upsertUser(login);
}

function upsertUser(login: string): App.Locals['user'] {
  const existing = db.select().from(users).where(eq(users.login, login)).get();
  const countRow = db.$client.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (!existing) {
    const role: 'admin' | 'viewer' = countRow.c === 0 ? 'admin' : 'viewer';
    db.insert(users)
      .values({ login, role, last_seen: new Date() })
      .run();
    return { login, role };
  }
  // Self-heal: if there are zero admins, promote whoever is hitting Berth now.
  const adminRow = db.$client.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get() as {
    c: number;
  };
  let role = existing.role as 'admin' | 'viewer';
  if (adminRow.c === 0) {
    db.update(users).set({ role: 'admin' }).where(eq(users.login, login)).run();
    role = 'admin';
  }
  db.update(users).set({ last_seen: new Date() }).where(eq(users.login, login)).run();
  return { login, role };
}

export function isLoopback(event: RequestEvent): boolean {
  const fwd = event.request.headers.get('x-forwarded-for') ?? '';
  const ra = event.getClientAddress?.() ?? '';
  const loopback = (ip: string) =>
    ip === '127.0.0.1' || ip === '::1' || ip.startsWith('::ffff:127.');
  if (loopback(ra)) return true;
  for (const part of fwd.split(',')) {
    if (loopback(part.trim())) return true;
  }
  return false;
}
