<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { X, Maximize2, Minimize2, ExternalLink } from 'lucide-svelte';

  // Floating mini log window that appears bottom-right after starting an app.
  // Streams the live stdout/stderr from /api/apps/[id]/logs (SSE) until the
  // user closes it or expands to the full logs page. ANSI is stripped so
  // vite/wrangler colour codes don't render as literal escape sequences.

  let {
    appId,
    appName,
    port,
    tailscaleHost,
    expanded,
    onClose,
    onToggleExpand
  }: {
    appId: string;
    appName: string;
    port: number | null;
    tailscaleHost: string | null;
    expanded: boolean;
    onClose: () => void;
    onToggleExpand: () => void;
  } = $props();

  type Line = { id: number; ts: number; stream: 'stdout' | 'stderr'; line: string };
  let lines: Line[] = $state([]);
  let pre: HTMLElement | undefined = $state();
  let es: EventSource | null = null;

  const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  const stripAnsi = (s: string) => s.replace(ANSI_CSI, '');

  const tailnetUrl = $derived(
    tailscaleHost && port ? `https://${tailscaleHost}:${port}/` : null
  );

  onMount(() => {
    es = new EventSource(`/api/apps/${encodeURIComponent(appId)}/logs`);
    es.addEventListener('log', async (m) => {
      try {
        const j = JSON.parse((m as MessageEvent).data) as Line;
        j.line = stripAnsi(j.line);
        lines.push(j);
        if (lines.length > 400) lines = lines.slice(-400);
        await Promise.resolve();
        if (pre) pre.scrollTop = pre.scrollHeight;
      } catch {
        /* */
      }
    });
  });
  onDestroy(() => es?.close());
</script>

<aside class="mini" class:expanded role="complementary" aria-label={`Live log for ${appName}`}>
  <header>
    <span class="title">
      <span class="dot live" aria-hidden="true"></span>
      <strong>{appName}</strong>
      {#if port}<span class="port b-mono">:{port}</span>{/if}
    </span>
    <span class="actions">
      {#if tailnetUrl}
        <a class="b-btn icon tiny" href={tailnetUrl} target="_blank" rel="noopener" title="Open on tailnet">
          <ExternalLink size={11} />
        </a>
      {/if}
      <a class="b-btn icon tiny" href={`/apps/${appId}/logs`} title="Full logs">
        <Maximize2 size={11} />
      </a>
      <button class="b-btn icon tiny" onclick={onToggleExpand} title={expanded ? 'Collapse' : 'Expand'}>
        {#if expanded}<Minimize2 size={11} />{:else}<Maximize2 size={11} />{/if}
      </button>
      <button class="b-btn icon tiny" onclick={onClose} title="Close">
        <X size={11} />
      </button>
    </span>
  </header>
  <pre bind:this={pre} class="body b-mono">{#each lines as l (l.id)}<span class={l.stream}><span class="ts">{new Date(l.ts).toLocaleTimeString()}</span> {l.line}
</span>{/each}{#if lines.length === 0}<span class="empty">waiting for output…</span>{/if}</pre>
</aside>

<style>
  .mini {
    position: fixed;
    right: 16px;
    bottom: 16px;
    width: 420px;
    height: 260px;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
    display: flex;
    flex-direction: column;
    z-index: 50;
    overflow: hidden;
  }
  .mini.expanded {
    width: 720px;
    height: 480px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    background: var(--b-surface-2);
    border-bottom: 1px solid var(--b-border);
    font-size: 12.5px;
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .dot.live {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--b-ok);
    box-shadow: 0 0 0 3px color-mix(in oklab, var(--b-ok) 22%, transparent);
  }
  .port {
    color: var(--b-text-3);
  }
  .actions {
    display: inline-flex;
    gap: 3px;
  }
  .body {
    flex: 1;
    margin: 0;
    padding: 8px 10px;
    overflow: auto;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .body .stdout {
    color: var(--b-text);
    display: block;
  }
  .body .stderr {
    color: var(--b-bad);
    display: block;
  }
  .body .empty {
    color: var(--b-text-3);
  }
  /* Same timestamp styling as the full /apps/[id]/logs page so the two
     views render identically (user request: mini and full must match). */
  .body .ts {
    color: var(--b-text-3);
    margin-right: 6px;
    user-select: none;
  }
</style>
