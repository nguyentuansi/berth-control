import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types.js';
import { requireUser } from '$lib/server/auth.js';
import { db, schema } from '$lib/server/db/index.js';

// POST /api/onboarding/dismiss
//
// Marks onboarding as completed for the current user by stamping
// `users.tour_completed_at`. The dashboard's load() reads this column
// and gates both `<OnboardingChecklist>` and `<OnboardingTour>` on it
// being null, so a successful POST + invalidateAll() makes both
// disappear permanently for this account.

export const POST: RequestHandler = async ({ locals }) => {
  const user = requireUser(locals);
  db.update(schema.users)
    .set({ tour_completed_at: new Date() })
    .where(eq(schema.users.login, user.login))
    .run();
  return json({ ok: true });
};
