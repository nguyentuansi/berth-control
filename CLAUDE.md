# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Runtime & commands

Bun is the package manager and dev runner (`bun.lock` is checked in). The app itself is plain Node at runtime via `adapter-node`.

```bash
bun install
bun run dev             # vite dev, port 5202, host 127.0.0.1 (strictPort: true)
bun run check           # svelte-kit sync && svelte-check --tsconfig ./tsconfig.json
bun run build           # → build/index.js
bun run preview         # run the prod build
bun run db:push         # apply Drizzle schema diff to the SQLite DB
bun run db:studio       # Drizzle Studio
bun run demo:seed       # populate ./demo.db with fictional apps
bun run demo:dev        # BERTH_CONTROL_DEMO=1 BERTH_CONTROL_DB=./demo.db, port 5203
```

There is no test suite, no linter, and no formatter. `bun run check` is the only static verification step.

Port 5202 is berth-control's default; demo mode uses 5203. Both are claimed in your `PORTS.md` if you keep one. Do not pick a different port to dodge a conflict — investigate the squatter.

## Boot sequence

`src/hooks.server.ts` runs `bootOnce()` on the first request, not at module load. Order:

1. `ensureSchema()` — idempotent `CREATE TABLE IF NOT EXISTS` in `src/lib/server/db/migrate.ts`. This is the runtime path; `db:push` is dev-only.
2. If `BERTH_CONTROL_DEMO=1`: skip the next two steps.
3. `reattachOnBoot()` — scans `runs` rows with `stopped_at IS NULL`, checks `pidAlive`, and re-claims the in-memory `Map` in `supervisor.ts`. Survives Vite HMR because PIDs are persisted.
4. `importPortsMd()` — parses `~/PORTS.md` (or `BERTH_CONTROL_PORTS_MD`) into the `apps` table.

Then `identify(event)` runs on every request and assigns `event.locals.user`.

## Architecture invariants

**SSR-only server modules.** Anything in `src/lib/server/` must never be imported from a `+page.svelte` or client-side code. SvelteKit enforces this, but be aware: `better-sqlite3` is a native module and is listed in `vite.config.ts` as `optimizeDeps.exclude` + `ssr.external`. Do not remove those entries.

**Process supervision (`src/lib/server/supervisor.ts`).**
- Children spawn with `detached: true` so the child is its own process-group leader. The PID + PGID are persisted in `runs`.
- Stop = `process.kill(-pgid, 'SIGTERM')` (negative PID = whole group), wait 5s, then `SIGKILL`. Don't bypass the negative-PGID kill — it's how child processes (e.g. vite + the framework subprocess) get reaped together.
- The in-memory `live` map is per-process; if a request lands on a fresh module (Vite reload), `reattachOnBoot()` is the recovery path. PIDs in the DB are the source of truth, not the in-memory map.
- `start_cmd` is run via `/bin/bash -c`. Treat it as code, not config — every change is a remote-exec primitive.

**Live state (`/api/state` SSE).** One subscriber polls `ss -tlnp` + `/proc` + `tailscale serve status` + per-app healthchecks every 2s and emits a combined snapshot. `tailscale serve status` is cached for 5s in `tailscale-serve.ts`. Do not call `ss` or `tailscale` from other routes — go through the prober.

**Auth (`src/lib/server/tailscale.ts`).** Identity comes from the `Tailscale-User-Login` request header, but it's trusted *only* when the request arrives via loopback (that's the same boundary `tailscale serve` enforces — it terminates TLS on the tailnet side and forwards plaintext to 127.0.0.1, injecting the header). Direct non-loopback requests carrying that header are rejected. First identified visitor is promoted to admin; if `users` ends up with zero admins, the next request self-heals. Loopback requests without the header fall back to the OS user, so `curl 127.0.0.1:5202` works from the same box.

**Demo mode (`BERTH_CONTROL_DEMO=1`).** Swaps the live-state pipeline for a canned snapshot (`src/lib/server/demo.ts`), skips PORTS.md import + supervisor re-attach, and makes start/stop/restart endpoints no-ops. Use it for screenshots. Anything that touches the live pipeline must check `isDemoMode()` and short-circuit.

## Schema

Single SQLite database (WAL mode), schema in `src/lib/server/db/schema.ts`. Tables: `apps`, `runs`, `events`, `log_chunks`, `users`, `snapshots`. For additive changes during development use `bun run db:push`; for the runtime path also update the `CREATE TABLE IF NOT EXISTS` in `migrate.ts` so cold boot still works.

`apps.kind` is a free-text discriminator (`vite|wrangler|bun|node|cargo|gradle|java|shell|docker`) used by `start-cmd-suggester.ts` and the dashboard's grouping. To add a new ecosystem, branch in `start-cmd-suggester.ts` on the marker file (e.g. `deno.json`).

## PORTS.md format

Markdown table parsed by `src/lib/server/ports-md.ts`. Columns: `Port | Project | Path | Proto | Tailscale | Systemd Service | Notes`. Anchor pattern: when a `Path` ends with `(apps/foo)`, subsequent rows with relative paths (`apps/jobs`) resolve against that monorepo root. berth-control runs without PORTS.md — apps can be added from the UI.

## Allowed dev-server hosts

`vite.config.ts` allows `localhost`, `127.0.0.1`, and `.ts.net` (every Tailscale tailnet lives under that TLD). Extra hosts come from `BERTH_CONTROL_ALLOWED_HOSTS` (comma-separated, leading dot = subdomain wildcard). Don't hardcode tailnet names in source.

## Conventions worth knowing

- File extensions in imports use `.js` even for `.ts` source (`from './db/index.js'`) — required by Node ESM resolution at runtime. Keep this consistent.
- `$lib` alias is set in `svelte.config.js`; use it instead of relative paths into `src/lib/`.
- Drizzle is used for queries (`db.select().from(...).where(...).get()`). Stick to it — no raw `better-sqlite3` calls outside `db/` and `migrate.ts`.
- Process spawning, file system writes outside `~/.berth-control/`, and `ss`/`tailscale` invocations all live in `src/lib/server/`. Don't introduce new shell-outs from route handlers — wrap them in a server module.
