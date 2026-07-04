import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types.js';
import { pullFastForward } from '$lib/server/repo-fetcher.js';
import { isDemoMode } from '$lib/server/demo.js';

// POST /api/apps/:id/repo/pull
//
// Run `git pull --ff-only origin <default-branch>` on the app's repo.
// --ff-only refuses to merge — we NEVER produce merge commits from
// this endpoint. Failures include:
//   - Uncommitted local changes that would be overwritten
//   - Untracked files that would be overwritten by pulled files
//   - Local branch diverges (has commits origin doesn't) → not fast-forwardable
//   - Merge conflict (rare with --ff-only, but possible on symlinks etc.)
//   - Network / auth failure
//
// We do NOT auto-stash or auto-anything — per project rules, berth
// never mutates the user's repo without explicit consent. Instead we
// classify the git error and return an actionable message so the UI
// can tell the user exactly what to do.
//
// On success: 200 { ok: true, new_sha }
// On failure: 4xx with body = { error, kind, hint } — UI renders `error`
//             as the main title and `hint` as description.

type FailKind =
  | 'uncommitted-changes'
  | 'untracked-conflict'
  | 'diverged'
  | 'merge-conflict'
  | 'no-default-branch'
  | 'not-a-repo'
  | 'network'
  | 'auth'
  | 'unknown';

function classify(rawMessage: string): { kind: FailKind; hint: string } {
  const m = rawMessage.toLowerCase();
  if (/your local changes to the following files would be overwritten/.test(m)) {
    return {
      kind: 'uncommitted-changes',
      hint: 'You have uncommitted local edits. Commit or stash them, then pull again.'
    };
  }
  if (/untracked working tree files.*would be overwritten/.test(m)) {
    return {
      kind: 'untracked-conflict',
      hint: 'Untracked files here would be overwritten by the pull. Move them aside or add them to .gitignore.'
    };
  }
  if (/not possible to fast-forward|non-fast-forward|refusing to merge unrelated histories/.test(m)) {
    return {
      kind: 'diverged',
      hint: 'Your branch has commits origin does not. Rebase locally (`git pull --rebase`) or push your commits first.'
    };
  }
  if (/conflict|automatic merge failed|unmerged/.test(m)) {
    return {
      kind: 'merge-conflict',
      hint: 'Merge conflict during pull. Resolve conflicts manually in your editor.'
    };
  }
  if (/no default branch configured/.test(m)) {
    return {
      kind: 'no-default-branch',
      hint: "Couldn't detect the default branch. Set it in the app's repo (e.g. `git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main`)."
    };
  }
  if (/not a git repo/.test(m)) {
    return {
      kind: 'not-a-repo',
      hint: 'This app is not backed by a git repository.'
    };
  }
  if (/could not resolve host|network|timed? ?out|connection refused|no route to host/.test(m)) {
    return {
      kind: 'network',
      hint: 'Network error reaching the remote. Check your connection.'
    };
  }
  if (/permission denied|authentication failed|access denied|could not read from remote/.test(m)) {
    return {
      kind: 'auth',
      hint: 'Auth failed on the remote. Check your SSH key or credentials.'
    };
  }
  return { kind: 'unknown', hint: 'Unexpected git error — see message above.' };
}

export const POST: RequestHandler = async ({ params, locals }) => {
  if (isDemoMode()) return json({ ok: true, new_sha: 'demo0000' });
  if (!locals.user) throw error(401, 'auth required');
  try {
    const r = await pullFastForward(params.id);
    return json(r);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const { kind, hint } = classify(raw);
    // Return structured body via `error()` — SvelteKit stringifies the
    // second arg. We return JSON so the client's summarizeError() can
    // parse it, but also include a plain message for the fallback path.
    const body = JSON.stringify({ error: raw, kind, hint });
    // 409 Conflict for the state-based failures (uncommitted / diverged /
    // untracked / merge-conflict), 502 for network, 400 for the rest.
    const status =
      kind === 'network'
        ? 502
        : kind === 'auth'
          ? 401
          : kind === 'not-a-repo' || kind === 'no-default-branch'
            ? 400
            : 409;
    throw error(status, body);
  }
};
