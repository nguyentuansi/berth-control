<script lang="ts">
  import { X, TriangleAlert } from 'lucide-svelte';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '$lib/toast.js';

  // Confirm-and-delete modal for removing an app from berth's registry. The
  // child-count warning surfaces the cascade behavior — removing a monorepo
  // root also removes every sub-app underneath, so the user can see the
  // damage radius before clicking through.

  type App = { id: string; name: string };

  let {
    app,
    childCount,
    onClose
  }: {
    app: App;
    childCount: number;
    onClose: () => void;
  } = $props();

  let busy = $state(false);
  let alsoStop = $state(true);

  async function confirm() {
    busy = true;
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(app.id)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stop: alsoStop, cascade: childCount > 0 })
      });
      if (!r.ok) {
        toast.error('Remove failed', await r.text());
        return;
      }
      toast.success(`${app.name} removed`);
      onClose();
      await invalidateAll();
    } finally {
      busy = false;
    }
  }
</script>

<div
  class="scrim"
  role="presentation"
  onclick={(e) => {
    if (e.target === e.currentTarget) onClose();
  }}
>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="rm-title">
    <header>
      <h2 id="rm-title">
        <TriangleAlert size={16} /> Remove {app.name}?
      </h2>
      <button class="b-btn icon tiny" onclick={onClose} title="Close">
        <X size={12} />
      </button>
    </header>
    <div class="body">
      <p>
        This removes <strong>{app.name}</strong> from berth's registry.
        {#if childCount > 0}
          It also removes <strong>{childCount} sub-app{childCount === 1 ? '' : 's'}</strong>
          registered under it (cascade).
        {/if}
      </p>
      <p class="muted">
        The project directory on disk is untouched. Run history and logs are
        preserved, but the app no longer appears on the dashboard.
      </p>
      <label class="chk">
        <input type="checkbox" bind:checked={alsoStop} />
        Also stop the running process (if any) before removing
      </label>
    </div>
    <footer>
      <button class="b-btn" onclick={onClose} disabled={busy}>Cancel</button>
      <button class="b-btn danger" onclick={confirm} disabled={busy}>
        {busy ? 'Removing…' : `Remove ${app.name}`}
      </button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: grid;
    place-items: center;
    z-index: 100;
  }
  .modal {
    width: 440px;
    max-width: 90vw;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 10px;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px;
    border-bottom: 1px solid var(--b-border);
  }
  header h2 {
    margin: 0;
    font-size: 14.5px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--b-bad);
  }
  .body {
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
    line-height: 1.5;
  }
  .body p {
    margin: 0;
  }
  .muted {
    color: var(--b-text-2);
    font-size: 12px;
  }
  .chk {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--b-border);
    background: var(--b-surface-2);
  }
</style>
