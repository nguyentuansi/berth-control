<script lang="ts">
  import { X, ArrowRight, ArrowLeft } from 'lucide-svelte';
  import { invalidateAll } from '$app/navigation';

  // 4-step welcome tour shown to first-time users after they have at
  // least one app registered. Steps are pure copy + a small illustration
  // (we render the actual UI behind the modal, so the user can see what
  // we're describing). On finish, we POST /api/onboarding/complete so
  // the tour doesn't fire again.

  let step = $state(0);
  let dismissed = $state(false);

  const steps = [
    {
      title: 'Welcome to berth-control',
      body: `Berth tracks every dev server on this machine — start, stop, watch logs,
             and expose them on your tailnet without changing any of your repos.`
    },
    {
      title: 'Status, at a glance',
      body: `Each card's green dot means the app's listener is actually up. Amber
             means a managed process is alive but not yet serving. Red means down.`
    },
    {
      title: 'Logs follow you',
      body: `Click the clock icon to open the log view for any app. The mini-log
             window pops up automatically when you start an app, so build errors
             surface immediately.`
    },
    {
      title: 'Tailnet access',
      body: `Berth's Host-rewrite proxy publishes each app on its tailnet hostname
             with no edits to your repo. Click the green "open" pill on a running
             card to launch it from anywhere on your tailnet.`
    }
  ];

  async function finish() {
    dismissed = true;
    try {
      await fetch('/api/onboarding/complete', { method: 'POST' });
      await invalidateAll();
    } catch {
      /* */
    }
  }
</script>

{#if !dismissed}
  <div class="scrim" role="presentation">
    <div class="card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <button class="close b-btn icon tiny" onclick={finish} title="Skip tour">
        <X size={12} />
      </button>
      <span class="step b-mono">{step + 1} / {steps.length}</span>
      <h2 id="tour-title">{steps[step].title}</h2>
      <p>{steps[step].body}</p>
      <footer>
        <button class="b-btn" disabled={step === 0} onclick={() => (step = Math.max(0, step - 1))}>
          <ArrowLeft size={13} /> Back
        </button>
        {#if step < steps.length - 1}
          <button class="b-btn primary" onclick={() => (step = step + 1)}>
            Next <ArrowRight size={13} />
          </button>
        {:else}
          <button class="b-btn primary" onclick={finish}>Get started</button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.32);
    display: grid;
    place-items: center;
    z-index: 200;
  }
  .card {
    width: 460px;
    max-width: 92vw;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 12px;
    padding: 22px 22px 18px;
    box-shadow: 0 28px 70px rgba(0, 0, 0, 0.3);
    position: relative;
  }
  .close {
    position: absolute;
    top: 8px;
    right: 8px;
  }
  .step {
    display: inline-block;
    font-size: 11px;
    color: var(--b-text-3);
    margin-bottom: 4px;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 18px;
    font-weight: 600;
  }
  p {
    margin: 0 0 16px;
    color: var(--b-text-2);
    line-height: 1.55;
    font-size: 13.5px;
  }
  footer {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
</style>
