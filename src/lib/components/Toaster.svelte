<script lang="ts">
  import { toasts, dismiss } from '$lib/toast.js';
  import { Check, Info, AlertCircle, Loader2, X } from 'lucide-svelte';
  import { fly } from 'svelte/transition';
</script>

<div class="toaster" role="status" aria-live="polite" aria-atomic="false">
  {#each $toasts as t (t.id)}
    <div
      class="toast {t.kind}"
      transition:fly={{ y: 16, duration: 180 }}
    >
      <span class="ico">
        {#if t.kind === 'success'}
          <Check size={14} />
        {:else if t.kind === 'error'}
          <AlertCircle size={14} />
        {:else if t.kind === 'loading'}
          <Loader2 size={14} class="spin" />
        {:else}
          <Info size={14} />
        {/if}
      </span>
      <div class="body">
        <div class="title">{t.title}</div>
        {#if t.description}<div class="desc">{t.description}</div>{/if}
      </div>
      <button
        class="close"
        type="button"
        aria-label="Dismiss"
        onclick={() => dismiss(t.id)}
      >
        <X size={12} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toaster {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 1000;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    pointer-events: none;
    max-width: calc(100vw - 32px);
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 10px 10px 12px;
    min-width: 280px;
    max-width: 380px;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 10px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
  }
  .toast.success {
    border-color: color-mix(in oklab, var(--b-ok) 35%, var(--b-border));
  }
  .toast.error {
    border-color: color-mix(in oklab, var(--b-bad) 35%, var(--b-border));
  }
  .toast.loading {
    border-color: color-mix(in oklab, var(--b-info) 30%, var(--b-border));
  }
  .ico { flex-shrink: 0; padding-top: 2px; }
  .toast.success .ico { color: var(--b-ok); }
  .toast.error .ico { color: var(--b-bad); }
  .toast.loading .ico { color: var(--b-info); }
  .toast.info .ico { color: var(--b-text-2); }
  :global(.spin) { animation: spin 800ms linear infinite; }
  @keyframes spin {
    from { transform: rotate(0); }
    to { transform: rotate(360deg); }
  }
  .body { flex: 1; min-width: 0; }
  .title {
    font-size: 13px;
    font-weight: 600;
    color: var(--b-text);
    line-height: 1.35;
  }
  .desc {
    font-size: 12px;
    color: var(--b-text-2);
    margin-top: 2px;
    word-break: break-word;
    line-height: 1.4;
    font-family: var(--b-mono);
    white-space: pre-wrap;
    /* Hard cap so a freak large payload can't take over the viewport. The
       client also pre-summarizes server bodies to ~240 chars before this. */
    max-height: 8.4em;
    overflow: auto;
  }
  .close {
    background: transparent;
    border: 0;
    color: var(--b-text-3);
    cursor: pointer;
    padding: 2px;
    border-radius: 4px;
    margin-top: -2px;
    align-self: flex-start;
  }
  .close:hover { color: var(--b-text); background: var(--b-surface-2); }
</style>
