<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Cpu, MemoryStick, HardDrive, Thermometer, Activity, Wifi, AlertTriangle } from 'lucide-svelte';
  import Card from '@berth/ui/Card.svelte';
  import Chart from '@berth/ui/Chart.svelte';

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

  let live: Sample | null = $state(null);
  let history: Sample[] = $state([]);
  let connected = $state(false);
  let loadError = $state<string | null>(null);
  let es: EventSource | null = null;

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

  const cpuHistory = $derived.by(() =>
    history
      .filter((s) => s.cpu_util_total != null)
      .map((s) => ({ label: hhmm(s.ts), value: s.cpu_util_total! }))
  );
  const ramHistory = $derived.by(() =>
    history
      .filter((s) => s.mem_total_mb != null && s.mem_available_mb != null)
      .map((s) => ({
        label: hhmm(s.ts),
        value: ((s.mem_total_mb! - s.mem_available_mb!) / s.mem_total_mb!) * 100
      }))
  );
  const netHistory = $derived.by(() => {
    // Sum rx+tx across all interfaces per sample to get total throughput.
    return history
      .filter((s) => s.net_per_iface != null)
      .map((s) => {
        let total = 0;
        for (const v of Object.values(s.net_per_iface!)) total += v.rx_bps + v.tx_bps;
        return { label: hhmm(s.ts), value: total / 1024 }; // KB/s
      });
  });

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

  async function loadHistory() {
    try {
      const since = Date.now() - 60 * 60 * 1000;
      const r = await fetch(`/api/monitor/history?from=${since}&max=120`);
      if (!r.ok) {
        loadError = `history load failed (${r.status})`;
        return;
      }
      const j = (await r.json()) as { samples: Sample[] };
      history = j.samples ?? [];
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  onMount(() => {
    void loadHistory();
    es = new EventSource('/api/monitor/state');
    es.addEventListener('meta', () => {
      connected = true;
    });
    es.addEventListener('sample', (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { ts: number; sample: Sample };
        live = payload.sample;
        // Append to history if the timestamp moved forward — keeps the
        // sparkline in sync with the live cards without needing a refetch.
        const last = history[history.length - 1];
        if (!last || payload.ts > last.ts) history.push({ ...payload.sample, ts: payload.ts });
        // Drop anything older than 60 minutes so the sparkline stays bounded.
        const cutoff = Date.now() - 60 * 60 * 1000;
        while (history.length > 0 && history[0].ts < cutoff) history.shift();
      } catch {
        /* */
      }
    });
    es.addEventListener('error', () => {
      connected = false;
    });
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
</section>

{#if loadError}
  <div class="b-surface error-panel">
    <AlertTriangle size={14} /> Couldn't load history: {loadError}
  </div>
{/if}

<div class="cards">
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
        <div class="card-chart"><Chart data={cpuHistory} type="line" variant="primary" height={80} showAxis={false} /></div>
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
        <div class="card-chart"><Chart data={ramHistory} type="line" variant={ramUsedPct != null && ramUsedPct >= 90 ? 'danger' : ramUsedPct != null && ramUsedPct >= 80 ? 'warning' : 'primary'} height={80} showAxis={false} /></div>
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

  <!-- Network throughput summary -->
  {#if live?.net_per_iface && Object.keys(live.net_per_iface).length > 0}
    <Card class="card card-wide">
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
          <div class="card-chart"><Chart data={netHistory} type="area" variant="primary" height={80} showAxis={false} /></div>
        {/if}
      {/snippet}
    </Card>
  {/if}

  <!-- Misc temps (hwmon / powermetrics) -->
  {#if live?.misc_temps && Object.keys(live.misc_temps).length > 0}
    <Card class="card card-wide">
      {#snippet children()}
        <div class="card-head">
          <Thermometer size={14} />
          <strong>Other temperatures</strong>
        </div>
        <div class="temps-grid">
          {#each Object.entries(live.misc_temps) as [name, temp]}
            <div class="temp">
              <span class="temp-name b-mono">{name}</span>
              <span class="temp-value">{temp.toFixed(1)}°C</span>
            </div>
          {/each}
        </div>
      {/snippet}
    </Card>
  {/if}
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

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 14px;
  }

  :global(.card) {
    padding: 14px 16px;
  }
  :global(.card.card-wide) {
    grid-column: span 2;
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

  .iface-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
    margin-top: 6px;
  }
  .iface {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 8px;
    font-size: 12px;
    align-items: baseline;
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
</style>
