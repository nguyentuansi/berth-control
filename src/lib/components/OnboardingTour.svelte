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

  // Selectors are tried left-to-right; first match wins. This lets one step
  // work in BOTH grid view (cards) AND list view (table rows) without
  // branching at runtime. We spotlight CONTAINERS, not 8-pixel dots — a
  // tiny target reads as "broken tour" even when the highlight is correct.
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
        'Each app shows a status dot: green = listener up, amber = managed ' +
        'process alive but not yet serving, red = down. Status updates within ' +
        '2 seconds of the OS state changing.',
      // ANY card / any non-folder row — findVisible() picks the first one
      // with a non-zero rect (skips collapsed sections, hidden subapps).
      target: 'article.card, .list tbody tr:not(.folder-row)'
    },
    {
      title: 'Open in browser',
      body:
        'When an app is up, click its "open" pill to launch it. Berth runs a ' +
        'Host-rewrite proxy so the tailnet URL works on any device on your ' +
        'tailnet — without editing vite.config or anything in your repo.',
      target: '.open-pill'
    },
    {
      title: 'More actions',
      body:
        'The ⋮ button on each app opens Logs, Restart, and Tailnet/local URL ' +
        'shortcuts. The mini-log window also pops up automatically when you ' +
        'start an app so build errors surface immediately.',
      target: 'button[aria-label="More actions"]'
    }
  ];

  let step = $state(0);
  let dismissed = $state(false);
  let busy = $state(false);

  // Live viewport dimensions — used as the SVG viewBox so user-space coords
  // (from getBoundingClientRect) line up 1:1 with CSS pixels. SSR uses
  // sensible fallbacks until onMount overwrites with the real values.
  let vw = $state(1024);
  let vh = $state(768);

  // Bounding box of the current target. null when no target matched.
  let spotlight: { x: number; y: number; w: number; h: number } | null = $state(null);
  let tooltipPos: { x: number; y: number; side: 'top' | 'bottom' | 'right' | 'left' } | null =
    $state(null);

  const tooltipW = 340;
  const tooltipH = 200; // approximate; positioning is loose
  const PAD = 12;

  // Returns the first element matching `selector` that is actually
  // rendered and has a non-zero box. Elements inside closed dropdowns,
  // collapsed folders, or `display: none` parents are skipped — those would
  // resolve to a 0×0 rect and produce an invisible "spotlight."
  function findVisible(selector: string): HTMLElement | null {
    const all = document.querySelectorAll<HTMLElement>(selector);
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return el;
    }
    return null;
  }

  async function locate(selector: string | null) {
    spotlight = null;
    tooltipPos = null;
    await tick();
    if (!selector) return;
    const el = findVisible(selector);
    if (!el) {
      // Selector didn't resolve to a visible element — fall back to the
      // centered modal so the step still progresses.
      return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, 360));
    const r = el.getBoundingClientRect();
    // 12px padding around the target — gives the ring breathing room and
    // makes small targets (status dots, pills) clearly visible.
    const PAD_SPOT = 12;
    spotlight = {
      x: r.left - PAD_SPOT,
      y: r.top - PAD_SPOT,
      w: r.width + PAD_SPOT * 2,
      h: r.height + PAD_SPOT * 2
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
    vw = window.innerWidth;
    vh = window.innerHeight;
    void locate(steps[step].target);
  }
  // onMount is a no-op on the server; the returned function is the cleanup
  // and is also skipped on the server. onDestroy, by contrast, fires during
  // SSR teardown — putting `window.removeEventListener` there crashed render.
  onMount(() => {
    vw = window.innerWidth;
    vh = window.innerHeight;
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
         spotlit area, so the user can interact with what we're highlighting.
         CRITICAL: width/height attrs MUST be present. Without them, browsers
         default the SVG viewport to 300×150 — so `<rect width="100%">`
         renders only a 300×150 dark box in the top-left and the cutout at
         a card's real coords (e.g. x=400) ends up outside the SVG. A
         viewBox over the live viewport size keeps SVG coords 1:1 with CSS
         pixels, which is what scrollIntoView+getBoundingClientRect produces. -->
    <svg
      class="overlay"
      aria-hidden="true"
      width="100%"
      height="100%"
      viewBox="0 0 {vw} {vh}"
      preserveAspectRatio="none"
    >
      <defs>
        <mask id="tour-mask">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          <rect x={sx} y={sy} width={sw} height={sh} rx="8" ry="8" fill="black" />
        </mask>
      </defs>
      <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.62)" mask="url(#tour-mask)" />
      <!-- Outer outline (white) + inner accent stroke for a clear "this is
           the spotlight" affordance even on tiny targets. -->
      <rect
        x={sx}
        y={sy}
        width={sw}
        height={sh}
        rx="10"
        ry="10"
        fill="none"
        stroke="rgba(255,255,255,0.95)"
        stroke-width="3"
        class="ring"
      />
      <rect
        x={sx - 4}
        y={sy - 4}
        width={sw + 8}
        height={sh + 8}
        rx="12"
        ry="12"
        fill="none"
        stroke="var(--b-accent, #6aa1ff)"
        stroke-opacity="0.65"
        stroke-width="2"
        class="ring-outer"
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
  .ring-outer {
    animation: ring-pulse 1.6s ease-in-out infinite reverse;
  }
  @keyframes ring-pulse {
    0%,
    100% {
      stroke-opacity: 0.95;
    }
    50% {
      stroke-opacity: 0.55;
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
