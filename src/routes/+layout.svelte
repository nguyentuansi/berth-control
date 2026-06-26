<script lang="ts">
  import '../app.css';
  import { ModeWatcher, mode, setMode } from 'mode-watcher';
  import { Sun, Moon, Activity, ListPlus, Settings, Search, Bookmark, HelpCircle, LogOut, Cpu } from 'lucide-svelte';
  import { page } from '$app/state';
  import CommandPalette from '$lib/components/CommandPalette.svelte';
  import Toaster from '$lib/components/Toaster.svelte';
  import type { LayoutData } from './$types.js';

  let { data, children }: { data: LayoutData; children: any } = $props();

  // mode-watcher sets `class="dark"` on <html> for dark mode. @berth/ui's
  // token palette flips on `[data-theme="light"]`. Bridge the two so the
  // berth-control light theme actually reaches into @berth/ui components
  // (otherwise their dark default ships through and you get white-on-white).
  $effect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = $mode === 'dark' ? 'dark' : 'light';
  });

  // Public/auth routes get a bare layout — no header chrome, no command
  // palette, full-bleed main. Keeps the brand visible only where the user
  // has actually signed in.
  const isPublicRoute = $derived.by(() => {
    const p = page.url.pathname;
    if (p === '/login') return true;
    if (p === '/setup') return true;
    if (p.startsWith('/auth/qr/')) return true;
    return false;
  });
  const showHeader = $derived(Boolean(data.user) && !isPublicRoute);

  async function signOut() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* even on failure, send them to /login — server will reject anyway */
    }
    window.location.href = '/login';
  }
</script>

<svelte:head>
  <title>Berth · local control</title>
</svelte:head>

<ModeWatcher defaultMode="system" />

{#if showHeader}
<header class="b-header">
  <div class="b-header-inner">
    <a class="b-brand" href="/">
      <img class="b-brand-mark" src="/logo.png" height="36" alt="Berth" />
      <span class="b-brand-name">Berth</span>
      <span class="b-brand-tag">local control · 5202</span>
    </a>

    <nav class="b-nav">
      <a class="b-navbtn" href="/"><Activity size={14} /> Dashboard</a>
      <a class="b-navbtn" href="/monitor"><Cpu size={14} /> Monitor</a>
      <a class="b-navbtn" href="/snapshots"><Bookmark size={14} /> Snapshots</a>
      <a class="b-navbtn" href="/import"><ListPlus size={14} /> Import</a>
      <a class="b-navbtn" href="/settings"><Settings size={14} /> Settings</a>
    </nav>

    <div class="b-user">
      <a class="b-navbtn ic" href="/onboarding" title="Onboarding guide" aria-label="Onboarding guide">
        <HelpCircle size={14} />
      </a>
      <span class="b-pill kbdhint" title="Cmd-K to open command palette"><Search size={11} /> ⌘K</span>
      {#if data.user}
        <span class="b-pill" title={data.user.login}>
          {data.user.display_name ?? data.user.login.split('@')[0]} · {data.user.role}
        </span>
        <button type="button" class="b-btn" title="Sign out" aria-label="Sign out" onclick={signOut}>
          <LogOut size={14} />
        </button>
      {/if}
      <button
        type="button"
        class="b-btn"
        aria-label="Toggle theme"
        onclick={() => setMode($mode === 'dark' ? 'light' : 'dark')}
      >
        {#if $mode === 'dark'}<Sun size={14} />{:else}<Moon size={14} />{/if}
      </button>
    </div>
  </div>
</header>
{/if}

<main class="b-main" class:bare={!showHeader}>
  {@render children()}
</main>

{#if showHeader}
  <CommandPalette apps={data.allApps ?? []} />
{/if}
<Toaster />

<style>
  .b-header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: color-mix(in oklab, var(--b-bg) 92%, transparent);
    backdrop-filter: saturate(140%) blur(10px);
    border-bottom: 1px solid var(--b-border);
  }
  .b-header-inner {
    max-width: 1680px;
    margin: 0 auto;
    padding: 10px 24px;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .b-brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    color: var(--b-text);
  }
  .b-brand-mark {
    height: 36px;
    width: auto;
    display: block;
  }
  .b-brand-name {
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .b-brand-tag {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-text-3);
  }
  .b-nav {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: 14px;
  }
  .b-navbtn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    text-decoration: none;
    color: var(--b-text-2);
    font-size: 13px;
    border-radius: 8px;
  }
  .b-navbtn:hover {
    background: var(--b-surface-2);
    color: var(--b-text);
  }
  .b-navbtn.ic {
    padding: 6px;
  }
  .b-user {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .b-main {
    max-width: 1680px;
    margin: 0 auto;
    padding: 18px 24px;
  }
  .b-main.bare {
    max-width: 100%;
    padding: 0;
  }
  .kbdhint { font-family: var(--b-mono); }
  @media (max-width: 640px) {
    .b-nav { display: none; }
    .b-brand-tag { display: none; }
    .kbdhint { display: none; }
  }

</style>
