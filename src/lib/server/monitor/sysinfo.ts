import { hostname, networkInterfaces, release, type, totalmem, arch, cpus, uptime } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Static-ish system info exposed to the dashboard's "System" card.
// Most values come from node:os, which is cross-platform. The bits node:os
// doesn't expose (e.g. boot time, distro pretty name) come from per-OS
// tools that we already use elsewhere — no new platform-specific deps.

export interface SystemInfo {
  hostname: string;
  os: string; // "Linux 6.5.0-1-generic" / "Darwin 25.1.0"
  os_pretty: string | null; // "Ubuntu 24.04 LTS" / "macOS 15.1 (Sequoia)"
  arch: string; // 'arm64' / 'x64'
  kernel: string; // os.release()
  /** Total RAM in MB. Static once boot completes. */
  total_ram_mb: number;
  /** Logical CPU count. */
  cpu_count: number;
  /** Process uptime since berth-control started, in seconds. */
  process_uptime_secs: number;
  /** Machine uptime since boot, in seconds. */
  system_uptime_secs: number;
  /** Primary non-loopback IPv4 address. May be a tailnet, LAN, or other —
   *  whichever comes first in node:os's enumeration. Null if the box has
   *  no IPv4 binding (rare). */
  primary_ipv4: string | null;
}

export function readSystemInfo(): SystemInfo {
  const ipv4 = pickPrimaryIPv4();
  return {
    hostname: hostname(),
    os: `${type()} ${release()}`,
    os_pretty: prettyOsName(),
    arch: arch(),
    kernel: release(),
    total_ram_mb: totalmem() / 1_048_576,
    cpu_count: cpus().length,
    process_uptime_secs: process.uptime(),
    system_uptime_secs: uptime(),
    primary_ipv4: ipv4
  };
}

function pickPrimaryIPv4(): string | null {
  const all = networkInterfaces();
  // Prefer interfaces that look "real" — not loopback, not link-local
  // (169.254.x.x). Tailnet (100.x.x.x), LAN private space, and public
  // addresses all qualify. We iterate in declaration order, which on
  // Linux/macOS roughly tracks "primary first".
  for (const ifaces of Object.values(all)) {
    if (!ifaces) continue;
    for (const i of ifaces) {
      if (i.family !== 'IPv4') continue;
      if (i.internal) continue;
      if (i.address.startsWith('169.254.')) continue;
      return i.address;
    }
  }
  return null;
}

function prettyOsName(): string | null {
  // Linux: /etc/os-release has PRETTY_NAME="..."
  if (process.platform === 'linux') {
    try {
      if (existsSync('/etc/os-release')) {
        const raw = readFileSync('/etc/os-release', 'utf8');
        const m = raw.match(/^PRETTY_NAME=("?)(.*)\1\s*$/m);
        if (m) return m[2];
      }
    } catch {
      /* */
    }
    return null;
  }
  // macOS: `sw_vers -productName` + `-productVersion`. Cheap.
  if (process.platform === 'darwin') {
    try {
      // Avoid spawn-per-request cost — cache the result; OS version doesn't
      // change while berth is running.
      if (cachedMacOsName != null) return cachedMacOsName;
      const name = execSync('sw_vers -productName', { encoding: 'utf8', timeout: 800 }).trim();
      const ver = execSync('sw_vers -productVersion', { encoding: 'utf8', timeout: 800 }).trim();
      cachedMacOsName = `${name} ${ver}`;
      return cachedMacOsName;
    } catch {
      /* */
    }
    return null;
  }
  return null;
}

let cachedMacOsName: string | null = null;
