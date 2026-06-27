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
    Globe as GlobeIcon,
    Wifi,
    MoreVertical,
    Plus,
    Lock,
    Users as UsersIcon,
    GitBranch as GitBranchIcon,
    Download,
    Loader2,
    AlertCircle,
    Trash2
  } from 'lucide-svelte';
  import AddAppModal from '$lib/components/AddAppModal.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import OnboardingChecklist from '$lib/components/OnboardingChecklist.svelte';
  import OnboardingTour from '$lib/components/OnboardingTour.svelte';
  import VisibilityBadge from '$lib/components/VisibilityBadge.svelte';
  import GrantsModal from '$lib/components/GrantsModal.svelte';
  import RemoveAppModal from '$lib/components/RemoveAppModal.svelte';
  // The vite-config patcher was removed — tailnet hostnames now route
  // through berth-control's Host-rewrite proxy (src/lib/server/host-rewrite-proxy.ts)
  // so no user-repo edit is ever required.
  import MiniLogWindow from '$lib/components/MiniLogWindow.svelte';
  // Vendored from @berth/ui — see src/lib/components/DataTable.svelte.
  import DataTable from '$lib/components/DataTable.svelte';
  type App = (typeof data.apps)[number];
  type ListState = (typeof livestate)[string] | null | undefined;
  type ListRow = {
    /** Real id — also the DataTable filter haystack. */
    id: string;
    /** Default-render fallback string for the name column. */
    name: string;
    app: App;
    state: ListState;
    isChild: boolean;
  };
  import { toast } from '$lib/toast.js';
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types.js';

  let { data }: { data: PageData } = $props();

  // Role-gated UI. Server-side 403 is the real enforcement; this just turns
  // off affordances so viewers don't see buttons that will reject their click.
  const isAdmin = $derived(data.user?.role === 'admin');
  function viewerToast() {
    toast.error('Read-only access', 'You are signed in as viewer. Ask an admin to promote you.');
  }

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
  // Hydrate from the server's snapshot so the first render reflects reality.
  // Without this seed, every app shows a "Start" button for the SSE-connect
  // window even when its listener is already up — looked broken for foreign
  // listeners that berth correctly detects but doesn't own.
  let livestate: Record<string, LiveStatus> = $state(
    (data.initialLive?.byApp ?? {}) as Record<string, LiveStatus>
  );
  let liveTs: number = $state(data.initialLive?.ts ?? 0);
  let tailscaleHost: string | null = $state(data.initialLive?.tailscaleHost ?? null);
  let tailscaleAvailable: boolean = $state(!!data.initialLive?.tailscaleAvailable);

  type RepoState = {
    default_branch: string | null;
    commits_behind: number;
    commits_ahead: number;
    fetch_status: 'idle' | 'queued' | 'fetching' | 'pulling' | 'error';
    fetch_error: string | null;
    last_fetched_at: number | null;
    local_sha: string | null;
    remote_sha: string | null;
    /** Paths of subapps the inspector found post-fetch that aren't registered
     *  yet. The parent card shows "↑N new subapps" when this is non-empty. */
    new_subapps: string[];
  };
  let repoState: Record<string, RepoState> = $state({});
  let es: EventSource | null = null;
  let busy: Record<string, 'start' | 'stop' | 'restart' | 'tailnet' | null> = $state({});

  // Detect which pipeline the user is currently viewing Berth through.
  let pageHost: string = $state('');
  const viaTailnet = $derived(pageHost.endsWith('.ts.net'));

  // View mode: 'grid' (default, card per app) or 'list' (compact rows).
  // Persisted per-browser in localStorage.
  let view: 'grid' | 'list' = $state('grid');

  let addOpen = $state(false);
  let grantsOpenAppId: string | null = $state(null);
  let removeOpenAppId: string | null = $state(null);
  /** When set alongside grantsOpenAppId, the GrantsModal opens in "pending
   *  flip" mode — it lets the user pick grants and commits the visibility
   *  change atomically when they hit the save button. Cleared on close. */
  let grantsPendingVisibility: 'invited' | 'public' | null = $state(null);

  function openGrants(id: string, pending: 'invited' | 'public' | null = null) {
    grantsOpenAppId = id;
    grantsPendingVisibility = pending;
  }

  /** Start every direct child of a monorepo. Uses /api/bulk so the permission
   *  check is per-child (skips any the user can't manage) without failing the
   *  whole batch. */
  async function startAllSubapps(rootId: string) {
    const subapps = data.apps.filter((a) => a.parent_id === rootId);
    if (subapps.length === 0) {
      toast.info('No subapps registered under this monorepo');
      return;
    }
    // Same filter as the group-level "Start all" — only attempt subapps that
    // actually have a start_cmd, so the toast reports honest numbers instead
    // of "9/9 started" when some couldn't have started in the first place.
    const ids = subapps.filter((a) => a.start_cmd).map((a) => a.id);
    const skipped = subapps.length - ids.length;
    if (ids.length === 0) {
      toast.info(
        'No subapps have a start command',
        `${subapps.length} subapp${subapps.length === 1 ? '' : 's'} skipped — open each to configure`
      );
      return;
    }
    const tid = toast.loading(
      `Starting ${ids.length} subapp${ids.length === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped — no start cmd)` : ''}…`
    );
    try {
      const r = await fetch('/api/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'start', ids })
      });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'Bulk start failed',
          description: summarizeError(await r.text(), r.status),
          durationMs: 10_000
        });
        return;
      }
      const j = (await r.json()) as { count: number; results: Record<string, { ok: boolean; msg?: string }> };
      const okCount = Object.values(j.results).filter((x) => x.ok).length;
      const failCount = j.count - okCount;
      toast.update(tid, {
        kind: failCount === 0 ? 'success' : 'error',
        title: `${okCount}/${j.count} started`,
        description: failCount > 0 ? `${failCount} couldn't start — check Logs` : undefined,
        durationMs: 4000
      });
    } catch (e) {
      toast.update(tid, {
        kind: 'error',
        title: 'Bulk start failed',
        description: e instanceof Error ? e.message : String(e),
        durationMs: 8000
      });
    }
  }

  /** Register any new subapps the fetcher detected under this monorepo root. */
  async function registerNewSubapps(rootId: string) {
    const tid = toast.loading('Registering new subapps…');
    try {
      const r = await fetch(`/api/apps/${rootId}/register-new-subapps`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'Register failed',
          description: summarizeError(await r.text(), r.status),
          durationMs: 8000
        });
        return;
      }
      const j = (await r.json()) as { registered: number; created: string[] };
      toast.update(tid, {
        kind: 'success',
        title: `Registered ${j.registered} new subapp${j.registered === 1 ? '' : 's'}`,
        description: j.created.length > 0 ? j.created.slice(0, 6).join(', ') + (j.created.length > 6 ? '…' : '') : undefined,
        durationMs: 4000
      });
      await invalidateAll();
    } catch (e) {
      toast.update(tid, {
        kind: 'error',
        title: 'Register failed',
        description: e instanceof Error ? e.message : String(e),
        durationMs: 8000
      });
    }
  }

  async function repoFetch(id: string) {
    const r = await fetch(`/api/apps/${id}/repo/fetch`, { method: 'POST' });
    if (!r.ok) {
      toast.error('Fetch failed', summarizeError(await r.text(), r.status));
      return;
    }
    const j = (await r.json()) as { queued: boolean; reason?: string };
    if (j.queued) {
      toast.success('Queued', `Fetching ${appName(id)}…`);
    } else {
      toast.info('Skipped', j.reason ?? 'already fresh');
    }
  }

  async function repoPull(id: string) {
    const tid = toast.loading(`Pulling ${appName(id)}…`);
    try {
      const r = await fetch(`/api/apps/${id}/repo/pull`, { method: 'POST' });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'Pull failed',
          description: summarizeError(await r.text(), r.status),
          durationMs: 10_000
        });
        return;
      }
      const j = (await r.json()) as { ok: true; new_sha: string };
      toast.update(tid, {
        kind: 'success',
        title: `${appName(id)} pulled`,
        description: `at ${j.new_sha.slice(0, 8)}`,
        durationMs: 4000
      });
    } catch (e) {
      toast.update(tid, {
        kind: 'error',
        title: 'Pull request failed',
        description: e instanceof Error ? e.message : String(e),
        durationMs: 10_000
      });
    }
  }

  async function flipVisibility(id: string, next: 'private' | 'invited' | 'public') {
    if (!isAdmin && next === 'public') {
      viewerToast();
      return;
    }
    const tid = toast.loading(`Setting visibility → ${next}…`);
    try {
      const r = await fetch(`/api/apps/${id}/visibility`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ visibility: next })
      });
      if (!r.ok) {
        toast.update(tid, {
          kind: 'error',
          title: 'Visibility change failed',
          description: summarizeError(await r.text(), r.status),
          durationMs: 8000
        });
        return;
      }
      toast.update(tid, { kind: 'success', title: `Visibility → ${next}`, durationMs: 2500 });
      await invalidateAll();
    } catch (e) {
      toast.update(tid, {
        kind: 'error',
        title: 'Visibility change failed',
        description: e instanceof Error ? e.message : String(e),
        durationMs: 8000
      });
    }
  }

  // Collapsed project groups: { [groupName]: true }. Persisted across reloads.
  // Shared across Active/Inactive sections — if you collapse "sample-monorepo",
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
        repoState = j.repos ?? {};
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
      if (!t?.closest('.kebab-trigger') && !t?.closest('.dropdown')) {
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
    // Prefer the *confirmed* tailscale mapping if the SSE snapshot has it.
    if (viaTailnet && ts && tailscaleHost) {
      return `https://${tailscaleHost}:${ts.port}`;
    }
    // Fallback: as soon as we know the tailscale hostname (always true on
    // the dashboard once the first SSE snapshot lands), preemptively produce
    // the tailnet URL using the app's port. Berth-control's contract is
    // "every start publishes on tailnet", so this URL becomes correct the
    // moment the serve mapping is registered — which happens in the same
    // tick as `act(id, 'start')`'s chained POST /tailscale-serve. Before
    // this fix the link flashed 127.0.0.1 for the first second or two
    // until the SSE snapshot caught up.
    if (tailscaleHost) {
      return `https://${tailscaleHost}:${port}`;
    }
    return `http://127.0.0.1:${port}`;
  }

  function setView(v: 'grid' | 'list') {
    view = v;
    if (typeof localStorage !== 'undefined') localStorage.setItem('berth.view', v);
  }

  // (vite-config patch consent modal removed — Approach A handles
  // tailnet Host headers via the Host-rewrite proxy. Nothing to gate.)

  // Mini-log window state — appears bottom-right on Start, above the toaster.
  // Holds one app at a time (the most recent Start); the user can close it
  // or expand to the full /apps/[id] view.
  let miniLogAppId = $state<string | null>(null);
  let miniLogExpanded = $state(false);
  function openMiniLog(id: string) {
    miniLogAppId = id;
    miniLogExpanded = false;
  }
  function closeMiniLog() {
    miniLogAppId = null;
  }

  async function act(id: string, kind: 'start' | 'stop' | 'restart') {
    if (!isAdmin) {
      viewerToast();
      return;
    }
    return doAct(id, kind);
  }

  async function doAct(id: string, kind: 'start' | 'stop' | 'restart') {
    busy[id] = kind;
    const name = appName(id);
    const verb = kind === 'start' ? 'Starting' : kind === 'stop' ? 'Stopping' : 'Restarting';
    const tid = toast.loading(
      kind === 'start' || kind === 'restart'
        ? `${verb} ${name} + publishing on tailnet…`
        : `${verb} ${name}…`
    );
    // Pop the mini-log window for any start/restart so the user can watch
    // progress without leaving the dashboard.
    if (kind === 'start' || kind === 'restart') openMiniLog(id);
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
        // Chain tailscale-serve unconditionally — berth-control's contract
        // is "start" = "running on the tailnet". No loopback-only mode.
        // Best-effort: if tailnet setup fails we still consider the start
        // a soft win (the process is running) but surface the failure in
        // the toast so the user notices.
        busy[id] = 'tailnet';
        try {
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
          // Tailnet endpoint may have persisted a freshly-detected port —
          // pull the new page data so the Port column shows it.
          const tBody = await t.json().catch(() => ({}));
          if (tBody?.autoDetected) void invalidateAll();
        } catch (e) {
          toast.update(tid, {
            kind: 'error',
            title: 'App started but tailnet setup failed',
            description: e instanceof Error ? e.message : String(e),
            durationMs: 10_000
          });
          return;
        }
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

  // `startWithTailnet` used to be a separate function that did start + then
  // tailscale-serve. Now that act() always chains tailnet on start/restart,
  // there's no second entrypoint — every start is `act(id, 'start')`.

  let bulkBusy: string | null = $state(null);
  async function bulkAct(
    group: string,
    action: 'start' | 'stop',
    items: { id: string; start_cmd?: string | null }[]
  ) {
    // Filter out start-targets that have no start_cmd configured. The server
    // would already reject them one-by-one (`startApp` throws "No start_cmd"),
    // but pre-filtering keeps the loading toast honest and gives the user a
    // clear "skipped N — no start command" hint instead of a misleading
    // "Starting all" / "Bulk start dispatched" message.
    const eligible = action === 'start' ? items.filter((i) => i.start_cmd) : items;
    const skipped = items.length - eligible.length;
    if (eligible.length === 0) {
      toast.info(
        `Nothing to ${action}`,
        `${items.length} app${items.length === 1 ? '' : 's'} skipped — no start command`
      );
      return;
    }
    bulkBusy = `${group}:${action}`;
    const tid = toast.loading(
      `${action === 'start' ? 'Starting' : 'Stopping'} ${eligible.length} ${group} app${eligible.length === 1 ? '' : 's'}${skipped ? ` (${skipped} skipped — no start cmd)` : ''}…`
    );
    try {
      const ids = eligible.map((i) => i.id);
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
  /** Per-monorepo-root collapse state. Default = expanded so the user sees
   *  everything on first paint. Clicking the chevron toggles. Persisted in
   *  localStorage so it survives a page refresh. */
  let foldersCollapsed: Record<string, boolean> = $state({});

  function toggleFolder(rootId: string) {
    foldersCollapsed = { ...foldersCollapsed, [rootId]: !foldersCollapsed[rootId] };
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('berth.folders', JSON.stringify(foldersCollapsed));
      } catch {
        /* */
      }
    }
  }

  // Rehydrate collapse state once on mount.
  $effect(() => {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('berth.folders');
      if (raw) {
        try {
          foldersCollapsed = JSON.parse(raw) as Record<string, boolean>;
        } catch {
          /* */
        }
      }
    }
  });

  /** Flatten a top-level items list into [parent, ...its-children-if-expanded].
   *  The row/card renderer reads `isChild` to apply the nested treatment. When
   *  a parent is collapsed, its children are excluded entirely — the row/card
   *  for the parent itself is what gets rendered, with the chevron + count
   *  serving as the affordance to expand. */
  function flatten(items: typeof data.apps): Array<{ app: typeof data.apps[number]; isChild: boolean }> {
    const out: Array<{ app: typeof data.apps[number]; isChild: boolean }> = [];
    for (const a of items) {
      out.push({ app: a, isChild: false });
      if (foldersCollapsed[a.id]) continue; // hide children when collapsed
      const kids = childrenByParent[a.id];
      if (kids) {
        for (const c of kids) out.push({ app: c, isChild: true });
      }
    }
    return out;
  }

  // Children of each monorepo root, keyed by parent id. Rendered inline
  // under the parent's row / card, NOT as their own top-level group.
  const childrenByParent = $derived.by(() => {
    const out: Record<string, typeof data.apps> = {};
    for (const a of data.apps) {
      if (!a.parent_id) continue;
      (out[a.parent_id] ??= []).push(a);
    }
    for (const id of Object.keys(out)) {
      out[id].sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  });

  const groupedByStatus = $derived.by(() => {
    const buckets: Record<Section, Map<string, typeof data.apps>> = {
      active: new Map(),
      inactive: new Map()
    };
    // Only top-level apps participate in the grouping — subapps render
    // nested under their parent's row instead of as their own cards.
    for (const a of data.apps) {
      if (a.parent_id) continue;
      const section: Section = livestate[a.id]?.serving ? 'active' : 'inactive';
      /* `??` only triggers on null/undefined — `group_tag` is often stored
       * as the empty string when the AddAppModal leaves the field blank.
       * Treat empty/whitespace as "not set" so guessGroup() takes over. */
      const tag = a.group_tag?.trim();
      const k = tag && tag.length > 0 ? tag : guessGroup(a);
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
    'Users', // macOS user root: `/Users/<name>/Development/...`
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
    /* Skip workspace-container segments. The `i === 1` cases handle the
     * platform-specific user-name segment that sits right after `/home` or
     * `/Users` — we don't want to bucket every app on the machine under the
     * username (then EVERY top-level project ends up in the same group). */
    while (
      i < segs.length &&
      (SKIP_DIRS.has(segs[i]) || (i === 1 && (segs[0] === 'home' || segs[0] === 'Users')))
    ) {
      i++;
    }
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
    {#if isAdmin}
      <button class="b-btn primary" onclick={() => (addOpen = true)} title="Register a project folder as a Berth app">
        <Plus size={13} /> Add app
      </button>
    {/if}
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

<AddAppModal bind:open={addOpen} {isAdmin} />

{#if grantsOpenAppId}
  {@const ga = data.apps.find((a) => a.id === grantsOpenAppId)}
  {#if ga}
    <GrantsModal
      app={ga}
      pendingVisibility={grantsPendingVisibility}
      onClose={() => {
        grantsOpenAppId = null;
        grantsPendingVisibility = null;
      }}
    />
  {/if}
{/if}

{#if removeOpenAppId}
  {@const ra = data.apps.find((a) => a.id === removeOpenAppId)}
  {#if ra}
    {@const childCount = data.apps.filter((a) => a.parent_id === ra.id).length}
    <RemoveAppModal
      app={ra}
      {childCount}
      onClose={() => (removeOpenAppId = null)}
    />
  {/if}
{/if}

{#if miniLogAppId}
  {@const ma = data.apps.find((a) => a.id === miniLogAppId)}
  {#if ma}
    <MiniLogWindow
      appId={ma.id}
      appName={ma.name}
      port={ma.port}
      tailscaleHost={tailscaleHost}
      expanded={miniLogExpanded}
      onClose={closeMiniLog}
      onToggleExpand={() => (miniLogExpanded = !miniLogExpanded)}
    />
  {/if}
{/if}

{#if data.apps.length === 0}
  <EmptyState onAddApp={() => (addOpen = true)} canAdd={isAdmin} />
{:else}
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
            {@const listRows = flatten(items).map((r): ListRow => ({
              id: r.app.id,
              name: r.app.name,
              app: r.app,
              state: livestate[r.app.id] as ListState,
              isChild: r.isChild
            }))}

            {#snippet stCell(r: ListRow)}
              <span
                class="b-dot"
                class:up={r.state?.serving}
                class:warn={r.state?.managedPid != null && !r.state.serving}
                class:down={r.state != null && !r.state.up}
                class:idle={!r.state}
                title={r.state?.managedPid != null && r.state.listenerPid == null
                  ? `Berth-managed process is alive (pid ${r.state.managedPid}) but isn't bound to any TCP port. The start command probably failed or hasn't bound yet — check Logs.`
                  : undefined}
              ></span>
            {/snippet}

            {#snippet nameCell(r: ListRow)}
              {@const a = r.app}
              {#if a.is_monorepo && childrenByParent[a.id]?.length}
                <button
                  type="button"
                  class="folder-toggle"
                  aria-label={foldersCollapsed[a.id] ? 'Expand subapps' : 'Collapse subapps'}
                  onclick={(e) => { e.stopPropagation(); toggleFolder(a.id); }}
                >
                  {#if foldersCollapsed[a.id]}
                    <ChevronRight size={12} />
                  {:else}
                    <ChevronDown size={12} />
                  {/if}
                </button>
              {/if}
              <a href={`/apps/${a.id}`} class="name">{a.name}</a>
              <VisibilityBadge visibility={a.visibility} showLabel={false} size={10} />
              {#if a.is_monorepo && childrenByParent[a.id]?.length}
                <span class="folder-count" title={`${childrenByParent[a.id].length} subapps`}>
                  <Folder size={9} />
                  {childrenByParent[a.id].length}
                </span>
              {/if}
              {#if a.is_monorepo && repoState[a.id]?.new_subapps?.length}
                <button
                  type="button"
                  class="new-subapps-pill"
                  title={`${repoState[a.id].new_subapps.length} new subapp${repoState[a.id].new_subapps.length === 1 ? '' : 's'} found on disk — click to register`}
                  onclick={(e) => { e.stopPropagation(); registerNewSubapps(a.id); }}
                >
                  <Plus size={9} /> {repoState[a.id].new_subapps.length} new
                </button>
              {/if}
              {#if repoState[a.id]}
                {#if repoState[a.id].fetch_status === 'fetching' || repoState[a.id].fetch_status === 'queued' || repoState[a.id].fetch_status === 'pulling'}
                  <span class="repo-pill working" title={repoState[a.id].fetch_status}>
                    <Loader2 size={10} class="spin" />
                  </span>
                {:else if repoState[a.id].commits_behind > 0}
                  <button
                    type="button"
                    class="repo-pill behind"
                    title={`${repoState[a.id].commits_behind} behind origin/${repoState[a.id].default_branch ?? 'HEAD'} — click to pull`}
                    onclick={(e) => { e.stopPropagation(); repoPull(a.id); }}
                  >
                    <Download size={10} /> ↑{repoState[a.id].commits_behind}
                  </button>
                {:else if repoState[a.id].fetch_status === 'error'}
                  <span class="repo-pill err" title={repoState[a.id].fetch_error ?? 'fetch error'}>
                    <AlertCircle size={10} />
                  </span>
                {/if}
              {/if}
            {/snippet}

            {#snippet portCell(r: ListRow)}
              <span class="b-mono" class:port-up={r.state?.serving}>
                {#if r.app.port}:{r.app.port}{:else}<span class="b-mute2">—</span>{/if}
              </span>
            {/snippet}

            {#snippet kindCell(r: ListRow)}
              {#if r.state?.up && r.app.port}
                <a
                  class="open-link"
                  href={`http://127.0.0.1:${r.app.port}/`}
                  target="_blank"
                  rel="noopener"
                  title={`Open ${r.app.name} in browser`}
                >
                  <ExternalLink size={10} /> open
                </a>
              {:else}
                <span class="b-mono b-mute2">{r.app.kind}</span>
              {/if}
            {/snippet}

            {#snippet sourceCell(r: ListRow)}
              {@const s = r.state}
              <span
                class="b-mono"
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
                {#if s?.origin?.kind === 'managed'}managed{:else if s?.origin?.kind === 'systemd'}{s.origin.unit}{:else if s?.origin?.kind === 'scope'}<span class="b-mute2">scope</span>{:else}<span class="b-mute2">—</span>{/if}
              </span>
            {/snippet}

            {#snippet tailnetCell(r: ListRow)}
              {@const s = r.state}
              <span
                class="b-mono"
                class:t-set={s?.tailscale}
                class:t-funnel={s?.tailscale?.funnel}
                class:t-stale={s?.tailscale && !s.up}
                title={s?.tailscale
                  ? s.tailscale.funnel
                    ? `Public funnel: ${tailscaleHost}:${s.tailscale.port}`
                    : `Tailnet-only: ${tailscaleHost}:${s.tailscale.port}`
                  : 'No tailscale serve mapping for this app'}
              >
                {#if s?.tailscale}:{s.tailscale.port}{:else}<span class="b-mute2">—</span>{/if}
              </span>
            {/snippet}

            {#snippet cpuCell(r: ListRow)}
              <span class="b-mono" class:has-val={r.state?.cpuPct != null}>
                {#if r.state?.cpuPct != null}{fmtCpu(r.state.cpuPct)}<span class="b-mute2">%</span>{:else}<span class="b-mute2">—</span>{/if}
              </span>
            {/snippet}

            {#snippet ramCell(r: ListRow)}
              <span class="b-mono" class:has-val={r.state?.ramMB != null}>{fmtMB(r.state?.ramMB)}</span>
            {/snippet}

            {#snippet gpuCell(r: ListRow)}
              <span class="b-mono" class:has-val={r.state?.gpuMB != null}>
                {#if r.state?.gpuMB != null}{fmtMB(r.state.gpuMB)}{:else}<span class="b-mute2">—</span>{/if}
              </span>
            {/snippet}

            {#snippet uptimeCell(r: ListRow)}
              {#if data.uptime?.[r.app.id]?.length}
                {@const u = data.uptime[r.app.id]}
                {@const pct = Math.round((u.reduce((acc, b) => acc + b, 0) / u.length) * 100)}
                <svg class="spark" viewBox="0 0 132 16" width="132" height="16" preserveAspectRatio="none" aria-label={`24h uptime: ${pct}%`}>
                  <title>{pct}% uptime over the last 24h</title>
                  {#each u as v, i}
                    <rect
                      x={i * 5.5}
                      y="0"
                      width="4.2"
                      height="16"
                      rx="0.8"
                      fill={v >= 0.95 ? 'var(--b-ok)' : v >= 0.5 ? 'var(--b-warn)' : v > 0 ? 'var(--b-bad)' : 'var(--b-border)'}
                      opacity={v > 0 ? 1 : 0.5}
                    />
                  {/each}
                </svg>
              {:else}
                <span class="b-mute2">—</span>
              {/if}
            {/snippet}

            {#snippet actCell(r: ListRow)}
              {@const a = r.app}
              {@const s = r.state}
              {#if a.port && s?.up}
                {@const u = openUrl(a.port, s.tailscale)}
                {#if u}
                  <a class="b-btn icon" href={u} target="_blank" rel="noreferrer" title={u}>
                    <ExternalLink size={13} />
                  </a>
                {/if}
              {/if}
              {#if !s?.up}
                {#if a.start_cmd}
                  <button
                    class="b-btn icon primary"
                    disabled={busy[a.id] != null}
                    onclick={() => act(a.id, 'start')}
                    title={`Start + publish on tailnet: ${a.start_cmd}`}
                  >
                    <Play size={13} />
                  </button>
                {:else}
                  <a class="b-btn icon" href={`/apps/${a.id}`} title="No start command — click to configure">
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
                  <button class="b-btn icon" disabled={busy[a.id] != null} onclick={() => act(a.id, 'restart')} title="Restart">
                    <RotateCw size={13} />
                  </button>
                {/if}
              {/if}
              <a class="b-btn icon" href={`/apps/${a.id}/logs`} title="Logs">
                <Clock size={13} />
              </a>
            {/snippet}

            {#snippet kebabCell(r: ListRow)}
              <button
                type="button"
                class="b-btn icon kebab-trigger"
                aria-label="More actions"
                title="More"
                onclick={(e) => {
                  e.stopPropagation();
                  if (openMenu?.id === r.app.id && openMenu.kind === 'kebab') closeMenu();
                  else openMenuAt(r.app.id, 'kebab', e.currentTarget);
                }}
              >
                <MoreVertical size={14} />
              </button>
            {/snippet}

            <div class="b-surface listwrap">
              <DataTable
                rows={listRows}
                dense
                filterable={false}
                pageSize={9999}
                class="list"
                rowClass={(r) => {
                  const cls: string[] = [];
                  if (!r.state?.serving) cls.push('dim');
                  if (r.isChild) cls.push('subapp-row');
                  if (r.app.is_monorepo && childrenByParent[r.app.id]?.length) cls.push('folder-row');
                  return cls.join(' ');
                }}
                columns={[
                  { key: 'id', label: '', class: 'col-st', width: '26px', render: stCell },
                  { key: 'name', label: 'App', class: 'col-name', render: nameCell },
                  { key: 'name', label: 'Port', class: 'col-port', width: '68px', render: portCell },
                  { key: 'name', label: 'Kind', class: 'col-kind', width: '52px', render: kindCell },
                  { key: 'name', label: 'Source', class: 'col-source', width: '124px', render: sourceCell },
                  { key: 'name', label: 'Tailscale', class: 'col-tailnet', width: '84px', render: tailnetCell },
                  { key: 'name', label: 'CPU', class: 'col-cpu', width: '58px', align: 'right', render: cpuCell },
                  { key: 'name', label: 'RAM', class: 'col-ram', width: '58px', align: 'right', render: ramCell },
                  { key: 'name', label: 'GPU', class: 'col-gpu', width: '58px', align: 'right', render: gpuCell },
                  { key: 'name', label: 'Uptime 24h', class: 'col-uptime', width: '148px', render: uptimeCell },
                  { key: 'name', label: 'Actions', class: 'col-act', align: 'right', render: actCell },
                  { key: 'name', label: '', class: 'col-kebab', width: '36px', align: 'right', render: kebabCell }
                ]}
              />
            </div>
          {:else}
            <div class="grid">
              <!-- Grid view never spawns separate subapp cards. Children live
                   inside their parent's folder-peek section (see below); the
                   list view is still flatten()-based so it can show them as
                   indented rows. -->
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
                      <VisibilityBadge visibility={a.visibility} showLabel={false} size={10} />
                    </div>
                    <div class="meta">
                      {#if a.port}
                        <span class="b-pill" title={a.port + ''}>:{a.port}</span>
                      {/if}
                      {#if s?.up && a.port}
                        <a
                          class="b-pill open-pill"
                          href={`http://127.0.0.1:${a.port}/`}
                          target="_blank"
                          rel="noopener"
                          title={`Open ${a.name} in browser`}
                          onclick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink size={10} /> open
                        </a>
                      {:else}
                        <span class="b-pill">{a.kind}</span>
                      {/if}
                    </div>
                  </header>

                  <!-- Mobile-app card body: only the live status pills get to
                       stay (latency, tailnet badge). Everything else lives
                       behind the settings icon. The project path moves to the
                       app detail page; the kebab can copy it. -->
                  {#if s?.up && (s.latencyMs != null || s.tailscale)}
                    <div class="body compact">
                      <div class="status">
                        {#if s.latencyMs != null}
                          <span class="b-pill subtle">{s.latencyMs}ms</span>
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
                    </div>
                  {/if}

                  <footer class="actions app-actions">
                    {#if !s?.up}
                      {#if a.start_cmd}
                        <button
                          class="b-btn primary app-action"
                          disabled={busy[a.id] != null}
                          onclick={() => act(a.id, 'start')}
                          title={`Start + publish on tailnet: ${a.start_cmd}`}
                        >
                          <Play size={14} /> Start
                        </button>
                      {:else}
                        <a class="b-btn app-action" href={`/apps/${a.id}`} title="No start command set yet">
                          <Settings2 size={13} /> Configure
                        </a>
                      {/if}
                    {:else}
                      <button
                        class="b-btn danger app-action"
                        disabled={busy[a.id] != null}
                        onclick={() => act(a.id, 'stop')}
                        title={s.managedPid ? 'Stop managed process' : `Stop external listener (pid ${s.listenerPid ?? '?'})`}
                      >
                        <Square size={14} /> Stop
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="b-btn icon settings-btn kebab-trigger"
                      aria-label="More actions"
                      title="More"
                      onclick={(e) => {
                        e.stopPropagation();
                        if (openMenu?.id === a.id && openMenu.kind === 'kebab')
                          closeMenu();
                        else openMenuAt(a.id, 'kebab', e.currentTarget);
                      }}
                    >
                      <Settings2 size={15} />
                    </button>
                  </footer>
                  {#if a.is_monorepo && childrenByParent[a.id]?.length}
                    <!-- iOS-style folder lives INSIDE the parent card.
                         Collapsed → 2×2 tile preview (peek). Expanded →
                         full vertical list of subapp rows, each with its own
                         start/stop button + settings icon. -->
                    <div class="folder">
                      <button
                        type="button"
                        class="folder-toggle-bar"
                        onclick={(e) => {
                          e.stopPropagation();
                          toggleFolder(a.id);
                        }}
                        aria-label={foldersCollapsed[a.id] ? 'Open folder' : 'Close folder'}
                      >
                        {#if foldersCollapsed[a.id]}
                          <ChevronRight size={11} />
                        {:else}
                          <ChevronDown size={11} />
                        {/if}
                        <span class="folder-label">
                          {childrenByParent[a.id].length} subapp{childrenByParent[a.id].length === 1 ? '' : 's'}
                        </span>
                      </button>

                      {#if foldersCollapsed[a.id]}
                        <!-- Collapsed: 2×2 mini-tile preview + "+N more" hint -->
                        <button
                          type="button"
                          class="folder-peek-preview"
                          onclick={(e) => {
                            e.stopPropagation();
                            toggleFolder(a.id);
                          }}
                        >
                          <div class="folder-tiles">
                            {#each childrenByParent[a.id].slice(0, 4) as c (c.id)}
                              {@const cs = livestate[c.id]}
                              <div class="folder-tile">
                                <span class="b-dot" class:up={cs?.serving} class:idle={!cs}></span>
                                <span class="t-name">{c.name}</span>
                              </div>
                            {/each}
                          </div>
                          {#if childrenByParent[a.id].length > 4}
                            <span class="folder-more">+{childrenByParent[a.id].length - 4} more</span>
                          {/if}
                        </button>
                      {:else}
                        <!-- Expanded: each subapp is a horizontal row with status
                             dot, name, port, kind, start/stop button, settings. -->
                        <ul class="folder-list">
                          {#each childrenByParent[a.id] as c (c.id)}
                            {@const cs = livestate[c.id]}
                            <li class="folder-row" class:dim={!cs?.serving}>
                              <span
                                class="b-dot"
                                class:up={cs?.serving}
                                class:warn={cs?.managedPid != null && !cs.serving}
                                class:down={cs != null && !cs.up}
                                class:idle={!cs}
                              ></span>
                              <a href={`/apps/${c.id}`} class="folder-row-name">{c.name}</a>
                              {#if c.port}
                                <span class="folder-row-port">:{c.port}</span>
                              {/if}
                              {#if cs?.up && c.port}
                                <a
                                  class="folder-row-kind open-pill"
                                  href={`http://127.0.0.1:${c.port}/`}
                                  target="_blank"
                                  rel="noopener"
                                  title={`Open ${c.name} in browser`}
                                  onclick={(e) => e.stopPropagation()}
                                >
                                  <ExternalLink size={9} /> open
                                </a>
                              {:else}
                                <span class="folder-row-kind">{c.kind}</span>
                              {/if}
                              <span class="folder-row-actions">
                                {#if !cs?.up}
                                  {#if c.start_cmd}
                                    <button
                                      type="button"
                                      class="b-btn icon primary tiny"
                                      disabled={busy[c.id] != null}
                                      onclick={(e) => { e.stopPropagation(); act(c.id, 'start'); }}
                                      title={`Start + tailnet: ${c.start_cmd}`}
                                    >
                                      <Play size={11} />
                                    </button>
                                  {:else}
                                    <a
                                      class="b-btn icon tiny"
                                      href={`/apps/${c.id}`}
                                      onclick={(e) => e.stopPropagation()}
                                      title="No start command — click to configure"
                                    >
                                      <Settings2 size={11} />
                                    </a>
                                  {/if}
                                {:else}
                                  <button
                                    type="button"
                                    class="b-btn icon danger tiny"
                                    disabled={busy[c.id] != null}
                                    onclick={(e) => { e.stopPropagation(); act(c.id, 'stop'); }}
                                    title="Stop"
                                  >
                                    <Square size={11} />
                                  </button>
                                {/if}
                                <button
                                  type="button"
                                  class="b-btn icon tiny kebab-trigger"
                                  aria-label="Settings"
                                  title="Settings"
                                  onclick={(e) => {
                                    e.stopPropagation();
                                    if (openMenu?.id === c.id && openMenu.kind === 'kebab')
                                      closeMenu();
                                    else openMenuAt(c.id, 'kebab', e.currentTarget);
                                  }}
                                >
                                  <Settings2 size={11} />
                                </button>
                              </span>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </div>
                  {/if}
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
{/if}

{#if data.user && data.apps.length > 0 && data.tourCompleted == null}
  {@const startedAnApp = Object.values(livestate).some((s) => s?.managedPid)}
  {@const sawGreen = Object.values(livestate).some((s) => s?.up)}
  <OnboardingChecklist
    addedAnApp={data.apps.length > 0}
    {startedAnApp}
    {sawGreen}
  />
{/if}

{#if data.user && data.tourCompleted == null && data.apps.length > 0}
  <OnboardingTour />
{/if}

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
    {#if openMenu?.kind === 'kebab' && app}
      <!-- Open + Logs + Restart used to be inline buttons on the card; now
           they live here so the card itself only has Start/Stop + ⚙. -->
      {#if livestate[id]?.up && app.port}
        {@const u = openUrl(app.port, livestate[id]?.tailscale ?? null)}
        {#if u}
          <a class="dropitem" href={u} target="_blank" rel="noreferrer" onclick={closeMenu}>
            <ExternalLink size={12} /> Open {u.startsWith('https://') ? 'tailnet' : 'local'} URL
          </a>
        {/if}
      {/if}
      <a class="dropitem" href={`/apps/${id}/logs`} onclick={closeMenu}>
        <Clock size={12} /> Logs
      </a>
      {#if livestate[id]?.managedPid}
        <button
          class="dropitem"
          onclick={() => { act(id, 'restart'); closeMenu(); }}
        >
          <RotateCw size={12} /> Restart
        </button>
      {/if}
      <div class="droprule"></div>
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
      {#if app.is_monorepo}
        <div class="droprule"></div>
        <button class="dropitem" onclick={() => { startAllSubapps(id); closeMenu(); }}>
          <PlayCircle size={12} /> Start all subapps
        </button>
      {/if}
      {#if repoState[id]}
        <div class="droprule"></div>
        <div class="dropsub">
          Repo
          {#if repoState[id].default_branch}<span class="b-mono">· {repoState[id].default_branch}</span>{/if}
          {#if repoState[id].last_fetched_at}
            <span class="b-mono b-mute2">· {Math.max(1, Math.round((Date.now() - (repoState[id].last_fetched_at ?? 0)) / 60000))}m ago</span>
          {/if}
        </div>
        {#if repoState[id].commits_behind > 0}
          <button class="dropitem" onclick={() => { repoPull(id); closeMenu(); }}>
            <Download size={12} /> Pull origin/{repoState[id].default_branch ?? 'HEAD'} ({repoState[id].commits_behind} ↑)
          </button>
        {/if}
        <button
          class="dropitem"
          onclick={() => { repoFetch(id); closeMenu(); }}
          disabled={repoState[id].fetch_status === 'fetching' || repoState[id].fetch_status === 'queued' || repoState[id].fetch_status === 'pulling'}
        >
          {#if repoState[id].fetch_status === 'fetching' || repoState[id].fetch_status === 'queued' || repoState[id].fetch_status === 'pulling'}
            <Loader2 size={12} class="spin" /> {repoState[id].fetch_status}…
          {:else}
            <GitBranchIcon size={12} /> Fetch latest
          {/if}
        </button>
      {/if}
      <div class="droprule"></div>
      <div class="dropsub">Visibility — {app.visibility}</div>
      {#if app.visibility !== 'private'}
        <button class="dropitem" onclick={() => { closeMenu(); flipVisibility(id, 'private'); }}>
          <Lock size={12} /> Make private
        </button>
      {/if}
      {#if app.visibility !== 'invited'}
        <!-- openGrants BEFORE closeMenu — closeMenu nulls openMenu, which makes
             the {@const id = openMenuId} re-evaluate to '' before the handler
             can pass it on. Capture first, close second. -->
        <button class="dropitem" onclick={() => { openGrants(id, 'invited'); closeMenu(); }}>
          <UsersIcon size={12} /> Make invited…
        </button>
      {/if}
      {#if app.visibility !== 'public' && isAdmin}
        <button class="dropitem" onclick={() => { openGrants(id, 'public'); closeMenu(); }}>
          <GlobeIcon size={12} /> Make public…
        </button>
      {/if}
      {#if app.visibility === 'invited'}
        <button class="dropitem" onclick={() => { openGrants(id); closeMenu(); }}>
          <UsersIcon size={12} /> Manage grants…
        </button>
      {/if}
      {#if livestate[id]?.origin?.kind === 'systemd' && livestate[id]?.origin?.unit && livestate[id]?.origin?.scope}
        <div class="droprule"></div>
        <button class="dropitem danger" onclick={menuUninstall}>
          <Square size={12} /> Uninstall {livestate[id]!.origin!.unit}.service
        </button>
      {/if}
      <div class="droprule"></div>
      <button class="dropitem danger" onclick={() => { removeOpenAppId = id; closeMenu(); }}>
        <Trash2 size={12} /> Remove…
      </button>
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
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 24px;
    align-items: start;
  }
  /* Grid + flex items default to min-content sizing, which lets descendants
   * (a wide table inside .listwrap) force the whole column wider than the
   * viewport. min-width:0 on .content overrides that so .listwrap's
   * overflow-x: auto can engage and scroll horizontally on mobile. */
  .layout > .content {
    min-width: 0;
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

  /* Open-in-browser button replaces the kind chip whenever an app is up,
   * because at that point the kind label ("VITE", "BUN" etc) is dead info
   * compared to "click here to actually use the thing". */
  .open-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--b-accent);
    border-color: color-mix(in oklab, var(--b-accent) 32%, var(--b-border));
    background: color-mix(in oklab, var(--b-accent) 10%, var(--b-surface-2));
    text-decoration: none;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }
  .open-pill:hover {
    background: color-mix(in oklab, var(--b-accent) 20%, var(--b-surface-2));
  }
  .open-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--b-accent);
    text-decoration: none;
  }
  .open-link:hover {
    text-decoration: underline;
  }

  /* ── repo sync pill (per-card) ───────────────────────────────────
   * Three shapes:
   *   .working — spinner only, no action; signals work in flight
   *   .behind  — counts behind origin; click pulls
   *   .err     — failed last fetch; hover for error text
   */
  .repo-pill {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
    margin-left: 4px;
    font-family: var(--b-mono);
    font-weight: 600;
    background: transparent;
    border: 1px solid transparent;
  }
  .repo-pill.behind {
    background: color-mix(in oklab, var(--b-accent) 14%, transparent);
    color: var(--b-accent);
    cursor: pointer;
    border: 1px solid color-mix(in oklab, var(--b-accent) 35%, transparent);
  }
  .repo-pill.behind:hover {
    background: color-mix(in oklab, var(--b-accent) 22%, transparent);
  }
  .repo-pill.working {
    color: var(--b-text-3);
  }
  .repo-pill.err {
    background: color-mix(in oklab, var(--b-bad) 14%, transparent);
    color: var(--b-bad);
    border: 1px solid color-mix(in oklab, var(--b-bad) 35%, transparent);
  }

  /* ── monorepo / subapp markers ─────────────────────────────── */
  .mono-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
    margin-left: 4px;
    font-family: var(--b-mono);
    background: color-mix(in oklab, var(--b-info) 14%, transparent);
    color: var(--b-info);
    border: 1px solid color-mix(in oklab, var(--b-info) 30%, transparent);
    font-weight: 600;
  }
  .sub-badge {
    display: inline-flex;
    align-items: center;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    line-height: 1;
    margin-left: 4px;
    font-family: var(--b-mono);
    color: var(--b-text-3);
    background: var(--b-surface-2);
    border: 1px solid var(--b-border);
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── nested subapp treatment ─────────────────────────────────
   * Parents render as collapsible headers. Children render plain
   * underneath with a slight indent + tinted background — no tree
   * symbols. Background tint reads as "grouped with the row above".
   *
   * Grid: parents become folder cards (full-bleed accent header,
   * 2×2 mini-tile preview). Click to open the inline drawer. */
  /* `tr.subapp-row` / `tr.folder-row` live inside DataTable's scope, so the
   * rules need :global() to stick. Keeping the whole row-variant block
   * grouped so the visual contract is one find away. */
  :global {
    .list tr.subapp-row {
      background: color-mix(in oklab, var(--b-info) 4%, transparent);
    }
    .list tr.subapp-row td {
      border-bottom-color: color-mix(in oklab, var(--b-info) 12%, var(--b-border));
    }
    .list tr.subapp-row .col-name {
      padding-left: 48px;
      position: relative;
    }
    .list tr.subapp-row .col-name::before {
      content: '';
      position: absolute;
      left: 26px;
      top: 50%;
      width: 14px;
      height: 1px;
      background: color-mix(in oklab, var(--b-info) 35%, var(--b-border));
    }
    .list tr.subapp-row .col-name .name {
      font-size: 12.5px;
      color: var(--b-text-2);
    }
    .list tr.folder-row .col-name > * {
      vertical-align: middle;
      margin-right: 6px;
    }
    .list tr.folder-row .col-name > *:last-child {
      margin-right: 0;
    }
    /* Row-level "dim" applies to inactive apps — fade the text so live ones pop. */
    .list tbody tr.dim {
      color: var(--b-text-3);
    }
  }

  /* Grid view: subapp cards are clearly indented past the parent's left
   * edge with an accent stripe so the parent/child relationship reads at
   * a glance even when the cards wrap to a new row. */
  .card.subapp-card {
    margin-left: 36px;
    border-left: 3px solid color-mix(in oklab, var(--b-info) 60%, var(--b-border));
  }
  .folder-toggle {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--b-text-3);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    line-height: 1;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .folder-toggle:hover {
    background: var(--b-surface-2);
    color: var(--b-text);
  }
  .folder-count {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--b-info) 18%, transparent);
    color: var(--b-info);
    border: 1px solid color-mix(in oklab, var(--b-info) 35%, transparent);
    font-family: var(--b-mono);
    font-weight: 600;
    line-height: 1;
  }

  /* "↑N new" pill — appears when post-fetch inspect finds new subapps */
  .new-subapps-pill {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--b-accent);
    color: white;
    border: 1px solid var(--b-accent);
    font-family: var(--b-mono);
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    margin-left: 4px;
    animation: new-subapps-pulse 2s ease-in-out infinite;
  }
  .new-subapps-pill:hover {
    background: color-mix(in oklab, var(--b-accent) 85%, black);
  }
  @keyframes new-subapps-pulse {
    0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--b-accent) 40%, transparent); }
    50% { box-shadow: 0 0 0 5px color-mix(in oklab, var(--b-accent) 0%, transparent); }
  }
  @media (prefers-reduced-motion: reduce) {
    .new-subapps-pill { animation: none; }
  }

  /* ── grid view: subapps live INSIDE the parent card ─────────────
   * The folder section glues to the bottom of the card, hosts:
   *   - a toggle bar header (chevron + "N subapps")
   *   - EITHER a 2×2 preview tile (collapsed) OR a vertical list of
   *     subapp rows with their own start/stop + settings buttons
   * Never spawns separate cards into the grid. */
  .folder {
    margin: 8px -14px -14px;
    border-top: 1px solid var(--b-border);
    background: color-mix(in oklab, var(--b-info) 4%, var(--b-surface-2));
    border-radius: 0 0 12px 12px;
    overflow: hidden;
  }
  .folder-toggle-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 8px 14px;
    background: transparent;
    border: 0;
    cursor: pointer;
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-text-2);
    letter-spacing: 0.02em;
    text-align: left;
  }
  .folder-toggle-bar:hover {
    background: color-mix(in oklab, var(--b-info) 8%, transparent);
    color: var(--b-text);
  }
  .folder-label {
    font-family: var(--b-mono);
  }

  .folder-peek-preview {
    display: block;
    width: 100%;
    padding: 6px 14px 12px;
    background: transparent;
    border: 0;
    cursor: pointer;
    text-align: left;
  }
  .folder-peek-preview:hover {
    background: color-mix(in oklab, var(--b-info) 6%, transparent);
  }
  .folder-more {
    display: inline-block;
    margin-top: 6px;
    font-size: 10px;
    font-family: var(--b-mono);
    color: var(--b-text-3);
    letter-spacing: 0.04em;
  }

  .folder-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .folder-row {
    display: grid;
    grid-template-columns: auto 1fr auto auto auto;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    border-top: 1px solid color-mix(in oklab, var(--b-info) 8%, var(--b-border));
    font-size: 12.5px;
  }
  .folder-row:first-child {
    border-top: 1px solid color-mix(in oklab, var(--b-info) 12%, var(--b-border));
  }
  .folder-row.dim {
    color: var(--b-text-2);
  }
  .folder-row-name {
    color: var(--b-text);
    text-decoration: none;
    min-width: 0;
    overflow-wrap: anywhere;
    word-break: break-word;
    font-weight: 500;
  }
  .folder-row.dim .folder-row-name {
    color: var(--b-text-2);
  }
  .folder-row-name:hover {
    color: var(--b-accent);
  }
  .folder-row-port {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-text-2);
  }
  .folder-row-kind {
    font-family: var(--b-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--b-text-3);
    background: var(--b-surface);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .folder-row-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .b-btn.tiny {
    padding: 4px 6px;
    font-size: 10px;
  }

  /* legacy folder-peek selectors that may still be referenced — keep
   * a stub so any straggling rules don't crash the compilation. */
  .folder-peek {
    display: block;
    width: calc(100% + 28px);
    margin: 8px -14px -14px;
    padding: 10px 14px;
    background: color-mix(in oklab, var(--b-info) 6%, var(--b-surface-2));
    border: 0;
    border-top: 1px solid var(--b-border);
    border-radius: 0 0 12px 12px;
    cursor: pointer;
    text-align: left;
    font: inherit;
    transition: background 0.15s;
  }
  .folder-peek:hover {
    background: color-mix(in oklab, var(--b-info) 10%, var(--b-surface-2));
  }
  .folder-tiles {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin-bottom: 8px;
  }
  .folder-tile {
    display: flex;
    align-items: center;
    gap: 5px;
    background: var(--b-surface);
    border: 1px solid var(--b-border);
    border-radius: 6px;
    padding: 5px 7px;
    font-size: 11px;
    color: var(--b-text);
    min-width: 0;
  }
  .folder-tile .b-dot {
    width: 5px;
    height: 5px;
    flex-shrink: 0;
  }
  .folder-tile .t-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--b-mono);
  }
  .folder-hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-family: var(--b-mono);
    color: var(--b-text-2);
    letter-spacing: 0.02em;
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
    /* Tighter tile grid — fits more on screen, each one reads as a single
     * "app icon" with one primary action. align-items:start so empty cards
     * don't stretch vertically to match a taller sibling in the same row. */
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
    align-items: start;
  }
  .card { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
  }
  .title { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
  /* Names wrap rather than ellipsing. Names like `sample-monorepo` were
     getting clipped to `jarvis-minia...` which read as a status indicator
     next to the real status dot. Wrapping costs a few pixels of card
     height for long names but never produces visually-ambiguous dots. */
  .name {
    font-weight: 600;
    color: var(--b-text);
    text-decoration: none;
    overflow-wrap: anywhere;
    word-break: break-word;
    min-width: 0;
  }
  .name:hover { color: var(--b-accent); }
  .meta { display: flex; gap: 4px; flex-shrink: 0; flex-wrap: wrap; }
  .body { display: flex; flex-direction: column; gap: 6px; }
  .body.compact { gap: 0; margin-top: -4px; }
  .path { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { display: flex; flex-wrap: wrap; gap: 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }

  /* Mobile-app-style footer: one primary action that fills the row, and a
   * settings icon-button at the right edge for everything else. */
  .actions.app-actions {
    display: flex;
    gap: 8px;
    align-items: stretch;
  }
  .actions.app-actions .app-action {
    flex: 1;
    justify-content: center;
    padding: 9px 12px;
    font-size: 13px;
    font-weight: 600;
  }
  .actions.app-actions .settings-btn {
    flex: 0 0 auto;
    padding: 9px 11px;
    color: var(--b-text-2);
  }
  .actions.app-actions .settings-btn:hover {
    color: var(--b-text);
    background: var(--b-surface-2);
  }

  /* List view — compact table.
     `table-layout: fixed` plus explicit column widths means every group's
     table renders identical column geometry, so columns line up vertically
     across groups even though each group is its own <table>. */
  .listwrap {
    /* The width:100% pins the wrapper to its container so the overflow:auto
     * actually engages — without it the listwrap is content-sized and grows
     * with the table (no scroll triggered, just the table pushes wider than
     * the viewport). With table-layout:auto on mobile, the table is sized to
     * its content, and this wrapper provides horizontal scrolling instead. */
    width: 100%;
    max-width: 100%;
    overflow-x: auto;
    padding: 0;
  }
  /* `.list` is the class we pass to DataTable, which puts it on its outer
   * wrapper <div>. Every `.list ...` rule below has to use `:global(...)`
   * because the actual <table>/<th>/<td>/.col-* live INSIDE the DataTable
   * component (different svelte scope) — Svelte would otherwise strip rules
   * it sees as unused. Putting the entire block in `:global { … }` keeps the
   * rules global without per-selector wrapping. */
  :global {
    .list { width: 100%; font-size: 13px; }
    .list table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }
    /* Strip the @berth/ui chrome on the inner wrapper — .listwrap already
     * provides berth's surface treatment, so the rounded border would double up. */
    .list > div {
      border: 0;
      border-radius: 0;
      overflow: visible;
      background: transparent;
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
      /* Sticky header so column meaning stays anchored while scrolling a
       * long list (or scrolling sideways on tablet). */
      position: sticky;
      top: 0;
      z-index: 2;
      height: auto;
    }
    .list tbody td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--b-border);
      vertical-align: middle;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.4;
      /* DataTable applies `text-ui-foreground/90` on every td. That maps the
       * text color to the @berth/ui token, which clashes with berth's own
       * --b-text. Reset to inherit so .list … color rules win. */
      color: var(--b-text);
      height: auto;
    }
    .list tbody tr:last-child td { border-bottom: none; }
    .list tbody tr:hover { background: color-mix(in oklab, var(--b-surface-2) 50%, transparent); }
    .list .col-st {
      width: 26px;
      padding-left: 12px;
      padding-right: 0;
      overflow: visible;
    }
    .list .col-name {
      min-width: 220px;
      overflow: visible;
      text-overflow: clip;
      white-space: nowrap;
    }
    .list .col-port { width: 68px; }
    .list .col-kind { width: 52px; font-size: 11px; }
    .list .col-source {
      width: 124px;
      font-size: 11.5px;
      color: var(--b-text-3);
    }
    .list .col-source.src-managed { color: var(--b-accent); font-weight: 500; }
    .list .col-source.src-systemd { color: var(--b-text); }
    .list tbody tr.dim .col-source { color: var(--b-text-3); }
    .list .col-tailnet { width: 84px; }
    .list .col-cpu,
    .list .col-ram,
    .list .col-gpu {
      width: 58px;
      font-size: 11.5px;
      color: var(--b-text-3);
      text-align: right;
    }
    .list .col-cpu.has-val,
    .list .col-ram.has-val,
    .list .col-gpu.has-val {
      color: var(--b-text);
    }
    .list tbody tr.dim .col-cpu,
    .list tbody tr.dim .col-ram,
    .list tbody tr.dim .col-gpu {
      color: var(--b-text-3);
    }
    .list .col-uptime { width: 148px; overflow: visible; }
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
  }

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

  /* The start-button split (Start vs Start local-only) is gone — every
   * Start always goes via tailscale serve. The single Play icon takes its
   * place. .startsplit / .b-btn.caret CSS was removed with it. */
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
  .dropitem .kbdhint {
    margin-left: auto;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--b-text-3);
    background: var(--b-surface-2);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--b-mono);
  }
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
    .layout { grid-template-columns: minmax(0, 1fr); }
    .sidebar { display: none; }
  }

  /* ── List responsive layers ─────────────────────────────────────
   * Desktop (>= 1100px): full 12-column table.
   * Tablet (≤ 1099px): drop telemetry columns (source / cpu / ram / gpu /
   *   uptime sparkline). Status / Name / Port / Kind / Tailnet / Actions
   *   stay visible — the columns the user actually needs to operate apps.
   * Mobile (≤ 640px): also drop Kind + Tailnet — they're available on the
   *   per-app detail page. Card-style padding so rows are tap-targets. */
  /* The responsive layers below ALSO need :global() because the .list
   * descendants (.col-*) and the global tr/td selectors live in DataTable's
   * scope. Without this wrap, Svelte strips the rules at build time. */
  :global {
    @media (max-width: 1099px) {
      .list .col-source,
      .list .col-cpu,
      .list .col-ram,
      .list .col-gpu,
      .list .col-uptime,
      .list thead .col-source,
      .list thead .col-cpu,
      .list thead .col-ram,
      .list thead .col-gpu,
      .list thead .col-uptime {
        display: none;
      }
    }
    @media (max-width: 640px) {
      /* Mobile: don't hide any columns — `.listwrap` is already overflow-x:
       * auto, so let the table scroll horizontally. Switch table-layout to
       * `auto` so columns can size to their content instead of being squeezed
       * into a fixed grid. The name column then auto-grows to fit the longest
       * app name (no truncation, no ellipsis), and the wrapper scrolls right
       * to reveal port/kind/actions etc. */
      .list { font-size: 13px; }
      .list table { table-layout: auto; }
      .list tbody td { padding: 11px 10px; }
      .list .col-st { width: 22px; padding-left: 10px; padding-right: 0; }
      .list .col-name {
        /* Fit content — the name + visibility badge + folder count + repo
         * pills always read in full, never get an ellipsis. */
        min-width: fit-content;
        width: auto;
        padding-right: 14px;
      }
      .list .col-name .name { font-size: 14px; }
      .list .col-port { width: auto; min-width: 64px; padding-right: 8px; }
      .list .col-kind { width: auto; min-width: 50px; padding-right: 8px; }
      .list .col-tailnet { width: auto; min-width: 70px; padding-right: 8px; }
      .list .col-act {
        padding-right: 6px;
        width: auto;
        min-width: max-content;
      }
      .list .col-act .b-btn.icon {
        /* fatter tap target on touch */
        padding: 8px 10px;
        margin-left: 1px;
      }
      .list .col-kebab { width: 38px; padding-right: 6px; }
      .list tr.subapp-row .col-name { padding-left: 24px; }
      .list tr.subapp-row .col-name::before { left: 8px; width: 10px; }
    }
  }
  @media (max-width: 640px) {
    /* These live on berth-control's OWN page elements, not on DataTable's
     * scope — keep them scoped (no :global wrap). */
    section.head {
      flex-direction: column;
      align-items: stretch;
      gap: 10px;
    }
    .head-actions {
      justify-content: space-between;
      flex-wrap: wrap;
    }
  }
</style>
