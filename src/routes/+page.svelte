<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    Play,
    Square,
    RotateCw,
    ExternalLink,
    Folder,
    Clock,
    PlayCircle,
    StopCircle,
    LayoutGrid,
    Rows3,
    Settings2
  } from 'lucide-svelte';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  // Live state pushed from /api/state (SSE).
  type LiveStatus = {
    up: boolean;
    listenerPid: number | null;
    listenerCmd: string | null;
    managedPid: number | null;
    managedSince: number | null;
    healthOk: boolean | null;
    latencyMs: number | null;
    tailscale: { port: number; funnel: boolean } | null;
  };
  let livestate: Record<string, LiveStatus> = $state({});
  let liveTs: number = $state(0);
  let tailscaleHost: string | null = $state(null);
  let tailscaleAvailable: boolean = $state(false);
  let es: EventSource | null = null;
  let busy: Record<string, 'start' | 'stop' | 'restart' | null> = $state({});

  // Detect which pipeline the user is currently viewing Berth through.
  // - If hostname ends in .ts.net → they came via tailscale serve, so "Open"
  //   should also link via tailscale (otherwise the loopback URL resolves to
  //   the *viewer's* loopback, e.g. their phone).
  // - Otherwise → loopback is fine.
  let pageHost: string = $state('');
  const viaTailnet = $derived(pageHost.endsWith('.ts.net'));

  // View mode: 'grid' (default, card per app) or 'list' (compact rows).
  // Persisted per-browser in localStorage.
  let view: 'grid' | 'list' = $state('grid');

  onMount(() => {
    const saved = localStorage.getItem('berth.view');
    if (saved === 'list' || saved === 'grid') view = saved;
    pageHost = window.location.hostname;
    es = new EventSource('/api/state');
    es.onmessage = (m) => {
      try {
        const j = JSON.parse(m.data);
        livestate = j.byApp ?? {};
        liveTs = j.ts;
        tailscaleHost = j.tailscaleHost ?? null;
        tailscaleAvailable = !!j.tailscaleAvailable;
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      // Browser auto-retries; just note it.
      liveTs = 0;
    };
  });

  /** Build the right "Open" URL for an app depending on which pipeline the
   *  user is currently looking at Berth through. */
  function openUrl(port: number | null, ts: LiveStatus['tailscale']): string | null {
    if (!port) return null;
    if (viaTailnet && ts && tailscaleHost) {
      // User is on tailnet → click-through stays on tailnet (preserves
      // their pipeline; loopback would resolve to their phone's loopback).
      return `https://${tailscaleHost}:${ts.port}`;
    }
    return `http://127.0.0.1:${port}`;
  }
  onDestroy(() => es?.close());

  function setView(v: 'grid' | 'list') {
    view = v;
    if (typeof localStorage !== 'undefined') localStorage.setItem('berth.view', v);
  }

  async function act(id: string, kind: 'start' | 'stop' | 'restart') {
    busy[id] = kind;
    try {
      const r = await fetch(`/api/apps/${id}/${kind}`, { method: 'POST' });
      if (!r.ok) {
        const text = await r.text();
        alert(`${kind} failed: ${text}`);
      }
    } finally {
      busy[id] = null;
    }
  }

  let bulkBusy: string | null = $state(null);
  async function bulkAct(group: string, action: 'start' | 'stop', items: { id: string }[]) {
    bulkBusy = `${group}:${action}`;
    try {
      const ids = items.map((i) => i.id);
      const r = await fetch('/api/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ids })
      });
      if (!r.ok) alert(`bulk ${action} failed: ${await r.text()}`);
    } finally {
      bulkBusy = null;
    }
  }

  function fmtSince(ms: number | null | undefined): string {
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 60_000) return `${Math.round(d / 1000)}s`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
    return `${Math.round(d / 3_600_000)}h`;
  }

  const grouped = $derived(() => {
    const m = new Map<string, typeof data.apps>();
    for (const a of data.apps) {
      const k = a.group_tag ?? guessGroup(a);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  });
  function guessGroup(a: { project_path: string; name: string }): string {
    // Default group from the parent directory name (e.g. ~/Work/acme/api → "acme").
    // For real grouping, set `group_tag` explicitly on each app via /apps/<id>.
    const segs = a.project_path.replace(/[\\/]+$/, '').split('/').filter(Boolean);
    if (segs.length >= 2) return segs[segs.length - 2];
    if (segs.length === 1) return segs[0];
    return 'other';
  }
</script>

<section class="head">
  <div>
    <h1>Dashboard</h1>
    <p class="b-muted">
      {data.apps.length} apps registered ·
      {Object.values(livestate).filter((s) => s?.up).length} listening ·
      {Object.values(livestate).filter((s) => s?.tailscale).length} on tailnet
      {#if liveTs}
        <span class="b-mute2"> · live</span>
      {:else}
        <span class="b-mute2"> · disconnected</span>
      {/if}
      {#if pageHost}
        <span class="b-pill viewbadge" title={pageHost}>
          via {viaTailnet ? 'tailnet' : 'loopback'}
        </span>
      {/if}
      {#if tailscaleHost && !tailscaleAvailable}
        <span class="b-pill warn" title="tailscale serve status returned an error">tailscale offline</span>
      {/if}
    </p>
  </div>

  <div class="viewtoggle" role="group" aria-label="View mode">
    <button
      class="b-btn"
      class:active={view === 'grid'}
      onclick={() => setView('grid')}
      title="Card grid (default)"
      aria-pressed={view === 'grid'}
    >
      <LayoutGrid size={13} /> Grid
    </button>
    <button
      class="b-btn"
      class:active={view === 'list'}
      onclick={() => setView('list')}
      title="Compact list"
      aria-pressed={view === 'list'}
    >
      <Rows3 size={13} /> List
    </button>
  </div>
</section>

{#each grouped() as [group, items] (group)}
  <section class="group">
    <div class="group-head">
      <h2>{group} <span class="b-mute2">({items.length})</span></h2>
      <div class="bulk">
        <button
          class="b-btn"
          disabled={bulkBusy != null}
          onclick={() => bulkAct(group, 'start', items)}
          title="Start every app in this group that has a start_cmd"
        >
          <PlayCircle size={13} /> Start group
        </button>
        <button
          class="b-btn danger"
          disabled={bulkBusy != null}
          onclick={() => bulkAct(group, 'stop', items)}
        >
          <StopCircle size={13} /> Stop group
        </button>
      </div>
    </div>

    {#if view === 'list'}
      <div class="b-surface listwrap">
        <table class="list">
          <thead>
            <tr>
              <th class="col-st" aria-label="status"></th>
              <th class="col-name">App</th>
              <th class="col-port">Port</th>
              <th class="col-kind">Kind</th>
              <th class="col-meta">Status</th>
              <th class="col-path">Path</th>
              <th class="col-act">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each items as a (a.id)}
              {@const s = livestate[a.id]}
              <tr>
                <td>
                  <span
                    class="b-dot"
                    class:up={s?.up}
                    class:down={s && !s.up}
                    class:idle={!s}
                  ></span>
                </td>
                <td class="col-name">
                  <a href={`/apps/${a.id}`} class="name">{a.name}</a>
                </td>
                <td class="b-mono col-port">
                  {#if a.port}:{a.port}{:else}—{/if}
                </td>
                <td class="b-mono col-kind b-mute2">{a.kind}</td>
                <td class="col-meta">
                  {#if s?.up}
                    {#if s.managedPid}
                      <span class="b-pill">managed · {fmtSince(s.managedSince)}</span>
                    {:else if s.listenerPid}
                      <span class="b-pill" title={s.listenerCmd ?? ''}>
                        external · pid {s.listenerPid}
                      </span>
                    {:else}
                      <span class="b-pill">up</span>
                    {/if}
                    {#if s.latencyMs != null}
                      <span class="b-pill">{s.latencyMs}ms</span>
                    {/if}
                  {:else if s}
                    <span class="b-pill">down</span>
                  {/if}
                  {#if s?.tailscale}
                    <span
                      class="b-pill ts"
                      class:funnel={s.tailscale.funnel}
                      class:stale={!s.up}
                      title={!s.up
                        ? `Mapped via tailscale but target :${a.port} is dead — clicking would 502`
                        : s.tailscale.funnel
                        ? `Public funnel: ${tailscaleHost}:${s.tailscale.port}`
                        : `Tailnet-only: ${tailscaleHost}:${s.tailscale.port}`}
                    >
                      {s.tailscale.funnel ? 'funnel' : 'tailnet'} :{s.tailscale.port}
                      {#if !s.up}· 502{/if}
                    </span>
                  {/if}
                </td>
                <td class="col-path b-mono b-mute2" title={a.project_path}>
                  {a.project_path.replace(/^\/(?:home|Users)\/[^/]+\//, '~/')}
                </td>
                <td class="col-act">
                  {#if a.port && s?.up}
                    {@const u = openUrl(a.port, s.tailscale)}
                    {#if u}
                      <a class="b-btn icon" href={u} target="_blank" rel="noreferrer" title={u}>
                        <ExternalLink size={13} />
                      </a>
                    {/if}
                  {/if}
                  {#if !s?.up}
                    {#if a.start_cmd}
                      <button
                        class="b-btn icon primary"
                        disabled={busy[a.id] != null}
                        onclick={() => act(a.id, 'start')}
                        title={`Start: ${a.start_cmd}`}
                      >
                        <Play size={13} />
                      </button>
                    {:else}
                      <a class="b-btn icon" href={`/apps/${a.id}`} title="No start command — click to configure">
                        <Settings2 size={13} />
                      </a>
                    {/if}
                  {:else if s.managedPid}
                    <button
                      class="b-btn icon danger"
                      disabled={busy[a.id] != null}
                      onclick={() => act(a.id, 'stop')}
                      title="Stop"
                    >
                      <Square size={13} />
                    </button>
                    <button
                      class="b-btn icon"
                      disabled={busy[a.id] != null}
                      onclick={() => act(a.id, 'restart')}
                      title="Restart"
                    >
                      <RotateCw size={13} />
                    </button>
                  {/if}
                  <a class="b-btn icon" href={`/apps/${a.id}/logs`} title="Logs">
                    <Clock size={13} />
                  </a>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
    <div class="grid">
      {#each items as a (a.id)}
        {@const s = livestate[a.id]}
        <article class="b-surface card">
          <header class="card-head">
            <div class="title">
              <span
                class="b-dot"
                class:up={s?.up}
                class:down={s && !s.up}
                class:idle={!s}
              ></span>
              <a href={`/apps/${a.id}`} class="name">{a.name}</a>
            </div>
            <div class="meta">
              {#if a.port}
                <span class="b-pill" title={a.port + ''}>:{a.port}</span>
              {/if}
              <span class="b-pill">{a.kind}</span>
            </div>
          </header>

          <div class="body">
            <div class="path b-mono b-mute2" title={a.project_path}>{a.project_path}</div>

            {#if s}
              <div class="status">
                {#if s.up}
                  {#if s.managedPid}
                    <span class="b-pill">managed · pid {s.managedPid} · {fmtSince(s.managedSince)}</span>
                  {:else if s.listenerPid}
                    <span class="b-pill" title={s.listenerCmd ?? ''}>
                      external · pid {s.listenerPid}{s.listenerCmd ? ` · ${s.listenerCmd}` : ''}
                    </span>
                  {:else}
                    <span class="b-pill">up</span>
                  {/if}
                  {#if s.latencyMs != null}
                    <span class="b-pill">{s.latencyMs}ms</span>
                  {/if}
                {:else}
                  <span class="b-pill">down</span>
                {/if}
                {#if s.tailscale}
                  <span
                    class="b-pill ts"
                    class:funnel={s.tailscale.funnel}
                    class:stale={!s.up}
                    title={!s.up
                      ? `Mapped via tailscale but target :${a.port} is dead — clicking would 502`
                      : s.tailscale.funnel
                      ? `Public funnel: ${tailscaleHost}:${s.tailscale.port}`
                      : `Tailnet-only: ${tailscaleHost}:${s.tailscale.port}`}
                  >
                    {s.tailscale.funnel ? 'funnel' : 'tailnet'} :{s.tailscale.port}
                    {#if !s.up}· 502{/if}
                  </span>
                {/if}
              </div>
            {/if}
          </div>

          <footer class="actions">
            {#if a.port && s?.up}
              {@const u = openUrl(a.port, s.tailscale)}
              {#if u}
                <a class="b-btn" href={u} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} /> Open
                </a>
              {/if}
            {/if}
            <a class="b-btn" href={`vscode://file${a.project_path}`}>
              <Folder size={13} /> VS Code
            </a>
            {#if !s?.up}
              {#if a.start_cmd}
                <button
                  class="b-btn primary"
                  disabled={busy[a.id] != null}
                  onclick={() => act(a.id, 'start')}
                  title={`Start: ${a.start_cmd}`}
                >
                  <Play size={13} /> Start
                </button>
              {:else}
                <a class="b-btn" href={`/apps/${a.id}`} title="No start command set yet">
                  <Settings2 size={13} /> Configure
                </a>
              {/if}
            {:else if s.managedPid}
              <button
                class="b-btn danger"
                disabled={busy[a.id] != null}
                onclick={() => act(a.id, 'stop')}
              >
                <Square size={13} /> Stop
              </button>
              <button
                class="b-btn"
                disabled={busy[a.id] != null}
                onclick={() => act(a.id, 'restart')}
              >
                <RotateCw size={13} /> Restart
              </button>
            {/if}
            <a class="b-btn" href={`/apps/${a.id}/logs`}>
              <Clock size={13} /> Logs
            </a>
          </footer>
        </article>
      {/each}
    </div>
    {/if}
  </section>
{/each}

<style>
  .head {
    padding: 8px 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .head h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .head p { margin: 4px 0 0; font-size: 13px; }
  .viewtoggle { display: flex; gap: 4px; }
  .viewtoggle .b-btn.active {
    background: var(--b-accent);
    color: #fff;
    border-color: transparent;
  }
  .b-pill.viewbadge {
    margin-left: 6px;
    border-color: var(--b-border-2);
  }
  .b-pill.warn {
    margin-left: 6px;
    color: var(--b-warn);
    border-color: color-mix(in oklab, var(--b-warn) 35%, var(--b-border));
  }
  .b-pill.ts {
    color: var(--b-info);
    border-color: color-mix(in oklab, var(--b-info) 30%, var(--b-border));
    background: color-mix(in oklab, var(--b-info) 10%, var(--b-surface-2));
  }
  .b-pill.ts.funnel {
    color: var(--b-accent);
    border-color: color-mix(in oklab, var(--b-accent) 35%, var(--b-border));
    background: color-mix(in oklab, var(--b-accent) 12%, var(--b-surface-2));
  }
  .b-pill.ts.stale {
    /* tailscale mapping exists but the proxy target is dead — user would hit 502 */
    color: var(--b-bad);
    border-color: color-mix(in oklab, var(--b-bad) 28%, var(--b-border));
    background: color-mix(in oklab, var(--b-bad) 8%, var(--b-surface-2));
    text-decoration: line-through;
    text-decoration-color: color-mix(in oklab, var(--b-bad) 60%, transparent);
  }

  .group { margin-top: 18px; }
  .group-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 6px 0 10px;
  }
  .group h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--b-text-3);
    margin: 0;
    font-weight: 600;
  }
  .bulk { display: flex; gap: 6px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .card { padding: 12px 12px 10px; display: flex; flex-direction: column; gap: 10px; }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    color: var(--b-text);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name:hover { color: var(--b-accent); }
  .meta { display: flex; gap: 4px; flex-shrink: 0; }
  .body { display: flex; flex-direction: column; gap: 6px; }
  .path { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { display: flex; flex-wrap: wrap; gap: 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }

  /* List view — compact table */
  .listwrap { overflow-x: auto; padding: 0; }
  .list {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  .list thead th {
    text-align: left;
    padding: 8px 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--b-text-3);
    font-weight: 500;
    background: var(--b-surface-2);
    border-bottom: 1px solid var(--b-border);
    position: sticky;
    top: 0;
  }
  .list tbody td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--b-border);
    vertical-align: middle;
  }
  .list tbody tr:last-child td { border-bottom: none; }
  .list tbody tr:hover { background: color-mix(in oklab, var(--b-surface-2) 50%, transparent); }
  .list .col-st { width: 16px; padding-left: 12px; padding-right: 0; }
  .list .col-port { width: 70px; }
  .list .col-kind { width: 70px; font-size: 11px; }
  .list .col-meta { white-space: nowrap; }
  .list .col-path {
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
  }
  .list .col-act {
    width: 130px;
    text-align: right;
    white-space: nowrap;
  }
  .list .col-act .b-btn.icon {
    padding: 4px 6px;
    margin-left: 2px;
  }
  .list .col-name .name {
    font-weight: 500;
    color: var(--b-text);
    text-decoration: none;
  }
  .list .col-name .name:hover { color: var(--b-accent); }
  @media (max-width: 720px) {
    .list .col-path, .list .col-kind { display: none; }
  }
</style>
