<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Cpu, MemoryStick, HardDrive, Thermometer, Activity, Wifi, AlertTriangle, Server, ListChecks } from 'lucide-svelte';
  import { Card } from '@berth/ui/card';
  import MultiLineChart from '@berth/ui/MultiLineChart.svelte';
  // Chart primitive was removed from @berth/ui in the Layer-1 namespace
  // refactor; sparklines use single-series MultiLineChart with the
  // legend suppressed. Layer 4 (layerchart-backed Chart) will replace
  // this if we want richer sparklines later.

  // Live host monitoring page.
  //
  // Two data sources:
  //   1. /api/monitor/state (SSE) — pushed every collector tick. Drives the
  //      big-number cards.
  //   2. /api/monitor/history (one-shot fetch on mount) — populates the
  //      sparklines with the last hour of samples.
  //
  // The page intentionally stays read-only in Phase C — threshold editing
  // and alert UI arrive in Phase D, push notifications in Phase E.

  type Sample = {
    ts: number;
    cpu_util_total: number | null;
    cpu_util_cores: number[] | null;
    cpu_pkg_temp: number | null;
    cpu_core_temps: number[] | null;
    gpu_temp: number | null;
    gpu_power_w: number | null;
    gpu_mem_used_mb: number | null;
    gpu_mem_total_mb: number | null;
    gpu_util_pct: number | null;
    mem_total_mb: number | null;
    mem_available_mb: number | null;
    swap_total_mb: number | null;
    swap_free_mb: number | null;
    disk_total_gb: number | null;
    disk_used_gb: number | null;
    disk_avail_gb: number | null;
    net_per_iface: Record<string, { rx_bps: number; tx_bps: number }> | null;
    misc_temps: Record<string, number> | null;
  };

  type Threshold = {
    key: string;
    label: string;
    unit: string;
    defaultWarn: number | null;
    warn_value: number | null;
    cooldown_secs: number;
    last_fired_at: number | null;
  };
  type Alert = { id: number; ts: number; level: string; msg: string };
  type SystemInfo = {
    hostname: string;
    os: string;
    os_pretty: string | null;
    arch: string;
    kernel: string;
    total_ram_mb: number;
    cpu_count: number;
    process_uptime_secs: number;
    system_uptime_secs: number;
    primary_ipv4: string | null;
  };
  type ProcRow = {
    pid: number;
    ppid: number;
    user: string;
    cpu_pct: number;
    mem_mb: number;
    comm: string;
  };

  // Time-range presets, matching SysWatch's layout. Values are minutes for
  // brevity; the load fn converts to ms when calling /history. Default 60.
  type RangeKey = '5M' | '10M' | '15M' | '30M' | '1H' | '6H' | '24H' | '7D' | '30D';
  const RANGE_MINUTES: Record<RangeKey, number> = {
    '5M': 5,
    '10M': 10,
    '15M': 15,
    '30M': 30,
    '1H': 60,
    '6H': 360,
    '24H': 1440,
    '7D': 10_080,
    '30D': 43_200
  };
  let activeRange = $state<RangeKey>('1H');

  let live: Sample | null = $state(null);
  let history: Sample[] = $state([]);
  let connected = $state(false);
  let loadError = $state<string | null>(null);
  let es: EventSource | null = null;

  let thresholds = $state<Threshold[]>([]);
  let alerts = $state<Alert[]>([]);
  let editing = $state(false);
  let saving = $state(false);

  // Web push state — null public key means the deployment hasn't set
  // BERTH_CONTROL_MONITOR_PUSH_CONTACT, in which case we hide the UI.
  let pushPublicKey = $state<string | null>(null);
  let pushReason = $state<string | null>(null);
  let pushSubscribed = $state(false);
  let pushBusy = $state(false);

  let sysInfo = $state<SystemInfo | null>(null);
  let processes = $state<ProcRow[]>([]);
  type ServiceRow = {
    name: string;
    status: 'running' | 'stopped' | 'failed' | 'unknown';
    sub: string;
    description: string | null;
    pid: number | null;
  };
  let services = $state<ServiceRow[]>([]);
  let serviceFilter = $state('');

  const filteredServices = $derived.by(() => {
    const q = serviceFilter.trim().toLowerCase();
    if (!q) return services;
    return services.filter((s) => s.name.toLowerCase().includes(q));
  });

  // Build the data shape MultiLineChart consumes from the history array.
  // One helper per chart so the page can show "Temperatures (CPU+GPU+NVMe)"
  // and "CPU + Memory" overlays without per-card timeline math.
  const tempSeries = $derived.by(() => {
    const series: { label: string; color: string; data: { ts: number; value: number }[] }[] = [];
    const cpu = history.filter((s) => s.cpu_pkg_temp != null);
    if (cpu.length > 1)
      series.push({
        label: 'CPU',
        color: 'var(--ui-primary)',
        data: cpu.map((s) => ({ ts: s.ts, value: s.cpu_pkg_temp! }))
      });
    const gpu = history.filter((s) => s.gpu_temp != null);
    if (gpu.length > 1)
      series.push({
        label: 'GPU',
        color: 'var(--ui-destructive)',
        data: gpu.map((s) => ({ ts: s.ts, value: s.gpu_temp! }))
      });
    // Pull any NVMe temp out of misc_temps if present.
    const nvme = history
      .filter(
        (s) => s.misc_temps && Object.keys(s.misc_temps).some((k) => /nvme/i.test(k))
      )
      .map((s) => {
        const k = Object.keys(s.misc_temps!).find((k) => /nvme/i.test(k))!;
        return { ts: s.ts, value: s.misc_temps![k] };
      });
    if (nvme.length > 1)
      series.push({ label: 'NVMe', color: 'var(--ui-warning)', data: nvme });
    return series;
  });

  // CPU and Memory live on their own time-series cards. Each is a
  // single-series MultiLineChart so the Y-axis auto-scales to the data
  // (a 5-15% CPU range stays readable instead of being flattened against
  // a 0-100% axis dominated by RAM).
  const cpuUsageSeries = $derived.by(() => {
    const cpu = history.filter((s) => s.cpu_util_total != null);
    if (cpu.length <= 1) return [];
    return [
      {
        label: 'CPU %',
        color: 'var(--ui-primary)',
        data: cpu.map((s) => ({ ts: s.ts, value: s.cpu_util_total! }))
      }
    ];
  });
  const memUsageSeries = $derived.by(() => {
    const mem = history.filter((s) => s.mem_total_mb != null && s.mem_available_mb != null);
    if (mem.length <= 1) return [];
    return [
      {
        label: 'Memory %',
        color: 'var(--ui-success)',
        data: mem.map((s) => ({
          ts: s.ts,
          value: ((s.mem_total_mb! - s.mem_available_mb!) / s.mem_total_mb!) * 100
        }))
      }
    ];
  });

  // Status badge for a temperature value vs its configured threshold.
  // Returns "Normal" if below warn, "Warning" otherwise. Null if either
  // value is missing — we don't fabricate a status from nothing.
  function tempBadge(key: string, value: number | null | undefined): { label: string; tone: 'ok' | 'warn' } | null {
    if (value == null) return null;
    const t = thresholds.find((x) => x.key === key);
    const warn = t?.warn_value;
    if (warn == null) return { label: 'Normal', tone: 'ok' };
    return value >= warn ? { label: 'Warning', tone: 'warn' } : { label: 'Normal', tone: 'ok' };
  }

  function fmtUptime(s: number | null | undefined): string {
    if (s == null) return '—';
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  const ramUsedPct = $derived.by(() => {
    if (!live?.mem_total_mb || live?.mem_available_mb == null) return null;
    return Math.max(0, Math.min(100, ((live.mem_total_mb - live.mem_available_mb) / live.mem_total_mb) * 100));
  });
  const diskUsedPct = $derived.by(() => {
    if (!live?.disk_total_gb || live?.disk_used_gb == null) return null;
    return Math.max(0, Math.min(100, (live.disk_used_gb / live.disk_total_gb) * 100));
  });
  const swapUsedPct = $derived.by(() => {
    if (!live?.swap_total_mb || live?.swap_free_mb == null || live.swap_total_mb === 0) return null;
    return Math.max(0, Math.min(100, ((live.swap_total_mb - live.swap_free_mb) / live.swap_total_mb) * 100));
  });

  // Sparkline data. `{ts, value}` shape matches MultiLineChart's series
  // contract directly — wrap each derived array in a one-element series
  // at the call site (label is unused when showLegend={false}).
  const cpuHistory = $derived.by(() =>
    history
      .filter((s) => s.cpu_util_total != null)
      .map((s) => ({ ts: s.ts, value: s.cpu_util_total! }))
  );
  const cpuTempHistory = $derived.by(() =>
    history
      .filter((s) => s.cpu_pkg_temp != null)
      .map((s) => ({ ts: s.ts, value: s.cpu_pkg_temp! }))
  );
  const gpuTempHistory = $derived.by(() =>
    history
      .filter((s) => s.gpu_temp != null)
      .map((s) => ({ ts: s.ts, value: s.gpu_temp! }))
  );
  const ramHistory = $derived.by(() =>
    history
      .filter((s) => s.mem_total_mb != null && s.mem_available_mb != null)
      .map((s) => ({
        ts: s.ts,
        value: ((s.mem_total_mb! - s.mem_available_mb!) / s.mem_total_mb!) * 100
      }))
  );
  const netHistory = $derived.by(() =>
    history
      .filter((s) => s.net_per_iface != null)
      .map((s) => {
        let total = 0;
        for (const v of Object.values(s.net_per_iface!)) total += v.rx_bps + v.tx_bps;
        return { ts: s.ts, value: total / 1024 }; // KB/s
      })
  );

  // Map the project's old Chart `variant` prop to a CSS color the
  // MultiLineChart `color` prop accepts. Keeps the at-a-glance red/orange
  // signal for memory + temp warn states.
  function sparkColor(variant: 'primary' | 'warning' | 'danger'): string {
    if (variant === 'danger') return 'var(--ui-destructive)';
    if (variant === 'warning') return 'var(--ui-warning, oklch(70% 0.15 65))';
    return 'var(--ui-primary)';
  }
  function sparkSeries(label: string, data: { ts: number; value: number }[], color: string) {
    return [{ label, color, data }];
  }

  function hhmm(ms: number): string {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  function fmtBytes(b: number): string {
    if (b < 1024) return `${b.toFixed(0)} B/s`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB/s`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB/s`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB/s`;
  }
  function fmtMB(mb: number | null | undefined): string {
    if (mb == null) return '—';
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(0)} MB`;
  }
  function fmtGB(gb: number | null | undefined): string {
    if (gb == null) return '—';
    return `${gb.toFixed(1)} GB`;
  }

  async function loadThresholds() {
    try {
      const r = await fetch('/api/monitor/thresholds');
      if (r.ok) thresholds = (await r.json()).thresholds ?? [];
    } catch {
      /* */
    }
  }
  async function loadAlerts() {
    try {
      const r = await fetch('/api/monitor/alerts?limit=20');
      if (r.ok) alerts = (await r.json()).alerts ?? [];
    } catch {
      /* */
    }
  }
  async function saveThresholds() {
    saving = true;
    try {
      const r = await fetch('/api/monitor/thresholds', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          changes: thresholds.map((t) => ({
            key: t.key,
            warn_value: t.warn_value,
            cooldown_secs: t.cooldown_secs
          }))
        })
      });
      if (r.ok) editing = false;
    } finally {
      saving = false;
    }
  }

  async function loadPushStatus() {
    try {
      const r = await fetch('/api/monitor/push/vapid-key');
      if (!r.ok) return;
      const j = (await r.json()) as { publicKey: string | null; reason: string | null };
      pushPublicKey = j.publicKey;
      pushReason = j.reason;
      // Check whether this browser already holds a subscription for this
      // origin's service worker. Avoids re-prompting on every visit.
      if (j.publicKey && 'serviceWorker' in navigator && 'PushManager' in window) {
        try {
          const reg = await navigator.serviceWorker.getRegistration('/monitor-sw.js');
          if (reg) {
            const sub = await reg.pushManager.getSubscription();
            pushSubscribed = !!sub;
          }
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
  }
  function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const out = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
    return out;
  }
  async function enablePush() {
    if (!pushPublicKey || !('serviceWorker' in navigator)) return;
    pushBusy = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
      const reg = await navigator.serviceWorker.register('/monitor-sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushPublicKey)
      });
      const r = await fetch('/api/monitor/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sub.toJSON())
      });
      if (r.ok) pushSubscribed = true;
    } catch (e) {
      console.warn('[monitor] push subscribe failed', e);
    } finally {
      pushBusy = false;
    }
  }
  async function testPush() {
    pushBusy = true;
    try {
      await fetch('/api/monitor/push/test', { method: 'POST' });
    } finally {
      pushBusy = false;
    }
  }

  async function loadHistory() {
    try {
      const minutes = RANGE_MINUTES[activeRange];
      const since = Date.now() - minutes * 60 * 1000;
      // Cap points by range so the @berth/ui Chart stays responsive: 120
      // points for short ranges (5–60M = ~2–30s/point), 240 for medium
      // (6–24h), 480 for long (7–30D ≈ 90s–1.5min/point).
      const max = minutes <= 60 ? 120 : minutes <= 1440 ? 240 : 480;
      const r = await fetch(`/api/monitor/history?from=${since}&max=${max}`);
      if (!r.ok) {
        loadError = `history load failed (${r.status})`;
        return;
      }
      const j = (await r.json()) as { samples: Sample[] };
      history = j.samples ?? [];
      loadError = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }
  async function loadSysInfo() {
    try {
      const r = await fetch('/api/monitor/system');
      if (r.ok) sysInfo = await r.json();
    } catch {
      /* */
    }
  }
  async function loadProcesses() {
    try {
      const r = await fetch('/api/monitor/processes?limit=20');
      if (r.ok) processes = (await r.json()).processes ?? [];
    } catch {
      /* */
    }
  }
  async function loadServices() {
    try {
      const r = await fetch('/api/monitor/services');
      if (r.ok) services = (await r.json()).services ?? [];
    } catch {
      /* */
    }
  }
  function setRange(r: RangeKey) {
    if (r === activeRange) return;
    activeRange = r;
    void loadHistory();
  }

  onMount(() => {
    void loadHistory();
    void loadThresholds();
    void loadAlerts();
    void loadPushStatus();
    void loadSysInfo();
    void loadProcesses();
    void loadServices();
    // Refresh process list every 5s — they churn fast and pushing via SSE
    // would more than double the per-tick payload for negligible UX gain.
    // Services are slower-changing AND systemctl/launchctl spawns are
    // pricier (~50-200ms) so refresh those every 30s.
    const procTimer = setInterval(() => void loadProcesses(), 5000);
    const svcTimer = setInterval(() => void loadServices(), 30000);

    es = new EventSource('/api/monitor/state');
    es.addEventListener('meta', () => {
      connected = true;
    });
    es.addEventListener('sample', (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as {
          ts: number;
          sample: Sample;
          fired?: { key: string }[];
        };
        live = payload.sample;
        const last = history[history.length - 1];
        if (!last || payload.ts > last.ts) history.push({ ...payload.sample, ts: payload.ts });
        // Cutoff matches the user's active range — so a 5M view drops
        // anything older, and a 30D view keeps a month's tail.
        const cutoff = Date.now() - RANGE_MINUTES[activeRange] * 60 * 1000;
        while (history.length > 0 && history[0].ts < cutoff) history.shift();
        // If any alerts fired, refresh the log so the user sees them
        // without a manual reload.
        if (payload.fired && payload.fired.length > 0) void loadAlerts();
      } catch {
        /* */
      }
    });
    es.addEventListener('error', () => {
      connected = false;
    });

    // Cleanup ONLY runs at component destroy. Putting the EventSource
    // setup before the return is mandatory — Svelte 5 treats onMount's
    // return as cleanup, so an early `return` would skip the SSE wiring
    // entirely (the regression that caused live cards to stay blank).
    return () => {
      clearInterval(procTimer);
      clearInterval(svcTimer);
    };
  });
  onDestroy(() => {
    es?.close();
  });
</script>

<section class="head">
  <div>
    <h1>Host monitor</h1>
    <p class="b-muted">
      System-wide metrics for the machine berth-control runs on. Sampled in-process every
      {#if live}few seconds — connection {connected ? 'live' : 'reconnecting'}{:else}few seconds{/if}.
    </p>
  </div>
  <div class="range-bar" role="tablist" aria-label="History range">
    {#each Object.keys(RANGE_MINUTES) as key (key)}
      <button
        class="b-btn small"
        class:active={activeRange === key}
        onclick={() => setRange(key as RangeKey)}
        role="tab"
        aria-selected={activeRange === key}
      >
        {key}
      </button>
    {/each}
  </div>
</section>

{#if loadError}
  <div class="b-surface error-panel">
    <AlertTriangle size={14} /> Couldn't load history: {loadError}
  </div>
{/if}

<div class="cards">
  <!-- System info — own row, full width -->
  {#if sysInfo}
    <Card class="card card-full">
      {#snippet children()}
        <div class="card-head">
          <Server size={14} />
          <strong>System</strong>
        </div>
        <div class="sys-grid">
          <div class="sys-row">
            <span class="sys-label">Hostname</span>
            <span class="sys-value b-mono">{sysInfo.hostname}</span>
          </div>
          {#if sysInfo.primary_ipv4}
            <div class="sys-row">
              <span class="sys-label">IPv4</span>
              <span class="sys-value b-mono">{sysInfo.primary_ipv4}</span>
            </div>
          {/if}
          <div class="sys-row">
            <span class="sys-label">OS</span>
            <span class="sys-value">{sysInfo.os_pretty ?? sysInfo.os}</span>
          </div>
          <div class="sys-row">
            <span class="sys-label">Kernel</span>
            <span class="sys-value b-mono">{sysInfo.kernel}</span>
          </div>
          <div class="sys-row">
            <span class="sys-label">Arch · CPUs</span>
            <span class="sys-value b-mono">{sysInfo.arch} · {sysInfo.cpu_count}</span>
          </div>
          <div class="sys-row">
            <span class="sys-label">RAM</span>
            <span class="sys-value">{(sysInfo.total_ram_mb / 1024).toFixed(1)} GB</span>
          </div>
          <div class="sys-row">
            <span class="sys-label">System up</span>
            <span class="sys-value">{fmtUptime(sysInfo.system_uptime_secs)}</span>
          </div>
          <div class="sys-row">
            <span class="sys-label">berth up</span>
            <span class="sys-value">{fmtUptime(sysInfo.process_uptime_secs)}</span>
          </div>
        </div>
      {/snippet}
    </Card>
  {/if}

  <!-- CPU temp (only if a value was collected) -->
  {#if live?.cpu_pkg_temp != null}
    <Card class="card">
      {#snippet children()}
        <div class="card-head">
          <Thermometer size={14} />
          <strong>CPU temp</strong>
          {#if tempBadge('cpu_temp', live.cpu_pkg_temp)}
            {@const b = tempBadge('cpu_temp', live.cpu_pkg_temp)!}
            <span class="status-badge" class:warn={b.tone === 'warn'} class:ok={b.tone === 'ok'}>{b.label}</span>
          {/if}
        </div>
        <div class="card-big">{live.cpu_pkg_temp.toFixed(1)}°C</div>
        <div class="card-sub">package</div>
        {#if cpuTempHistory.length > 1}
          <div class="card-chart"><MultiLineChart series={sparkSeries('CPU temp', cpuTempHistory, sparkColor(tempBadge('cpu_temp', live.cpu_pkg_temp)?.tone === 'warn' ? 'danger' : 'primary'))} height={80} showLegend={false} /></div>
        {/if}
      {/snippet}
    </Card>
  {/if}

  <!-- GPU temp (only if a value was collected) -->
  {#if live?.gpu_temp != null}
    <Card class="card">
      {#snippet children()}
        <div class="card-head">
          <Thermometer size={14} />
          <strong>GPU temp</strong>
          {#if tempBadge('gpu_temp', live.gpu_temp)}
            {@const b = tempBadge('gpu_temp', live.gpu_temp)!}
            <span class="status-badge" class:warn={b.tone === 'warn'} class:ok={b.tone === 'ok'}>{b.label}</span>
          {/if}
        </div>
        <div class="card-big">{live.gpu_temp.toFixed(1)}°C</div>
        <div class="card-sub">GPU sensor</div>
        {#if gpuTempHistory.length > 1}
          <div class="card-chart"><MultiLineChart series={sparkSeries('GPU temp', gpuTempHistory, sparkColor(tempBadge('gpu_temp', live.gpu_temp)?.tone === 'warn' ? 'danger' : 'primary'))} height={80} showLegend={false} /></div>
        {/if}
      {/snippet}
    </Card>
  {/if}

  <!-- CPU -->
  <Card class="card">
    {#snippet children()}
      <div class="card-head">
        <Cpu size={14} />
        <strong>CPU</strong>
      </div>
      <div class="card-big">
        {live?.cpu_util_total == null ? '—' : `${live.cpu_util_total.toFixed(1)}%`}
      </div>
      <div class="card-sub">
        {#if live?.cpu_pkg_temp != null}package {live.cpu_pkg_temp.toFixed(1)}°C{/if}
        {#if live?.cpu_util_cores}
          · {live.cpu_util_cores.length} cores
        {/if}
      </div>
      {#if cpuHistory.length > 1}
        <div class="card-chart"><MultiLineChart series={sparkSeries('CPU %', cpuHistory, sparkColor('primary'))} height={80} showLegend={false} /></div>
      {/if}
    {/snippet}
  </Card>

  <!-- Memory -->
  <Card class="card">
    {#snippet children()}
      <div class="card-head">
        <MemoryStick size={14} />
        <strong>Memory</strong>
      </div>
      <div class="card-big">
        {ramUsedPct == null ? '—' : `${ramUsedPct.toFixed(0)}%`}
      </div>
      <div class="card-sub">
        {fmtMB(live?.mem_total_mb && live?.mem_available_mb ? live.mem_total_mb - live.mem_available_mb : null)}
        of {fmtMB(live?.mem_total_mb)}
        {#if swapUsedPct != null}· swap {swapUsedPct.toFixed(0)}%{/if}
      </div>
      {#if ramHistory.length > 1}
        <div class="card-chart"><MultiLineChart series={sparkSeries('Memory %', ramHistory, sparkColor(ramUsedPct != null && ramUsedPct >= 90 ? 'danger' : ramUsedPct != null && ramUsedPct >= 80 ? 'warning' : 'primary'))} height={80} showLegend={false} /></div>
      {/if}
    {/snippet}
  </Card>

  <!-- Disk -->
  <Card class="card">
    {#snippet children()}
      <div class="card-head">
        <HardDrive size={14} />
        <strong>Disk /</strong>
      </div>
      <div class="card-big">
        {diskUsedPct == null ? '—' : `${diskUsedPct.toFixed(0)}%`}
      </div>
      <div class="card-sub">
        {fmtGB(live?.disk_used_gb)} of {fmtGB(live?.disk_total_gb)}
        · {fmtGB(live?.disk_avail_gb)} free
      </div>
    {/snippet}
  </Card>

  <!-- GPU (hidden if no GPU detected) -->
  {#if live?.gpu_util_pct != null || live?.gpu_temp != null || live?.gpu_power_w != null}
    <Card class="card">
      {#snippet children()}
        <div class="card-head">
          <Activity size={14} />
          <strong>GPU</strong>
        </div>
        <div class="card-big">
          {live.gpu_util_pct == null ? '—' : `${live.gpu_util_pct.toFixed(0)}%`}
        </div>
        <div class="card-sub">
          {#if live.gpu_temp != null}{live.gpu_temp.toFixed(0)}°C{/if}
          {#if live.gpu_power_w != null}· {live.gpu_power_w.toFixed(1)} W{/if}
          {#if live.gpu_mem_used_mb != null && live.gpu_mem_total_mb != null}
            · {fmtMB(live.gpu_mem_used_mb)} / {fmtMB(live.gpu_mem_total_mb)} VRAM
          {/if}
        </div>
      {/snippet}
    </Card>
  {/if}

  <!-- Network throughput summary — small card, shares row with CPU/Memory/Disk/GPU -->
  {#if live?.net_per_iface && Object.keys(live.net_per_iface).length > 0}
    <Card class="card">
      {#snippet children()}
        <div class="card-head">
          <Wifi size={14} />
          <strong>Network</strong>
        </div>
        <div class="iface-list">
          {#each Object.entries(live.net_per_iface) as [name, bps]}
            <div class="iface">
              <span class="iface-name b-mono">{name}</span>
              <span class="iface-rx">↓ {fmtBytes(bps.rx_bps)}</span>
              <span class="iface-tx">↑ {fmtBytes(bps.tx_bps)}</span>
            </div>
          {/each}
        </div>
        {#if netHistory.length > 1}
          <div class="card-chart"><MultiLineChart series={sparkSeries('Network KB/s', netHistory, sparkColor('primary'))} height={80} showLegend={false} /></div>
        {/if}
      {/snippet}
    </Card>
  {/if}

  <!-- Multi-line temperature chart -->
  {#if tempSeries.length > 0}
    <Card class="card card-wide">
      {#snippet children()}
        <div class="card-head">
          <Thermometer size={14} />
          <strong>Temperatures · {activeRange}</strong>
        </div>
        <MultiLineChart series={tempSeries} yUnit="°C" height={220} />
      {/snippet}
    </Card>
  {/if}

  <!-- CPU usage time-series (its own card) -->
  {#if cpuUsageSeries.length > 0}
    <Card class="card card-wide">
      {#snippet children()}
        <div class="card-head">
          <Cpu size={14} />
          <strong>CPU usage · {activeRange}</strong>
        </div>
        <MultiLineChart series={cpuUsageSeries} yUnit="%" height={220} />
      {/snippet}
    </Card>
  {/if}

  <!-- Memory usage time-series (its own card) -->
  {#if memUsageSeries.length > 0}
    <Card class="card card-wide">
      {#snippet children()}
        <div class="card-head">
          <MemoryStick size={14} />
          <strong>Memory usage · {activeRange}</strong>
        </div>
        <MultiLineChart series={memUsageSeries} yUnit="%" height={220} />
      {/snippet}
    </Card>
  {/if}

  <!-- Top processes -->
  {#if processes.length > 0}
    <Card class="card card-wide">
      {#snippet children()}
        <div class="card-head">
          <ListChecks size={14} />
          <strong>Processes</strong>
          <span class="b-mute2 small">({processes.length} by CPU)</span>
        </div>
        <div class="proc-table">
          <div class="proc-row proc-head">
            <span>Process</span>
            <span>PID</span>
            <span>User</span>
            <span class="proc-right">CPU%</span>
            <span class="proc-right">Memory</span>
          </div>
          {#each processes as p (p.pid)}
            <div class="proc-row">
              <span class="b-mono proc-comm" title={p.comm}>{p.comm}</span>
              <span class="b-mono b-mute2">{p.pid}</span>
              <span class="b-mute2">{p.user}</span>
              <span class="proc-right">{p.cpu_pct.toFixed(1)}</span>
              <span class="proc-right">{p.mem_mb < 1 ? '< 1 MB' : `${p.mem_mb.toFixed(0)} MB`}</span>
            </div>
          {/each}
        </div>
      {/snippet}
    </Card>
  {/if}

  <!-- Services -->
  {#if services.length > 0}
    <Card class="card card-wide">
      {#snippet children()}
        <div class="card-head">
          <ListChecks size={14} />
          <strong>Services</strong>
          <span class="b-mute2 small">({services.length} total · {services.filter((s) => s.status === 'running').length} running)</span>
          <span class="card-head-trail">
            <input
              type="search"
              class="b-input"
              placeholder="Filter…"
              bind:value={serviceFilter}
              aria-label="Filter services"
            />
          </span>
        </div>
        <div class="svc-table">
          <div class="svc-row svc-head">
            <span>Status</span>
            <span>Name</span>
            <span class="svc-detail">Detail</span>
          </div>
          {#each filteredServices.slice(0, 100) as s (s.name)}
            <div class="svc-row">
              <span class="svc-status">
                <span class="svc-dot {s.status}" title={s.status}></span>
                <span class="svc-status-text">{s.status}</span>
              </span>
              <span class="b-mono svc-name" title={s.description ?? s.name}>{s.name}</span>
              <span class="svc-detail b-mute2 b-mono">
                {s.pid != null ? `pid ${s.pid}` : s.sub}
              </span>
            </div>
          {/each}
        </div>
        {#if filteredServices.length > 100}
          <p class="threshold-hint">Showing first 100 of {filteredServices.length} matching services.</p>
        {/if}
      {/snippet}
    </Card>
  {/if}

  <!-- Threshold editor + alert log -->
  <Card class="card card-wide">
    {#snippet children()}
      <div class="card-head">
        <AlertTriangle size={14} />
        <strong>Alerts</strong>
        <span class="card-head-trail">
          {#if pushPublicKey}
            {#if pushSubscribed}
              <button class="b-btn small" disabled={pushBusy} onclick={() => void testPush()}>Test push</button>
            {:else}
              <button class="b-btn small" disabled={pushBusy} onclick={() => void enablePush()}>Enable push</button>
            {/if}
          {/if}
          {#if editing}
            <button class="b-btn small" onclick={() => (editing = false)}>Cancel</button>
            <button class="b-btn small primary" disabled={saving} onclick={() => void saveThresholds()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          {:else}
            <button class="b-btn small" onclick={() => (editing = true)}>Edit thresholds</button>
          {/if}
        </span>
      </div>

      {#if !pushPublicKey && pushReason}
        <p class="threshold-hint">
          Push notifications: {pushReason}
        </p>
      {/if}
      {#if editing}
        <div class="threshold-grid">
          {#each thresholds as t (t.key)}
            <label class="threshold">
              <span class="threshold-label">{t.label} <span class="b-mute2">({t.unit})</span></span>
              <input
                type="number"
                step="0.1"
                class="b-input"
                placeholder="disabled"
                bind:value={t.warn_value}
              />
            </label>
          {/each}
        </div>
        <p class="threshold-hint">
          Set a value to enable alerts for that metric; clear to disable. Alerts deduplicate per
          metric with a cooldown (default 15 min). Triggered alerts appear in the log below and in
          the dashboard's events feed.
        </p>
      {:else}
        <div class="threshold-summary">
          {#each thresholds as t (t.key)}
            <span class="threshold-pill" class:disabled={t.warn_value == null}>
              {t.label}: {t.warn_value == null ? 'off' : `${t.warn_value}${t.unit}`}
            </span>
          {/each}
        </div>
      {/if}

      <div class="alert-log">
        {#if alerts.length === 0}
          <p class="b-mute2 small">No alerts in the last 24 hours.</p>
        {:else}
          {#each alerts as a (a.id)}
            <div class="alert-row">
              <span class="alert-ts b-mono">{new Date(a.ts).toLocaleString()}</span>
              <span class="alert-msg">{a.msg}</span>
            </div>
          {/each}
        {/if}
      </div>
    {/snippet}
  </Card>

</div>

<style>
  .head {
    padding: 8px 0 14px;
  }
  .head h1 {
    font-size: 20px;
    font-weight: 600;
    margin: 0;
  }
  .head p {
    margin: 4px 0 0;
    font-size: 13px;
  }

  .error-panel {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    margin-bottom: 14px;
    color: var(--b-bad);
    border-left: 3px solid var(--b-bad);
  }

  /* 21-column grid = LCM(7 small + 3 wide). At ≥1200px each row holds:
       row 1: one system card (span 21)
       row 2: 7 small big-number cards (span 3 each → 21)
       row 3: 3 wide chart cards (span 7 each → 21)
       row 4: 3 wide list cards (span 7 each → 21)
     Below 1200px we fall back to auto-fill — narrow screens just wrap. */
  .cards {
    display: grid;
    grid-template-columns: repeat(21, 1fr);
    gap: 14px;
  }

  :global(.card) {
    padding: 14px 16px;
    grid-column: span 3;
  }
  :global(.card.card-wide) {
    grid-column: span 7;
  }
  :global(.card.card-full) {
    grid-column: span 21;
  }

  @media (max-width: 1199px) {
    .cards {
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    }
    :global(.card) {
      grid-column: auto;
    }
    :global(.card.card-wide) {
      grid-column: span 2;
    }
    :global(.card.card-full) {
      grid-column: 1 / -1;
    }
  }

  .card-head {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--b-text-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .card-big {
    font-size: 28px;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .card-sub {
    font-size: 12.5px;
    color: var(--b-text-2);
    margin-top: 2px;
  }
  .card-chart {
    margin-top: 8px;
    margin-left: -6px;
    margin-right: -6px;
  }

  /* Network now lives in a small (span-3) card. Stack interface rows
     vertically — each row keeps the original 3-column "name / ↓ rx / ↑ tx"
     layout but the list itself is one-up so it fits in the narrow card. */
  .iface-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 6px;
  }
  .iface {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 6px;
    font-size: 11.5px;
    align-items: baseline;
  }
  .iface-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .iface-name { color: var(--b-text); font-weight: 500; }
  .iface-rx { color: var(--b-info); }
  .iface-tx { color: var(--b-accent); }

  .temps-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 6px;
    margin-top: 6px;
  }
  .temp {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
  }
  .temp-name { color: var(--b-text-2); }
  .temp-value { font-variant-numeric: tabular-nums; }

  @media (max-width: 720px) {
    :global(.card.card-wide) {
      grid-column: span 1;
    }
  }

  .card-head-trail {
    margin-left: auto;
    display: inline-flex;
    gap: 6px;
  }
  .card-head { display: flex; align-items: center; }

  .threshold-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
    margin-top: 8px;
  }
  .threshold { display: flex; flex-direction: column; gap: 4px; }
  .threshold-label { font-size: 11.5px; color: var(--b-text-2); }
  .threshold input {
    font-size: 13px;
    padding: 6px 8px;
  }
  .threshold-hint {
    font-size: 11.5px;
    color: var(--b-text-3);
    line-height: 1.5;
    margin: 8px 0 0;
  }

  .threshold-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }
  .threshold-pill {
    font-size: 11.5px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--b-surface-2);
    color: var(--b-text-2);
    border: 1px solid var(--b-border);
  }
  .threshold-pill.disabled {
    color: var(--b-text-3);
    opacity: 0.65;
  }

  .alert-log {
    margin-top: 10px;
    border-top: 1px solid var(--b-border);
    padding-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .small { font-size: 12.5px; margin: 0; }
  .alert-row {
    display: grid;
    grid-template-columns: 160px 1fr;
    gap: 10px;
    font-size: 12px;
    padding: 3px 0;
  }
  .alert-ts { color: var(--b-text-3); }
  .alert-msg { color: var(--b-text); }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .range-bar {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: flex-start;
  }
  .range-bar .b-btn.small {
    padding: 4px 10px;
    font-size: 11.5px;
    min-width: 38px;
    background: var(--b-surface);
  }
  .range-bar .b-btn.small.active {
    background: var(--b-accent);
    color: var(--b-bg);
    border-color: var(--b-accent);
  }

  .sys-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 8px;
    margin-top: 6px;
  }
  .sys-row {
    display: flex;
    justify-content: space-between;
    font-size: 12.5px;
    gap: 12px;
  }
  .sys-label { color: var(--b-text-3); }
  .sys-value { color: var(--b-text); }

  .status-badge {
    margin-left: auto;
    font-size: 10.5px;
    padding: 1px 8px;
    border-radius: 999px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border: 1px solid transparent;
  }
  .status-badge.ok {
    color: var(--b-ok);
    background: color-mix(in oklab, var(--b-ok) 14%, transparent);
    border-color: color-mix(in oklab, var(--b-ok) 28%, transparent);
  }
  .status-badge.warn {
    color: var(--b-bad);
    background: color-mix(in oklab, var(--b-bad) 14%, transparent);
    border-color: color-mix(in oklab, var(--b-bad) 30%, transparent);
  }

  .proc-table {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    max-height: 360px;
    overflow-y: auto;
  }
  .proc-row {
    display: grid;
    grid-template-columns: 2fr 80px 100px 60px 80px;
    gap: 10px;
    padding: 5px 0;
    font-size: 12.5px;
    align-items: baseline;
    border-bottom: 1px solid var(--b-border);
  }
  .proc-row.proc-head {
    font-size: 10.5px;
    text-transform: uppercase;
    color: var(--b-text-3);
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--b-border-2);
    margin-bottom: 2px;
    padding-bottom: 4px;
  }
  .proc-row:last-child { border-bottom: none; }
  .proc-comm { color: var(--b-text); }
  .proc-right { text-align: right; font-variant-numeric: tabular-nums; }

  @media (max-width: 720px) {
    .proc-row { grid-template-columns: 1.5fr 70px 80px 50px 70px; gap: 6px; font-size: 11.5px; }
  }

  .svc-table {
    margin-top: 6px;
    max-height: 420px;
    overflow-y: auto;
  }
  .svc-row {
    display: grid;
    grid-template-columns: 130px 1fr 140px;
    gap: 10px;
    padding: 5px 0;
    font-size: 12.5px;
    align-items: baseline;
    border-bottom: 1px solid var(--b-border);
  }
  .svc-row.svc-head {
    font-size: 10.5px;
    text-transform: uppercase;
    color: var(--b-text-3);
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--b-border-2);
  }
  .svc-row:last-child { border-bottom: none; }
  .svc-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--b-text-2); }
  .svc-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--b-text-3);
    flex-shrink: 0;
  }
  .svc-dot.running { background: var(--b-ok); }
  .svc-dot.stopped { background: var(--b-text-3); }
  .svc-dot.failed { background: var(--b-bad); }
  .svc-dot.unknown { background: var(--b-warn); opacity: 0.7; }
  .svc-status-text { text-transform: capitalize; }
  .svc-name { color: var(--b-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .svc-detail { text-align: right; }

  .card-head input[type="search"] {
    padding: 4px 8px;
    font-size: 12px;
    max-width: 180px;
  }
</style>
