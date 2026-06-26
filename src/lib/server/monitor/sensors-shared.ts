// Cross-platform host-monitoring sensor types + dispatch.
//
// Per the berth-control cross-platform rule (feedback-cross-platform memory):
// every sensor has a Linux path AND a macOS path. Either may return null for
// fields that simply don't exist on that platform. The collector writes
// nulls verbatim to host_readings; the UI hides them. Never substitute a
// fabricated value for a missing reading.

/** One full sample. All fields nullable — the collector writes whatever it
 *  could read. */
export interface HostSample {
  /** CPU utilization 0..100, total across all cores. */
  cpu_util_total: number | null;
  /** Per-core utilization 0..100. Length = discovered core count. */
  cpu_util_cores: number[] | null;
  /** Package temp in °C. */
  cpu_pkg_temp: number | null;
  /** Per-core temps in °C. */
  cpu_core_temps: number[] | null;

  gpu_temp: number | null;
  gpu_power_w: number | null;
  gpu_mem_used_mb: number | null;
  gpu_mem_total_mb: number | null;
  gpu_fan_pct: number | null;
  gpu_util_pct: number | null;

  mem_total_mb: number | null;
  mem_available_mb: number | null;
  mem_buffers_mb: number | null;
  mem_cached_mb: number | null;
  swap_total_mb: number | null;
  swap_free_mb: number | null;

  disk_total_gb: number | null;
  disk_used_gb: number | null;
  disk_avail_gb: number | null;

  /** bytes-per-second per interface name. Discovered at runtime — never
   *  hardcode names like `eno1` / `tailscale0` / `en0`. */
  net_per_iface: Record<string, { rx_bps: number; tx_bps: number }> | null;

  /** Hardware-specific extra temps that don't fit the named CPU/GPU slots:
   *  motherboard, NVMe sensors, WiFi controller, ACPI thermal zones, etc.
   *  Keys are platform-specific (Linux: hwmon device + label; macOS: smc
   *  channel). */
  misc_temps: Record<string, number> | null;
}

/** Sensor module contract: each platform exports the same interface. The
 *  collector picks the right module at boot via process.platform and never
 *  calls the wrong one. */
export interface SensorModule {
  /** Cheap; called once at boot to log what's available. */
  init(): Promise<{ availability: Record<string, boolean>; notes: string[] }>;
  /** Take one sample. Should complete in well under interval_secs even on a
   *  slow box — most time goes to subprocess spawns (nvidia-smi, top, etc.).
   *  Returns a partial sample; missing keys come back as null. */
  sample(): Promise<HostSample>;
}

/** Build an all-nulls sample. Useful as a starting point that the platform
 *  module then fills in. */
export function emptySample(): HostSample {
  return {
    cpu_util_total: null,
    cpu_util_cores: null,
    cpu_pkg_temp: null,
    cpu_core_temps: null,
    gpu_temp: null,
    gpu_power_w: null,
    gpu_mem_used_mb: null,
    gpu_mem_total_mb: null,
    gpu_fan_pct: null,
    gpu_util_pct: null,
    mem_total_mb: null,
    mem_available_mb: null,
    mem_buffers_mb: null,
    mem_cached_mb: null,
    swap_total_mb: null,
    swap_free_mb: null,
    disk_total_gb: null,
    disk_used_gb: null,
    disk_avail_gb: null,
    net_per_iface: null,
    misc_temps: null
  };
}
