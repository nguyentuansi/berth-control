<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { ChevronLeft, Search, Download } from 'lucide-svelte';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  type Line = { id: number; ts: number; stream: 'stdout' | 'stderr'; line: string };
  let lines: Line[] = $state([]);
  let runId: number | null = $state(data.openRun?.id ?? data.recent[0]?.id ?? null);
  let filter = $state('');
  let onlyStderr = $state(false);
  let stickToBottom = $state(true);
  let pre: HTMLElement | undefined = $state();
  let es: EventSource | null = null;

  // Vite / wrangler / cargo etc. all write ANSI color escapes assuming a tty.
  // Strip CSI sequences so they don't render as literal `[36m` noise.
  const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const stripAnsi = (s: string) => s.replace(ANSI_CSI, '');

  function connect() {
    es?.close();
    lines = [];
    if (!runId) return;
    es = new EventSource(`/api/apps/${data.app.id}/logs?run=${runId}`);
    es.addEventListener('log', async (m) => {
      try {
        const j = JSON.parse((m as MessageEvent).data) as Line;
        j.line = stripAnsi(j.line);
        lines = [...lines.slice(-4999), j];
        if (stickToBottom) {
          await tick();
          pre?.scrollTo({ top: pre.scrollHeight });
        }
      } catch {
        /* */
      }
    });
  }

  $effect(() => {
    connect();
  });
  onMount(() => connect());
  onDestroy(() => es?.close());

  const filtered = $derived(
    lines.filter((l) => {
      if (onlyStderr && l.stream !== 'stderr') return false;
      if (filter && !l.line.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    })
  );

  function downloadAll() {
    const txt = lines.map((l) => l.line).join('\n');
    const blob = new Blob([txt], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.app.id}-run-${runId}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }
</script>

<nav class="crumb">
  <a href={`/apps/${data.app.id}`}><ChevronLeft size={14} /> {data.app.name}</a>
</nav>

<header class="head">
  <h1>Logs</h1>
  <div class="tools">
    <label class="picker">
      <span>Run</span>
      <select class="b-input" bind:value={runId}>
        {#each data.recent as r}
          <option value={r.id}>
            #{r.id} · {r.started_at.toLocaleString()}
            {#if !r.stopped_at}· live{:else}· exit {r.exit_code ?? '—'}{/if}
          </option>
        {/each}
      </select>
    </label>
    <label class="srch">
      <Search size={14} />
      <input class="b-input" placeholder="filter…" bind:value={filter} />
    </label>
    <label class="chk">
      <input type="checkbox" bind:checked={onlyStderr} /> stderr only
    </label>
    <label class="chk">
      <input type="checkbox" bind:checked={stickToBottom} /> follow
    </label>
    <button class="b-btn" onclick={downloadAll}>
      <Download size={13} /> Download
    </button>
  </div>
</header>

<pre bind:this={pre} class="logview b-surface b-mono">{#each filtered as l (l.id)}<span class={l.stream}><span class="ts">{new Date(l.ts).toLocaleTimeString()}</span> {l.line}</span>{/each}{#if filtered.length === 0}<span class="empty">— no lines yet —</span>{/if}</pre>

<style>
  .crumb { font-size: 13px; margin: 4px 0 8px; }
  .crumb a { color: var(--b-text-2); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin: 6px 0 12px; }
  .head h1 { font-size: 22px; font-weight: 600; margin: 0; }
  .tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .picker, .srch, .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--b-text-2); }
  .picker span { font-size: 11px; }

  .logview {
    height: calc(100vh - 200px);
    min-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .logview .stderr { color: var(--b-bad); display: block; }
  .logview .stdout { color: var(--b-text); display: block; }
  .logview .ts { color: var(--b-text-3); margin-right: 6px; }
  .logview .empty { color: var(--b-text-3); }
</style>
