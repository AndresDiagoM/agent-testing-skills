#!/usr/bin/env node
// @ts-check
// e2e-changed.mjs: runs only the e2e specs touched by the current change, a few times each, to catch flakes before reporting.
// The mapping table (changed file -> specs) lives in e2e-changed.map.json. A changed app file that matches no row is NOT ignored:
// the whole suite runs and the reason is printed (a "nothing affected, exit 0" for a real source change would be a silent pass).
// Plain ESM, Node 20+, no dependencies, no network.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PORT, checkBuildFreshness, detectPackageManager, expandCommand, formatDuration, loadConfig, pickFreePort, runCommand } from './gate-lib.mjs';

export const VERSION = '0.2.0';
export const ALL = 'ALL';

export const USAGE = `e2e-changed.mjs ${VERSION}: run only the e2e specs affected by the current change, repeated.

Usage: node e2e-changed.mjs [--base <ref>] [--repeat <n>] [--map <file>] [--root <dir>] [--dry-run] [--dev] [--help]

  --base <ref>   compare with the merge-base of HEAD and <ref> (default: guard.baseBranch of kit.config.json, else main/master);
                 committed, uncommitted and untracked files all count
  --repeat <n>   times each spec runs, one after another (default: map "repeat", else 3). Exported as the env var named by the map
                 "repeatEnv" (default E2E_REPEAT); the Playwright config applies it to the project that holds the specs, NOT to
                 the setup project (so --repeat-each is not used: it would repeat the login setup too)
  --map <file>   mapping table (default: kit.config.json e2eChanged.map, else e2e-changed.map.json at the repo root)
  --dry-run      print the mapping and the command, run nothing
  --dev          do not export E2E_USE_BUILD even when a build exists

Map file (JSON): specDir, specPattern (regex string), routes [{ pattern (regex string), specs: [names] | "ALL" }], shared (regex:
changes to it select the whole suite), noEffect (regex: never selects anything), fullSuiteFallback (regex: an app file no route
claims selects the whole suite), command (with <pm> and {specs}), repeat, repeatEnv.
Exports PORT (first free port from kit.config.json e2e.portStart, default ${DEFAULT_PORT}), E2E_USE_BUILD=1 when e2e.buildIdFile exists,
and E2E_SERVER_COMMAND when e2e.serverCommand is set. Exit codes: 0 pass or nothing to run, 1 failing run, 2 usage or config error.`;

/**
 * @typedef {{ specDir?: string, specPattern?: string, routes?: Array<{ pattern: string, specs: string[] | 'ALL' }>, shared?: string,
 *   noEffect?: string, fullSuiteFallback?: string, command?: string, repeat?: number, repeatEnv?: string }} ChangedMap
 * @typedef {{ specs: string[], unmapped: string[], all: boolean, allReasons: string[] }} Selection
 */

/** @type {Required<Pick<ChangedMap, 'specDir' | 'specPattern' | 'command' | 'repeat' | 'repeatEnv'>>} */
export const DEFAULTS = {
  specDir: 'e2e',
  specPattern: '\\.spec\\.[cm]?[jt]sx?$',
  command: '<pm> exec playwright test --workers=1 {specs}',
  repeat: 3,
  repeatEnv: 'E2E_REPEAT',
};

/** @param {string} p */
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Maps changed files to specs. Pure.
 * @param {string[]} changed repo-relative changed files
 * @param {string[]} allSpecs every spec, relative to specDir (posix)
 * @param {ChangedMap} map
 * @returns {Selection}
 */
export function mapChangedToSpecs(changed, allSpecs, map) {
  const specDir = norm(map.specDir ?? DEFAULTS.specDir).replace(/\/+$/, '');
  const specRe = new RegExp(map.specPattern ?? DEFAULTS.specPattern);
  const sharedRe = map.shared ? new RegExp(map.shared) : new RegExp(`^${specDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(?!\\.auth/)(?!.*${(map.specPattern ?? DEFAULTS.specPattern).replace(/\$$/, '')}$).+|(^|/)playwright\\.config\\.[^/]+$`);
  const noEffectRe = map.noEffect ? new RegExp(map.noEffect) : /\.(test|unit)\.[cm]?[jt]sx?$|\/__tests__\/|\.md$/;
  const fallbackRe = map.fullSuiteFallback ? new RegExp(map.fullSuiteFallback) : null;
  const routes = (map.routes ?? []).map((r) => ({ re: new RegExp(r.pattern), specs: r.specs }));
  const exists = new Set(allSpecs);
  const picked = new Set();
  /** @type {string[]} */ const unmapped = [];
  /** @type {string[]} */ const shared = [];
  /** @type {string[]} */ const sharedApp = [];
  /** @type {string[]} */ const unknownApp = [];
  for (const raw of changed) {
    const file = norm(raw);
    if (file.startsWith(`${specDir}/`) && specRe.test(file)) {
      picked.add(file.slice(specDir.length + 1));
      continue;
    }
    if (sharedRe.test(file)) {
      shared.push(file);
      continue;
    }
    if (noEffectRe.test(file)) {
      unmapped.push(file);
      continue;
    }
    const row = routes.find((r) => r.re.test(file));
    if (row) {
      if (row.specs === ALL) sharedApp.push(file);
      else for (const s of row.specs) picked.add(s);
    } else if (fallbackRe?.test(file)) unknownApp.push(file);
    else unmapped.push(file);
  }
  /** @param {string[]} files */
  const list = (files) => `${files.slice(0, 6).join(', ')}${files.length > 6 ? `, ... (+${files.length - 6})` : ''}`;
  /** @type {string[]} */
  const allReasons = [];
  if (shared.length) allReasons.push(`shared e2e infrastructure changed: ${list(shared)}`);
  if (sharedApp.length) allReasons.push(`code shared by every screen changed: ${list(sharedApp)}`);
  if (unknownApp.length) allReasons.push(`no spec is mapped to these app files, so nothing can be ruled out: ${list(unknownApp)}`);
  const all = allReasons.length > 0;
  const specs = (all ? [...exists] : [...picked]).filter((s) => exists.has(s)).sort();
  return { specs, unmapped, all, allReasons };
}

/** Shell-safe enough for file names: quoted when it holds anything but word characters and ./-. @param {string} s */
const q = (s) => (/^[\w./@-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/**
 * @param {string} template command with <pm> and {specs} @param {string} pm @param {string} specDir @param {string[]} specs
 */
export function buildCommand(template, pm, specDir, specs) {
  const dir = norm(specDir).replace(/\/+$/, '');
  return expandCommand(pm, template).replace('{specs}', specs.map((s) => q(`${dir}/${s}`)).join(' '));
}

/** @param {string} dir @param {RegExp} re @param {string} base @param {string[]} out */
function walk(dir, re, base, out) {
  /** @type {import('node:fs').Dirent[]} */
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(join(dir, e.name), re, rel, out);
    else if (re.test(rel)) out.push(rel);
  }
}

/** @param {string} root @param {string} base @returns {string[]} */
function changedFiles(root, base) {
  const run = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const lines = (/** @type {string} */ s) => s.split(/\r?\n/).filter(Boolean);
  let from = base;
  try {
    from = run(['merge-base', base, 'HEAD']).trim();
  } catch {
    /* not an ancestor reference: diff against it directly */
  }
  // `git diff <commit>` compares that commit with the working tree: committed and uncommitted edits.
  return [...new Set([...lines(run(['diff', '--name-only', '--diff-filter=d', from, '--'])), ...lines(run(['ls-files', '--others', '--exclude-standard']))])];
}

/** @param {string} root @param {string} ref */
const refExists = (root, ref) => {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** @param {string[]} argv */
export function parseArgs(argv) {
  const o = { base: /** @type {string | undefined} */ (undefined), repeat: /** @type {number | undefined} */ (undefined), map: /** @type {string | undefined} */ (undefined), root: process.cwd(), dryRun: false, dev: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--dev') o.dev = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--base') o.base = next();
    else if (a === '--map') o.map = next();
    else if (a === '--root') o.root = resolve(next());
    else if (a === '--repeat') {
      const n = Number(next());
      if (!Number.isInteger(n) || n < 1) throw new Error('--repeat needs an integer >= 1');
      o.repeat = n;
    } else throw new Error(`unknown argument "${a}" (see --help)`);
  }
  return o;
}

async function main() {
  /** @type {ReturnType<typeof parseArgs>} */
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`e2e-changed: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const root = o.root;
  try {
    const { config } = loadConfig(root);
    const mapFile = resolve(root, o.map ?? config.e2eChanged?.map ?? 'e2e-changed.map.json');
    if (!existsSync(mapFile)) throw new Error(`mapping table not found: ${mapFile} (copy e2e-changed.map.json from the kit and edit it)`);
    /** @type {ChangedMap} */
    const map = JSON.parse(readFileSync(mapFile, 'utf8'));
    const pkg = existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : {};
    const pm = detectPackageManager(root, pkg, config.packageManager).name;
    const specDir = map.specDir ?? DEFAULTS.specDir;
    const repeat = o.repeat ?? map.repeat ?? DEFAULTS.repeat;
    const base = o.base ?? [config.guard?.baseBranch, 'main', 'master'].filter(Boolean).find((r) => refExists(root, r) || refExists(root, `origin/${r}`)) ?? 'HEAD';
    const baseRef = refExists(root, base) ? base : refExists(root, `origin/${base}`) ? `origin/${base}` : 'HEAD';
    const changed = changedFiles(root, baseRef);
    /** @type {string[]} */
    const allSpecs = [];
    walk(resolve(root, specDir), new RegExp(map.specPattern ?? DEFAULTS.specPattern), '', allSpecs);
    const sel = mapChangedToSpecs(changed, allSpecs, map);

    console.log(`e2e-changed: ${changed.length} changed file(s) vs ${baseRef}`);
    if (sel.all) console.log(`e2e-changed: running the FULL suite. Why:\n  - ${sel.allReasons.join('\n  - ')}`);
    if (sel.unmapped.length) console.log(`e2e-changed: ${sel.unmapped.length} file(s) cannot affect a browser run, ignored: ${sel.unmapped.slice(0, 8).join(', ')}${sel.unmapped.length > 8 ? ', ...' : ''}`);
    if (sel.specs.length === 0) {
      console.log('e2e-changed: no e2e spec affected, nothing to run.');
      return 0;
    }
    const command = buildCommand(map.command ?? DEFAULTS.command, pm, specDir, sel.specs);
    const repeatEnv = map.repeatEnv ?? DEFAULTS.repeatEnv;
    console.log(`e2e-changed: specs -> ${sel.specs.join(', ')}\ne2e-changed: ${command}  (${repeatEnv}=${repeat})`);
    if (o.dryRun) return 0;

    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, [repeatEnv]: String(repeat) };
    delete env.PLAYWRIGHT_BASE_URL;
    const e2e = config.e2e ?? {};
    if (!o.dev && e2e.buildIdFile && existsSync(resolve(root, e2e.buildIdFile))) {
      const fresh = e2e.sourceDirs ? checkBuildFreshness({ root, buildIdFile: e2e.buildIdFile, sourceDirs: e2e.sourceDirs }) : null;
      if (fresh && fresh.freshness.status === 'stale') console.warn(`e2e-changed: WARNING the production build is older than ${fresh.freshness.newer.file}; rebuild first or the specs test stale code.`);
      env.E2E_USE_BUILD = '1';
    } else console.log('e2e-changed: no production build (or --dev): E2E_USE_BUILD is not set.');
    if (typeof e2e.serverCommand === 'string') env.E2E_SERVER_COMMAND = expandCommand(pm, e2e.serverCommand);
    const port = await pickFreePort(Number(e2e.portStart) || DEFAULT_PORT);
    env.PORT = String(port);
    console.log(`e2e-changed: server on port ${port}`);
    const timeoutMs = 15 * 60_000;
    const run = await runCommand(command, { cwd: root, env, timeoutMs });
    if (run.timedOut) console.error(`e2e-changed: exceeded ${formatDuration(timeoutMs)} and was killed.`);
    console.log(`e2e-changed: finished in ${formatDuration(run.wallMs)} (exit ${run.exitCode})`);
    return run.exitCode === 0 && !run.timedOut ? 0 : 1;
  } catch (err) {
    console.error(`e2e-changed: ${/** @type {Error} */ (err).message}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then((c) => { process.exitCode = c; });
