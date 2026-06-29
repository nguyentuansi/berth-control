import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { db, schema } from '$lib/server/db/index.js';

// POST /api/onboarding/dismiss-checklist
//
// Stamps `users.checklist_dismissed_at` so the "Getting started" checklist
// stops rendering for this user. Independent from the spotlight tour —
// closing one does not close the other. The tour has its own endpoint
// (`/api/onboarding/dismiss`) which stamps `tour_completed_at`.

export const POST: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals);
  db.update(schema.users)
    .set({ checklist_dismissed_at: new Date() })
    .where(eq(schema.users.login, user.login))
    .run();
  return json({ ok: true });
};
