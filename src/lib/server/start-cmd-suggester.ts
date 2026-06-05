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
        if (typeof scripts[name] === 'string') {
          // If the script already references --port the same value, don't append;
          // otherwise leave the script as-is (it likely binds the right port already).
          return { cmd: `bun run ${name}`, reason: `package.json "scripts.${name}"` };
        }
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
