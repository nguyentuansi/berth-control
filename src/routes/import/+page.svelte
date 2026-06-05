<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData } from './$types.js';

  let { data, form }: { data: PageData; form: any } = $props();

  type BackfillResult = {
    scanned: number;
    filled: number;
    results: Array<{ id: string; cmd: string | null; reason: string }>;
  };
  let backfillResult: BackfillResult | null = $state(null);
</script>

<h1>Import</h1>
<p class="b-muted">
  Berth bootstraps its registry from a markdown table — default
  <code class="b-mono">~/PORTS.md</code>, or whatever
  <code class="b-mono">BERTH_PORTS_MD</code> points to. Re-import to pick up rows
  you've added since the last sync. Existing apps keep their
  <code class="b-mono">start_cmd</code> and other Berth-only overrides.
</p>

<form method="post" action="?/reimport" use:enhance class="row">
  <button class="b-btn primary" type="submit">Re-import from PORTS.md</button>
</form>

{#if form?.ok}
  <p>
    Imported: <strong>{form.result.inserted}</strong> new,
    <strong>{form.result.updated}</strong>
    updated (of {form.result.total} rows).
  </p>
{:else if form?.error}
  <p style="color: var(--b-bad)">Error: {form.error}</p>
{/if}

<h2>Auto-fill start commands</h2>
<p class="b-muted">
  PORTS.md doesn't carry the actual dev command. This scans each app's project
  path for <code class="b-mono">package.json</code> /
  <code class="b-mono">Cargo.toml</code> / <code class="b-mono">gradlew</code> and
  fills <code class="b-mono">start_cmd</code> with a sensible default (e.g.
  <code class="b-mono">bun run dev</code>). Already-set commands are left alone
  unless you tick "force".
</p>

<form
  onsubmit={async (e) => {
    e.preventDefault();
    const force = (e.currentTarget.elements.namedItem('force') as HTMLInputElement)?.checked;
    const r = await fetch('/api/apps/backfill-start-cmds' + (force ? '?force=1' : ''), {
      method: 'POST'
    });
    backfillResult = await r.json();
  }}
  class="row"
>
  <button class="b-btn primary" type="submit">Run backfill</button>
  <label class="b-muted" style="display: flex; align-items: center; gap: 6px; font-size: 13px;">
    <input type="checkbox" name="force" /> force (overwrite existing)
  </label>
</form>

{#if backfillResult}
  <p>
    Scanned <strong>{backfillResult.scanned}</strong>, filled
    <strong>{backfillResult.filled}</strong>.
  </p>
  <details>
    <summary class="b-mute2">Show per-app suggestions ({backfillResult.results.length})</summary>
    <ul class="results">
      {#each backfillResult.results as r (r.id)}
        <li>
          <code class="b-mono">{r.id}</code>
          {#if r.cmd}
            → <code class="b-mono">{r.cmd}</code>
            <span class="b-mute2">({r.reason})</span>
          {:else}
            <span class="b-mute2">— {r.reason}</span>
          {/if}
        </li>
      {/each}
    </ul>
  </details>
{/if}

<h2>Recent events</h2>
<ul class="events">
  {#each data.events as e (e.id)}
    <li>
      <span class="b-mono b-mute2">{e.ts.toLocaleTimeString()}</span>
      <span class={`lvl ${e.level}`}>{e.level}</span>
      <span>{e.msg}</span>
    </li>
  {/each}
</ul>

<style>
  h1 { font-size: 22px; font-weight: 600; margin: 6px 0 8px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--b-text-3); font-weight: 600; margin-top: 24px; }
  form { margin: 14px 0; }
  form.row { display: flex; gap: 10px; align-items: center; }
  .results { list-style: none; padding: 0; margin: 8px 0 0; max-height: 320px; overflow: auto; }
  .results li { font-size: 12px; padding: 3px 0; border-bottom: 1px solid var(--b-border); }
  .events { list-style: none; padding: 0; margin: 0; }
  .events li { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--b-border); font-size: 13px; }
  .lvl { font-family: var(--b-mono); font-size: 11px; padding: 1px 6px; border-radius: 999px; }
  .lvl.info  { background: color-mix(in oklab, var(--b-info) 12%, transparent); color: var(--b-info); }
  .lvl.warn  { background: color-mix(in oklab, var(--b-warn) 18%, transparent); color: var(--b-warn); }
  .lvl.error { background: color-mix(in oklab, var(--b-bad) 14%, transparent); color: var(--b-bad); }
</style>
