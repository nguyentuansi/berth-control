<script lang="ts">
  import { Check, Circle, X, ArrowRight } from 'lucide-svelte';

  // 3-item checklist surfaced on the dashboard while the user hasn't
  // dismissed onboarding yet. Items are CLICKABLE — the active one (next
  // step) triggers the relevant action via callback props. Completed
  // items render as static checked rows. A skip button dismisses the
  // whole onboarding (parent persists via /api/onboarding/dismiss).

  let {
    addedAnApp,
    startedAnApp,
    sawGreen,
    onAddApp,
    onStartFirst,
    onSkip
  }: {
    addedAnApp: boolean;
    startedAnApp: boolean;
    sawGreen: boolean;
    /** Open the AddApp modal — fires when user clicks "Add your first app". */
    onAddApp?: () => void;
    /** Focus / scroll to a startable card — fires when user clicks "Start it". */
    onStartFirst?: () => void;
    /** Dismiss onboarding for this user — POSTs and invalidates. */
    onSkip?: () => void | Promise<void>;
  } = $props();

  let skipping = $state(false);

  const steps = $derived([
    {
      key: 'add',
      label: 'Add your first app',
      hint: 'Register a project directory as a berth app.',
      done: addedAnApp,
      onClick: onAddApp ?? null
    },
    {
      key: 'start',
      label: 'Start it',
      hint: 'Click the play icon on a card.',
      done: startedAnApp,
      onClick: onStartFirst ?? null
    },
    {
      key: 'green',
      label: 'Watch it go green',
      hint: 'The dot turns green once the app binds its port.',
      done: sawGreen,
      // No action — passive milestone reached by running the dev server.
      onClick: null
    }
  ]);
  const doneCount = $derived(steps.filter((s) => s.done).length);
  const allDone = $derived(doneCount === steps.length);
  // The "active" step is the first un-done one — only it is clickable.
  const activeKey = $derived(steps.find((s) => !s.done)?.key ?? null);

  async function handleSkip() {
    if (!onSkip) return;
    skipping = true;
    try {
      await onSkip();
    } finally {
      skipping = false;
    }
  }
</script>

{#if !allDone}
  <aside class="checklist" aria-label="Onboarding progress">
    <header>
      <strong>Getting started</strong>
      <div class="trail">
        <span class="count b-mono">{doneCount} / {steps.length}</span>
        <button
          class="skip"
          type="button"
          onclick={handleSkip}
          disabled={skipping || !onSkip}
          title="Skip onboarding for this account"
          aria-label="Skip onboarding"
        >
          <X size={11} />
        </button>
      </div>
    </header>
    <ul>
      {#each steps as s (s.key)}
        {@const isActive = s.key === activeKey}
        <li class:done={s.done} class:active={isActive}>
          {#if s.done}
            <span class="row" aria-disabled="true">
              <span class="ico"><Check size={13} /></span>
              <span class="lbl">{s.label}</span>
            </span>
          {:else if isActive && s.onClick}
            <button
              type="button"
              class="row click"
              onclick={s.onClick}
              title={s.hint}
            >
              <span class="ico"><Circle size={13} /></span>
              <span class="lbl">{s.label}</span>
              <span class="arr"><ArrowRight size={11} /></span>
            </button>
          {:else}
            <span class="row" aria-disabled="true">
              <span class="ico"><Circle size={13} /></span>
              <span class="lbl">{s.label}</span>
            </span>
          {/if}
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
    width: 240px;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 10px;
    padding: 10px 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
    z-index: 30;
    font-size: 12.5px;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .trail {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .count {
    color: var(--b-text-3);
    font-size: 11px;
  }
  .skip {
    appearance: none;
    border: 1px solid var(--b-border);
    background: var(--b-surface-2);
    color: var(--b-text-3);
    border-radius: 4px;
    padding: 2px 4px;
    line-height: 0;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .skip:hover:not(:disabled) {
    color: var(--b-text);
    border-color: var(--b-border-2);
  }
  .skip:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  li {
    border-radius: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    color: var(--b-text-2);
    background: transparent;
    border: 0;
    text-align: left;
    font: inherit;
    border-radius: 6px;
  }
  .row .lbl {
    flex: 1;
  }
  .row.click {
    cursor: pointer;
    color: var(--b-text);
    background: color-mix(in oklab, var(--b-accent) 8%, transparent);
  }
  .row.click:hover {
    background: color-mix(in oklab, var(--b-accent) 18%, transparent);
  }
  .row.click:focus-visible {
    outline: 2px solid var(--b-accent);
    outline-offset: 2px;
  }
  .arr {
    color: var(--b-accent);
  }
  li.done .row {
    color: var(--b-ok);
    text-decoration: line-through;
    text-decoration-color: color-mix(in oklab, var(--b-ok) 50%, transparent);
  }
  .ico {
    display: inline-flex;
    width: 16px;
    height: 16px;
    align-items: center;
    justify-content: center;
  }
</style>
