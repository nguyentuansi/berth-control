#!/usr/bin/env node
// Build the in-tree berth_temp N-API addon during install.
//
// Skips cleanly on:
//   - non-darwin platforms (binding.gyp emits type=none there, but we can
//     skip the node-gyp spawn entirely)
//   - CI environments that explicitly set BERTH_CONTROL_SKIP_NATIVE=1
//   - environments missing Xcode Command Line Tools (we emit a one-line
//     hint instead of an opaque gyp error)
//
// On failure we DO NOT exit non-zero — berth-control is fully functional
// without temperature reading, and a missing native addon should not
// block install of the rest of the app.

import { spawnSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = resolve(repoRoot, 'native');

function log(msg) {
  process.stdout.write(`[build-native] ${msg}\n`);
}

if (process.platform !== 'darwin') {
  log(`skipping — native temperature module is macOS-only (platform=${process.platform})`);
  process.exit(0);
}

if (process.env.BERTH_CONTROL_SKIP_NATIVE === '1') {
  log('skipping — BERTH_CONTROL_SKIP_NATIVE=1');
  process.exit(0);
}

// Probe for Xcode Command Line Tools — node-gyp needs them.
try {
  execSync('xcode-select -p', { stdio: 'ignore' });
} catch {
  log('skipping — Xcode Command Line Tools not installed (run `xcode-select --install`)');
  log('         temperature reading will be unavailable until you reinstall after that');
  process.exit(0);
}

// node-gyp lives under devDependencies; locate its bin.
const gypBin = resolve(repoRoot, 'node_modules/.bin/node-gyp');
if (!existsSync(gypBin)) {
  log(`skipping — ${gypBin} not found (devDependencies not installed yet?)`);
  process.exit(0);
}

if (!existsSync(resolve(nativeDir, 'binding.gyp'))) {
  log(`skipping — no binding.gyp at ${nativeDir}`);
  process.exit(0);
}

log('building berth_temp.node …');
const result = spawnSync(gypBin, ['rebuild'], {
  cwd: nativeDir,
  stdio: 'inherit'
});

if (result.status !== 0) {
  log('build failed — temperature reading will be unavailable.');
  log('berth-control will still run; everything else works.');
  // Intentionally exit 0 so install completes.
  process.exit(0);
}

log('build ok — berth_temp.node ready');
