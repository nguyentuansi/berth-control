<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Save, Play, Square, Trash2 } from 'lucide-svelte';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();
  let name = $state('');
  let busy: number | null = $state(null);

  async function save() {
    if (!name.trim()) return;
    const r = await fetch('/api/snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', name: name.trim() })
    });
    if (!r.ok) alert(await r.text());
    name = '';
    await invalidateAll();
  }
  async function call(action: 'apply' | 'delete' | 'stop', id: number) {
    busy = id;
    try {
      const r = await fetch('/api/snapshots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, id })
      });
      if (!r.ok) alert(await r.text());
      await invalidateAll();
    } finally {
      busy = null;
    }
  }
</script>

<h1>Snapshots</h1>
<p class="b-muted">
  Save the current set of running apps under a name (e.g. <em>"review mode"</em> or
  <em>"database stack"</em>) and restore it later with one click.
</p>

<form onsubmit={(e) => { e.preventDefault(); save(); }} class="saver b-surface">
  <input class="b-input" placeholder="snapshot name…" bind:value={name} />
  <button class="b-btn primary" type="submit"><Save size={13} /> Save current</button>
</form>

<ul class="snaps">
  {#each data.snapshots as s (s.id)}
    {@const ids = JSON.parse(s.app_ids) as string[]}
    <li class="b-surface">
      <header>
        <div>
          <strong>{s.name}</strong>
          <span class="b-mute2 b-mono"> · {ids.length} app{ids.length === 1 ? '' : 's'} · {s.created_at.toLocaleString()}</span>
        </div>
        <div class="row">
          <button class="b-btn primary" disabled={busy === s.id} onclick={() => call('apply', s.id)}>
            <Play size={13} /> Apply
          </button>
          <button class="b-btn danger" disabled={busy === s.id} onclick={() => call('stop', s.id)}>
            <Square size={13} /> Stop all
          </button>
          <button class="b-btn" disabled={busy === s.id} onclick={() => call('delete', s.id)}>
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </header>
      <ul class="ids">
        {#each ids as id}
          <li>{data.byId[id] ?? id}</li>
        {/each}
      </ul>
    </li>
  {:else}
    <li class="empty b-mute2">No snapshots yet — start the apps you want, then save.</li>
  {/each}
</ul>

<style>
  h1 { font-size: 22px; font-weight: 600; margin: 6px 0 8px; }
  .saver { display: flex; gap: 8px; padding: 10px; margin: 14px 0 18px; }
  .saver input { flex: 1; }
  .snaps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
  .snaps > li { padding: 12px; }
  .snaps header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
  .row { display: flex; gap: 6px; }
  .ids { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .ids li { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--b-surface-2); border: 1px solid var(--b-border); font-family: var(--b-mono); color: var(--b-text-2); }
  .empty { padding: 12px; }
</style>
