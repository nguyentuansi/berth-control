// Recovered from build/server/chunks/auth-Dm_3AJ02.js (the last successful
// build before this file was lost from the working tree).
//
// Session + password authentication for berth-control. Sessions live in
// SQLite (table `sessions`) and are issued via a httpOnly cookie. The first
// identified user is promoted to admin; if `users` ends up with zero
// admins, the next request self-heals.

import { error, type RequestEvent, type Cookies } from '@sveltejs/kit';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const { users, sessions } = schema;

export const SESSION_COOKIE = 'berth_session';
export const LOGGED_OUT_COOKIE = 'berth_logged_out';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LEN = 64;

export function hashPassword(plain: string): string {
  if (typeof plain !== 'string' || plain.length < 1) {
    throw new Error('password required');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, SCRYPT_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P
  });
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let derived: Buffer;
  try {
    derived = scryptSync(plain, salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function passwordUserCount(): number {
  const row = (db as { $client: { prepare(sql: string): { get(): { c: number } } } }).$client
    .prepare('SELECT COUNT(*) AS c FROM users WHERE password_hash IS NOT NULL')
    .get();
  return row.c;
}

function newSessionId(): string {
  return randomBytes(32).toString('hex');
}

export function createSession(opts: {
  login: string;
  source: 'password' | 'qr' | 'os-user' | 'tailscale-header';
  userAgent?: string | null;
}): { id: string; expiresAt: Date } {
  const id = newSessionId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessions)
    .values({
      id,
      user_login: opts.login,
      created_at: now,
      expires_at: expiresAt,
      source: opts.source,
      user_agent: opts.userAgent ?? null
    })
    .run();
  return { id, expiresAt };
}

export function deleteSession(id: string): void {
  db.delete(sessions).where(eq(sessions.id, id)).run();
}

export function deleteAllSessionsFor(login: string): number {
  const r = db.delete(sessions).where(eq(sessions.user_login, login)).run();
  return Number((r as { changes?: number }).changes ?? 0);
}

export function pruneExpired(): void {
  const now = Date.now();
  const client = (db as { $client: { prepare(sql: string): { run(...args: unknown[]): unknown } } })
    .$client;
  client.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  client.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`).run(now);
  // os-user + tailscale-header sessions are recreated on every request,
  // so they never need to persist across boots.
  client.prepare(`DELETE FROM sessions WHERE source IN ('os-user', 'tailscale-header')`).run();
}

export interface AuthenticatedUser {
  login: string;
  role: 'admin' | 'viewer';
  display_name: string | null;
}

export function lookupSession(id: string): AuthenticatedUser | null {
  const row = (db as {
    $client: {
      prepare(sql: string): {
        get(id: string): {
          id: string;
          user_login: string;
          expires_at: number;
          role: string;
          display_name: string | null;
        } | undefined;
        run(...args: unknown[]): unknown;
      };
    };
  }).$client
    .prepare(
      `SELECT s.id, s.user_login, s.expires_at, u.role, u.display_name
         FROM sessions s
         JOIN users u ON u.login = s.user_login
         WHERE s.id = ?`
    )
    .get(id);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    (db as { $client: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).$client
      .prepare('DELETE FROM sessions WHERE id = ?')
      .run(id);
    return null;
  }
  if (row.expires_at - now < SESSION_REFRESH_THRESHOLD_MS) {
    const next = now + SESSION_TTL_MS;
    (db as { $client: { prepare(sql: string): { run(...args: unknown[]): unknown } } }).$client
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(next, id);
  }
  return {
    login: row.user_login,
    role: row.role === 'admin' ? 'admin' : 'viewer',
    display_name: row.display_name
  };
}

export function requireUser(locals: App.Locals): AuthenticatedUser {
  if (!locals.user) throw error(401, 'sign in required');
  return locals.user;
}

export function requireAdmin(locals: App.Locals): AuthenticatedUser {
  const u = requireUser(locals);
  if (u.role !== 'admin') throw error(403, 'admin role required');
  return u;
}

export function setSessionCookie(event: RequestEvent, sessionId: string, expiresAt: Date): void {
  event.cookies.set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt
  });
}

export function clearSessionCookie(event: { cookies: Cookies }): void {
  event.cookies.delete(SESSION_COOKIE, { path: '/' });
}

export function setLoggedOutCookie(event: { cookies: Cookies }): void {
  event.cookies.set(LOGGED_OUT_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30
  });
}

export function clearLoggedOutCookie(event: { cookies: Cookies }): void {
  event.cookies.delete(LOGGED_OUT_COOKIE, { path: '/' });
}

export function upsertUserIdentity(opts: {
  login: string;
  display_name?: string | null;
  password_hash?: string | null;
}): AuthenticatedUser {
  const existing = db.select().from(users).where(eq(users.login, opts.login)).get();
  const totalRow = (db as { $client: { prepare(sql: string): { get(): { c: number } } } }).$client
    .prepare('SELECT COUNT(*) AS c FROM users')
    .get();
  if (!existing) {
    const role: 'admin' | 'viewer' = totalRow.c === 0 ? 'admin' : 'viewer';
    const now = new Date();
    db.insert(users)
      .values({
        login: opts.login,
        role,
        display_name: opts.display_name ?? null,
        password_hash: opts.password_hash ?? null,
        created_at: now,
        last_seen: now
      })
      .run();
    return { login: opts.login, role, display_name: opts.display_name ?? null };
  }
  // Self-heal: if there are zero admins anywhere, promote this user.
  const adminRow = (db as { $client: { prepare(sql: string): { get(): { c: number } } } }).$client
    .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
    .get();
  let role: 'admin' | 'viewer' = existing.role === 'admin' ? 'admin' : 'viewer';
  if (adminRow.c === 0) {
    db.update(users).set({ role: 'admin' }).where(eq(users.login, opts.login)).run();
    role = 'admin';
  }
  const patch: { last_seen: Date; display_name?: string | null; password_hash?: string | null } = {
    last_seen: new Date()
  };
  if (opts.display_name && !existing.display_name) patch.display_name = opts.display_name;
  if (opts.password_hash) patch.password_hash = opts.password_hash;
  db.update(users).set(patch).where(eq(users.login, opts.login)).run();
  return {
    login: opts.login,
    role,
    display_name: patch.display_name ?? existing.display_name ?? null
  };
}
