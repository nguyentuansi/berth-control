import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Suggest a `start_cmd` for an app based on what's in its project directory.
 *  Returns null when we can't make a confident guess — better empty than wrong. */
export function suggestStartCmd(
  projectPath: string,
  port: number | null,
  kind: string
): { cmd: string; reason: string } | null {
  if (!existsSync(projectPath)) return null;

  // Node / Bun / Vite / Wrangler — read package.json scripts.
  const pkgPath = resolve(projectPath, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      // Pick the most-likely script — order matches what most templates use.
      const candidates = ['dev', 'start', 'serve', 'develop'] as const;
      for (const name of candidates) {
        const scriptValue = scripts[name];
        if (typeof scriptValue !== 'string') continue;
        // Force the framework onto Berth's allocated port instead of its
        // builtin default (vite → 5173, next → 3000, nuxt → 3000, etc.).
        // Without this the first time the user starts the app it binds
        // whatever the framework picks and the dashboard's port column
        // ends up disagreeing with reality. Only do this when the script
        // looks like it'll respect a --port flag and isn't already pinned.
        const wantsPort =
          port != null &&
          !/--port[=\s]\d+/.test(scriptValue) &&
          /(\bvite\b|\bnext\s+dev\b|\bnuxt\s+dev\b|\bremix\b|\bwrangler\b|\bsvelte-kit\b)/.test(
            scriptValue
          );
        const cmd = wantsPort ? `bun run ${name} -- --port ${port}` : `bun run ${name}`;
        return {
          cmd,
          reason: wantsPort
            ? `package.json "scripts.${name}" pinned to :${port}`
            : `package.json "scripts.${name}"`
        };
      }
    } catch {
      /* malformed package.json — fall through */
    }
  }

  // Cargo workspace.
  if (existsSync(resolve(projectPath, 'Cargo.toml'))) {
    return { cmd: 'cargo run', reason: 'Cargo.toml detected' };
  }

  // Python uvicorn / FastAPI — convention only, not safe to auto-build.
  if (
    kind === 'python' &&
    (existsSync(resolve(projectPath, 'main.py')) ||
      existsSync(resolve(projectPath, 'app.py')))
  ) {
    // Leave null — module name + venv activation is too project-specific.
    return null;
  }

  // Gradle / Java.
  if (existsSync(resolve(projectPath, 'gradlew'))) {
    return { cmd: './gradlew bootRun', reason: 'gradlew detected' };
  }

  // Fallback by kind.
  if (kind === 'wrangler' && port) {
    return { cmd: `bunx wrangler dev --port ${port}`, reason: 'kind=wrangler' };
  }
  if (kind === 'vite' && port) {
    return {
      cmd: `bunx vite dev --port ${port} --host 127.0.0.1`,
      reason: 'kind=vite'
    };
  }

  return null;
}
