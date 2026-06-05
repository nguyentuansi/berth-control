import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types.js';
import { importPortsMd } from '$lib/server/ports-md.js';
import { db, schema } from '$lib/server/db/index.js';
import { desc } from 'drizzle-orm';

export const load: PageServerLoad = async () => {
  const events = db
    .select()
    .from(schema.events)
    .orderBy(desc(schema.events.ts))
    .limit(20)
    .all();
  return { events };
};

export const actions: Actions = {
  reimport: async () => {
    try {
      const r = importPortsMd();
      return { ok: true, result: r };
    } catch (e) {
      return fail(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
};
