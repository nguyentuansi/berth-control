import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = async ({ locals }) => {
  // Same auth pattern as the dashboard — signed-out users get redirected to
  // /login. Once signed in, anyone can see host metrics (they're about the
  // machine berth runs on, not other users' apps).
  if (!locals.user) throw redirect(302, '/login?next=/monitor');
  return {};
};
