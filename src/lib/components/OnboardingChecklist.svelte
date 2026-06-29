<script lang="ts">
  import { Check, Circle } from 'lucide-svelte';

  // Compact 3-item checklist surfaced on the dashboard while the user is
  // still in onboarding. Items light up as each milestone is reached.
  // Auto-hides itself when all 3 are done — the parent gates rendering
  // via `data.tourCompleted == null && data.apps.length > 0` etc.

  let {
    addedAnApp,
    startedAnApp,
    sawGreen
  }: {
    addedAnApp: boolean;
    startedAnApp: boolean;
    sawGreen: boolean;
  } = $props();

  const steps = $derived([
    { done: addedAnApp, label: 'Add your first app' },
    { done: startedAnApp, label: 'Start it' },
    { done: sawGreen, label: 'Watch it go green' }
  ]);
  const allDone = $derived(steps.every((s) => s.done));
</script>

{#if !allDone}
  <aside class="checklist" aria-label="Onboarding progress">
    <div class="head">
      <strong>Getting started</strong>
      <span class="count">{steps.filter((s) => s.done).length} / {steps.length}</span>
    </div>
    <ul>
      {#each steps as s}
        <li class:done={s.done}>
          {#if s.done}<Check size={13} />{:else}<Circle size={13} />{/if}
          <span>{s.label}</span>
        </li>
      {/each}
    </ul>
  </aside>
{/if}

<style>
  .checklist {
    position: fixed;
    right: 16px;
    top: 80px;
    width: 220px;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 10px;
    padding: 10px 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    z-index: 30;
    font-size: 12.5px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }
  .count {
    color: var(--b-text-3);
    font-family: var(--b-mono);
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--b-text-2);
  }
  li.done {
    color: var(--b-ok);
    text-decoration: line-through;
    text-decoration-color: color-mix(in oklab, var(--b-ok) 50%, transparent);
  }
</style>
