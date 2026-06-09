import { json, error } from '@sveltejs/kit';
import { readdir, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import type { RequestHandler } from './$types.js';

/**
 * Server-side directory browser for the "Add app" modal. Browsers can't
 * expose absolute OS paths from showDirectoryPicker(), so we drive the
 * picker UI from this endpoint. Returns the current dir's child directories
 * (files are hidden since you can't run a file as an app), plus the parent
 * path so the client can offer a ".." entry.
 *
 * Berth is loopback-or-tailnet only and trusts the identified user, so this
 * deliberately doesn't sandbox to a root. The user can browse anywhere they
 * have OS-level read permission for. If you ever expose Berth more broadly
 * this needs revisiting.
 */
export const GET: RequestHandler = async ({ url }) => {
  const requested = url.searchParams.get('path');
  const showHidden = url.searchParams.get('hidden') === '1';
  const path = resolve(requested && requested.trim() ? requested.trim() : homedir());
  let s;
  try {
    s = await stat(path);
  } catch (e) {
    throw error(404, e instanceof Error ? e.message : `Cannot stat ${path}`);
  }
  if (!s.isDirectory()) throw error(400, `${path} is not a directory`);
  let raw: string[];
  try {
    raw = await readdir(path);
  } catch (e) {
    throw error(403, e instanceof Error ? e.message : `Cannot read ${path}`);
  }
  // Filter to directories. Each `stat` call is cheap but doing them in
  // parallel keeps a hot-cache home dir responsive.
  const entries = await Promise.all(
    raw.map(async (name) => {
      if (!showHidden && name.startsWith('.')) return null;
      try {
        const child = resolve(path, name);
        const cs = await stat(child);
        if (!cs.isDirectory()) return null;
        return { name, path: child };
      } catch {
        return null;
      }
    })
  );
  const dirs = entries
    .filter((e): e is { name: string; path: string } => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return json({
    path,
    parent: parent === path ? null : parent,
    name: basename(path) || path,
    entries: dirs
  });
};
