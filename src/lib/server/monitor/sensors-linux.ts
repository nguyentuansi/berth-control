import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { emptySample, type HostSample, type SensorModule } from './sensors-shared.js';

// Linux host monitoring. Ported from pcmonitor's Rust collector (which see
// for the original implementation). Reads /proc, /sys/class/hwmon, and
// shells out to nvidia-smi for GPU when available.
//
// All sysfs scanning is dynamic — never hardcode device names like
// `coretemp`, `nvme`, `gigabyte_wmi`, or interface names like `eno1` /
// `tailscale0`. Hardware varies between machines; the collector adapts.

/** /proc/stat jiffies from the previous tick, so we can compute per-core
 *  utilization as a delta. Keyed by core index (0 = aggregate "cpu"). */
let prevJiffies: { idle: number[]; total: number[] } | null = null;

/** /proc/net/dev counters from the previous tick + wall-clock time, to turn
 *  byte counters into bytes-per-second deltas. */
let prevNet: { ts: number; rx: Record<string, number>; tx: Record<string, number> } | null =
  null;

/** Mapping from hwmon device name (e.g. "coretemp", "nvme") to its sysfs
 *  path. Computed once at init(). Hardware doesn't shuffle without a reboot,
 *  so caching is safe. */
let hwmonDevices: Record<string, string> = {};

/** Whether `nvidia-smi` is on PATH. Cached at init() so we don't pay a
 *  spawn-and-fail cost per sample. */
let gpuAvailable = false;

async function init(): Promise<{ availability: Record<string, boolean>; notes: string[] }> {
  const notes: string[] = [];
  const availability: Record<string, boolean> = {};

  // hwmon scan
  hwmonDevices = {};
  try {
    for (const entry of readdirSync('/sys/class/hwmon')) {
      const namePath = `/sys/class/hwmon/${entry}/name`;
      if (existsSync(namePath)) {
        const name = readFileSync(namePath, 'utf8').trim();
        if (name) hwmonDevices[name] = `/sys/class/hwmon/${entry}`;
      }
    }
  } catch {
    notes.push('hwmon scan failed; CPU + misc temps will be null');
  }
  availability.hwmon = Object.keys(hwmonDevices).length > 0;
  if (availability.hwmon) {
    notes.push(`hwmon devices: ${Object.keys(hwmonDevices).sort().join(', ')}`);
  }

  // GPU via nvidia-smi
  try {
    execSync('nvidia-smi --version', { stdio: 'ignore', timeout: 1000 });
    gpuAvailable = true;
    availability.nvidia_smi = true;
  } catch {
    gpuAvailable = false;
    availability.nvidia_smi = false;
  }

  availability.proc_stat = existsSync('/proc/stat');
  availability.proc_meminfo = existsSync('/proc/meminfo');
  availability.proc_net_dev = existsSync('/proc/net/dev');

  return { availability, notes };
}

async function sample(): Promise<HostSample> {
  const s = emptySample();

  sampleCpu(s);
  sampleMemory(s);
  sampleDisk(s);
  sampleNet(s);
  sampleHwmonTemps(s);
  if (gpuAvailable) sampleGpu(s);

  return s;
}

function sampleCpu(s: HostSample): void {
  // /proc/stat layout:
  //   cpu  <user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal> ...
  //   cpu0 ... cpu1 ... etc.
  // utilization = (total_busy_delta) / (total_delta) * 100
  let raw: string;
  try {
    raw = readFileSync('/proc/stat', 'utf8');
  } catch {
    return;
  }
  const idle: number[] = [];
  const total: number[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^cpu(\d*)\s+(.+)$/);
    if (!m) continue;
    const fields = m[2].trim().split(/\s+/).map(Number);
    if (fields.length < 5) continue;
    const idleAndIowait = (fields[3] ?? 0) + (fields[4] ?? 0);
    const sum = fields.reduce((a, b) => a + b, 0);
    if (m[1] === '') {
      idle[0] = idleAndIowait;
      total[0] = sum;
    } else {
      const i = Number(m[1]) + 1;
      idle[i] = idleAndIowait;
      total[i] = sum;
    }
  }

  if (prevJiffies) {
    const utilTotal = computeUtil(idle[0], total[0], prevJiffies.idle[0], prevJiffies.total[0]);
    s.cpu_util_total = utilTotal;
    const cores: number[] = [];
    for (let i = 1; i < total.length; i++) {
      if (total[i] == null || prevJiffies.total[i] == null) continue;
      const u = computeUtil(idle[i], total[i], prevJiffies.idle[i], prevJiffies.total[i]);
      if (u != null) cores.push(u);
    }
    if (cores.length > 0) s.cpu_util_cores = cores;
  }

  prevJiffies = { idle, total };
}

function computeUtil(
  idle: number | undefined,
  total: number | undefined,
  prevIdle: number | undefined,
  prevTotal: number | undefined
): number | null {
  if (idle == null || total == null || prevIdle == null || prevTotal == null) return null;
  const dt = total - prevTotal;
  if (dt <= 0) return null;
  const di = idle - prevIdle;
  return Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
}

function sampleMemory(s: HostSample): void {
  let raw: string;
  try {
    raw = readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return;
  }
  const fields: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z()]+):\s+(\d+)\s*kB$/);
    if (m) fields[m[1]] = Number(m[2]);
  }
  // /proc/meminfo reports kB; we store MB.
  const kBtoMB = (v: number | undefined) => (v == null ? null : v / 1024);
  s.mem_total_mb = kBtoMB(fields.MemTotal);
  s.mem_available_mb = kBtoMB(fields.MemAvailable);
  s.mem_buffers_mb = kBtoMB(fields.Buffers);
  s.mem_cached_mb = kBtoMB(fields.Cached);
  s.swap_total_mb = kBtoMB(fields.SwapTotal);
  s.swap_free_mb = kBtoMB(fields.SwapFree);
}

function sampleDisk(s: HostSample): void {
  // statfs() is in Node 18.15+. We require Node 22.
  // Bytes returned: f_blocks * f_frsize, f_bavail * f_frsize.
  try {
    // node:fs.statfs is callback-based; the sync wrapper from older versions
    // is gone in newer ones. Spawn a one-shot child to call it synchronously
    // via a CLI: `df -k /`. Cheap (~1ms) and portable.
    const df = execSync('df -kP /', { encoding: 'utf8', timeout: 800 });
    const lines = df.trim().split('\n');
    if (lines.length < 2) return;
    // df -kP output: Filesystem 1024-blocks Used Available Capacity Mounted-on
    const parts = lines[lines.length - 1].split(/\s+/);
    if (parts.length < 6) return;
    const totalKb = Number(parts[1]);
    const usedKb = Number(parts[2]);
    const availKb = Number(parts[3]);
    const kbToGb = (v: number) => v / 1024 / 1024;
    if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || !Number.isFinite(availKb)) return;
    s.disk_total_gb = kbToGb(totalKb);
    s.disk_used_gb = kbToGb(usedKb);
    s.disk_avail_gb = kbToGb(availKb);
  } catch {
    /* leave null */
  }
}

function sampleNet(s: HostSample): void {
  let raw: string;
  try {
    raw = readFileSync('/proc/net/dev', 'utf8');
  } catch {
    return;
  }
  // /proc/net/dev format:
  //   Inter-|   Receive                                                |  Transmit
  //    face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets ...
  //     eth0:  N N N N N N N N  M M M M M M M M
  const rx: Record<string, number> = {};
  const tx: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([^:]+):\s*(.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    if (name === 'lo') continue; // ignore loopback noise
    const cols = m[2].trim().split(/\s+/).map(Number);
    // Receive is the first 8 columns, Transmit is the next 8.
    if (cols.length < 16) continue;
    rx[name] = cols[0];
    tx[name] = cols[8];
  }

  const ts = Date.now();
  if (prevNet) {
    const dtSec = (ts - prevNet.ts) / 1000;
    if (dtSec > 0) {
      const out: Record<string, { rx_bps: number; tx_bps: number }> = {};
      for (const name of Object.keys(rx)) {
        const prev_rx = prevNet.rx[name];
        const prev_tx = prevNet.tx[name];
        if (prev_rx == null || prev_tx == null) continue;
        const rxBps = Math.max(0, (rx[name] - prev_rx) / dtSec);
        const txBps = Math.max(0, (tx[name] - prev_tx) / dtSec);
        if (rxBps > 0 || txBps > 0) out[name] = { rx_bps: rxBps, tx_bps: txBps };
      }
      if (Object.keys(out).length > 0) s.net_per_iface = out;
    }
  }
  prevNet = { ts, rx, tx };
}

function sampleHwmonTemps(s: HostSample): void {
  const misc: Record<string, number> = {};
  const coreTemps: number[] = [];

  for (const [device, path] of Object.entries(hwmonDevices)) {
    try {
      for (const f of readdirSync(path)) {
        const m = f.match(/^temp(\d+)_input$/);
        if (!m) continue;
        const idx = Number(m[1]);
        const inputPath = resolve(path, f);
        let value: number;
        try {
          // hwmon temps are milli-°C.
          value = Number(readFileSync(inputPath, 'utf8').trim()) / 1000;
        } catch {
          continue;
        }
        if (!Number.isFinite(value)) continue;

        // Try to find the label for context.
        let label: string | null = null;
        const labelPath = resolve(path, `temp${idx}_label`);
        if (existsSync(labelPath)) {
          try {
            label = readFileSync(labelPath, 'utf8').trim();
          } catch {
            /* */
          }
        }

        // Special-case the recognizable CPU sensors so the named columns get
        // populated, with everything else falling into misc_temps.
        if (device === 'coretemp' || device === 'k10temp' || device === 'zenpower') {
          if (label && /^package/i.test(label)) {
            s.cpu_pkg_temp = value;
            continue;
          }
          if (label && /^core\s*\d+/i.test(label)) {
            coreTemps.push(value);
            continue;
          }
        }

        const key = label ? `${device}_${label.toLowerCase().replace(/\s+/g, '_')}` : `${device}_temp${idx}`;
        misc[key] = value;
      }
    } catch {
      /* skip device on error */
    }
  }

  if (coreTemps.length > 0) s.cpu_core_temps = coreTemps;
  if (Object.keys(misc).length > 0) s.misc_temps = misc;
}

function sampleGpu(s: HostSample): void {
  // nvidia-smi can query multiple metrics in one shot.
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=temperature.gpu,power.draw,memory.used,memory.total,fan.speed,utilization.gpu --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 2000 }
    );
    const first = out.split('\n').find((l) => l.trim().length > 0);
    if (!first) return;
    const fields = first.split(',').map((v) => {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : null;
    });
    s.gpu_temp = fields[0];
    s.gpu_power_w = fields[1];
    s.gpu_mem_used_mb = fields[2];
    s.gpu_mem_total_mb = fields[3];
    s.gpu_fan_pct = fields[4];
    s.gpu_util_pct = fields[5];
  } catch {
    /* leave nulls; nvidia-smi may have been unplugged since init() */
  }
}

export const linuxSensors: SensorModule = {
  init,
  sample
};
