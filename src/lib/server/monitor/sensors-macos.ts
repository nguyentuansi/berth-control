import { execSync } from 'node:child_process';
import { emptySample, type HostSample, type SensorModule } from './sensors-shared.js';

// macOS host monitoring. Same surface as sensors-linux but pulls from
// BSD-shaped tools: top / vm_stat / sysctl / netstat / iostat / df, with
// powermetrics gated behind sudo for thermal + GPU on Apple Silicon.
//
// Per the cross-platform rule, this is an ADDITIVE module — Linux's
// /proc/sys paths stay untouched.

interface PrevNet {
  ts: number;
  rx: Record<string, number>;
  tx: Record<string, number>;
}
let prevNet: PrevNet | null = null;

let cachedCpuCount: number | null = null;
let powermetricsAvailable = false;

async function init(): Promise<{ availability: Record<string, boolean>; notes: string[] }> {
  const notes: string[] = [];
  const availability: Record<string, boolean> = {};

  availability.top = canSpawn('top');
  availability.vm_stat = canSpawn('vm_stat');
  availability.sysctl = canSpawn('sysctl');
  availability.netstat = canSpawn('netstat');
  availability.df = canSpawn('df');
  availability.system_profiler = canSpawn('system_profiler');

  // powermetrics is the only path to CPU temps + Apple Silicon GPU metrics,
  // but it requires sudo. Try a one-shot probe — if it works without a
  // password prompt, we can use it. If not, set to false and silently skip
  // thermal/GPU until the user wires sudoers.
  try {
    execSync('sudo -n powermetrics --samplers smc -i 100 -n 1 --hide-cpu-duty-cycle 2>/dev/null', {
      stdio: 'ignore',
      timeout: 1500
    });
    powermetricsAvailable = true;
    availability.powermetrics = true;
  } catch {
    powermetricsAvailable = false;
    availability.powermetrics = false;
    notes.push(
      "powermetrics not usable without sudo — CPU temps + Apple-Silicon GPU will be null. " +
        "To enable: add a NOPASSWD sudoers entry for `/usr/bin/powermetrics`."
    );
  }

  // Cache logical CPU count so per-core sizing is consistent across ticks.
  try {
    cachedCpuCount = Number(execSync('sysctl -n hw.logicalcpu', { encoding: 'utf8' }).trim());
    if (!Number.isFinite(cachedCpuCount) || cachedCpuCount <= 0) cachedCpuCount = null;
  } catch {
    cachedCpuCount = null;
  }

  return { availability, notes };
}

function canSpawn(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore', timeout: 500 });
    return true;
  } catch {
    return false;
  }
}

async function sample(): Promise<HostSample> {
  const s = emptySample();

  sampleCpu(s);
  sampleMemory(s);
  sampleDisk(s);
  sampleNet(s);
  if (powermetricsAvailable) samplePowermetrics(s);

  return s;
}

function sampleCpu(s: HostSample): void {
  // `top -l 1 -s 0 -n 0` prints a CPU usage line:
  //   CPU usage: 5.10% user, 2.34% sys, 92.55% idle
  // The line is a single-sample snapshot — not a delta — so unlike Linux
  // there's no jiffies bookkeeping. We use top's already-computed %.
  try {
    const out = execSync('top -l 1 -n 0 -s 0', { encoding: 'utf8', timeout: 1500 });
    const m = out.match(/CPU usage:\s+([\d.]+)% user,\s+([\d.]+)% sys,\s+([\d.]+)% idle/i);
    if (m) {
      const user = Number(m[1]);
      const sys = Number(m[2]);
      const idle = Number(m[3]);
      if (Number.isFinite(user) && Number.isFinite(sys) && Number.isFinite(idle)) {
        s.cpu_util_total = Math.max(0, Math.min(100, 100 - idle));
      }
    }
  } catch {
    /* leave null */
  }
  // No cheap per-core source without sampling overhead — leave cpu_util_cores
  // null on macOS. (powermetrics gives per-core but it's an expensive,
  // long-running tool we already gate behind sudo for thermal use.)
}

function sampleMemory(s: HostSample): void {
  // vm_stat output is in pages of size hw.pagesize. We multiply each free
  // class by the page size to convert to bytes, then to MB.
  let pageSize = 4096;
  try {
    pageSize = Number(execSync('sysctl -n hw.pagesize', { encoding: 'utf8' }).trim()) || 4096;
  } catch {
    /* */
  }
  let totalBytes = 0;
  try {
    totalBytes = Number(execSync('sysctl -n hw.memsize', { encoding: 'utf8' }).trim());
  } catch {
    /* */
  }

  try {
    const out = execSync('vm_stat', { encoding: 'utf8', timeout: 1500 });
    const fields: Record<string, number> = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^(.*?):\s+(\d+)\.?\s*$/);
      if (m) fields[m[1].trim()] = Number(m[2]);
    }
    const pagesFree = fields['Pages free'] ?? 0;
    const pagesInactive = fields['Pages inactive'] ?? 0;
    const pagesSpeculative = fields['Pages speculative'] ?? 0;
    const pagesCached = fields['Pages purgeable'] ?? 0; // approx
    const pagesActive = fields['Pages active'] ?? 0;
    const pagesWired = fields['Pages wired down'] ?? 0;
    const pagesCompressed = fields['Pages occupied by compressor'] ?? 0;

    const bytesToMb = (v: number) => (v * pageSize) / 1_048_576;
    // "Available" on macOS — close analog to Linux MemAvailable — is the
    // sum of free+inactive+speculative+purgeable.
    const avail = bytesToMb(pagesFree + pagesInactive + pagesSpeculative + pagesCached);

    if (totalBytes > 0) {
      s.mem_total_mb = totalBytes / 1_048_576;
    } else {
      // Fallback: total = active + wired + compressed + avail.
      s.mem_total_mb = bytesToMb(pagesActive + pagesWired + pagesCompressed) + avail;
    }
    s.mem_available_mb = avail;
    s.mem_cached_mb = bytesToMb(pagesCached);
    // There's no direct "buffers" analog on macOS — leave null rather than
    // guess.
  } catch {
    /* */
  }

  // Swap is reported by sysctl as a human-readable string:
  //   vm.swapusage: total = 0.00M used = 0.00M free = 0.00M (encrypted)
  try {
    const out = execSync('sysctl -n vm.swapusage', { encoding: 'utf8', timeout: 800 });
    const t = out.match(/total\s*=\s*([\d.]+)([MGK])/i);
    const u = out.match(/used\s*=\s*([\d.]+)([MGK])/i);
    if (t) {
      const total = toMb(Number(t[1]), t[2]);
      s.swap_total_mb = total;
      if (u) s.swap_free_mb = Math.max(0, total - toMb(Number(u[1]), u[2]));
    }
  } catch {
    /* */
  }
}

function toMb(v: number, unit: string): number {
  switch (unit.toUpperCase()) {
    case 'G':
      return v * 1024;
    case 'K':
      return v / 1024;
    default:
      return v;
  }
}

function sampleDisk(s: HostSample): void {
  // df -kP works identically on Linux + macOS. The same code shape as the
  // Linux module; could be hoisted to a shared helper later if a third
  // platform shows up.
  try {
    const df = execSync('df -kP /', { encoding: 'utf8', timeout: 800 });
    const lines = df.trim().split('\n');
    if (lines.length < 2) return;
    const parts = lines[lines.length - 1].split(/\s+/);
    if (parts.length < 6) return;
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const availKb = Number(parts[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(availKb)) return;
    const kbToGb = (v: number) => v / 1024 / 1024;
    s.disk_total_gb = kbToGb(totalKb);
    s.disk_used_gb = kbToGb(usedKb);
    s.disk_avail_gb = kbToGb(availKb);
  } catch {
    /* */
  }
}

function sampleNet(s: HostSample): void {
  // `netstat -ibn` columns on macOS:
  //   Name  Mtu   Network       Address     Ipkts Ierrs Ibytes  Opkts Oerrs Obytes  Coll Drop
  // The first line is a header. Some interfaces appear twice (once per
  // address family) — we use the first row per name so we don't double-count.
  let out: string;
  try {
    out = execSync('netstat -ibn', { encoding: 'utf8', timeout: 1500 });
  } catch {
    return;
  }
  const rx: Record<string, number> = {};
  const tx: Record<string, number> = {};
  const lines = out.trim().split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].trim().split(/\s+/);
    if (cols.length < 10) continue;
    const name = cols[0];
    if (name === 'lo0' || name in rx) continue;
    const ibytes = Number(cols[6]);
    const obytes = Number(cols[9]);
    if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) continue;
    rx[name] = ibytes;
    tx[name] = obytes;
  }

  const ts = Date.now();
  if (prevNet) {
    const dtSec = (ts - prevNet.ts) / 1000;
    if (dtSec > 0) {
      const result: Record<string, { rx_bps: number; tx_bps: number }> = {};
      for (const name of Object.keys(rx)) {
        const prev_rx = prevNet.rx[name];
        const prev_tx = prevNet.tx[name];
        if (prev_rx == null || prev_tx == null) continue;
        const rxBps = Math.max(0, (rx[name] - prev_rx) / dtSec);
        const txBps = Math.max(0, (tx[name] - prev_tx) / dtSec);
        if (rxBps > 0 || txBps > 0) result[name] = { rx_bps: rxBps, tx_bps: txBps };
      }
      if (Object.keys(result).length > 0) s.net_per_iface = result;
    }
  }
  prevNet = { ts, rx, tx };
}

function samplePowermetrics(s: HostSample): void {
  // powermetrics is heavyweight — a single short sample (100ms, 1 iteration)
  // can still take ~500ms wall-clock for the sudo + tool setup. Use sparingly.
  // We pull smc (temps + battery) + gpu_power in one shot.
  let out: string;
  try {
    out = execSync(
      'sudo -n powermetrics --samplers smc,gpu_power -i 100 -n 1 --hide-cpu-duty-cycle 2>/dev/null',
      { encoding: 'utf8', timeout: 3500 }
    );
  } catch {
    return;
  }

  // CPU die temperature on Apple Silicon shows up under "CPU die temperature: NN.NN C".
  const cpuTempMatch = out.match(/CPU\s+die\s+temperature[^0-9]*([\d.]+)\s*C/i);
  if (cpuTempMatch) {
    const v = Number(cpuTempMatch[1]);
    if (Number.isFinite(v)) s.cpu_pkg_temp = v;
  }

  // GPU active residency / power. Apple Silicon reports "GPU HW active frequency"
  // and "GPU Power: N mW".
  const gpuPowerMatch = out.match(/GPU\s+Power[^0-9]*([\d.]+)\s*(mW|W)/i);
  if (gpuPowerMatch) {
    const v = Number(gpuPowerMatch[1]);
    if (Number.isFinite(v)) s.gpu_power_w = gpuPowerMatch[2].toUpperCase() === 'MW' ? v / 1000 : v;
  }
  const gpuActiveMatch = out.match(/GPU\s+HW\s+active\s+residency:\s+([\d.]+)\s*%/i);
  if (gpuActiveMatch) {
    const v = Number(gpuActiveMatch[1]);
    if (Number.isFinite(v)) s.gpu_util_pct = v;
  }

  // Misc thermal channels — there are many under "Thermal pressure" /
  // "thermal_state". Capture each named channel that has a numeric value.
  const misc: Record<string, number> = {};
  for (const line of out.split('\n')) {
    // Match patterns like "<channel name>: <value> <unit>" where channel
    // looks like a thermal sensor name.
    const m = line.match(/^([A-Za-z][\w\s\-]+?):\s+([\d.]+)\s*C\b/);
    if (m) {
      const channel = m[1].trim().toLowerCase().replace(/\s+/g, '_');
      const v = Number(m[2]);
      // Don't double-record the CPU die temp we already pulled out.
      if (channel === 'cpu_die_temperature') continue;
      if (Number.isFinite(v)) misc[`smc_${channel}`] = v;
    }
  }
  if (Object.keys(misc).length > 0) s.misc_temps = misc;

  // Track cpu_count for future per-core support.
  void cachedCpuCount;
}

export const macosSensors: SensorModule = {
  init,
  sample
};
