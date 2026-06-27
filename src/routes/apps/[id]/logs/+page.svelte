<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { ChevronLeft, Search, Download, ArrowDown } from 'lucide-svelte';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  type Line = { id: number; ts: number; stream: 'stdout' | 'stderr'; line: string };
  let lines: Line[] = $state([]);
  let runId: number | null = $state(data.openRun?.id ?? data.recent[0]?.id ?? null);
  let filter = $state('');
  let onlyStderr = $state(false);
  // `stickToBottom` is auto-managed: it's true when the user is at (or
  // within 40px of) the bottom of the scroll area, false the moment they
  // scroll up. New log lines only force a scroll-to-bottom while this is
  // true — so reading history isn't a tug-of-war with the live tail.
  let stickToBottom = $state(true);
  let pre: HTMLElement | undefined = $state();
  let es: EventSource | null = null;

  // Vite / wrangler / cargo etc. all write ANSI color escapes assuming a tty.
  // Strip CSI sequences so they don't render as literal `[36m` noise.
  const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const stripAnsi = (s: string) => s.replace(ANSI_CSI, '');

  function isAtBottom(): boolean {
    if (!pre) return true;
    return pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  }

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
        // Only snap to bottom when the user is ALREADY there. If they
        // scrolled up to read an earlier line, we leave them where they
        // are and let them choose to come back via "Jump to bottom".
        if (stickToBottom && isAtBottom()) {
          await tick();
          pre?.scrollTo({ top: pre.scrollHeight });
        }
      } catch {
        /* */
      }
    });
  }

  // `$effect` reads `runId` so this re-runs ONCE per runId change (and once
  // on mount). The previous code ALSO registered onMount(connect) which
  // double-fired connect() on initial mount — two live EventSources, each
  // replaying history, lines double, auto-scroll fires twice per line. Gone.
  $effect(() => {
    connect();
  });
  onDestroy(() => es?.close());

  // Watch the user's scroll position. If they scroll away from the bottom
  // we drop `stickToBottom`; if they scroll back we re-enable it. The
  // user's intent is encoded entirely in their scroll position.
  function onScroll() {
    stickToBottom = isAtBottom();
  }
  function jumpToBottom() {
    if (!pre) return;
    pre.scrollTo({ top: pre.scrollHeight });
    stickToBottom = true;
  }

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
    <span class="chk follow-state" title={stickToBottom ? 'live tail' : 'paused (scroll up — click Jump to resume)'}>
      <span class="follow-dot" class:on={stickToBottom}></span>
      {stickToBottom ? 'following' : 'paused'}
    </span>
    <button class="b-btn" onclick={downloadAll}>
      <Download size={13} /> Download
    </button>
  </div>
</header>

<div class="logwrap">
  <pre bind:this={pre} class="logview b-surface b-mono" onscroll={onScroll}>{#each filtered as l (l.id)}<span class={l.stream}><span class="ts">{new Date(l.ts).toLocaleTimeString()}</span> {l.line}</span>{/each}{#if filtered.length === 0}<span class="empty">— no lines yet —</span>{/if}</pre>
  {#if !stickToBottom}
    <button class="b-btn jump" onclick={jumpToBottom} title="Jump to latest">
      <ArrowDown size={13} /> Latest
    </button>
  {/if}
</div>

<style>
  .crumb { font-size: 13px; margin: 4px 0 8px; }
  .crumb a { color: var(--b-text-2); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin: 6px 0 12px; }
  .head h1 { font-size: 22px; font-weight: 600; margin: 0; }
  .tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .picker, .srch, .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--b-text-2); }
  .picker span { font-size: 11px; }

  .logwrap {
    position: relative;
  }
  .logview {
    height: calc(100vh - 200px);
    min-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    /* Hint the browser this scroller is its own scroll context — avoids
       reflowing the whole page on every wheel tick when there are 5000+
       lines. Crucial for crashed apps that dumped a huge error spew. */
    contain: strict;
    overscroll-behavior: contain;
  }
  .jump {
    position: absolute;
    right: 18px;
    bottom: 14px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    background: var(--b-accent);
    color: var(--b-bg);
    border-color: transparent;
  }
  /* "following / paused" pill — replaces the manual checkbox; the dot's
     color signals whether new lines auto-scroll. */
  .follow-state {
    user-select: none;
  }
  .follow-dot {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--b-text-3);
  }
  .follow-dot.on {
    background: var(--b-ok);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--b-ok) 25%, transparent);
  }
  .logview .stderr { color: var(--b-bad); display: block; }
  .logview .stdout { color: var(--b-text); display: block; }
  .logview .ts { color: var(--b-text-3); margin-right: 6px; }
  .logview .empty { color: var(--b-text-3); }
</style>
