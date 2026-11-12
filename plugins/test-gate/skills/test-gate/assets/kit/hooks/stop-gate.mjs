#!/usr/bin/env node
// @ts-check
// stop-gate.mjs: Claude Code Stop hook. A fast quality gate that runs before the agent is allowed to stop:
//   1. e2e-guard (diff mode) on changed test files, 2. lint of the changed files, 3. typecheck of the affected packages,
//   4. related unit tests. Commands come from kit.config.json "stopGate"; nothing is hard-coded to one toolchain.
// Exit 2 = block the stop and show stderr to the agent; exit 0 = let it stop (also on timeout and on infrastructure errors).
// Budget 90 s (stopGate.budgetMs or STOP_GATE_BUDGET_MS). STOP_GATE=off disables it. Never runs e2e, build or db tests.
// Claude Code only. Plain ESM, Node 20+, no dependencies, self-contained (no imports from the other kit scripts).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BUDGET_MS = 90_000;
export const MAX_OUTPUT_LINES = 40;
const MAX_CMD_LEN = 6000; // cmd.exe caps a command line at 8191 chars

export const USAGE = `stop-gate.mjs: Claude Code Stop hook (fast gate before the agent stops).

Reads the hook JSON from stdin and kit.config.json "stopGate" from the repo root:
  { "budgetMs": 90000, "guard": true, "lintChanged": true, "typecheck": true, "relatedTests": true, "packages": ["apps/*"] }
Each of lintChanged, typecheck and relatedTests is true (default command for the detected package manager), false, or a command
string with <pm>, {files} and {pkg} placeholders. "guard" runs scripts/e2e-guard.mjs in diff mode when test files changed.
Exit 2 blocks the stop (stderr is shown to the agent), exit 0 lets it stop (also on timeout or infrastructure errors).
STOP_GATE=off disables it, STOP_GATE_BUDGET_MS overrides the budget, STOP_GATE_VERBOSE=1 prints the wall time.
Settings: add the snippet of hooks/settings.snippet.json to .claude/settings.json. Never runs e2e, build or db tests.`;

const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const PKG_CONFIG = /(^|\/)(package\.json|tsconfig[^/]*\.json|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s)$/;
// Directories that are never linted by this gate.
const NO_LINT = /^(\.agents|\.claude|\.git|docs|graphify-out|node_modules)\//;
// Files whose change is worth running e2e-guard for (a superset of what the guard checks; the guard decides).
const GUARDED = /(\.(spec|test|e2e|setup|teardown)\.[cm]?[jt]sx?$)|(^|\/)(supabase\/tests|e2e)\/|(^|\/)(playwright|vitest|jest)\.config\./;
const NO_RELATED = /(^|\/)(e2e|node_modules|\.next)\//;
const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check:types', 'tsc'];

/** @param {string} p */
const norm = (p) => p.replace(/\\/g, '/');
/** @param {string} p */
const ext = (p) => path.posix.extname(norm(p)).toLowerCase();

/** True when the file is (or may be) a test file that e2e-guard inspects. @param {string} file */
export function isGuardedTestFile(file) {
  return GUARDED.test(norm(file));
}

/** @param {string} file */
export function isCode(file) {
  return CODE_EXT.has(ext(file));
}

/** True when the file can affect lint, types or unit tests (not docs or assets). @param {string} file */
export function isRelevantChange(file) {
  const f = norm(file);
  return isCode(f) || PKG_CONFIG.test(f);
}

/**
 * Package dir (repo-relative posix, '' for the root) a file belongs to, from workspace globs such as `apps/*` or `packages/*`.
 * @param {string} file @param {string[]} globs
 */
export function packageOf(file, globs) {
  const f = norm(file);
  for (const g of globs) {
    const parts = norm(g).replace(/\/+$/, '').split('/');
    const segs = f.split('/');
    if (segs.length <= parts.length) continue;
    if (parts.every((p, i) => p === '*' || p === segs[i])) return segs.slice(0, parts.length).join('/');
  }
  return '';
}

/** @param {string[]} args @param {number} [maxLen] */
export function chunkArgs(args, maxLen = MAX_CMD_LEN) {
  /** @type {string[][]} */
  const chunks = [];
  /** @type {string[]} */
  let cur = [];
  let len = 0;
  for (const a of args) {
    const l = a.length + 3;
    if (cur.length && len + l > maxLen) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(a);
    len += l;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** @param {string} s */
export const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/** Exec prefix and run form for a package manager. @param {string} pm */
export function pmForms(pm) {
  const exec = pm === 'pnpm' ? 'pnpm exec' : pm === 'yarn' ? 'yarn exec' : pm === 'bun' ? 'bunx' : 'npm exec --';
  /** @param {string} script */
  const run = (script) => (pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`);
  return { exec, run };
}

/** `packageManager` field, else lockfile, else npm. @param {string} root @param {Record<string, any>} pkg */
export function detectPm(root, pkg) {
  const m = /^(npm|pnpm|yarn|bun)@/.exec(typeof pkg.packageManager === 'string' ? pkg.packageManager : '');
  if (m) return /** @type {string} */ (m[1]);
  for (const [file, name] of [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']]) {
    if (existsSync(path.join(root, /** @type {string} */ (file)))) return /** @type {string} */ (name);
  }
  return 'npm';
}

/** Replaces a leading `<pm> exec` and any other `<pm>` of a configured command. @param {string} pm @param {string} command */
export function expandPm(pm, command) {
  return command.replace(/^\s*<pm>\s+exec\b/, pmForms(pm).exec).replace(/<pm>/g, pm);
}

/** @param {string} file @returns {Record<string, any>} */
function readJson(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * @typedef {{ name: string, cmds: string[], cwd?: string, infraCodes?: number[] }} Task
 * @typedef {{ budgetMs?: number, guard?: boolean, lintChanged?: boolean | string, typecheck?: boolean | string, relatedTests?: boolean | string, packages?: string[] }} StopGateConfig
 */

/**
 * Pure planner: changed files (repo-relative) -> tasks, run in parallel from `cwd` (default the repo root).
 * @param {string[]} changed
 * @param {{ cfg?: StopGateConfig, pm?: string, exists?: (f: string) => boolean, root?: string, guardChanged?: string[] | null, guardBase?: string,
 *   pkgJson?: (dir: string) => Record<string, any> }} [ctx]
 * @returns {Task[]}
 */
export function planTasks(changed, ctx = {}) {
  const cfg = ctx.cfg ?? {};
  const pm = ctx.pm ?? 'npm';
  const exists = ctx.exists ?? (() => true);
  const pkgJson = ctx.pkgJson ?? (() => ({}));
  const { exec, run } = pmForms(pm);
  const globs = Array.isArray(cfg.packages) ? cfg.packages : [];
  const all = [...new Set(changed.map(norm))];
  const files = all.filter(isRelevantChange);
  /** @type {Task[]} */
  const tasks = [];

  // Weakened tests block the stop. Exit 1 = findings, exit 2 = the guard itself could not run (not a reason to block). It compares
  // the working tree with `guardBase`: HEAD, or the merge-base with the default branch when the branch is ahead of it, so a
  // weakened test committed earlier in the session is still caught.
  const guardFiles = ctx.guardChanged ? [...new Set(ctx.guardChanged.map(norm))] : all;
  if (cfg.guard !== false && guardFiles.some(isGuardedTestFile) && exists('scripts/e2e-guard.mjs')) {
    const base = ctx.guardBase && /^[\w./^~@{}-]+$/.test(ctx.guardBase) ? ctx.guardBase : 'HEAD';
    tasks.push({ name: 'e2e-guard', cmds: [`node scripts/e2e-guard.mjs --base ${base}`], infraCodes: [2] });
  }
  if (files.length === 0) return tasks;

  const rootPkg = pkgJson('');
  const hasDep = (/** @type {Record<string, any>} */ p, /** @type {string} */ name) => Boolean(p.dependencies?.[name] ?? p.devDependencies?.[name]);

  // 2. lint changed files
  const lintable = files.filter((f) => isCode(f) && !NO_LINT.test(f) && exists(f));
  if (cfg.lintChanged && lintable.length) {
    if (typeof cfg.lintChanged === 'string') {
      for (const c of chunkArgs(lintable.map(quote))) tasks.push({ name: 'lint', cmds: [expandPm(pm, cfg.lintChanged).replace('{files}', c.join(' ')).replace('{pkg}', '.')] });
    } else if (hasDep(rootPkg, 'eslint') || pkgDirsHave(files, globs, pkgJson, (p) => hasDep(p, 'eslint'))) {
      tasks.push({ name: 'lint', cmds: chunkArgs(lintable.map(quote)).map((c) => `${exec} eslint --no-warn-ignored ${c.join(' ')}`) });
    }
  }

  const pkgs = [...new Set(files.map((f) => packageOf(f, globs)))].sort();

  // 3. typecheck each affected package
  if (cfg.typecheck) {
    for (const pkg of pkgs) {
      const label = pkg || '.';
      if (typeof cfg.typecheck === 'string') {
        tasks.push({ name: `typecheck ${label}`, cmds: [expandPm(pm, cfg.typecheck).replace(/\{pkg\}/g, label).replace('{files}', '')] });
        continue;
      }
      const scripts = pkgJson(pkg).scripts ?? {};
      const name = TYPECHECK_SCRIPTS.find((s) => typeof scripts[s] === 'string');
      if (name) tasks.push({ name: `typecheck ${label}`, cmds: [run(name)], cwd: pkg });
    }
  }

  // 4. unit tests related to the changed files
  if (cfg.relatedTests) {
    for (const pkg of pkgs) {
      const testable = files.filter((f) => packageOf(f, globs) === pkg && isCode(f) && !/\.d\.ts$/.test(f) && !NO_RELATED.test(f) && exists(f));
      if (!testable.length) continue;
      const label = pkg || '.';
      if (typeof cfg.relatedTests === 'string') {
        for (const c of chunkArgs(testable.map(quote))) tasks.push({ name: `related tests ${label}`, cmds: [expandPm(pm, cfg.relatedTests).replace(/\{pkg\}/g, label).replace('{files}', c.join(' '))] });
        continue;
      }
      if (!hasDep(pkgJson(pkg), 'vitest') && !hasDep(rootPkg, 'vitest')) continue;
      const rel = testable.map((f) => quote(pkg ? f.slice(pkg.length + 1) : f));
      tasks.push({ name: `related tests ${label}`, cmds: chunkArgs(rel).map((c) => `${exec} vitest related --run --passWithNoTests ${c.join(' ')}`), cwd: pkg });
    }
  }
  return tasks;
}

/** @param {string[]} files @param {string[]} globs @param {(d: string) => Record<string, any>} pkgJson @param {(p: Record<string, any>) => boolean} test */
function pkgDirsHave(files, globs, pkgJson, test) {
  return [...new Set(files.map((f) => packageOf(f, globs)))].some((d) => test(pkgJson(d)));
}

/** @param {string} raw */
export function parseInput(raw) {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** @param {string} s */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** @param {string} text @param {number} [max] */
export function truncateOutput(text, max = MAX_OUTPUT_LINES) {
  const lines = stripAnsi(text).replace(/\r/g, '').split('\n');
  while (lines.length && /** @type {string} */ (lines[lines.length - 1]).trim() === '') lines.pop();
  if (lines.length <= max) return lines.join('\n');
  return [...lines.slice(0, max), `... (${lines.length - max} more lines, run the command locally for the full output)`].join('\n');
}

/** @param {number} startMs @param {number} totalMs @param {number} nowMs */
export function remainingBudget(startMs, totalMs, nowMs) {
  return Math.max(0, totalMs - (nowMs - startMs));
}

/** @param {Record<string, string | undefined>} [env] @param {number} [configured] */
export function parseBudget(env = process.env, configured) {
  const n = Number(env.STOP_GATE_BUDGET_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_BUDGET_MS;
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Base the guard compares against: the merge-base with the default branch when HEAD is ahead of it (commits made in this session
 * or earlier on the branch are checked too), else HEAD. Any failure falls back to HEAD.
 * @param {string} cwd @param {string} [baseBranch]
 */
export function guardBase(cwd, baseBranch) {
  try {
    const head = git(['rev-parse', 'HEAD'], cwd).trim();
    const refs = [...(baseBranch ? [`origin/${baseBranch}`, baseBranch] : []), 'origin/main', 'origin/master', 'main', 'master'];
    for (const ref of refs) {
      let mb;
      try {
        mb = git(['merge-base', 'HEAD', ref], cwd).trim();
      } catch {
        continue;
      }
      return mb && mb !== head ? mb : 'HEAD';
    }
  } catch {
    /* no HEAD */
  }
  return 'HEAD';
}

/** @param {string} cwd @param {string} [base] */
export function changedFiles(cwd, base = 'HEAD') {
  const out = [...git(['diff', '--name-only', base, '--'], cwd).split('\n'), ...git(['ls-files', '--others', '--exclude-standard'], cwd).split('\n')];
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

/** @param {import('node:child_process').ChildProcess} child */
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-/** @type {number} */ (child.pid), 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Runs one shell command; resolves { code, output, timedOut }. Only kills processes it started.
 * @param {string} cmd @param {string} cwd @param {number} deadline @param {Set<import('node:child_process').ChildProcess>} running
 * @returns {Promise<{ code: number | null, output: string, timedOut?: boolean, spawnError?: boolean }>}
 */
function runCmd(cmd, cwd, deadline, running) {
  return new Promise((resolve) => {
    const left = deadline - Date.now();
    if (left <= 0) return resolve({ code: null, output: '', timedOut: true });
    let out = '';
    let done = false;
    const child = spawn(cmd, { cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', CI: '1', STOP_GATE: 'off' } });
    running.add(child);
    /** @param {{ code: number | null, timedOut?: boolean, spawnError?: boolean }} r */
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running.delete(child);
      resolve({ output: out, ...r });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, timedOut: true });
    }, left);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (out += d));
    child.on('error', (e) => {
      out += String(e);
      finish({ code: 127, spawnError: true });
    });
    child.on('close', (code) => finish({ code }));
  });
}

/**
 * @param {Task} task @param {string} root @param {number} deadline @param {Set<import('node:child_process').ChildProcess>} running
 * @returns {Promise<{ name: string, status: 'ok' | 'fail' | 'timeout' | 'infra', output: string }>}
 */
export async function runTask(task, root, deadline, running) {
  let output = '';
  const cwd = task.cwd ? path.join(root, task.cwd) : root;
  for (const cmd of task.cmds) {
    const r = await runCmd(cmd, cwd, deadline, running);
    output += r.output;
    if (r.timedOut) return { name: task.name, status: 'timeout', output };
    if (r.spawnError || (task.infraCodes && task.infraCodes.includes(/** @type {number} */ (r.code)))) return { name: task.name, status: 'infra', output };
    if (r.code !== 0) return { name: task.name, status: 'fail', output };
  }
  return { name: task.name, status: 'ok', output };
}

/**
 * @param {string} rawInput hook JSON from stdin
 * @param {Record<string, string | undefined>} [env]
 * @param {{ write?: (s: string) => void }} [io] stderr sink (tests)
 * @returns {Promise<number>} exit code
 */
export async function main(rawInput, env = process.env, io = {}) {
  const write = io.write ?? ((/** @type {string} */ s) => process.stderr.write(s));
  if (env.STOP_GATE === 'off') return 0;
  const input = parseInput(rawInput);
  if (input.stop_hook_active === true) return 0;

  const start = Date.now();
  let root;
  try {
    root = git(['rev-parse', '--show-toplevel'], input.cwd || process.cwd()).trim();
  } catch {
    return 0; // not a git repo / no git: nothing to gate
  }
  const kit = readJson(path.join(root, 'kit.config.json'));
  /** @type {StopGateConfig} */
  const cfg = kit.stopGate && typeof kit.stopGate === 'object' ? kit.stopGate : {};
  const budget = parseBudget(env, cfg.budgetMs);
  /** @type {string[]} */
  let changed;
  let base = 'HEAD';
  /** @type {string[] | null} */
  let guardChanged = null;
  try {
    changed = changedFiles(root);
    base = guardBase(root, typeof kit.guard?.baseBranch === 'string' ? kit.guard.baseBranch : undefined);
    if (base !== 'HEAD') guardChanged = changedFiles(root, base);
  } catch {
    return 0; // e.g. no HEAD yet
  }

  const pm = detectPm(root, readJson(path.join(root, 'package.json')));
  const tasks = planTasks(changed, {
    cfg,
    pm,
    root,
    exists: (f) => existsSync(path.join(root, f)),
    guardChanged,
    guardBase: base,
    pkgJson: (dir) => readJson(path.join(root, dir, 'package.json')),
  });
  if (tasks.length === 0) return 0;

  const deadline = start + budget;
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const running = new Set();
  const results = await Promise.all(tasks.map((t) => runTask(t, root, deadline, running)));
  for (const c of running) killTree(c);

  const failed = results.filter((r) => r.status === 'fail');
  if (failed.length) {
    const per = Math.max(8, Math.floor(MAX_OUTPUT_LINES / failed.length));
    const body = failed.map((r) => `--- ${r.name} FAILED ---\n${truncateOutput(r.output, per)}`).join('\n\n');
    const timed = results.filter((r) => r.status === 'timeout').map((r) => r.name);
    const note = timed.length ? `\n\n(not finished within the budget: ${timed.join(', ')})` : '';
    write(`stop-gate: fix these before finishing (STOP_GATE=off to skip).\n\n${body}${note}\n`);
    return 2;
  }
  const timed = results.filter((r) => r.status === 'timeout');
  const infra = results.filter((r) => r.status === 'infra');
  if (timed.length || infra.length) {
    const secs = Math.round(remainingBudget(start, budget, Date.now()) / 1000);
    const parts = [...timed.map((r) => `${r.name} timed out (budget ${Math.round(budget / 1000)} s)`), ...infra.map((r) => `${r.name} could not start: ${truncateOutput(r.output, 2)}`)];
    write(`stop-gate warning (not blocking, ${secs} s left): ${parts.join('; ')}\n`);
  }
  return 0;
}

/** @returns {Promise<string>} */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => resolve(s));
    process.stdin.on('error', () => resolve(s));
  });
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const t0 = Date.now();
  readStdin()
    .then((raw) => main(raw))
    .then((code) => {
      if (process.env.STOP_GATE_VERBOSE) process.stderr.write(`stop-gate: ${Date.now() - t0} ms, exit ${code}\n`);
      process.exit(code);
    })
    .catch((e) => {
      process.stderr.write(`stop-gate internal error (not blocking): ${e?.stack || e}\n`);
      process.exit(0);
    });
}
