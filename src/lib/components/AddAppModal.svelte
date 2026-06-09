<script lang="ts">
  import { Folder, FolderUp, ChevronRight, X, Loader2 } from 'lucide-svelte';
  import { toast } from '$lib/toast.js';
  import { invalidateAll } from '$app/navigation';

  let { open = $bindable(false) }: { open?: boolean } = $props();

  type Stage = 'browse' | 'configure';
  let stage: Stage = $state('browse');

  type Entry = { name: string; path: string };
  type Listing = { path: string; parent: string | null; name: string; entries: Entry[] };
  let listing: Listing | null = $state(null);
  let browsing = $state(false);
  let showHidden = $state(false);

  let form = $state({
    project_path: '',
    name: '',
    port: '' as string | number,
    kind: 'shell',
    start_cmd: '',
    start_cmd_reason: '' as string | null
  });
  let sniffing = $state(false);
  let submitting = $state(false);

  async function load(path?: string) {
    browsing = true;
    try {
      const u = new URL('/api/fs', window.location.origin);
      if (path) u.searchParams.set('path', path);
      if (showHidden) u.searchParams.set('hidden', '1');
      const r = await fetch(u);
      if (!r.ok) {
        toast.error('Browse failed', await r.text().then((t) => t.slice(0, 200)));
        return;
      }
      listing = (await r.json()) as Listing;
    } finally {
      browsing = false;
    }
  }

  $effect(() => {
    if (open && stage === 'browse' && !listing) {
      void load();
    }
  });

  // Lock the underlying page scroll whenever the modal is open — the dashboard
  // can scroll arbitrarily long, and that movement behind the backdrop while
  // the user navigates the folder picker is disorienting. Restores the prior
  // overflow value on close (in case something else had already set it).
  $effect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  });

  function reset() {
    stage = 'browse';
    listing = null;
    form = {
      project_path: '',
      name: '',
      port: '',
      kind: 'shell',
      start_cmd: '',
      start_cmd_reason: ''
    };
  }

  function close() {
    open = false;
    setTimeout(reset, 150);
  }

  async function useThisFolder() {
    if (!listing) return;
    sniffing = true;
    try {
      const u = new URL('/api/apps', window.location.origin);
      u.searchParams.set('path', listing.path);
      const r = await fetch(u);
      if (!r.ok) {
        toast.error('Couldn’t sniff folder', await r.text().then((t) => t.slice(0, 200)));
        return;
      }
      const sniff = await r.json();
      form.project_path = sniff.path;
      form.name = sniff.name;
      form.kind = sniff.kind;
      form.port = sniff.port ?? '';
      form.start_cmd = sniff.start_cmd ?? '';
      form.start_cmd_reason = sniff.start_cmd_reason ?? '';
      stage = 'configure';
    } finally {
      sniffing = false;
    }
  }

  async function submit() {
    submitting = true;
    const tid = toast.loading(`Registering ${form.name}…`);
    try {
      const r = await fetch('/api/apps', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project_path: form.project_path,
          name: form.name,
          port: form.port === '' ? null : Number(form.port),
          kind: form.kind,
          start_cmd: form.start_cmd || null
        })
      });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'Add failed',
          description: (await r.text()).slice(0, 240),
          durationMs: 10_000
        });
        return;
      }
      toast.update(tid, {
        kind: 'success',
        title: `${form.name} registered`,
        durationMs: 3000
      });
      close();
      await invalidateAll();
    } finally {
      submitting = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
</script>

{#if open}
  <div
    class="overlay"
    role="dialog"
    aria-modal="true"
    aria-label="Add app"
    onkeydown={onKey}
    tabindex="-1"
  >
    <div class="backdrop" onclick={close} role="presentation"></div>
    <div class="panel b-surface">
      <header>
        <h2>{stage === 'browse' ? 'Pick a project folder' : 'Confirm new app'}</h2>
        <button class="iconbtn" onclick={close} aria-label="Close"><X size={14} /></button>
      </header>

      {#if stage === 'browse'}
        <div class="pathbar b-mono">
          {#if listing?.parent}
            <button
              class="b-btn small"
              onclick={() => load(listing!.parent!)}
              title="Go up to {listing.parent}"
              disabled={browsing}
            >
              <FolderUp size={13} /> ..
            </button>
          {/if}
          <span class="here">{listing?.path ?? '…'}</span>
          <label class="hidden-toggle">
            <input type="checkbox" bind:checked={showHidden} onchange={() => load(listing?.path)} />
            show hidden
          </label>
        </div>

        <div class="list">
          {#if browsing && !listing}
            <div class="empty"><Loader2 size={14} class="spin" /> loading…</div>
          {:else if listing}
            {#each listing.entries as e (e.path)}
              <button class="row" onclick={() => load(e.path)} disabled={browsing}>
                <Folder size={14} />
                <span class="name">{e.name}</span>
                <ChevronRight size={12} />
              </button>
            {/each}
            {#if listing.entries.length === 0}
              <div class="empty">(no subdirectories)</div>
            {/if}
          {/if}
        </div>

        <footer>
          <button class="b-btn" onclick={close}>Cancel</button>
          <button
            class="b-btn primary"
            onclick={useThisFolder}
            disabled={!listing || browsing || sniffing}
          >
            {#if sniffing}
              <Loader2 size={13} class="spin" /> Inspecting…
            {:else}
              Use this folder
            {/if}
          </button>
        </footer>
      {:else}
        <div class="formgrid">
          <label>
            <span>Path</span>
            <input class="b-input b-mono" bind:value={form.project_path} disabled />
          </label>
          <label>
            <span>Name</span>
            <input class="b-input" bind:value={form.name} placeholder="Display name" />
          </label>
          <div class="row2">
            <label>
              <span>Port</span>
              <input
                class="b-input b-mono"
                bind:value={form.port}
                placeholder="auto"
                inputmode="numeric"
              />
              <small class="hint">
                {#if form.port}
                  auto-picked next to siblings; edit if you want a different one
                {:else}
                  blank → Berth picks the next free port in this project's cluster
                {/if}
              </small>
            </label>
            <label>
              <span>Kind</span>
              <select class="b-input" bind:value={form.kind}>
                {#each ['vite', 'wrangler', 'bun', 'node', 'cargo', 'gradle', 'java', 'python', 'docker', 'shell'] as k (k)}
                  <option value={k}>{k}</option>
                {/each}
              </select>
            </label>
          </div>
          <label>
            <span>Start command</span>
            <input
              class="b-input b-mono"
              bind:value={form.start_cmd}
              placeholder="e.g. bun run dev"
            />
            {#if form.start_cmd_reason}
              <small class="hint">suggested from {form.start_cmd_reason}</small>
            {/if}
          </label>
        </div>

        <footer>
          <button class="b-btn" onclick={() => (stage = 'browse')} disabled={submitting}>
            Back
          </button>
          <button
            class="b-btn primary"
            onclick={submit}
            disabled={submitting || !form.name || !form.project_path}
          >
            {#if submitting}
              <Loader2 size={13} class="spin" /> Adding…
            {:else}
              Add app
            {/if}
          </button>
        </footer>
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: color-mix(in oklab, #000 38%, transparent);
    backdrop-filter: blur(2px);
  }
  .panel {
    position: relative;
    width: min(640px, 100%);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    padding: 0;
    border-radius: 14px;
    box-shadow: 0 30px 80px rgba(0, 0, 0, 0.28);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--b-border);
  }
  header h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .iconbtn {
    background: transparent;
    border: 0;
    color: var(--b-text-3);
    cursor: pointer;
    padding: 4px;
    border-radius: 6px;
  }
  .iconbtn:hover { background: var(--b-surface-2); color: var(--b-text); }

  .pathbar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--b-border);
    font-size: 12px;
  }
  .pathbar .here {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--b-text-2);
  }
  .hidden-toggle {
    font-size: 11.5px;
    color: var(--b-text-3);
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .list {
    overflow-y: auto;
    flex: 1;
    padding: 6px 8px;
    min-height: 220px;
  }
  .row {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 0;
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--b-text);
    font: inherit;
    font-size: 13px;
  }
  .row:hover { background: var(--b-surface-2); }
  .row .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    color: var(--b-text-3);
    font-size: 12px;
    padding: 16px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .formgrid {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
  }
  .formgrid label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11.5px;
    color: var(--b-text-2);
  }
  .formgrid .row2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .hint {
    font-size: 10.5px;
    color: var(--b-text-3);
    margin-top: 2px;
    font-family: var(--b-mono);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--b-border);
  }
</style>
