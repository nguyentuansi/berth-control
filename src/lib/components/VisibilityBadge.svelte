<script lang="ts">
  import { Lock, Users, Globe } from 'lucide-svelte';

  // Tiny visibility indicator that appears next to app names in the
  // dashboard list/grid. Shows a lock for private, two people for
  // invited-share, or a globe for public. Optionally shows the text.

  let {
    visibility,
    showLabel = true,
    size = 11
  }: {
    visibility: 'private' | 'invited' | 'public';
    showLabel?: boolean;
    size?: number;
  } = $props();
</script>

<span
  class="vis {visibility}"
  title={`Visibility: ${visibility}`}
  aria-label={`Visibility: ${visibility}`}
>
  {#if visibility === 'private'}
    <Lock {size} />
  {:else if visibility === 'invited'}
    <Users {size} />
  {:else}
    <Globe {size} />
  {/if}
  {#if showLabel}<span class="lbl">{visibility}</span>{/if}
</span>

<style>
  .vis {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px;
    border-radius: 4px;
    font-size: 10.5px;
    line-height: 1;
    color: var(--b-text-3);
    background: var(--b-surface);
    border: 1px solid var(--b-border);
  }
  .vis.public {
    color: var(--b-ok);
    border-color: color-mix(in oklab, var(--b-ok) 30%, var(--b-border));
  }
  .vis.invited {
    color: var(--b-info);
    border-color: color-mix(in oklab, var(--b-info) 30%, var(--b-border));
  }
  .lbl {
    text-transform: capitalize;
  }
</style>
