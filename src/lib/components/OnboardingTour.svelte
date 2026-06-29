<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { X, ArrowRight, ArrowLeft } from 'lucide-svelte';

  // 4-step welcome tour. Each step targets a CSS selector — when the
  // selector matches a visible element, we render a translucent
  // backdrop with a CUTOUT around that element and anchor the tooltip
  // next to it. The dashboard updates underneath stays visible and
  // interactive only through the cutout, drawing the user's eye to the
  // exact UI we're describing. If a selector doesn't match anything,
  // we fall back to a centered modal so the tour still progresses.

  let {
    onComplete
  }: {
    /** Called when the user finishes or skips. Parent persists via
     *  /api/onboarding/dismiss and invalidates. */
    onComplete?: () => void | Promise<void>;
  } = $props();

  type Step = {
    title: string;
    body: string;
    /** CSS selector to spotlight. Null = centered modal (intro/outro). */
    target: string | null;
  };

  const steps: Step[] = [
    {
      title: 'Welcome to berth-control',
      body:
        'Berth tracks every dev server on this machine — start, stop, watch ' +
        'logs, and expose them on your tailnet without changing any of your repos.',
      target: null
    },
    {
      title: 'Status, at a glance',
      body:
        'Each dot is the app\'s live status: green = listener up, amber = ' +
        'managed process alive but not yet serving, red = down. The status ' +
        'updates within 2 seconds of the OS state changing.',
      target: '.b-dot'
    },
    {
      title: 'Logs follow you',
      body:
        'Click the clock icon to see live stdout/stderr for any app. The ' +
        'mini-log window also pops up automatically when you start an app, ' +
        'so build errors surface immediately.',
      target: 'a[title="Logs"], a[aria-label="Logs"]'
    },
    {
      title: 'Tailnet access',
      body:
        'Berth runs a Host-rewrite proxy in front of each app so the tailnet ' +
        'URL works without editing your repo\'s vite.config or anything else. ' +
        'Click the "open" pill on a running card to launch it from anywhere ' +
        'on your tailnet.',
      target: '.open-pill, [title*="Open"][href*="://"]'
    }
  ];

  let step = $state(0);
  let dismissed = $state(false);
  let busy = $state(false);

  // Bounding box of the current target. null when no target matched.
  let spotlight: { x: number; y: number; w: number; h: number } | null = $state(null);
  let tooltipPos: { x: number; y: number; side: 'top' | 'bottom' | 'right' | 'left' } | null =
    $state(null);

  const tooltipW = 340;
  const tooltipH = 200; // approximate; positioning is loose
  const PAD = 12;

  async function locate(selector: string | null) {
    spotlight = null;
    tooltipPos = null;
    await tick();
    if (!selector) return;
    const el = document.querySelector(selector) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, 320));
    const r = el.getBoundingClientRect();
    spotlight = {
      x: r.left - 6,
      y: r.top - 6,
      w: r.width + 12,
      h: r.height + 12
    };
    tooltipPos = placeTooltip(spotlight);
  }

  function placeTooltip(s: { x: number; y: number; w: number; h: number }) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Prefer below the spotlight; flip to above if it would overflow.
    if (s.y + s.h + PAD + tooltipH < vh) {
      return {
        x: Math.max(PAD, Math.min(s.x, vw - tooltipW - PAD)),
        y: s.y + s.h + PAD,
        side: 'bottom' as const
      };
    }
    if (s.y - PAD - tooltipH > 0) {
      return {
        x: Math.max(PAD, Math.min(s.x, vw - tooltipW - PAD)),
        y: s.y - PAD - tooltipH,
        side: 'top' as const
      };
    }
    // Fall back to right.
    if (s.x + s.w + PAD + tooltipW < vw) {
      return {
        x: s.x + s.w + PAD,
        y: Math.max(PAD, Math.min(s.y, vh - tooltipH - PAD)),
        side: 'right' as const
      };
    }
    // Last resort: left.
    return {
      x: Math.max(PAD, s.x - PAD - tooltipW),
      y: Math.max(PAD, Math.min(s.y, vh - tooltipH - PAD)),
      side: 'left' as const
    };
  }

  $effect(() => {
    void locate(steps[step].target);
  });

  function onResize() {
    void locate(steps[step].target);
  }
  // onMount is a no-op on the server; the returned function is the cleanup
  // and is also skipped on the server. onDestroy, by contrast, fires during
  // SSR teardown — putting `window.removeEventListener` there crashed render.
  onMount(() => {
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });

  async function finish() {
    busy = true;
    try {
      dismissed = true;
      await onComplete?.();
    } finally {
      busy = false;
    }
  }
</script>

{#if !dismissed}
  {#if spotlight}
    {@const sx = Math.max(0, spotlight.x)}
    {@const sy = Math.max(0, spotlight.y)}
    {@const sw = Math.max(0, spotlight.w)}
    {@const sh = Math.max(0, spotlight.h)}
    <!-- SVG mask cuts a transparent rectangle through a dark overlay. The
         pointer-events on the overlay block clicks everywhere except the
         spotlit area, so the user can interact with what we're highlighting. -->
    <svg class="overlay" aria-hidden="true">
      <defs>
        <mask id="tour-mask">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          <rect x={sx} y={sy} width={sw} height={sh} rx="8" ry="8" fill="black" />
        </mask>
      </defs>
      <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#tour-mask)" />
      <!-- Glow outline around the cutout. -->
      <rect
        x={sx}
        y={sy}
        width={sw}
        height={sh}
        rx="8"
        ry="8"
        fill="none"
        stroke="rgba(255,255,255,0.9)"
        stroke-width="2"
        class="ring"
      />
    </svg>
  {:else}
    <div class="overlay-flat" aria-hidden="true"></div>
  {/if}

  <div
    class="tooltip"
    role="dialog"
    aria-modal="true"
    aria-labelledby="tour-title"
    class:floating={!!tooltipPos}
    style:left={tooltipPos ? `${tooltipPos.x}px` : null}
    style:top={tooltipPos ? `${tooltipPos.y}px` : null}
  >
    <button class="x b-btn icon tiny" onclick={finish} disabled={busy} title="Skip tour" aria-label="Skip tour">
      <X size={12} />
    </button>
    <span class="step b-mono">{step + 1} / {steps.length}</span>
    <h2 id="tour-title">{steps[step].title}</h2>
    <p>{steps[step].body}</p>
    <footer>
      <button class="b-btn ghost" type="button" onclick={finish} disabled={busy}>
        Skip
      </button>
      <div class="nav">
        <button
          class="b-btn"
          type="button"
          disabled={busy || step === 0}
          onclick={() => (step = Math.max(0, step - 1))}
        >
          <ArrowLeft size={13} /> Back
        </button>
        {#if step < steps.length - 1}
          <button
            class="b-btn primary"
            type="button"
            disabled={busy}
            onclick={() => (step = step + 1)}
          >
            Next <ArrowRight size={13} />
          </button>
        {:else}
          <button class="b-btn primary" type="button" disabled={busy} onclick={finish}>
            Got it
          </button>
        {/if}
      </div>
    </footer>
  </div>
{/if}

<style>
  .overlay,
  .overlay-flat {
    position: fixed;
    inset: 0;
    z-index: 199;
    pointer-events: auto;
  }
  .overlay-flat {
    background: rgba(0, 0, 0, 0.42);
  }
  .ring {
    animation: ring-pulse 1.6s ease-in-out infinite;
  }
  @keyframes ring-pulse {
    0%,
    100% {
      stroke-opacity: 0.95;
    }
    50% {
      stroke-opacity: 0.5;
    }
  }
  .tooltip {
    position: fixed;
    z-index: 200;
    width: 340px;
    max-width: calc(100vw - 24px);
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 12px;
    padding: 18px 20px 14px;
    box-shadow: 0 28px 70px rgba(0, 0, 0, 0.35);
  }
  .tooltip:not(.floating) {
    /* No spotlight target — center it. */
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
  }
  .x {
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
    font-size: 17px;
    font-weight: 600;
  }
  p {
    margin: 0 0 14px;
    color: var(--b-text-2);
    line-height: 1.55;
    font-size: 13.5px;
  }
  footer {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    align-items: center;
  }
  .nav {
    display: inline-flex;
    gap: 6px;
  }
  .ghost {
    color: var(--b-text-3);
    background: transparent;
    border: 1px solid transparent;
  }
  .ghost:hover {
    color: var(--b-text);
    border-color: var(--b-border);
  }
</style>
