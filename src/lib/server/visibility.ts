// Recovered from build/server/chunks/visibility-DeK3xu6Z.js (the last
// successful build before this file was lost from the working tree).
//
// Per-app visibility + grant filter for berth-control. Apps have three
// visibility modes: public (everyone can view; admin can manage),
// invited (owner + grant rows can view/manage), private (owner only).

import { error } from '@sveltejs/kit';
import { eq, and, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from './db/index.js';

const { apps, app_grants } = schema;

type App = typeof schema.apps.$inferSelect;

export const VALID_VISIBILITIES = ['private', 'invited', 'public'] as const;
export type Visibility = (typeof VALID_VISIBILITIES)[number];

export function grantedAppIds(login: string): Set<string> {
  const rows = db
    .select({ app_id: app_grants.app_id })
    .from(app_grants)
    .where(eq(app_grants.user_login, login))
    .all();
  return new Set(rows.map((r) => r.app_id));
}

/** Build a Drizzle predicate that filters `apps` to ones the user can SEE.
 *  Used by the dashboard's load function + any list endpoint. */
export function visibilityFilter(login: string): SQL | undefined {
  const granted = grantedAppIds(login);
  const grantedIds = Array.from(granted);
  if (grantedIds.length === 0) {
    return or(eq(apps.visibility, 'public'), eq(apps.owner_login, login));
  }
  return or(
    eq(apps.visibility, 'public'),
    eq(apps.owner_login, login),
    sql`${apps.id} IN (${sql.join(
      grantedIds.map((id) => sql`${id}`),
      sql`, `
    )})`
  );
}

export function canView(app: App, login: string, isAdmin: boolean): boolean {
  if (app.visibility === 'public') return true;
  if (app.owner_login === login) return true;
  if (app.visibility === 'invited') {
    const row = db
      .select()
      .from(app_grants)
      .where(and(eq(app_grants.app_id, app.id), eq(app_grants.user_login, login)))
      .get();
    if (row) return true;
  }
  return false;
}

export function canManage(app: App, login: string, isAdmin: boolean): boolean {
  if (app.visibility === 'public') return isAdmin;
  if (app.owner_login === login) return true;
  if (app.visibility === 'invited') {
    const row = db
      .select()
      .from(app_grants)
      .where(and(eq(app_grants.app_id, app.id), eq(app_grants.user_login, login)))
      .get();
    if (row) return true;
  }
  return false;
}

export function canAdmin(app: App, login: string, isAdmin: boolean): boolean {
  if (app.visibility === 'public') return isAdmin;
  return app.owner_login === login;
}

export function requireManage(appId: string, locals: App.Locals): App {
  const user = locals.user;
  if (!user) throw error(401, 'sign in required');
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) throw error(404, 'unknown app');
  if (!canView(app, user.login, user.role === 'admin')) {
    throw error(404, 'unknown app');
  }
  if (!canManage(app, user.login, user.role === 'admin')) {
    throw error(403, "you don't have permission to start/stop this app");
  }
  return app;
}

export function requireAdminApp(appId: string, locals: App.Locals): App {
  const user = locals.user;
  if (!user) throw error(401, 'sign in required');
  const app = db.select().from(apps).where(eq(apps.id, appId)).get();
  if (!app) throw error(404, 'unknown app');
  if (!canView(app, user.login, user.role === 'admin')) throw error(404, 'unknown app');
  if (!canAdmin(app, user.login, user.role === 'admin')) {
    throw error(403, 'owner only');
  }
  return app;
}
