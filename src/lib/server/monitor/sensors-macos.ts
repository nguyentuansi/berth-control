import { emptySample, type HostSample, type SensorModule } from './sensors-shared.js';

// macOS host monitoring. Phase A stub — every metric returns null so berth
// boots cleanly on macOS without errors. Phase B fills in `top`, `vm_stat`,
// `iostat`, `netstat -ib`, `sysctl`, and (sudo-gated) `powermetrics`.
//
// Keeping this as a real module (instead of just throwing platform-not-
// supported) means the rest of the pipeline — collector tick, SSE feed,
// charts, alert evaluation — exercises end-to-end on the mac during phase
// A development; only the chart lines are flat lines of nulls until B.

async function init(): Promise<{ availability: Record<string, boolean>; notes: string[] }> {
  return {
    availability: {},
    notes: ['macOS sensor module is a stub in phase A; phase B fills the real metrics.']
  };
}

async function sample(): Promise<HostSample> {
  return emptySample();
}

export const macosSensors: SensorModule = {
  init,
  sample
};
