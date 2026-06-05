<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { Search, Play, Square, RotateCw, Activity, ListPlus, Settings } from 'lucide-svelte';

  type App = { id: string; name: string; port: number | null; project_path: string };
  let { apps }: { apps: App[] } = $props();

  let open = $state(false);
  let q = $state('');
  let idx = $state(0);
  let input: HTMLInputElement | undefined = $state();

  type Item =
    | { kind: 'app'; id: string; label: string; sub: string; href: string }
    | { kind: 'action'; id: string; label: string; sub: string; run: () => void | Promise<void> };

  const baseActions: Item[] = $derived([
    { kind: 'action', id: 'go-import', label: 'Re-import PORTS.md', sub: 'go to /import', run: () => goto('/import') },
    { kind: 'action', id: 'go-settings', label: 'Settings', sub: 'go to /settings', run: () => goto('/settings') },
    { kind: 'action', id: 'go-dashboard', label: 'Dashboard', sub: 'go to /', run: () => goto('/') },
    {
      kind: 'action',
      id: 'reap-orphans',
      label: 'Reap orphans (kill stale workerd/vite)',
      sub: 'POST /api/reap',
      run: async () => {
        const r = await fetch('/api/reap', { method: 'POST' });
        alert(await r.text());
      }
    }
  ]);

  const items = $derived(() => {
    const lower = q.trim().toLowerCase();
    const appItems: Item[] = apps.map((a) => ({
      kind: 'app',
      id: a.id,
      label: a.name,
      sub: `${a.port ? `:${a.port} · ` : ''}${a.project_path}`,
      href: `/apps/${a.id}`
    }));
    const all = [...appItems, ...baseActions];
    if (!lower) return all.slice(0, 30);
    return all
      .filter((i) => i.label.toLowerCase().includes(lower) || i.sub.toLowerCase().includes(lower))
      .slice(0, 30);
  });

  function onKey(e: KeyboardEvent) {
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === 'k' &&
      !e.altKey
    ) {
      e.preventDefault();
      open = true;
      setTimeout(() => input?.focus(), 0);
      return;
    }
    if (e.key === 'Escape' && open) {
      open = false;
      return;
    }
  }

  function onListKey(e: KeyboardEvent) {
    const list = items();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = Math.min(idx + 1, list.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = Math.max(idx - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const sel = list[idx];
      if (!sel) return;
      pick(sel);
    }
  }

  function pick(i: Item) {
    open = false;
    if (i.kind === 'app') goto(i.href);
    else i.run();
  }

  $effect(() => {
    // Reset idx when query changes.
    void q;
    idx = 0;
  });

  onMount(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
</script>

{#if open}
  <div class="scrim" onclick={() => (open = false)} role="presentation">
    <div class="palette b-surface" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <div class="search">
        <Search size={14} />
        <input
          bind:this={input}
          bind:value={q}
          onkeydown={onListKey}
          placeholder="Search apps · actions · ⌘K to toggle"
          class="b-input"
          autocomplete="off"
        />
      </div>
      <ul>
        {#each items() as i, n (i.id)}
          <li class={n === idx ? 'sel' : ''} onmouseenter={() => (idx = n)} onclick={() => pick(i)}>
            <span class="lbl">{i.label}</span>
            <span class="sub b-mono b-mute2">{i.sub}</span>
          </li>
        {/each}
        {#if items().length === 0}
          <li class="empty b-mute2">No matches</li>
        {/if}
      </ul>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: color-mix(in oklab, #000 40%, transparent);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 14vh;
    z-index: 100;
  }
  .palette {
    width: min(640px, 92vw);
    padding: 0;
    overflow: hidden;
    box-shadow: 0 30px 80px -20px rgba(0, 0, 0, 0.35);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--b-border);
    background: var(--b-surface-2);
  }
  .search input {
    flex: 1;
    border: none;
    background: transparent;
    padding: 4px 0;
    font-size: 14px;
  }
  .search input:focus { outline: none; }
  ul {
    list-style: none;
    margin: 0;
    padding: 4px;
    max-height: 50vh;
    overflow: auto;
  }
  li {
    display: flex;
    flex-direction: column;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    gap: 2px;
  }
  li.sel { background: var(--b-surface-2); }
  .lbl { font-size: 13px; }
  .sub { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { padding: 14px; text-align: center; cursor: default; }
</style>
