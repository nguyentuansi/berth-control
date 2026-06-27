import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];

const TAILNET_WILDCARD = "'.ts.net'";
const COMMENT_MARK = '/* berth-control: tailnet access */';

export interface PatchResult {
  patched: boolean;
  configPath: string | null;
  reason?:
    | 'no-config'
    | 'already-allowed'
    | 'patched-existing-array'
    | 'patched-added-key'
    | 'unparseable';
}

export interface PatchPreview {
  needsPatch: boolean;
  configPath: string | null;
  reason: PatchResult['reason'];
  /** The line that would change, as it is now (null if we'd insert a fresh line). */
  beforeLine: string | null;
  /** What the line would look like after patching (null if we can't patch). */
  afterLine: string | null;
  /** The full file content after patching, for clients that want to render a full diff. */
  afterFull: string | null;
  /** Suggested manual snippet the user can copy in if they prefer to edit themselves. */
  manualSnippet: string;
}

// Idempotent: ensures vite's server.allowedHosts contains '.ts.net' (vite's
// leading-dot wildcard for subdomain matches), so any tailnet hostname is
// accepted without ever hardcoding a machine name. Marks the patched line
// with a comment so it's self-documenting in a git diff.
//
// Three coverage layers ensure we never insert a duplicate `allowedHosts:` key:
//   1. The array already contains '.ts.net' → no-op.
//   2. `allowedHosts: true` (or `'all'`) already allows every host → no-op.
//   3. ANY other recognized `allowedHosts:` form we can patch in place.
//   4. Only if NO `allowedHosts:` key exists at all do we insert a new line.
export async function ensureTailnetAllowedHosts(projectPath: string): Promise<PatchResult> {
  let configPath: string | null = null;
  for (const name of CONFIG_NAMES) {
    const candidate = resolve(projectPath, name);
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }
  if (!configPath) return { patched: false, configPath: null, reason: 'no-config' };

  const src = readFileSync(configPath, 'utf8');

  if (alreadyHasTailnetWildcard(src) || allowsAllHosts(src)) {
    return { patched: false, configPath, reason: 'already-allowed' };
  }

  const arrayPatch = patchExistingArray(src);
  if (arrayPatch) {
    writeFileSync(configPath, arrayPatch, 'utf8');
    return { patched: true, configPath, reason: 'patched-existing-array' };
  }

  // Bail BEFORE inserting a new line if there's already an allowedHosts key
  // we don't know how to patch (e.g. a function call, a spread, a reference
  // to a variable). Inserting now would create a duplicate object key — the
  // exact bug this branch guards against.
  if (hasAnyAllowedHostsKey(src)) {
    return { patched: false, configPath, reason: 'unparseable' };
  }

  const insertPatch = insertAllowedHostsIntoServerBlock(src);
  if (insertPatch) {
    writeFileSync(configPath, insertPatch, 'utf8');
    return { patched: true, configPath, reason: 'patched-added-key' };
  }

  return { patched: false, configPath, reason: 'unparseable' };
}

const ALLOWED_HOSTS_RE = new RegExp('(allowedHosts\\s*:\\s*\\[)([^\\]]*)(\\])');
const ANY_ALLOWED_HOSTS_RE = /\ballowedHosts\s*:/;
const ALLOW_ALL_RE = /\ballowedHosts\s*:\s*(true|['"]all['"])\b/;
const TAILNET_PRESENT_RE = new RegExp('[\'\"]\\.ts\\.net[\'\"]');

function alreadyHasTailnetWildcard(src: string): boolean {
  const m = src.match(ALLOWED_HOSTS_RE);
  if (!m) return false;
  return TAILNET_PRESENT_RE.test(m[2]);
}

// `allowedHosts: true` (or `'all'`) means vite accepts every Host header —
// every tailnet hostname is already allowed, no patch needed.
function allowsAllHosts(src: string): boolean {
  return ALLOW_ALL_RE.test(src);
}

// Any form of an `allowedHosts:` key, recognized or not. Used to bail
// before inserting a fresh line if a duplicate would result.
function hasAnyAllowedHostsKey(src: string): boolean {
  return ANY_ALLOWED_HOSTS_RE.test(src);
}

function patchExistingArray(src: string): string | null {
  const m = src.match(ALLOWED_HOSTS_RE);
  if (!m) return null;
  const whole = m[0];
  const open = m[1];
  const body = m[2];
  const close = m[3];
  const trimmed = body.trim();
  const head = TAILNET_WILDCARD + ' ' + COMMENT_MARK;
  const insertion = trimmed.length > 0 ? head + ', ' + trimmed : head;
  return src.replace(whole, open + insertion + close);
}

// server: { becomes server: {\n  allowedHosts: ['.ts.net' /berth-marker/],
// Dry-run: tell the caller whether a patch is needed and what it would look
// like, without writing to disk. The UI calls this before showing the modal.
export async function previewTailnetPatch(projectPath: string): Promise<PatchPreview> {
  const MANUAL = "allowedHosts: ['.ts.net'] // matches any tailnet hostname";
  let configPath: string | null = null;
  for (const name of CONFIG_NAMES) {
    const candidate = resolve(projectPath, name);
    if (existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }
  if (!configPath) {
    return {
      needsPatch: false,
      configPath: null,
      reason: 'no-config',
      beforeLine: null,
      afterLine: null,
      afterFull: null,
      manualSnippet: MANUAL
    };
  }
  const src = readFileSync(configPath, 'utf8');
  if (alreadyHasTailnetWildcard(src) || allowsAllHosts(src)) {
    return {
      needsPatch: false,
      configPath,
      reason: 'already-allowed',
      beforeLine: null,
      afterLine: null,
      afterFull: null,
      manualSnippet: MANUAL
    };
  }
  const arrayPatched = patchExistingArray(src);
  if (arrayPatched) {
    return {
      needsPatch: true,
      configPath,
      reason: 'patched-existing-array',
      beforeLine: extractLineMatching(src, /allowedHosts/),
      afterLine: extractLineMatching(arrayPatched, /allowedHosts/),
      afterFull: arrayPatched,
      manualSnippet: MANUAL
    };
  }
  // Same guard as ensureTailnetAllowedHosts — never preview a duplicate-key
  // insert; if there's already an allowedHosts key in an unrecognized shape,
  // tell the caller a patch isn't safe.
  if (hasAnyAllowedHostsKey(src)) {
    return {
      needsPatch: false,
      configPath,
      reason: 'unparseable',
      beforeLine: extractLineMatching(src, /allowedHosts/),
      afterLine: null,
      afterFull: null,
      manualSnippet: MANUAL
    };
  }
  const inserted = insertAllowedHostsIntoServerBlock(src);
  if (inserted) {
    return {
      needsPatch: true,
      configPath,
      reason: 'patched-added-key',
      beforeLine: null,
      afterLine: extractLineMatching(inserted, /allowedHosts/),
      afterFull: inserted,
      manualSnippet: MANUAL
    };
  }
  return {
    needsPatch: false,
    configPath,
    reason: 'unparseable',
    beforeLine: null,
    afterLine: null,
    afterFull: null,
    manualSnippet: MANUAL
  };
}

function extractLineMatching(src: string, re: RegExp): string | null {
  const lines = src.split('\n');
  for (const l of lines) if (re.test(l)) return l;
  return null;
}

function insertAllowedHostsIntoServerBlock(src: string): string | null {
  // Look for `server: {` (with optional whitespace). We pick the first one,
  // since vite configs only have one server block.
  const re = /(server\s*:\s*\{)/;
  const m = src.match(re);
  if (!m) return null;
  const opening = m[0];
  // Determine the indentation of the line that contains `server: {` so the
  // inserted line lines up with sibling keys (best-effort).
  const idx = src.indexOf(opening);
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const lineIndent = src.slice(lineStart, idx);
  const childIndent = lineIndent + '  '; // two-space nesting is the default in vite configs
  const insertion = `${opening}\n${childIndent}allowedHosts: [${TAILNET_WILDCARD} ${COMMENT_MARK}],`;
  return src.replace(opening, insertion);
}
