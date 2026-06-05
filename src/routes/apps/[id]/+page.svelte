<script lang="ts">
  import { Play, Square, RotateCw, Save, Clock, ChevronLeft } from 'lucide-svelte';
  import { enhance } from '$app/forms';
  import type { PageData } from './$types.js';

  let { data, form }: { data: PageData; form: any } = $props();

  let busy = $state<'start' | 'stop' | 'restart' | null>(null);
  async function act(kind: 'start' | 'stop' | 'restart') {
    busy = kind;
    try {
      const r = await fetch(`/api/apps/${data.app.id}/${kind}`, { method: 'POST' });
      if (!r.ok) alert(`${kind} failed: ${await r.text()}`);
      else if (kind !== 'stop') location.reload();
    } finally {
      busy = null;
    }
  }
</script>

<nav class="crumb"><a href="/"><ChevronLeft size={14} /> Dashboard</a></nav>

<header class="head">
  <h1>{data.app.name}</h1>
  <div class="actions">
    {#if !data.openRun}
      <button class="b-btn primary" disabled={busy != null} onclick={() => act('start')}>
        <Play size={14} /> Start
      </button>
    {:else}
      <button class="b-btn danger" disabled={busy != null} onclick={() => act('stop')}>
        <Square size={14} /> Stop
      </button>
      <button class="b-btn" disabled={busy != null} onclick={() => act('restart')}>
        <RotateCw size={14} /> Restart
      </button>
    {/if}
    <a class="b-btn" href={`/apps/${data.app.id}/logs`}>
      <Clock size={14} /> Logs
    </a>
  </div>
</header>

<form method="post" action="?/save" use:enhance class="b-surface settings">
  <div class="row">
    <label>
      <span>Name</span>
      <input class="b-input" name="name" value={data.app.name} required />
    </label>
    <label>
      <span>Port</span>
      <input class="b-input" name="port" type="number" value={data.app.port ?? ''} />
    </label>
    <label>
      <span>Kind</span>
      <select class="b-input" name="kind" value={data.app.kind}>
        {#each ['vite', 'wrangler', 'bun', 'node', 'python', 'cargo', 'gradle', 'java', 'shell', 'docker'] as k}
          <option value={k}>{k}</option>
        {/each}
      </select>
    </label>
  </div>
  <label class="full">
    <span>Project path</span>
    <input class="b-input b-mono" name="project_path" value={data.app.project_path} />
  </label>
  <label class="full">
    <span>Start command</span>
    <input
      class="b-input b-mono"
      name="start_cmd"
      value={data.app.start_cmd ?? ''}
      placeholder="bun run dev"
    />
  </label>
  <label class="full">
    <span>Stop command (optional)</span>
    <input
      class="b-input b-mono"
      name="stop_cmd"
      value={data.app.stop_cmd ?? ''}
      placeholder="pkill -9 workerd"
    />
  </label>
  <div class="row">
    <label class="full">
      <span>Healthcheck URL</span>
      <input
        class="b-input"
        name="healthcheck_url"
        value={data.app.healthcheck_url ?? ''}
        placeholder="http://127.0.0.1:5202/health"
      />
    </label>
    <label>
      <span>Group tag</span>
      <input class="b-input" name="group_tag" value={data.app.group_tag ?? ''} />
    </label>
  </div>
  <label class="full">
    <span>Env file</span>
    <input class="b-input b-mono" name="env_file" value={data.app.env_file ?? ''} />
  </label>
  <label class="full">
    <span>Notes</span>
    <textarea class="b-input" name="notes" rows="2">{data.app.notes ?? ''}</textarea>
  </label>
  <label class="check">
    <input type="checkbox" name="hidden" checked={data.app.hidden} /> Hidden from dashboard
  </label>
  <div class="footer">
    {#if form?.ok}
      <span class="b-mute2">Saved.</span>
    {/if}
    <button class="b-btn primary" type="submit"><Save size={14} /> Save</button>
  </div>
</form>

<section class="history">
  <h2>Recent runs</h2>
  {#if data.recentRuns.length === 0}
    <p class="b-mute2">Never started by Berth yet.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Run</th><th>Started</th><th>Stopped</th><th>PID</th><th>Exit</th>
        </tr>
      </thead>
      <tbody>
        {#each data.recentRuns as r (r.id)}
          <tr>
            <td><a href={`/apps/${data.app.id}/logs?run=${r.id}`}>#{r.id}</a></td>
            <td class="b-mono b-mute2">{r.started_at.toLocaleString()}</td>
            <td class="b-mono b-mute2">{r.stopped_at?.toLocaleString() ?? '—'}</td>
            <td class="b-mono">{r.pid}</td>
            <td class="b-mono">{r.exit_code ?? (r.stopped_at ? '—' : 'live')}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>

<section class="history">
  <h2>Events</h2>
  <ul class="events">
    {#each data.recentEvents as e (e.id)}
      <li>
        <span class="b-mono b-mute2">{e.ts.toLocaleTimeString()}</span>
        <span class={`lvl ${e.level}`}>{e.level}</span>
        <span>{e.msg}</span>
        {#if e.user_login}<span class="b-mute2">· {e.user_login}</span>{/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .crumb { font-size: 13px; margin: 4px 0 8px; }
  .crumb a { color: var(--b-text-2); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
  .crumb a:hover { color: var(--b-text); }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 6px 0 14px; }
  .head h1 { font-size: 22px; font-weight: 600; margin: 0; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .settings { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
  .row { display: grid; grid-template-columns: 1.5fr 1fr 1fr; gap: 10px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--b-text-2); }
  label.full { grid-column: 1 / -1; }
  label.check { flex-direction: row; align-items: center; gap: 6px; }
  .footer { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 6px; }

  .history { margin-top: 18px; }
  .history h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--b-text-3); font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--b-border); }
  th { color: var(--b-text-2); font-weight: 500; font-size: 11px; text-transform: uppercase; }
  .events { list-style: none; padding: 0; margin: 0; }
  .events li { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--b-border); font-size: 13px; }
  .lvl { font-family: var(--b-mono); font-size: 11px; padding: 1px 6px; border-radius: 999px; }
  .lvl.info  { background: color-mix(in oklab, var(--b-info) 12%, transparent); color: var(--b-info); }
  .lvl.warn  { background: color-mix(in oklab, var(--b-warn) 18%, transparent); color: var(--b-warn); }
  .lvl.error { background: color-mix(in oklab, var(--b-bad) 14%, transparent); color: var(--b-bad); }
</style>
