<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import {
    Play,
    Square,
    RotateCw,
    ExternalLink,
    Folder,
    Clock,
    PlayCircle,
    StopCircle,
    LayoutGrid,
    Rows3,
    Settings2,
    ChevronDown,
    ChevronRight,
    Globe,
    Wifi,
    MoreVertical,
    Plus
  } from 'lucide-svelte';
  import AddAppModal from '$lib/components/AddAppModal.svelte';
  import { toast } from '$lib/toast.js';
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  // Live state pushed from /api/state (SSE).
  type LiveStatus = {
    up: boolean;
    serving: boolean;
    listenerPid: number | null;
    listenerCmd: string | null;
    managedPid: number | null;
    managedSince: number | null;
    healthOk: boolean | null;
    latencyMs: number | null;
    tailscale: { port: number; funnel: boolean } | null;
    cpuPct: number | null;
    ramMB: number | null;
    gpuMB: number | null;
    origin: {
      kind: 'managed' | 'systemd' | 'scope' | 'unknown';
      unit: string | null;
      scope: 'user' | 'system' | null;
    } | null;
  };
  let livestate: Record<string, LiveStatus> = $state({});
  let liveTs: number = $state(0);
  let tailscaleHost: string | null = $state(null);
  let tailscaleAvailable: boolean = $state(false);
  let es: EventSource | null = null;
  let busy: Record<string, 'start' | 'stop' | 'restart' | 'tailnet' | null> = $state({});

  // Detect which pipeline the user is currently viewing Berth through.
  let pageHost: string = $state('');
  const viaTailnet = $derived(pageHost.endsWith('.ts.net'));

  // View mode: 'grid' (default, card per app) or 'list' (compact rows).
  // Persisted per-browser in localStorage.
  let view: 'grid' | 'list' = $state('grid');

  let addOpen = $state(false);

  // Collapsed project groups: { [groupName]: true }. Persisted across reloads.
  // Shared across Active/Inactive sections — if you collapse "jarvis-miniapps",
  // it collapses in both sections (it's the same conceptual project).
  let collapsed: Record<string, boolean> = $state({});

  // Top-level Active/Inactive section collapse. Separate key so the project
  // group collapse state stays orthogonal.
  let sectionsCollapsed: { active: boolean; inactive: boolean } = $state({
    active: false,
    inactive: false
  });

  // Active group for the scrollspy sidebar — driven by IntersectionObserver.
  // Format: "active:<groupName>" or "inactive:<groupName>".
  let activeGroup: string | null = $state(null);

  // Currently-open inline menu, plus its viewport-anchored coords (cached
  // from the trigger's getBoundingClientRect when it opens). Two kinds:
  //   'start' — split-button dropdown next to the Play icon (Start / Start + tailnet)
  //   'kebab' — row-end three-dots menu (Copy path, ...)
  // One menu open at a time keeps the click-outside logic simple.
  type MenuKind = 'start' | 'kebab';
  let openMenu: { id: string; kind: MenuKind } | null = $state(null);
  let menuPos: { top: number; right: number } | null = $state(null);

  // Held outside the template because Svelte 5 compiles inline `{@const}` to
  // a derived that re-runs the *moment* its deps change. If the menu closes
  // (openMenu → null) inside an onclick — exactly what every dropitem does —
  // an inline `{@const id = openMenu.id}` would throw "Cannot read 'id' of
  // null" before the surrounding `{#if}` unmounts. Doing it here with optional
  // chaining short-circuits cleanly.
  const openMenuId = $derived.by(() => {
    const m = openMenu;
    return m ? m.id : '';
  });
  const openMenuApp = $derived.by(() => {
    const m = openMenu;
    if (!m) return null;
    return data.apps.find((a) => a.id === m.id) ?? null;
  });

  /** Pull a usable error message out of a fetch response body.
   *  - JSON: prefer `.error.message`, then `.message`, then stringify.
   *  - HTML (e.g. SvelteKit's 404 page): strip tags, collapse whitespace.
   *  Caps at 600 chars — `.desc` has overflow:auto so long tails (e.g. log
   *  output appended by the server) scroll inside the toast card. */
  function summarizeError(body: string, status: number): string {
    let msg = '';
    let preserveNewlines = false;
    try {
      const j = JSON.parse(body);
      msg = j?.error?.message ?? j?.message ?? '';
      // JSON-encoded error messages from the server intentionally keep \n in
      // them (e.g. the "log tail" appended after a build-error explanation).
      // Preserve those — only collapse whitespace for the HTML fallback below.
      preserveNewlines = true;
    } catch {
      /* not JSON */
    }
    if (!msg) {
      msg = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else if (!preserveNewlines) {
      msg = msg.replace(/\s+/g, ' ').trim();
    }
    if (!msg) msg = `HTTP ${status}`;
    return msg.length > 600 ? msg.slice(0, 597) + '…' : msg;
  }

  function openMenuAt(id: string, kind: MenuKind, anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect();
    menuPos = { top: r.bottom + 4, right: window.innerWidth - r.right };
    openMenu = { id, kind };
  }
  function closeMenu() {
    openMenu = null;
    menuPos = null;
  }

  // Dropitem handlers. They must snapshot `openMenu.id` (and any sibling
  // state they need from `livestate`) BEFORE calling closeMenu — Svelte 5
  // compiles inline arrow closures so the const/derived they reference is
  // re-read on every access, which means by the time the action runs after
  // closeMenu the id reads as '' and we POST to /api/apps//start → 404.
  function menuStartLocal() {
    const id = openMenu?.id;
    closeMenu();
    if (id) act(id, 'start');
  }
  function menuStartTailnet() {
    const id = openMenu?.id;
    if (id) startWithTailnet(id); // it calls closeMenu internally
  }
  function menuToggleTailnet() {
    const id = openMenu?.id;
    if (!id) return;
    const onTailnet = !!livestate[id]?.tailscale;
    closeMenu();
    toggleTailnet(id, onTailnet);
  }
  function menuCopyPath() {
    const path = openMenuApp?.project_path;
    closeMenu();
    if (path) copyText(path);
  }
  function menuUninstall() {
    const id = openMenu?.id;
    if (!id) return;
    const origin = livestate[id]?.origin;
    closeMenu();
    if (origin?.unit && origin?.scope) {
      uninstallSystemd(id, origin.unit, origin.scope);
    }
  }

  function appName(id: string): string {
    return data.apps.find((a) => a.id === id)?.name ?? id;
  }
  function appPort(id: string): number | null {
    return data.apps.find((a) => a.id === id)?.port ?? null;
  }

  /** Watch SSE state for an expected `up` transition after a Start, then
   *  resolve the loading toast to success / error. Times out at 30s — long
   *  enough for a cold vite build to land but short enough to surface
   *  genuinely stuck launches. */
  function watchStart(id: string, toastId: string) {
    const started = Date.now();
    const TIMEOUT_MS = 30_000;
    const POLL_MS = 400;
    const handle = setInterval(() => {
      const s = livestate[id];
      if (s?.up) {
        clearInterval(handle);
        const port = appPort(id);
        toast.update(toastId, {
          kind: 'success',
          title: `${appName(id)} is up`,
          description: port ? `listening on :${port}` : undefined,
          durationMs: 4000
        });
      } else if (Date.now() - started > TIMEOUT_MS) {
        clearInterval(handle);
        toast.update(toastId, {
          kind: 'error',
          title: `${appName(id)} didn't bind within ${TIMEOUT_MS / 1000}s`,
          description: 'The process is still running — check the logs for build errors or hung tasks.',
          durationMs: 12_000
        });
      }
    }, POLL_MS);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied', text);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  /** Disable + remove a systemd unit that's supervising this app's port.
   *  Destructive — confirms first. Falls back to surfacing the server error. */
  async function uninstallSystemd(
    appId: string,
    unit: string,
    scope: 'user' | 'system'
  ): Promise<void> {
    const verb = scope === 'user' ? 'user-level' : 'system-level';
    const ok = confirm(
      `Disable + delete the ${verb} systemd unit \`${unit}.service\`?\n\n` +
        `This will:\n  • stop the unit\n  • disable autostart at login\n` +
        `  • remove the .service file\n\nYou can't undo this from Berth.`
    );
    if (!ok) return;
    busy[appId] = 'stop';
    const tid = toast.loading(`Uninstalling ${unit}.service…`);
    try {
      const r = await fetch('/api/systemd/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId, unit, scope })
      });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'Uninstall failed',
          description: summarizeError(await r.text(), r.status),
          durationMs: 12_000
        });
        return;
      }
      toast.update(tid, {
        kind: 'success',
        title: `${unit}.service removed`,
        durationMs: 4000
      });
    } finally {
      busy[appId] = null;
    }
  }

  let observer: IntersectionObserver | null = null;

  onMount(() => {
    const saved = localStorage.getItem('berth.view');
    if (saved === 'list' || saved === 'grid') view = saved;
    try {
      const c = localStorage.getItem('berth.collapsed');
      if (c) collapsed = JSON.parse(c);
      const sc = localStorage.getItem('berth.sectionsCollapsed');
      if (sc) {
        const parsed = JSON.parse(sc);
        if (parsed && typeof parsed === 'object') {
          sectionsCollapsed = {
            active: !!parsed.active,
            inactive: !!parsed.inactive
          };
        }
      }
    } catch {
      /* ignore parse errors */
    }
    pageHost = window.location.hostname;
    es = new EventSource('/api/state');
    es.onmessage = (m) => {
      try {
        const j = JSON.parse(m.data);
        livestate = j.byApp ?? {};
        liveTs = j.ts;
        tailscaleHost = j.tailscaleHost ?? null;
        tailscaleAvailable = !!j.tailscaleAvailable;
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      liveTs = 0;
    };

    // Close the open menu on outside-click. The menu's anchor (.startsplit
    // caret or .kebab-trigger) and the floating .dropdown itself shouldn't
    // count as "outside" — clicks on them belong to the menu and should let
    // their own onclick handlers fire first.
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        !t?.closest('.startsplit') &&
        !t?.closest('.kebab-trigger') &&
        !t?.closest('.dropdown')
      ) {
        closeMenu();
      }
    };
    const onScroll = () => {
      if (openMenu) closeMenu();
    };
    document.addEventListener('click', onDocClick);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('scroll', onScroll, true);
    };
  });
  onDestroy(() => {
    es?.close();
    observer?.disconnect();
  });

  // Set up the scrollspy once groups have rendered. Re-run on group change.
  $effect(() => {
    // Touch groupedByStatus so we re-establish observers when the active/
    // inactive split changes. Keys are "section:groupName" — matches both the
    // `data-group` attribute and the `activeGroup` sentinel.
    const g = groupedByStatus;
    const keys: string[] = [
      ...g.active.map(([k]) => `active:${k}`),
      ...g.inactive.map(([k]) => `inactive:${k}`)
    ];
    if (typeof window === 'undefined') return;
    observer?.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        // Prefer the entry closest to (but past) the top of the viewport.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          const id = (visible[0].target as HTMLElement).dataset.group;
          if (id) activeGroup = id;
        }
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 }
    );
    // Wait for DOM, then observe.
    tick().then(() => {
      for (const key of keys) {
        const el = document.querySelector(`[data-group="${cssEscape(key)}"]`);
        if (el) observer!.observe(el);
      }
      if (keys.length > 0 && !activeGroup) activeGroup = keys[0];
    });
  });

  function cssEscape(s: string): string {
    return s.replace(/"/g, '\\"');
  }

  /** Stable DOM id for a project-group section, scoped under Active/Inactive. */
  function groupId(name: string, section: 'active' | 'inactive'): string {
    return (
      `g-${section}-` +
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    );
  }

  function jumpToGroup(name: string, section: 'active' | 'inactive') {
    const id = groupId(name, section);
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      activeGroup = `${section}:${name}`;
    }
  }

  function toggleCollapsed(name: string) {
    collapsed = { ...collapsed, [name]: !collapsed[name] };
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('berth.collapsed', JSON.stringify(collapsed));
    }
  }

  function toggleSection(section: 'active' | 'inactive') {
    sectionsCollapsed = {
      ...sectionsCollapsed,
      [section]: !sectionsCollapsed[section]
    };
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(
        'berth.sectionsCollapsed',
        JSON.stringify(sectionsCollapsed)
      );
    }
  }

  /** Build the right "Open" URL for an app depending on which pipeline the
   *  user is currently looking at Berth through. */
  function openUrl(port: number | null, ts: LiveStatus['tailscale']): string | null {
    if (!port) return null;
    if (viaTailnet && ts && tailscaleHost) {
      return `https://${tailscaleHost}:${ts.port}`;
    }
    return `http://127.0.0.1:${port}`;
  }

  function setView(v: 'grid' | 'list') {
    view = v;
    if (typeof localStorage !== 'undefined') localStorage.setItem('berth.view', v);
  }

  async function act(id: string, kind: 'start' | 'stop' | 'restart') {
    busy[id] = kind;
    const name = appName(id);
    const verb = kind === 'start' ? 'Starting' : kind === 'stop' ? 'Stopping' : 'Restarting';
    const tid = toast.loading(`${verb} ${name}…`);
    try {
      const r = await fetch(`/api/apps/${id}/${kind}`, { method: 'POST' });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: `${kind[0].toUpperCase() + kind.slice(1)} failed`,
          description: summarizeError(await r.text(), r.status),
          durationMs: 10_000
        });
        return;
      }
      if (kind === 'start' || kind === 'restart') {
        // Hand off to SSE-state watcher — resolves loading→success when the
        // port binds (or error on timeout).
        watchStart(id, tid);
      } else {
        toast.update(tid, {
          kind: 'success',
          title: `${name} stopped`,
          durationMs: 3000
        });
      }
    } catch (e) {
      toast.update(tid, {
        kind: 'error',
        title: `${kind} request failed`,
        description: e instanceof Error ? e.message : String(e),
        durationMs: 10_000
      });
    } finally {
      busy[id] = null;
    }
  }

  /** Toggle the tailscale serve mapping for this app's port. If currently
   *  published → DELETE removes it; otherwise POST adds it. State comes
   *  from the live SSE snapshot, so this stays in sync with reality. */
  async function toggleTailnet(id: string, currentlyPublished: boolean) {
    busy[id] = 'tailnet';
    const name = appName(id);
    const verb = currentlyPublished ? 'Removing' : 'Publishing';
    const tid = toast.loading(`${verb} ${name} on tailnet…`);
    try {
      const method = currentlyPublished ? 'DELETE' : 'POST';
      const r = await fetch(`/api/apps/${id}/tailscale-serve`, { method });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: `Tailnet ${currentlyPublished ? 'remove' : 'add'} failed`,
          description: summarizeError(await r.text(), r.status),
          durationMs: 10_000
        });
        return;
      }
      const body = await r.json().catch(() => ({}));
      toast.update(tid, {
        kind: 'success',
        title: currentlyPublished ? `${name} no longer on tailnet` : `${name} now on tailnet`,
        description: body?.autoDetected ? `auto-detected port :${body.port}` : undefined,
        durationMs: 3500
      });
      // Server may have persisted a newly-detected port — refresh page data so
      // the Port column reflects it.
      if (body?.autoDetected) void invalidateAll();
    } finally {
      busy[id] = null;
    }
  }

  async function startWithTailnet(id: string) {
    closeMenu();
    const name = appName(id);
    const tid = toast.loading(`Starting ${name} + publishing on tailnet…`);
    busy[id] = 'start';
    try {
      const r = await fetch(`/api/apps/${id}/start`, { method: 'POST' });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'Start failed',
          description: summarizeError(await r.text(), r.status),
          durationMs: 10_000
        });
        return;
      }
      busy[id] = 'tailnet';
      const t = await fetch(`/api/apps/${id}/tailscale-serve`, { method: 'POST' });
      if (!t.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'App started but tailnet setup failed',
          description: summarizeError(await t.text(), t.status),
          durationMs: 10_000
        });
        return;
      }
      // Tailnet endpoint may have persisted a freshly-detected port — pull
      // the new page data so the Port column shows it.
      const t_body = await t.json().catch(() => ({}));
      if (t_body?.autoDetected) void invalidateAll();
      // Wait for the port to actually bind before declaring success.
      watchStart(id, tid);
    } finally {
      busy[id] = null;
    }
  }

  let bulkBusy: string | null = $state(null);
  async function bulkAct(group: string, action: 'start' | 'stop', items: { id: string }[]) {
    bulkBusy = `${group}:${action}`;
    const tid = toast.loading(
      `${action === 'start' ? 'Starting' : 'Stopping'} ${items.length} ${group} apps…`
    );
    try {
      const ids = items.map((i) => i.id);
      const r = await fetch('/api/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ids })
      });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: `Bulk ${action} failed`,
          description: summarizeError(await r.text(), r.status),
          durationMs: 10_000
        });
        return;
      }
      toast.update(tid, {
        kind: 'success',
        title: `${group}: ${action} dispatched to ${items.length} apps`,
        durationMs: 4000
      });
    } finally {
      bulkBusy = null;
    }
  }

  function fmtSince(ms: number | null | undefined): string {
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 60_000) return `${Math.round(d / 1000)}s`;
    if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
    return `${Math.round(d / 3_600_000)}h`;
  }

  function fmtCpu(v: number | null | undefined): string {
    if (v == null) return '—';
    if (v < 1) return v.toFixed(1);
    return Math.round(v).toString();
  }
  function fmtMB(v: number | null | undefined): string {
    if (v == null) return '—';
    if (v >= 1024) return (v / 1024).toFixed(1) + 'G';
    return Math.round(v) + 'M';
  }

  // Two-tier grouping:
  //  1. status (Active vs Inactive — `serving === true` is the cut)
  //  2. project group (group_tag override, else path-derived guessGroup)
  // A given project can legitimately appear in *both* sections when some of
  // its apps are serving and others aren't; the section context disambiguates.
  type Section = 'active' | 'inactive';
  type GroupTuple = [string, typeof data.apps];
  const groupedByStatus = $derived.by(() => {
    const buckets: Record<Section, Map<string, typeof data.apps>> = {
      active: new Map(),
      inactive: new Map()
    };
    for (const a of data.apps) {
      const section: Section = livestate[a.id]?.serving ? 'active' : 'inactive';
      const k = a.group_tag ?? guessGroup(a);
      const m = buckets[section];
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    for (const section of ['active', 'inactive'] as const) {
      for (const [, items] of buckets[section]) {
        items.sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    return {
      active: Array.from(buckets.active.entries()).sort((a, b) =>
        a[0].localeCompare(b[0])
      ) as GroupTuple[],
      inactive: Array.from(buckets.inactive.entries()).sort((a, b) =>
        a[0].localeCompare(b[0])
      ) as GroupTuple[]
    };
  });

  // Workspace-container dirs to skip when guessing the project root from a path.
  // For `~/Development/<project>/apps/<sub>` we want `<project>` — not `apps`
  // (the immediate parent) and not `Development` (the workspace dir).
  // `group_tag` set on the app row overrides this guess entirely.
  const SKIP_DIRS = new Set([
    'home',
    'Development',
    'Work',
    'Projects',
    'Code',
    'repos',
    'src',
    'opt',
    'usr',
    'var'
  ]);
  function guessGroup(a: { project_path: string; name: string }): string {
    const segs = (a.project_path ?? '').replace(/[\\/]+$/, '').split('/').filter(Boolean);
    let i = 0;
    while (i < segs.length && (SKIP_DIRS.has(segs[i]) || (i === 1 && segs[0] === 'home'))) i++;
    if (i < segs.length) return segs[i];
    return (a.name ?? '').split(/[:(]/)[0].trim() || 'other';
  }
</script>

<section class="head">
  <div>
    <h1>Dashboard</h1>
    <p class="b-muted">
      {data.apps.length} apps registered ·
      {Object.values(livestate).filter((s) => s?.up).length} listening ·
      {Object.values(livestate).filter((s) => s?.tailscale).length} on tailnet
      {#if liveTs}
        <span class="b-mute2"> · live</span>
      {:else}
        <span class="b-mute2"> · disconnected</span>
      {/if}
      {#if pageHost}
        <span class="b-pill viewbadge" title={pageHost}>
          via {viaTailnet ? 'tailnet' : 'loopback'}
        </span>
      {/if}
      {#if tailscaleHost && !tailscaleAvailable}
        <span class="b-pill warn" title="tailscale serve status returned an error"
          >tailscale offline</span
        >
      {/if}
    </p>
  </div>

  <div class="head-actions">
    <button class="b-btn primary" onclick={() => (addOpen = true)} title="Register a project folder as a Berth app">
      <Plus size={13} /> Add app
    </button>
    <div class="viewtoggle" role="group" aria-label="View mode">
      <button
        class="b-btn"
        class:active={view === 'grid'}
        onclick={() => setView('grid')}
        title="Card grid"
        aria-pressed={view === 'grid'}
      >
        <LayoutGrid size={13} /> Grid
      </button>
      <button
        class="b-btn"
        class:active={view === 'list'}
        onclick={() => setView('list')}
        title="Compact list"
        aria-pressed={view === 'list'}
      >
        <Rows3 size={13} /> List
      </button>
    </div>
  </div>
</section>

<AddAppModal bind:open={addOpen} />

<div class="layout">
  <aside class="sidebar" aria-label="Projects">
    <nav class="scrollspy">
      {#each ['active', 'inactive'] as const as section (section)}
        {@const entries = groupedByStatus[section]}
        {#if entries.length > 0}
          {@const sectionCollapsed = sectionsCollapsed[section]}
          {@const sectionTotal = entries.reduce((n, [, items]) => n + items.length, 0)}
          <div class="nav-section">
            <button
              type="button"
              class="nav-section-head"
              class:active-section={section === 'active'}
              onclick={() => toggleSection(section)}
              aria-expanded={!sectionCollapsed}
            >
              {#if sectionCollapsed}
                <ChevronRight size={11} />
              {:else}
                <ChevronDown size={11} />
              {/if}
              <span class="nav-section-label">
                {section === 'active' ? 'Active' : 'Inactive'}
              </span>
              <span class="nav-section-count">{sectionTotal}</span>
            </button>
            {#if !sectionCollapsed}
              {#each entries as [group, items] (group)}
                {@const key = `${section}:${group}`}
                <button
                  type="button"
                  class="navitem"
                  class:active={activeGroup === key}
                  onclick={() => jumpToGroup(group, section)}
                  title={`${items.length} app${items.length === 1 ? '' : 's'}`}
                >
                  <span class="dot" class:any-up={section === 'active'}></span>
                  <span class="label">{group}</span>
                  <span class="count">{items.length}</span>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      {/each}
    </nav>
  </aside>

  <div class="content">
    {#each ['active', 'inactive'] as const as section (section)}
      {@const entries = groupedByStatus[section]}
      {#if entries.length > 0}
        {@const sectionCollapsed = sectionsCollapsed[section]}
        {@const sectionTotal = entries.reduce((n, t) => n + t[1].length, 0)}
        <section
          class="status-section"
          class:status-active={section === 'active'}
          id={`section-${section}`}
        >
          <header class="status-section-head">
            <button
              type="button"
              class="status-section-toggle"
              onclick={() => toggleSection(section)}
              aria-expanded={!sectionCollapsed}
              aria-label={sectionCollapsed
                ? `Expand ${section} apps`
                : `Collapse ${section} apps`}
            >
              {#if sectionCollapsed}
                <ChevronRight size={16} />
              {:else}
                <ChevronDown size={16} />
              {/if}
              <h2>{section === 'active' ? 'Active' : 'Inactive'}</h2>
              <span class="status-section-count">
                {sectionTotal} app{sectionTotal === 1 ? '' : 's'}
              </span>
            </button>
          </header>
          {#if !sectionCollapsed}
            {#each entries as [group, items] (group)}
              {@const isCollapsed = collapsed[group] === true}
              <section
                class="group"
                id={groupId(group, section)}
                data-group={`${section}:${group}`}
              >
        <div class="group-head">
          <button
            type="button"
            class="collapse"
            onclick={() => toggleCollapsed(group)}
            aria-expanded={!isCollapsed}
            aria-label={isCollapsed ? `Expand ${group}` : `Collapse ${group}`}
          >
            {#if isCollapsed}
              <ChevronRight size={14} />
            {:else}
              <ChevronDown size={14} />
            {/if}
            <h2>{group}</h2>
            <span class="b-mute2">{items.length}</span>
          </button>
          <div class="bulk">
            {#if section === 'inactive'}
              <button
                class="b-btn small"
                disabled={bulkBusy != null}
                onclick={() => bulkAct(group, 'start', items)}
                title="Start every app in this group that has a start_cmd"
              >
                <PlayCircle size={13} /> Start all
              </button>
            {:else}
              <button
                class="b-btn small danger"
                disabled={bulkBusy != null}
                onclick={() => bulkAct(group, 'stop', items)}
                title="Stop every app in this group"
              >
                <StopCircle size={13} /> Stop all
              </button>
            {/if}
          </div>
        </div>

        {#if !isCollapsed}
          {#if view === 'list'}
            <div class="b-surface listwrap">
              <table class="list">
                <thead>
                  <tr>
                    <th class="col-st" aria-label="status"></th>
                    <th class="col-name">App</th>
                    <th class="col-port">Port</th>
                    <th class="col-kind">Kind</th>
                    <th class="col-source" title="Which supervisor (if any) owns the listener PID">Source</th>
                    <th class="col-tailnet">Tailscale</th>
                    <th class="col-cpu" title="Pgid CPU % over the last tick">CPU</th>
                    <th class="col-ram" title="Pgid resident memory">RAM</th>
                    <th class="col-gpu" title="Pgid VRAM from nvidia-smi">GPU</th>
                    <th class="col-uptime">Uptime 24h</th>
                    <th class="col-act">Actions</th>
                    <th class="col-kebab" aria-label="More"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each items as a (a.id)}
                    {@const s = livestate[a.id]}
                    <tr class:dim={!s?.serving}>
                      <td class="col-st">
                        <span
                          class="b-dot"
                          class:up={s?.serving}
                          class:warn={s?.managedPid != null && !s.serving}
                          class:down={s != null && !s.up}
                          class:idle={!s}
                          title={s?.managedPid != null && s.listenerPid == null
                            ? `Berth-managed process is alive (pid ${s.managedPid}) but isn't bound to any TCP port. The start command probably failed or hasn't bound yet — check Logs.`
                            : undefined}
                        ></span>
                      </td>
                      <td class="col-name">
                        <a href={`/apps/${a.id}`} class="name">{a.name}</a>
                      </td>
                      <td class="b-mono col-port" class:port-up={s?.serving}>
                        {#if a.port}:{a.port}{:else}<span class="b-mute2">—</span>{/if}
                      </td>
                      <td class="b-mono col-kind b-mute2">{a.kind}</td>
                      <td
                        class="b-mono col-source"
                        class:src-managed={s?.origin?.kind === 'managed'}
                        class:src-systemd={s?.origin?.kind === 'systemd'}
                        title={s?.origin?.kind === 'systemd'
                          ? `Running under systemd unit ${s.origin.unit}.service — stop/restart it via systemctl, not Berth's start_cmd`
                          : s?.origin?.kind === 'managed'
                            ? 'Berth spawned this process directly; the lifecycle is controlled from this dashboard'
                            : s?.origin?.kind === 'scope'
                              ? `Transient cgroup: ${s.origin.unit}`
                              : 'Not currently up'}
                      >
                        {#if s?.origin?.kind === 'managed'}managed{:else if s?.origin?.kind === 'systemd'}{s.origin.unit}{:else if s?.origin?.kind === 'scope'}<span
                            class="b-mute2">scope</span
                          >{:else}<span class="b-mute2">—</span>{/if}
                      </td>
                      <td
                        class="b-mono col-tailnet"
                        class:t-set={s?.tailscale}
                        class:t-funnel={s?.tailscale?.funnel}
                        class:t-stale={s?.tailscale && !s.up}
                        title={s?.tailscale
                          ? s.tailscale.funnel
                            ? `Public funnel: ${tailscaleHost}:${s.tailscale.port}`
                            : `Tailnet-only: ${tailscaleHost}:${s.tailscale.port}`
                          : 'No tailscale serve mapping for this app'}
                      >
                        {#if s?.tailscale}:{s.tailscale.port}{:else}<span class="b-mute2"
                            >—</span
                          >{/if}
                      </td>
                      <td class="b-mono col-cpu" class:has-val={s?.cpuPct != null}>
                        {#if s?.cpuPct != null}{fmtCpu(s.cpuPct)}<span class="b-mute2"
                            >%</span
                          >{:else}<span class="b-mute2">—</span>{/if}
                      </td>
                      <td class="b-mono col-ram" class:has-val={s?.ramMB != null}>
                        {fmtMB(s?.ramMB)}
                      </td>
                      <td class="b-mono col-gpu" class:has-val={s?.gpuMB != null}>
                        {#if s?.gpuMB != null}{fmtMB(s.gpuMB)}{:else}<span class="b-mute2"
                            >—</span
                          >{/if}
                      </td>
                      <td class="col-uptime">
                        {#if data.uptime?.[a.id]?.length}
                          {@const u = data.uptime[a.id]}
                          {@const pct = Math.round(
                            (u.reduce((acc, b) => acc + b, 0) / u.length) * 100
                          )}
                          <svg
                            class="spark"
                            viewBox="0 0 132 16"
                            width="132"
                            height="16"
                            preserveAspectRatio="none"
                            aria-label={`24h uptime: ${pct}%`}
                          >
                            <title>{pct}% uptime over the last 24h</title>
                            {#each u as v, i}
                              <rect
                                x={i * 5.5}
                                y="0"
                                width="4.2"
                                height="16"
                                rx="0.8"
                                fill={v >= 0.95
                                  ? 'var(--b-ok)'
                                  : v >= 0.5
                                    ? 'var(--b-warn)'
                                    : v > 0
                                      ? 'var(--b-bad)'
                                      : 'var(--b-border)'}
                                opacity={v > 0 ? 1 : 0.5}
                              />
                            {/each}
                          </svg>
                        {:else}
                          <span class="b-mute2">—</span>
                        {/if}
                      </td>
                      <td class="col-act">
                        {#if a.port && s?.up}
                          {@const u = openUrl(a.port, s.tailscale)}
                          {#if u}
                            <a
                              class="b-btn icon"
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                              title={u}
                            >
                              <ExternalLink size={13} />
                            </a>
                          {/if}
                        {/if}
                        {#if !s?.up}
                          {#if a.start_cmd}
                            <span class="startsplit">
                              <button
                                class="b-btn icon primary main"
                                disabled={busy[a.id] != null}
                                onclick={() => act(a.id, 'start')}
                                title={`Start: ${a.start_cmd}`}
                              >
                                <Play size={13} />
                              </button>
                              <button
                                class="b-btn icon primary caret"
                                disabled={busy[a.id] != null}
                                aria-label="Start options"
                                onclick={(e) => {
                                  e.stopPropagation();
                                  if (openMenu?.id === a.id && openMenu.kind === 'start')
                                    closeMenu();
                                  else openMenuAt(a.id, 'start', e.currentTarget);
                                }}
                              >
                                <ChevronDown size={11} />
                              </button>
                            </span>
                          {:else}
                            <a
                              class="b-btn icon"
                              href={`/apps/${a.id}`}
                              title="No start command — click to configure"
                            >
                              <Settings2 size={13} />
                            </a>
                          {/if}
                        {:else}
                          <button
                            class="b-btn icon danger"
                            disabled={busy[a.id] != null}
                            onclick={() => act(a.id, 'stop')}
                            title={s.managedPid ? 'Stop managed process' : `Stop external listener (pid ${s.listenerPid ?? '?'})`}
                          >
                            <Square size={13} />
                          </button>
                          {#if s.managedPid}
                            <button
                              class="b-btn icon"
                              disabled={busy[a.id] != null}
                              onclick={() => act(a.id, 'restart')}
                              title="Restart"
                            >
                              <RotateCw size={13} />
                            </button>
                          {/if}
                        {/if}
                        <a class="b-btn icon" href={`/apps/${a.id}/logs`} title="Logs">
                          <Clock size={13} />
                        </a>
                      </td>
                      <td class="col-kebab">
                        <button
                          type="button"
                          class="b-btn icon kebab-trigger"
                          aria-label="More actions"
                          title="More"
                          onclick={(e) => {
                            e.stopPropagation();
                            if (openMenu?.id === a.id && openMenu.kind === 'kebab')
                              closeMenu();
                            else openMenuAt(a.id, 'kebab', e.currentTarget);
                          }}
                        >
                          <MoreVertical size={14} />
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="grid">
              {#each items as a (a.id)}
                {@const s = livestate[a.id]}
                <article class="b-surface card" class:dim={!s?.serving}>
                  <header class="card-head">
                    <div class="title">
                      <span
                        class="b-dot"
                        class:up={s?.serving}
                        class:warn={s?.managedPid != null && !s.serving}
                        class:down={s != null && !s.up}
                        class:idle={!s}
                        title={s?.managedPid != null && s.listenerPid == null
                          ? `Process alive (pid ${s.managedPid}) but not listening on a port — check Logs.`
                          : undefined}
                      ></span>
                      <a href={`/apps/${a.id}`} class="name">{a.name}</a>
                    </div>
                    <div class="meta">
                      {#if a.port}
                        <span class="b-pill" title={a.port + ''}>:{a.port}</span>
                      {/if}
                      <span class="b-pill">{a.kind}</span>
                    </div>
                  </header>

                  <div class="body">
                    <div class="path b-mono b-mute2" title={a.project_path}>
                      {a.project_path}
                    </div>

                    {#if s}
                      <div class="status">
                        {#if s.up}
                          {#if s.managedPid}
                            <span class="b-pill subtle"
                              >managed · {fmtSince(s.managedSince)}</span
                            >
                          {/if}
                          {#if s.latencyMs != null}
                            <span class="b-pill subtle">{s.latencyMs}ms</span>
                          {/if}
                        {/if}
                        {#if s.tailscale}
                          <span
                            class="b-pill ts"
                            class:funnel={s.tailscale.funnel}
                            class:stale={!s.up}
                            title={!s.up
                              ? `Mapped via tailscale but target :${a.port} is dead — would 502`
                              : s.tailscale.funnel
                                ? `Public funnel: ${tailscaleHost}:${s.tailscale.port}`
                                : `Tailnet-only: ${tailscaleHost}:${s.tailscale.port}`}
                          >
                            {s.tailscale.funnel ? 'funnel' : 'tailnet'} :{s.tailscale.port}
                          </span>
                        {/if}
                      </div>
                    {/if}
                  </div>

                  <footer class="actions">
                    {#if a.port && s?.up}
                      {@const u = openUrl(a.port, s.tailscale)}
                      {#if u}
                        <a class="b-btn" href={u} target="_blank" rel="noreferrer">
                          <ExternalLink size={13} /> Open
                        </a>
                      {/if}
                    {/if}
                    <a class="b-btn" href={`vscode://file${a.project_path}`}>
                      <Folder size={13} /> VS Code
                    </a>
                    {#if !s?.up}
                      {#if a.start_cmd}
                        <span class="startsplit">
                          <button
                            class="b-btn primary main"
                            disabled={busy[a.id] != null}
                            onclick={() => act(a.id, 'start')}
                            title={`Start: ${a.start_cmd}`}
                          >
                            <Play size={13} /> Start
                          </button>
                          <button
                            class="b-btn primary caret"
                            disabled={busy[a.id] != null}
                            aria-label="Start options"
                            onclick={(e) => {
                              e.stopPropagation();
                              if (openMenu?.id === a.id && openMenu.kind === 'start')
                                closeMenu();
                              else openMenuAt(a.id, 'start', e.currentTarget);
                            }}
                          >
                            <ChevronDown size={12} />
                          </button>
                        </span>
                      {:else}
                        <a class="b-btn" href={`/apps/${a.id}`} title="No start command set yet">
                          <Settings2 size={13} /> Configure
                        </a>
                      {/if}
                    {:else}
                      <button
                        class="b-btn danger"
                        disabled={busy[a.id] != null}
                        onclick={() => act(a.id, 'stop')}
                        title={s.managedPid ? 'Stop managed process' : `Stop external listener (pid ${s.listenerPid ?? '?'})`}
                      >
                        <Square size={13} /> Stop
                      </button>
                      {#if s.managedPid}
                        <button
                          class="b-btn"
                          disabled={busy[a.id] != null}
                          onclick={() => act(a.id, 'restart')}
                        >
                          <RotateCw size={13} /> Restart
                        </button>
                      {/if}
                    {/if}
                    <a class="b-btn" href={`/apps/${a.id}/logs`}>
                      <Clock size={13} /> Logs
                    </a>
                    <button
                      type="button"
                      class="b-btn icon kebab-trigger"
                      aria-label="More actions"
                      title="More"
                      onclick={(e) => {
                        e.stopPropagation();
                        if (openMenu?.id === a.id && openMenu.kind === 'kebab')
                          closeMenu();
                        else openMenuAt(a.id, 'kebab', e.currentTarget);
                      }}
                    >
                      <MoreVertical size={14} />
                    </button>
                  </footer>
                </article>
              {/each}
            </div>
          {/if}
        {/if}
              </section>
            {/each}
          {/if}
        </section>
      {/if}
    {/each}
  </div>
</div>

<!-- Floating dropdown. One element shared by both menu kinds — rendered at
     the page root so `position: fixed` escapes `.listwrap`'s `overflow-x: auto`
     clipping context. Coords come from the trigger's getBoundingClientRect
     captured at click time. -->
{#if openMenu && menuPos}
  {@const id = openMenuId}
  {@const app = openMenuApp}
  <div
    class="dropdown"
    role="menu"
    style="top: {menuPos.top}px; right: {menuPos.right}px;"
  >
    {#if openMenu?.kind === 'start'}
      <button class="dropitem" onclick={menuStartLocal}>
        <Play size={12} /> Start (local only)
      </button>
      <button class="dropitem" onclick={menuStartTailnet}>
        <Wifi size={12} /> Start + tailnet
      </button>
    {:else if openMenu?.kind === 'kebab' && app}
      {#if app.port && tailscaleAvailable}
        {@const onTailnet = !!livestate[id]?.tailscale}
        <button
          class="dropitem"
          class:emph={onTailnet}
          onclick={menuToggleTailnet}
        >
          <Globe size={12} />
          {onTailnet ? 'Remove from tailnet' : 'Publish via tailscale'}
        </button>
        <div class="droprule"></div>
      {/if}
      <button class="dropitem" onclick={menuCopyPath}>
        <Folder size={12} /> Copy path
      </button>
      <a class="dropitem" href={`vscode://file${app.project_path}`} onclick={closeMenu}>
        <Folder size={12} /> Open in VS Code
      </a>
      <a class="dropitem" href={`/apps/${id}`} onclick={closeMenu}>
        <Settings2 size={12} /> Configure…
      </a>
      {#if livestate[id]?.origin?.kind === 'systemd' && livestate[id]?.origin?.unit && livestate[id]?.origin?.scope}
        <div class="droprule"></div>
        <button class="dropitem danger" onclick={menuUninstall}>
          <Square size={12} /> Uninstall {livestate[id]!.origin!.unit}.service
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .head {
    padding: 8px 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .head h1 { font-size: 20px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
  .head p { margin: 4px 0 0; font-size: 13px; }
  .head-actions { display: flex; gap: 8px; align-items: center; }
  .viewtoggle { display: flex; gap: 4px; }
  .viewtoggle .b-btn.active {
    background: var(--b-accent);
    color: #fff;
    border-color: transparent;
  }
  .b-pill.viewbadge { margin-left: 6px; border-color: var(--b-border-2); }
  .b-pill.warn {
    margin-left: 6px;
    color: var(--b-warn);
    border-color: color-mix(in oklab, var(--b-warn) 35%, var(--b-border));
  }

  /* Two-column dashboard layout: sticky scrollspy sidebar + content. */
  .layout {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 24px;
    align-items: start;
  }
  .sidebar {
    position: sticky;
    top: 78px;            /* below the sticky header */
    max-height: calc(100vh - 96px);
    overflow-y: auto;
    padding-right: 4px;
  }
  .scrollspy { display: flex; flex-direction: column; gap: 2px; }
  /* Sidebar top-level Active / Inactive groupings. */
  .nav-section {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 8px;
  }
  .nav-section:first-child { margin-top: 0; }
  .nav-section-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    background: transparent;
    border: 0;
    text-align: left;
    cursor: pointer;
    color: var(--b-text-3);
    font: inherit;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 600;
    border-radius: 4px;
  }
  .nav-section-head:hover { color: var(--b-text-2); }
  .nav-section-head .nav-section-label { flex: 1; }
  .nav-section-head.active-section { color: var(--b-ok); }
  .nav-section-head.active-section:hover {
    color: color-mix(in oklab, var(--b-ok) 70%, var(--b-text));
  }
  .nav-section-count {
    font-family: var(--b-mono);
    font-size: 10.5px;
    color: var(--b-text-3);
  }
  .navitem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    background: transparent;
    border-radius: 6px;
    text-align: left;
    cursor: pointer;
    color: var(--b-text-2);
    font: inherit;
    font-size: 12.5px;
    transition: background 90ms;
  }
  .navitem:hover { background: var(--b-surface-2); color: var(--b-text); }
  /* Active scrollspy entry: tinted background + bolder text. No side accent
     bar — that style was explicitly disliked (see
     feedback-no-accent-bar-on-active-nav in memory). */
  .navitem.active {
    background: color-mix(in oklab, var(--b-accent) 14%, transparent);
    color: var(--b-text);
    font-weight: 600;
  }
  .navitem .label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .navitem .count {
    font-family: var(--b-mono);
    font-size: 10.5px;
    color: var(--b-text-3);
  }
  .navitem .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--b-border-2);
    flex-shrink: 0;
  }
  .navitem .dot.any-up { background: var(--b-ok); }

  /* Status pills made consistently subtle. The dim row + dot already tell
     the user the app is down; the pill is just supplementary detail. */
  .b-pill.subtle {
    color: var(--b-text-3);
    border-color: var(--b-border);
    background: transparent;
    font-weight: 400;
  }
  .b-pill.ts {
    color: var(--b-info);
    border-color: color-mix(in oklab, var(--b-info) 28%, var(--b-border));
    background: color-mix(in oklab, var(--b-info) 8%, var(--b-surface-2));
  }
  .b-pill.ts.funnel {
    color: var(--b-accent);
    border-color: color-mix(in oklab, var(--b-accent) 32%, var(--b-border));
    background: color-mix(in oklab, var(--b-accent) 10%, var(--b-surface-2));
  }
  /* Stale = tailscale mapped but proxy target dead. Muted, no strikethrough —
     the dim row carries the "down" signal already. */
  .b-pill.ts.stale {
    color: var(--b-text-3);
    border-color: var(--b-border);
    background: transparent;
  }

  /* Top-level Active / Inactive section wrappers. */
  .status-section {
    display: block;
    margin-top: 30px;
    scroll-margin-top: 72px;
  }
  .status-section:first-of-type { margin-top: 0; }
  .status-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--b-border);
  }
  .status-section-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    background: transparent;
    border: 0;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 6px;
    color: var(--b-text);
  }
  .status-section-toggle:hover h2 { color: var(--b-accent); }
  .status-section-toggle h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--b-text-2);
  }
  .status-section.status-active .status-section-toggle h2 { color: var(--b-ok); }
  .status-section-count {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-text-3);
  }

  .group { margin-top: 22px; scroll-margin-top: 72px; }
  .group:first-of-type { margin-top: 4px; }
  /* Project title row sits immediately above the table, left-aligned. The
     whole row is the collapse trigger; bulk actions live on the right. */
  .group-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    margin: 0 0 8px;
  }
  .collapse {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    background: transparent;
    border: 0;
    padding: 4px 2px;
    cursor: pointer;
    color: var(--b-text);
    border-radius: 6px;
    min-width: 0;
  }
  .collapse:hover h2 { color: var(--b-accent); }
  .collapse h2 {
    font-size: 16px;
    margin: 0;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--b-text);
  }
  .collapse .b-mute2 {
    font-family: var(--b-mono);
    font-size: 11px;
  }

  .bulk { display: flex; gap: 4px; }
  .b-btn.small {
    padding: 3px 8px;
    font-size: 11px;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 10px;
  }
  .card { padding: 10px 12px 10px; display: flex; flex-direction: column; gap: 8px; }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name {
    font-weight: 600;
    color: var(--b-text);
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name:hover { color: var(--b-accent); }
  .meta { display: flex; gap: 4px; flex-shrink: 0; }
  .body { display: flex; flex-direction: column; gap: 6px; }
  .path { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { display: flex; flex-wrap: wrap; gap: 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }

  /* List view — compact table.
     `table-layout: fixed` plus explicit column widths means every group's
     table renders identical column geometry, so columns line up vertically
     across groups even though each group is its own <table>. */
  .listwrap { overflow-x: auto; padding: 0; }
  .list {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    table-layout: fixed;
  }
  .list thead th {
    text-align: left;
    padding: 7px 10px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--b-text-3);
    font-weight: 500;
    background: var(--b-surface-2);
    border-bottom: 1px solid var(--b-border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list tbody td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--b-border);
    vertical-align: middle;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list tbody tr:last-child td { border-bottom: none; }
  .list tbody tr:hover { background: color-mix(in oklab, var(--b-surface-2) 50%, transparent); }
  .list .col-st {
    width: 26px;
    padding-left: 12px;
    padding-right: 0;
    overflow: visible;
  }
  .list .col-port { width: 68px; }
  .list .col-kind { width: 52px; font-size: 11px; }
  .list .col-source {
    width: 124px;
    font-size: 11.5px;
    color: var(--b-text-3);
  }
  /* Berth-supervised pids get the accent so you can find them at a glance. */
  .list .col-source.src-managed { color: var(--b-accent); font-weight: 500; }
  /* Systemd-owned pids stay on --b-text — bigger pool, no need to highlight. */
  .list .col-source.src-systemd { color: var(--b-text); }
  .list tbody tr.dim .col-source { color: var(--b-text-3); }
  .list .col-tailnet { width: 84px; }
  .list .col-cpu, .list .col-ram, .list .col-gpu {
    width: 58px;
    font-size: 11.5px;
    color: var(--b-text-3);
    text-align: right;
  }
  .list .col-cpu.has-val, .list .col-ram.has-val, .list .col-gpu.has-val {
    color: var(--b-text);
  }
  .list tbody tr.dim .col-cpu, .list tbody tr.dim .col-ram, .list tbody tr.dim .col-gpu {
    color: var(--b-text-3);
  }
  .list .col-uptime { width: 148px; overflow: visible; }
  /* Port column reads green once the local listener is confirmed serving on
     it, so a quick scan across Port + Tailscale columns shows which access
     paths are currently live (green :port = local up; blue :port = tailnet
     mapped + serving; grey :port in either column = configured but inert). */
  .list .col-port.port-up { color: var(--b-ok); }
  .list .col-act {
    text-align: right;
    overflow: visible;
    padding-right: 6px;
  }
  .list .col-kebab {
    width: 36px;
    text-align: right;
    overflow: visible;
    padding-left: 0;
  }
  .list .col-act .b-btn.icon { padding: 4px 6px; margin-left: 2px; vertical-align: middle; }
  .list .col-kebab .b-btn.icon { padding: 4px 6px; vertical-align: middle; }

  /* Tailnet toggle — Globe icon turns blue when the mapping is active so the
     button reads "this app is on the tailnet" at a glance. */
  .b-btn.tail-on {
    color: var(--b-info);
    border-color: color-mix(in oklab, var(--b-info) 32%, var(--b-border));
    background: color-mix(in oklab, var(--b-info) 9%, var(--b-surface));
  }
  .b-btn.tail-on:hover {
    background: color-mix(in oklab, var(--b-info) 14%, var(--b-surface));
  }

  /* Kebab "more" trigger — keep it visually quiet; it's a low-frequency action. */
  .b-btn.kebab-trigger {
    color: var(--b-text-3);
    border-color: transparent;
    background: transparent;
  }
  .b-btn.kebab-trigger:hover {
    color: var(--b-text);
    background: var(--b-surface-2);
  }
  .list .col-name .name {
    font-weight: 500;
    color: var(--b-text);
    text-decoration: none;
  }
  .list .col-name .name:hover { color: var(--b-accent); }

  /* Tailscale column — styled like the Port column (mono, color hints
     funnel vs tailnet vs stale). Plain monospace, no pill. */
  .list .col-tailnet { color: var(--b-text-3); }
  .list .col-tailnet.t-set { color: var(--b-info); }
  .list .col-tailnet.t-funnel { color: var(--b-accent); }
  .list .col-tailnet.t-stale { color: var(--b-text-3); }

  /* 24h uptime sparkline. Bars are --b-ok with opacity scaled by up-fraction
     so eyes immediately see which hours had any uptime at all. */
  .spark { display: inline-block; vertical-align: middle; }

  /* Down / idle rows lose the pure --b-text and drop to --b-text-3 so the
     contrast against live rows is unmistakable. */
  .list tbody tr.dim td,
  .list tbody tr.dim .name {
    color: var(--b-text-3);
  }
  .card.dim,
  .card.dim .name {
    color: var(--b-text-3);
  }

  /* Start split button — main click runs start_cmd; caret opens a dropdown
     letting you also publish via tailscale serve. Both buttons share the
     same vertical padding (4px) and butt against each other with one inset
     divider line, so the join looks clean at any zoom level. */
  .startsplit {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    vertical-align: middle;
  }
  .startsplit .b-btn.main {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: none;
  }
  .startsplit .b-btn.caret {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    padding-left: 6px;
    padding-right: 6px;
    border-left: 1px solid rgba(0, 0, 0, 0.18);
  }
  /* In col-act, regular icon buttons get a 2px left margin to space them
     out — but the caret half of the split must hug the main button. */
  .list .col-act .startsplit .b-btn { margin-left: 0; }
  .list .col-act .startsplit { margin-left: 2px; }
  /* Floating dropdown — `position: fixed` (top/right come from inline style)
     so it isn't clipped by `.listwrap`'s `overflow-x: auto`. Lives at the
     page root via `{#if startMenu}` and is anchored to the caret button's
     viewport rect captured at click time. */
  .dropdown {
    position: fixed;
    z-index: 100;
    min-width: 200px;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .dropitem {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    background: transparent;
    border-radius: 6px;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 12.5px;
    color: var(--b-text);
  }
  .dropitem:hover { background: var(--b-surface-2); }
  .dropitem.emph { color: var(--b-info); font-weight: 500; }
  .dropitem.danger { color: var(--b-bad); }
  .dropitem.danger:hover {
    background: color-mix(in oklab, var(--b-bad) 9%, var(--b-surface-2));
  }
  .droprule {
    height: 1px;
    background: var(--b-border);
    margin: 4px 4px;
  }

  @media (max-width: 880px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { display: none; }
  }
  @media (max-width: 720px) {
    .list .col-path, .list .col-kind { display: none; }
  }
</style>
