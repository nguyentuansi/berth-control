// TypeScript wrapper for the in-tree berth_temp N-API addon.
//
// The C source lives under `native/src/` and the compiled .node file
// under `native/build/Release/`. We deliberately keep the native module
// in a separate top-level directory from SvelteKit's `build/` to avoid
// node-gyp wiping the adapter-node output.
//
// The addon exposes the raw IOHIDEventSystem sensor list — this module
// groups it into the cpu/gpu/soc readings the host monitor consumes,
// applying the same prefix matching the upstream JS wrapper used:
//
//   "PMU tdie*"           → CPU die temps  (max → cpu)
//   "PMU tdev*"           → GPU die temps  (max → gpu)
//   "PMU tp*g"            → SoC probe-group temps (combined w/ tdie for soc avg)
//
// Loading is best-effort. The .node file is platform-specific (macOS arm64
// only) and may be missing if the postinstall build skipped. Callers must
// check `available` before reading.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

interface RawSensor {
  name: string;
  tempC: number;
}

interface RawSnapshot {
  pCoreAvgC: number;
  eCoreAvgC: number;
  sensors: RawSensor[];
}

interface NativeBinding {
  snapshot(): RawSnapshot;
  listSensors(): RawSensor[];
}

export interface TemperatureReading {
  /** Hottest CPU die in °C, or null if no CPU sensor reported. */
  cpu: number | null;
  /** SoC-wide average across CPU dies + probe groups, or null. */
  soc: number | null;
  /** Hottest GPU die in °C, or null. */
  gpu: number | null;
  /** Raw per-die CPU temps (one per pACC/eACC cluster). */
  cpuDieTemps: number[];
  /** Raw probe-group temps. */
  probeGroupsTemps: number[];
  /** Raw per-die GPU temps. */
  gpuDieTemps: number[];
}

function loadBinding(): NativeBinding | null {
  // The binding.gyp emits `type: none` on every non-darwin OS, so no
  // .node file exists there — skip the lookup entirely.
  if (process.platform !== 'darwin') return null;

  // Candidate locations to search for the .node file, in order:
  //  1. Explicit env override for unusual installs (containers / chroots).
  //  2. Repo-relative `native/build/Release/` when running from the repo
  //     root (dev server + most prod launches).
  //  3. A path relative to this module's compiled location — covers the
  //     adapter-node bundle case where cwd may differ from the repo.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.BERTH_CONTROL_NATIVE_DIR
      ? resolve(process.env.BERTH_CONTROL_NATIVE_DIR, 'berth_temp.node')
      : null,
    resolve(process.cwd(), 'native/build/Release/berth_temp.node'),
    resolve(here, '../../../../native/build/Release/berth_temp.node'),
    resolve(here, '../../../../../native/build/Release/berth_temp.node')
  ].filter((p): p is string => p != null);

  const path = candidates.find((p) => existsSync(p));
  if (!path) return null;

  try {
    const req = createRequire(import.meta.url);
    return req(path) as NativeBinding;
  } catch {
    return null;
  }
}

const binding = loadBinding();

export const available = binding != null;

function maxFinite(arr: number[]): number | null {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return Number.isFinite(m) ? m : null;
}

function avgFinite(arr: number[]): number | null {
  if (arr.length === 0) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

/** Read a current temperature snapshot. Returns null if the native module
 *  is not available on this platform or the IOHID read failed. The grouping
 *  here mirrors macos-temperature-sensor v1.0.4's prefix rules so future
 *  Apple Silicon revisions continue to map sensor names → readings. */
export function readTemperature(): TemperatureReading | null {
  if (!binding) return null;
  let raw: RawSnapshot;
  try {
    raw = binding.snapshot();
  } catch {
    return null;
  }

  const cpuDieTemps: number[] = [];
  const probeGroupsTemps: number[] = [];
  const gpuDieTemps: number[] = [];

  for (const s of raw.sensors) {
    const n = s.name.toLowerCase();
    if (n.startsWith('pmu tdie')) cpuDieTemps.push(s.tempC);
    else if (n.startsWith('pmu tp') && n.endsWith('g')) probeGroupsTemps.push(s.tempC);
    else if (n.startsWith('pmu tdev')) gpuDieTemps.push(s.tempC);
  }

  return {
    cpu: maxFinite(cpuDieTemps),
    soc: avgFinite([...cpuDieTemps, ...probeGroupsTemps]),
    gpu: maxFinite(gpuDieTemps),
    cpuDieTemps,
    probeGroupsTemps,
    gpuDieTemps
  };
}

/** Debug helper — full per-sensor list. */
export function listSensors(): RawSensor[] {
  if (!binding) return [];
  try {
    return binding.listSensors();
  } catch {
    return [];
  }
}
