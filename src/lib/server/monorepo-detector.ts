// Recovered from build/server/chunks/monorepo-detector-BqhBfzYo.js (the
// last successful build before this file was lost from the working tree).
//
// Inspect a directory and detect whether it's a monorepo with sub-apps
// — supports pnpm-workspace.yaml, package.json `workspaces`, Cargo
// workspaces, and the plain `apps/* | services/* | packages/*`
// convention as a fallback. Returns the detected sub-apps with their
// suggested start command.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { suggestStartCmd } from './start-cmd-suggester.js';

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

export interface Subapp {
  path: string;
  name: string;
  kind: string;
  start_cmd: string | null;
  start_cmd_reason: string | null;
  has_dev_script: boolean;
}

export interface InspectResult {
  isMonorepo: boolean;
  tool: 'pnpm' | 'bun' | 'yarn' | 'npm' | 'cargo' | 'plain' | null;
  patterns: string[];
  subapps: Subapp[];
}

function readJson(path: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expandPattern(root: string, pattern: string): string[] {
  const norm = pattern.replace(/\/+$/, '').replace(/\\/g, '/');
  if (!norm) return [];
  if (!norm.includes('*')) {
    const abs = resolve(root, norm);
    if (existsSync(abs) && safeIsDir(abs)) return [abs];
    return [];
  }
  const m = norm.match(/^(.*?)\/\*$/);
  if (!m) return [];
  const parentDir = resolve(root, m[1]);
  if (!existsSync(parentDir) || !safeIsDir(parentDir)) return [];
  try {
    return readdirSync(parentDir)
      .filter((n) => !n.startsWith('.'))
      .map((n) => resolve(parentDir, n))
      .filter(safeIsDir);
  } catch {
    return [];
  }
}

function parsePnpmWorkspace(yamlPath: string): string[] {
  try {
    const raw = readFileSync(yamlPath, 'utf8');
    const lines = raw.split('\n');
    const out: string[] = [];
    let inPackages = false;
    for (const line of lines) {
      if (/^packages\s*:/i.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = line.match(/^\s*-\s*["']?([^"'\s#]+)["']?/);
        if (m) out.push(m[1]);
        else if (line.trim() && !/^\s/.test(line)) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseCargoWorkspace(tomlPath: string): string[] {
  try {
    const raw = readFileSync(tomlPath, 'utf8');
    const m = raw.match(/\[workspace\]([\s\S]*?)(?=\n\[|$)/);
    if (!m) return [];
    const sect = m[1];
    const mem = sect.match(/members\s*=\s*\[([^\]]+)\]/);
    if (!mem) return [];
    const out: string[] = [];
    for (const part of mem[1].split(',')) {
      const t = part.trim().replace(/^["']|["']$/g, '');
      if (t) out.push(t);
    }
    return out;
  } catch {
    return [];
  }
}

function devScripts(pkg: PackageJson | null): string[] {
  if (!pkg || typeof pkg !== 'object') return [];
  const scripts = pkg.scripts;
  if (!scripts) return [];
  return Object.keys(scripts).filter((k) => /^(dev|start|serve|preview|watch)$/i.test(k));
}

function sniffKind(path: string): string {
  if (existsSync(resolve(path, 'wrangler.toml')) || existsSync(resolve(path, 'wrangler.jsonc'))) {
    return 'wrangler';
  }
  if (existsSync(resolve(path, 'vite.config.ts')) || existsSync(resolve(path, 'vite.config.js'))) {
    return 'vite';
  }
  if (existsSync(resolve(path, 'bun.lock')) || existsSync(resolve(path, 'bunfig.toml'))) {
    return 'bun';
  }
  if (existsSync(resolve(path, 'Cargo.toml'))) return 'cargo';
  if (existsSync(resolve(path, 'gradlew')) || existsSync(resolve(path, 'build.gradle'))) {
    return 'gradle';
  }
  if (existsSync(resolve(path, 'pom.xml'))) return 'java';
  if (existsSync(resolve(path, 'docker-compose.yml')) || existsSync(resolve(path, 'Dockerfile'))) {
    return 'docker';
  }
  if (existsSync(resolve(path, 'pyproject.toml')) || existsSync(resolve(path, 'requirements.txt'))) {
    return 'python';
  }
  if (existsSync(resolve(path, 'package.json'))) return 'node';
  return 'shell';
}

function buildSubapp(path: string, tool: string): Subapp | null {
  let name = basename(path);
  let hasDev = true;
  const kind = sniffKind(path);
  if (tool === 'cargo') {
    if (!existsSync(resolve(path, 'Cargo.toml'))) return null;
  } else {
    const pkgPath = resolve(path, 'package.json');
    const pkg = readJson(pkgPath);
    if (!pkg) return null;
    const pkgName = pkg.name;
    if (pkgName) name = pkgName.replace(/^@[^/]+\//, '');
    const dev = devScripts(pkg);
    hasDev = dev.length > 0;
    if (!hasDev) return null;
  }
  const cmd = suggestStartCmd(path, null, kind);
  return {
    path,
    name,
    kind,
    start_cmd: cmd?.cmd ?? null,
    start_cmd_reason: cmd?.reason ?? null,
    has_dev_script: hasDev
  };
}

export function inspectPath(root: string): InspectResult {
  if (!existsSync(root) || !safeIsDir(root)) {
    return { isMonorepo: false, tool: null, patterns: [], subapps: [] };
  }
  let tool: InspectResult['tool'] = null;
  let patterns: string[] = [];

  const pnpmPath = resolve(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmPath)) {
    tool = 'pnpm';
    patterns = parsePnpmWorkspace(pnpmPath);
  }
  if (!tool) {
    const pkgPath = resolve(root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg?.workspaces) {
        const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? [];
        if (list.length > 0) {
          patterns = list;
          if (existsSync(resolve(root, 'bun.lock'))) tool = 'bun';
          else if (existsSync(resolve(root, 'yarn.lock'))) tool = 'yarn';
          else tool = 'npm';
        }
      }
    }
  }
  if (!tool) {
    const cargoPath = resolve(root, 'Cargo.toml');
    if (existsSync(cargoPath)) {
      const mems = parseCargoWorkspace(cargoPath);
      if (mems.length > 0) {
        tool = 'cargo';
        patterns = mems;
      }
    }
  }
  if (!tool) {
    for (const conv of ['apps', 'services', 'packages']) {
      const convPath = resolve(root, conv);
      if (!safeIsDir(convPath)) continue;
      try {
        const kids = readdirSync(convPath)
          .filter((n) => !n.startsWith('.'))
          .map((n) => resolve(convPath, n))
          .filter(safeIsDir)
          .filter(
            (p) => existsSync(resolve(p, 'package.json')) || existsSync(resolve(p, 'Cargo.toml'))
          );
        if (kids.length >= 2) {
          tool = 'plain';
          patterns = [`${conv}/*`];
          break;
        }
      } catch {
        /* skip */
      }
    }
  }
  if (!tool || patterns.length === 0) {
    return { isMonorepo: false, tool: null, patterns: [], subapps: [] };
  }
  const seen = new Set<string>();
  const subapps: Subapp[] = [];
  for (const pat of patterns) {
    for (const memberPath of expandPattern(root, pat)) {
      if (seen.has(memberPath)) continue;
      seen.add(memberPath);
      const s = buildSubapp(memberPath, tool);
      if (s) subapps.push(s);
    }
  }
  subapps.sort((a, b) => a.name.localeCompare(b.name));
  return {
    isMonorepo: subapps.length > 0,
    tool,
    patterns,
    subapps
  };
}
