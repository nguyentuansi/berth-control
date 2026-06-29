<script lang="ts">
  import { Plus, FolderOpen } from 'lucide-svelte';

  // Big empty-state hero shown when berth-control has zero apps registered.
  // Surfaces the primary "Add app" CTA + a short explainer of what berth does.

  let {
    onAddApp,
    canAdd
  }: {
    onAddApp: () => void;
    canAdd: boolean;
  } = $props();
</script>

<section class="empty">
  <div class="icon">
    <FolderOpen size={42} />
  </div>
  <h2>No apps yet</h2>
  <p>
    Berth-control is a thin spawn-and-monitor layer for your local dev servers.
    Add an app, pick its start command, and berth will track it, expose it on
    your tailnet, and surface its status here.
  </p>
  {#if canAdd}
    <button class="b-btn primary" onclick={onAddApp}>
      <Plus size={14} /> Add your first app
    </button>
  {:else}
    <p class="hint">Ask an admin to add the first app for this workspace.</p>
  {/if}
</section>

<style>
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 60px 24px;
    max-width: 460px;
    margin: 40px auto;
    gap: 12px;
  }
  .icon {
    color: var(--b-text-3);
    margin-bottom: 8px;
  }
  h2 {
    font-size: 22px;
    font-weight: 600;
    margin: 0;
    color: var(--b-text);
  }
  p {
    color: var(--b-text-2);
    font-size: 14px;
    line-height: 1.55;
    margin: 0;
  }
  .hint {
    font-size: 12.5px;
    color: var(--b-text-3);
  }
  button {
    margin-top: 8px;
  }
</style>
