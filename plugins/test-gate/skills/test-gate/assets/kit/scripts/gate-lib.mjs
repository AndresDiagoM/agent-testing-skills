// @ts-check
// gate-lib.mjs: pure helpers and small process helpers of the test-gate kit (used by gate.mjs, tested by gate-lib.test.mjs).
// Plain ESM, Node 20+, no dependencies, no network. Derived from the reference project's scripts/gate-core.ts, gate-run.ts, gate-build.ts.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';

export const VERSION = '0.1.0';
export const REPORTED_BY = `gate.mjs ${VERSION}`;
export const DEFAULT_PORT = 3200;
export const MIN = 60_000;
export const STEP_NAME_RE = /^[a-z0-9:_-]+$/;
export const STATUSES = ['passed', 'failed', 'timeout', 'skipped', 'not-run'];
export const KINDS = ['lint', 'typecheck', 'unit', 'db', 'build', 'e2e', 'parity', 'custom'];
/** Kinds whose `passed` status needs a parsed passing-test count (honesty rule 2). */
export const COUNTED_KINDS = ['unit', 'db', 'e2e'];

/**
 * @typedef {{ test: string, file?: string, message?: string, [k: string]: unknown }} Failure
 * @typedef {{ test: string, reason: string, issue?: string, approvedBy: string, approvalRef: string, approvedAt?: string, recheckBy?: string }} ApprovedSkip
 * @typedef {{ reason: string, approvedBy: string, approvalRef: string, approvedAt?: string }} Approval
 * @typedef {Record<string, any>} Counts
 * @typedef {{
 *   name: string, kind?: string, status: string, command: string, exitCode: number | null, wallMs: number, timeoutMs: number,
 *   startedAt?: string, finishedAt?: string, previousPassMs?: number, port?: number, counts?: Counts | null,
 *   failures?: Failure[], flaky?: Failure[], approvedSkips?: ApprovedSkip[], approval?: Approval, allowEmpty?: { reason: string },
 *   scope?: { kind: string, files?: string[] }, stale?: boolean, skipReason?: string, problems?: string[],
 *   details?: Record<string, unknown>, logFile?: string, reportedBy?: string, [k: string]: unknown
 * }} Step
 * @typedef {{ schemaVersion?: number, ok?: boolean, complete?: boolean, finishedAt?: string, totalMs?: number, args?: string[],
 *   requiredSteps?: string[], git?: { head?: string, dirty?: boolean }, environment?: Record<string, any>,
 *   build?: { id?: string, builtAt?: string, servedId?: string }, steps: Step[], [k: string]: unknown }} Evidence
 * @typedef {{ name: string, kind: string, command: string | null, timeoutMs: number, env: Record<string, string>, required: boolean,
 *   reason?: string, allowEmpty?: { reason: string }, approval?: Approval, approvedSkips?: ApprovedSkip[], jsonReport?: boolean }} PlanStep
 */

// ------------------------------------------------------------------------------------------------ step table

/** Conventional steps; `scripts` are tried in order (spec section 5). */
export const DEFAULT_STEPS = [
  { name: 'lint', kind: 'lint', scripts: ['lint'], timeoutMin: 10 },
  { name: 'typecheck', kind: 'typecheck', scripts: ['typecheck', 'type-check', 'check:types', 'tsc'], timeoutMin: 10 },
  { name: 'test', kind: 'unit', scripts: ['test', 'test:unit'], timeoutMin: 10 },
  { name: 'db:test', kind: 'db', scripts: ['db:test', 'test:db'], timeoutMin: 10 },
  { name: 'build', kind: 'build', scripts: ['build'], timeoutMin: 10 },
  { name: 'e2e', kind: 'e2e', scripts: ['test:e2e', 'e2e', 'playwright'], timeoutMin: 15 },
  { name: 'parity', kind: 'parity', scripts: ['test:parity'], timeoutMin: 10 },
];
export const DEFAULT_REQUIRED = ['lint', 'typecheck', 'test', 'db:test', 'build', 'e2e'];

// ------------------------------------------------------------------------------------------------ arguments

/**
 * @typedef {{ command: 'run' | 'add-step', from?: string, only?: string[], skip: string[], timeoutsMs: Record<string, number>,
 *   port?: number, rebuild: boolean, dryRun: boolean, help: boolean, version: boolean, requireComplete: boolean,
 *   root?: string, config?: string, evidenceDir?: string, fromJson?: string, required?: string[] }} GateOptions
 */

/** @param {string} value */
function splitList(value) {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Accepts `--flag value` and `--flag=value`. Throws on anything unknown so a typo never silently runs the full gate.
 * `names` (known step names) enables validation of --from/--only/--skip/--timeout; pass it once the config is loaded.
 * @param {string[]} argv
 * @param {string[] | null} [names]
 * @returns {GateOptions}
 */
export function parseArgs(argv, names = null) {
  /** @type {GateOptions} */
  const opts = { command: 'run', skip: [], timeoutsMs: {}, rebuild: false, dryRun: false, help: false, version: false, requireComplete: false };
  let args = argv;
  if (args[0] === 'add-step') {
    opts.command = 'add-step';
    args = args.slice(1);
  }
  /** @param {string} v @param {string} flag */
  const asStep = (v, flag) => {
    if (names && !names.includes(v)) throw new Error(`${flag}: unknown step "${v}" (valid: ${names.join(', ')})`);
    if (!STEP_NAME_RE.test(v)) throw new Error(`${flag}: bad step name "${v}"`);
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const raw = /** @type {string} */ (args[i]);
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
        opts.version = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--rebuild':
        opts.rebuild = true;
        break;
      case '--require-complete':
        opts.requireComplete = true;
        break;
      case '--root':
        opts.root = value();
        break;
      case '--config':
        opts.config = value();
        break;
      case '--evidence-dir':
        opts.evidenceDir = value();
        break;
      case '--from':
        if (opts.command === 'add-step') throw new Error('--from is not valid for add-step');
        opts.from = asStep(value(), flag);
        break;
      case '--only':
        opts.only = splitList(value()).map((s) => asStep(s, flag));
        break;
      case '--skip':
        opts.skip.push(...splitList(value()).map((s) => asStep(s, flag)));
        break;
      case '--timeout':
        // --timeout e2e=20,build=5 (minutes)
        for (const pair of splitList(value())) {
          const [name, minutes] = pair.split('=');
          const n = Number(minutes);
          if (!name || !Number.isFinite(n) || n <= 0) throw new Error(`--timeout: bad pair "${pair}" (use step=minutes)`);
          opts.timeoutsMs[asStep(name.trim(), flag)] = Math.round(n * MIN);
        }
        break;
      case '--port': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('--port must be an integer between 1 and 65535');
        opts.port = n;
        break;
      }
      case '--from-json':
        opts.fromJson = value();
        break;
      case '--required':
        opts.required = splitList(value());
        break;
      default:
        throw new Error(`unknown argument "${raw}" (see --help)`);
    }
  }
  if (opts.only && opts.from) throw new Error('--only and --from cannot be combined');
  if (opts.command === 'add-step' && !opts.fromJson && !opts.help) throw new Error('add-step needs --from-json <file>');
  return opts;
}

/**
 * Steps that will run, in plan order.
 * @param {Pick<GateOptions, 'from' | 'only' | 'skip'>} opts
 * @param {string[]} names plan order
 */
export function selectSteps(opts, names) {
  let out = [...names];
  const only = opts.only;
  if (only) out = out.filter((n) => only.includes(n));
  if (opts.from) out = out.slice(out.indexOf(opts.from));
  return out.filter((n) => !opts.skip.includes(n));
}

// ------------------------------------------------------------------------------------------------ config + package manager

/**
 * @param {string} root
 * @param {string} [file]
 * @returns {{ config: Record<string, any>, path: string | null }}
 */
export function loadConfig(root, file) {
  const p = resolve(root, file ?? 'kit.config.json');
  if (!existsSync(p)) {
    if (file) throw new Error(`config file not found: ${p}`);
    return { config: {}, path: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`cannot parse ${p}: ${/** @type {Error} */ (err).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${p} must contain a JSON object`);
  return { config: parsed, path: p };
}

/**
 * `packageManager` field, else lockfile, else npm.
 * @param {string} root
 * @param {Record<string, any>} pkg
 * @param {string} [forced] value of config.packageManager ("auto" or absent = detect)
 * @returns {{ name: string, version?: string, source: string }}
 */
export function detectPackageManager(root, pkg, forced) {
  if (forced && forced !== 'auto') return { name: forced.split('@')[0] ?? forced, source: 'kit.config.json' };
  const field = typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  const m = /^(npm|pnpm|yarn|bun)@([^+\s]+)/.exec(field);
  if (m) return { name: /** @type {string} */ (m[1]), version: m[2], source: 'package.json packageManager' };
  const locks = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ];
  for (const [file, name] of locks) if (existsSync(join(root, /** @type {string} */ (file)))) return { name: /** @type {string} */ (name), source: `lockfile ${file}` };
  return { name: 'npm', source: 'default' };
}

/** @param {string} pm @param {string} script */
export function runScriptCommand(pm, script) {
  return pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`;
}

/** Exec prefix for one-off binaries: never hard-coded by the caller. @param {string} pm */
export function execPrefix(pm) {
  switch (pm) {
    case 'pnpm':
      return 'pnpm exec';
    case 'yarn':
      return 'yarn exec';
    case 'bun':
      return 'bunx';
    default:
      return 'npm exec --';
  }
}

/** Replaces a leading `<pm> exec` and any other `<pm>` placeholder of a configured command. @param {string} pm @param {string} command */
export function expandCommand(pm, command) {
  return command.replace(/^\s*<pm>\s+exec\b/, execPrefix(pm)).replace(/<pm>/g, pm);
}

/**
 * Resolves every step of the plan from package.json scripts and kit.config.json (spec section 5).
 * @param {{ pkg: Record<string, any>, config: Record<string, any>, pm: string }} ctx
 * @returns {PlanStep[]}
 */
export function resolveSteps({ pkg, config, pm }) {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const cfgSteps = config.steps && typeof config.steps === 'object' ? config.steps : {};
  const required = Array.isArray(config.requiredSteps) ? config.requiredSteps : DEFAULT_REQUIRED;
  const defs = DEFAULT_STEPS.map((d) => /** @type {any} */ (d));
  for (const name of Object.keys(cfgSteps)) if (!defs.some((d) => d.name === name)) defs.push({ name, kind: 'custom', scripts: [], timeoutMin: 10 });
  return defs.map((def) => {
    const cfg = cfgSteps[def.name] ?? {};
    /** @type {string | null} */
    let command = null;
    /** @type {string | undefined} */
    let reason;
    if (typeof cfg.command === 'string' && cfg.command.trim()) command = expandCommand(pm, cfg.command.trim());
    else if (typeof cfg.script === 'string') {
      if (scripts[cfg.script] !== undefined) command = runScriptCommand(pm, cfg.script);
      else reason = `package.json has no script named "${cfg.script}"`;
    } else {
      const found = def.scripts.find((/** @type {string} */ s) => scripts[s] !== undefined);
      if (found) command = runScriptCommand(pm, found);
      else reason = def.scripts.length ? `no script named ${def.scripts.map((/** @type {string} */ s) => `"${s}"`).join(', ')}` : 'no command configured';
    }
    const minutes = Number(cfg.timeoutMin);
    return {
      name: def.name,
      kind: typeof cfg.kind === 'string' ? cfg.kind : def.kind,
      command,
      timeoutMs: Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : def.timeoutMin) * MIN),
      env: cfg.env && typeof cfg.env === 'object' ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, String(v)])) : {},
      required: required.includes(def.name),
      ...(reason ? { reason } : {}),
      ...(cfg.allowEmpty && typeof cfg.allowEmpty.reason === 'string' ? { allowEmpty: { reason: cfg.allowEmpty.reason } } : {}),
      ...(cfg.approval ? { approval: cfg.approval } : {}),
      ...(Array.isArray(cfg.approvedSkips) ? { approvedSkips: cfg.approvedSkips } : {}),
      ...(cfg.jsonReport ? { jsonReport: true } : {}),
    };
  });
}

// ------------------------------------------------------------------------------------------------ parsers

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
/** @param {string} text */
export const stripAnsi = (text) => text.replace(ANSI, '');

/** @param {string} s @param {number} [max] */
function firstLine(s, max = 300) {
  const line = stripAnsi(String(s ?? '')).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * Sums every vitest "Tests  N passed | M skipped (T)" line (a monorepo run prints one per package, maybe with a prefix).
 * @param {string} output
 */
export function parseVitest(output) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, runs: 0 };
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const m = /(?:^|\s)Tests\s+((?:\d+\s+(?:passed|failed|skipped|todo)(?:\s*\|\s*)?)+)/.exec(line);
    if (!m) continue;
    counts.runs++;
    for (const part of /** @type {string} */ (m[1]).matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
      counts[/** @type {'passed' | 'failed' | 'skipped' | 'todo'} */ (part[2])] += Number(part[1]);
    }
  }
  return counts;
}

/**
 * Jest summary line "Tests:       1 failed, 2 skipped, 3 passed, 6 total". NOT verified against a local Jest repo (decision D6).
 * @param {string} output
 */
export function parseJest(output) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, runs: 0 };
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const m = /(?:^|\s)Tests:\s+((?:\d+\s+[a-z]+(?:,\s*)?)+)/.exec(line);
    if (!m) continue;
    counts.runs++;
    for (const part of /** @type {string} */ (m[1]).matchAll(/(\d+)\s+(passed|failed|skipped|todo)/g)) {
      counts[/** @type {'passed' | 'failed' | 'skipped' | 'todo'} */ (part[2])] += Number(part[1]);
    }
  }
  return counts;
}

/**
 * node:test summary ("ℹ tests 12", "ℹ pass 11", "ℹ fail 0", "ℹ skipped 1", "ℹ todo 0"; the TAP form uses "# ").
 * @param {string} output
 */
export function parseNodeTest(output) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, runs: 0 };
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const m = /^\s*(?:ℹ|#)\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const n = Number(m[2]);
    if (m[1] === 'tests') counts.runs++;
    else if (m[1] === 'pass') counts.passed += n;
    else if (m[1] === 'fail' || m[1] === 'cancelled') counts.failed += n;
    else if (m[1] === 'skipped') counts.skipped += n;
    else counts.todo += n;
  }
  return counts;
}

/**
 * Unit-test counts: Vitest, Jest and node:test summaries are all recognised and summed (monorepos mix them).
 * @param {string} output
 */
export function parseUnit(output) {
  const parts = [parseVitest(output), parseJest(output), parseNodeTest(output)];
  const sum = { passed: 0, failed: 0, skipped: 0, todo: 0, runs: 0 };
  for (const p of parts) for (const k of /** @type {const} */ (['passed', 'failed', 'skipped', 'todo', 'runs'])) sum[k] += p[k];
  return sum;
}

/**
 * Vitest-style failure headings (" FAIL  path > suite > test") with the first message line.
 * @param {string} output
 * @returns {Failure[]}
 */
export function parseUnitFailures(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  /** @type {Failure[]} */
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /(?:^|\s)FAIL\s+(\S.*?)\s*$/.exec(/** @type {string} */ (lines[i]));
    if (!m) continue;
    const test = /** @type {string} */ (m[1]).replace(/\s+\d+ms$/, '');
    if (seen.has(test)) continue;
    seen.add(test);
    const file = test.split(' > ')[0]?.trim();
    const message = firstLine(lines.slice(i + 1, i + 6).find((l) => /Error|expected|Expected/.test(l)) ?? '');
    out.push({ test, ...(file ? { file } : {}), ...(message ? { message } : {}) });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * `supabase test db` runs pg_prove: "Files=3, Tests=45, 1 wallclock secs" then "Result: PASS".
 * `failed` sums "Failed N/M subtests" lines; `passed = tests - failed`.
 * @param {string} output
 */
export function parsePgTap(output) {
  const text = stripAnsi(output);
  const summary = [...text.matchAll(/Files=(\d+),\s*Tests=(\d+)/g)].at(-1);
  const result = [...text.matchAll(/Result:\s*(PASS|FAIL)/g)].at(-1);
  const tests = summary ? Number(summary[2]) : 0;
  let failed = 0;
  for (const m of text.matchAll(/Failed\s+(\d+)\/\d+\s+subtests/g)) failed += Number(m[1]);
  const skipped = [...text.matchAll(/^\s*(?:ok|not ok)\s+\d+.*#\s*SKIP\b/gim)].length;
  return {
    files: summary ? Number(summary[1]) : 0,
    tests,
    result: result ? /** @type {'PASS' | 'FAIL'} */ (result[1]) : /** @type {'UNKNOWN'} */ ('UNKNOWN'),
    passed: Math.max(0, tests - failed),
    failed,
    skipped,
  };
}

/**
 * Reads the closing summary of Playwright's list/line/dot reporters ("  58 passed (1.2m)", "  1 flaky").
 * @param {string} output
 */
export function parsePlaywright(output) {
  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0, interrupted: 0, didNotRun: 0 };
  const lines = stripAnsi(output).split(/\r?\n/);
  // Only the last run counts: start after the last "Running N tests using ..." header when there is one.
  let start = 0;
  lines.forEach((l, i) => {
    if (/^\s*Running \d+ tests? using/.test(l)) start = i;
  });
  for (const line of lines.slice(start)) {
    const m = /^\s*(\d+) (passed|failed|flaky|skipped|interrupted|did not run)(?: \([^)]*\))?\s*$/.exec(line);
    if (!m) continue;
    const key = m[2] === 'did not run' ? 'didNotRun' : /** @type {'passed' | 'failed' | 'flaky' | 'skipped' | 'interrupted'} */ (m[2]);
    counts[key] += Number(m[1]);
  }
  return counts;
}

/**
 * Failure headings of the list reporter ("  1) [chromium] › e2e/a.spec.ts:75:5 › suite › name ───") with the first message line.
 * @param {string} output
 * @returns {Failure[]}
 */
export function parsePlaywrightFailures(output) {
  const lines = stripAnsi(output).split(/\r?\n/);
  const start = lines.reduce((acc, l, i) => (/^\s*Running \d+ tests? using/.test(l) ? i : acc), 0);
  /** @type {Failure[]} */
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^\s+\d+\) (?:\[[^\]]+\] › )?(\S+?):(\d+):\d+ › (.+?)(?:\s+─+)?\s*$/.exec(/** @type {string} */ (lines[i]));
    if (!m) continue;
    const message = firstLine(lines.slice(i + 1, i + 8).find((l) => l.trim() && !/^\s*$/.test(l)) ?? '');
    out.push({ test: `${m[1]} > ${String(m[3]).split(' › ').join(' > ')}`, file: m[1], ...(message ? { message } : {}) });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Playwright `json` reporter (structure verified in playwright 1.65.0 source, lib/runner/index.js, JSONReporter).
 * Counts come from per-test outcomes: expected/unexpected/flaky/skipped; a skipped test with no results did not run.
 * @param {any} report parsed JSON
 * @param {string} [repoRoot] makes `file` repo-relative using config.rootDir
 * @returns {{ counts: Counts, failures: Failure[], flaky: Failure[] }}
 */
export function parsePlaywrightJson(report, repoRoot) {
  const counts = { passed: 0, failed: 0, skipped: 0, flaky: 0, interrupted: 0, didNotRun: 0 };
  /** @type {Failure[]} */
  const failures = [];
  /** @type {Failure[]} */
  const flaky = [];
  const rootDir = typeof report?.config?.rootDir === 'string' ? report.config.rootDir : '';
  /** @param {string} file */
  const repoFile = (file) => {
    if (!repoRoot || !rootDir) return file;
    const rel = relative(resolve(repoRoot), resolve(rootDir, file)).split('\\').join('/');
    return rel.startsWith('..') ? file : rel;
  };
  /** @param {any} suite @param {string[]} titles */
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results.at(-1);
        const entry = {
          test: `${spec.file ?? suite.file} > ${[...titles, spec.title].join(' > ')}`,
          file: repoFile(spec.file ?? suite.file),
        };
        if (t.status === 'expected') counts.passed++;
        else if (t.status === 'flaky') {
          counts.flaky++;
          flaky.push(entry);
        } else if (t.status === 'skipped') {
          if (results.length === 0) counts.didNotRun++;
          else counts.skipped++;
        } else if (last?.status === 'interrupted') counts.interrupted++;
        else {
          counts.failed++;
          const message = firstLine(last?.errors?.[0]?.message ?? last?.error?.message ?? '');
          failures.push({ ...entry, ...(message ? { message } : {}) });
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, child.title && child.title !== suite.title ? [...titles, child.title] : titles);
  };
  for (const top of report?.suites ?? []) walk(top, []);
  return { counts, failures: failures.slice(0, 50), flaky: flaky.slice(0, 50) };
}

/**
 * Cypress run summary row ("✔  All specs passed!  00:12  12  12  -  -  -" = Tests, Passing, Failing, Pending, Skipped).
 * NOT verified against a local Cypress repo (decision D6); `passed` is only trusted when the row parses.
 * @param {string} output
 */
export function parseCypress(output) {
  const counts = { passed: 0, failed: 0, skipped: 0, runs: 0 };
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const m = /(?:All specs passed!|\d+ of \d+ failed \(\d+%\))\s+\d{2}:\d{2}(?::\d{2})?\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)/.exec(line);
    if (!m) continue;
    /** @param {string | undefined} v */
    const n = (v) => (v === '-' || v === undefined ? 0 : Number(v));
    counts.runs++;
    counts.passed += n(m[2]);
    counts.failed += n(m[3]);
    counts.skipped += n(m[4]) + n(m[5]);
  }
  return counts;
}

/**
 * @param {string} kind step kind
 * @param {string} output
 * @returns {Counts | null}
 */
export function parseCounts(kind, output) {
  switch (kind) {
    case 'unit':
      return parseUnit(output);
    case 'db':
      return parsePgTap(output);
    case 'e2e': {
      const pw = parsePlaywright(output);
      if (Object.values(pw).some((n) => n > 0)) return pw;
      const cy = parseCypress(output);
      return cy.runs > 0 ? cy : pw;
    }
    default:
      return null;
  }
}

/**
 * @param {string} kind
 * @param {string} output
 * @returns {Failure[]}
 */
export function parseFailures(kind, output) {
  if (kind === 'unit') return parseUnitFailures(output);
  if (kind === 'e2e') return parsePlaywrightFailures(output);
  return [];
}

/** One short human string for the summary table. @param {string} kind @param {Counts | null | undefined} c */
export function describeCounts(kind, c) {
  if (!c) return '';
  if (kind === 'db') return `${c.result ?? '?'}, ${c.tests ?? 0} tests in ${c.files ?? 0} files`;
  const parts = [`${c.passed ?? 0} passed`, `${c.failed ?? 0} failed`, `${c.skipped ?? 0} skipped`];
  if (c.flaky) parts.push(`${c.flaky} flaky`);
  if (c.todo) parts.push(`${c.todo} todo`);
  if (c.didNotRun) parts.push(`${c.didNotRun} did not run`);
  if (c.runs !== undefined && kind === 'unit') parts.push(`${c.runs} runs`);
  return parts.join(' | ');
}

// ------------------------------------------------------------------------------------------------ honesty

/**
 * Why a step that exited 0 is still a failure, or null when it is fine (honesty rule 2, spec 4.2.5 R7).
 * "0 tests passed" must never look like a green gate.
 * @param {{ kind?: string, allowEmpty?: { reason: string } | undefined }} step
 * @param {Counts | null | undefined} counts
 * @returns {string | null}
 */
export function zeroExitProblem(step, counts) {
  const kind = step.kind ?? 'custom';
  const empty = Boolean(step.allowEmpty?.reason);
  if (!COUNTED_KINDS.includes(kind)) return null;
  if (!counts) return 'no test counts were parsed from the output';
  if (kind === 'db') {
    if (counts.result === 'FAIL') return 'pgTAP reported "Result: FAIL" although the exit code was 0';
    if (counts.result === 'UNKNOWN' || counts.result === undefined) return 'no parsable pg_prove summary (Result: UNKNOWN)';
    if (!empty && (counts.files === 0 || counts.tests === 0)) return `pgTAP ran ${counts.tests ?? 0} tests in ${counts.files ?? 0} files`;
    return null;
  }
  if (kind === 'unit') {
    if (!empty && !(counts.passed > 0)) return `exit code 0 but 0 tests passed (${counts.skipped ?? 0} skipped, ${counts.todo ?? 0} todo, ${counts.runs ?? 0} runs parsed)`;
    return null;
  }
  if (!empty && !(counts.passed > 0)) return `exit code 0 but 0 tests passed (${counts.skipped ?? 0} skipped, ${counts.didNotRun ?? 0} did not run)`;
  return null;
}

/**
 * @param {{ kind?: string, allowEmpty?: { reason: string } | undefined }} step
 * @param {number | null} exitCode
 * @param {Counts | null | undefined} counts
 * @param {boolean} timedOut
 * @returns {{ status: string, problem: string | null }}
 */
export function judge(step, exitCode, counts, timedOut) {
  if (timedOut) return { status: 'timeout', problem: null };
  if (exitCode !== 0) return { status: 'failed', problem: null };
  const problem = zeroExitProblem(step, counts);
  return { status: problem ? 'failed' : 'passed', problem };
}

// ------------------------------------------------------------------------------------------------ evidence

/** An approval is valid only from the user or the orchestrator (decision D5), with a reference and a reason. @param {any} a */
export function isValidApproval(a) {
  return Boolean(a) && ['user', 'orchestrator'].includes(a.approvedBy) && typeof a.approvalRef === 'string' && a.approvalRef.trim() !== '' && typeof a.reason === 'string' && a.reason.trim() !== '';
}

/** An approval past its `recheckBy` date (end of that day, UTC) no longer counts. @param {any} a @param {number} now */
function approvalExpired(a, now) {
  if (typeof a?.recheckBy !== 'string') return false;
  const when = Date.parse(a.recheckBy.includes('T') ? a.recheckBy : `${a.recheckBy}T23:59:59.999Z`);
  return Number.isFinite(when) && when < now;
}

/** v1 meaning, unchanged: every recorded step passed or was skipped. @param {Step[]} steps */
export function computeOk(steps) {
  return steps.every((s) => s.status === 'passed' || s.status === 'skipped');
}

/**
 * `complete`: ok AND every required step is fresh, passed (scope all, no unapproved skips/flaky/interrupted) or skipped with approval.
 * @param {Evidence} ev
 * @param {number} [now]
 * @returns {{ ok: boolean, complete: boolean, reasons: string[] }}
 */
export function evaluateEvidence(ev, now = Date.now()) {
  const steps = Array.isArray(ev.steps) ? ev.steps : [];
  const ok = computeOk(steps);
  /** @type {string[]} */
  const reasons = [];
  if (!ok) reasons.push('ok is false (a recorded step did not pass)');
  const required = Array.isArray(ev.requiredSteps) ? ev.requiredSteps : [];
  if (required.length === 0) reasons.push('requiredSteps is absent or empty (a v1 file cannot prove completeness)');
  for (const name of required) {
    const s = steps.find((x) => x.name === name);
    if (!s) {
      reasons.push(`required step "${name}" has no entry`);
      continue;
    }
    if (s.stale) {
      reasons.push(`required step "${name}" is stale (not run in the latest invocation)`);
      continue;
    }
    if (s.status === 'skipped') {
      if (!(isValidApproval(s.approval) && !approvalExpired(s.approval, now))) reasons.push(`required step "${name}" was skipped without a valid approval`);
      continue;
    }
    if (s.status !== 'passed') {
      reasons.push(`required step "${name}" is ${s.status}`);
      continue;
    }
    if (s.scope && s.scope.kind !== 'all') reasons.push(`step "${name}" ran with scope "${s.scope.kind}" (partial)`);
    const c = s.counts;
    if (c) {
      const approved = (s.approvedSkips ?? []).filter((a) => isValidApproval(a) && !approvalExpired(a, now)).length;
      const held = (c.skipped ?? 0) + (c.todo ?? 0) + (c.didNotRun ?? 0);
      if (held > approved) reasons.push(`step "${name}" has ${held - approved} skipped/todo/did-not-run test(s) without a valid approvedSkips entry`);
      if ((c.flaky ?? 0) > 0) reasons.push(`step "${name}" has ${c.flaky} flaky test(s) (a pass on retry is never a clean pass)`);
      if ((c.interrupted ?? 0) > 0) reasons.push(`step "${name}" has ${c.interrupted} interrupted test(s)`);
    }
  }
  if (ev.build && ev.build.servedId !== undefined && ev.build.id !== undefined && ev.build.id !== ev.build.servedId) reasons.push('build.id differs from build.servedId (e2e ran against another build)');
  return { ok, complete: reasons.length === 0, reasons };
}

/** Reader: returns the parsed file untouched (v1 files have no schemaVersion). @param {string} file @returns {Evidence | null} */
export function readEvidence(file) {
  if (!existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot parse evidence file ${file}: ${/** @type {Error} */ (err).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.steps)) throw new Error(`${file} is not an evidence file (no steps array)`);
  return parsed;
}

/** Absent schemaVersion means 1. @param {Evidence} ev */
export const schemaOf = (ev) => (typeof ev.schemaVersion === 'number' ? ev.schemaVersion : 1);

/** Writes JSON atomically: temp file in the same directory, then rename. @param {string} file @param {unknown} data */
export function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Pure merge: builds the next evidence file from the previous one and the steps run in THIS invocation.
 * Steps not run now are kept and marked `stale: true` (never erased). Unknown root and step fields are preserved.
 * @param {{ prev: Evidence | null, fresh: Step[], planOrder: string[], args: string[], requiredSteps: string[], git?: Evidence['git'],
 *   environment?: Evidence['environment'], build?: Evidence['build'], finishedAt?: string, markStale?: boolean }} p
 * @returns {Evidence}
 */
export function assembleEvidence({ prev, fresh, planOrder, args, requiredSteps, git, environment, build, finishedAt, markStale = true }) {
  /** @type {Step[]} */
  const steps = [];
  for (const old of prev?.steps ?? []) {
    const replacement = fresh.find((s) => s.name === old.name);
    if (replacement) steps.push(replacement);
    else steps.push(markStale ? { ...old, stale: true } : old);
  }
  const have = new Set(steps.map((s) => s.name));
  for (const name of planOrder) {
    const s = fresh.find((x) => x.name === name);
    if (s && !have.has(name)) {
      steps.push(s);
      have.add(name);
    }
  }
  for (const s of fresh) if (!have.has(s.name)) steps.push(s);
  const { ok, complete } = evaluateEvidence({ ...(prev ?? {}), requiredSteps, steps, build: build ?? prev?.build });
  /** @type {Evidence} */
  const next = {
    ...(prev ?? {}),
    schemaVersion: 2,
    ok,
    complete,
    finishedAt: finishedAt ?? new Date().toISOString(),
    totalMs: steps.filter((s) => !s.stale).reduce((a, s) => a + (s.wallMs || 0), 0),
    args,
    requiredSteps,
    ...(git ? { git } : {}),
    ...(environment ? { environment } : {}),
    ...(build ? { build } : {}),
    steps,
  };
  return next;
}

/**
 * Validates a step object given by another skill (spec 4.2.3). Returns problems (empty = valid).
 * @param {any} step
 * @returns {string[]}
 */
export function validateStep(step) {
  /** @type {string[]} */
  const p = [];
  if (!step || typeof step !== 'object' || Array.isArray(step)) return ['step must be a JSON object'];
  if (typeof step.name !== 'string' || !STEP_NAME_RE.test(step.name)) p.push('name must match [a-z0-9:_-]+');
  if (!STATUSES.includes(step.status)) p.push(`status must be one of ${STATUSES.join(', ')}`);
  if (typeof step.command !== 'string' || !step.command) p.push('command (exact command line) is required');
  if (!(step.exitCode === null || typeof step.exitCode === 'number')) p.push('exitCode must be a number or null');
  if (typeof step.wallMs !== 'number') p.push('wallMs must be a number');
  if (typeof step.timeoutMs !== 'number') p.push('timeoutMs must be a number');
  if (step.kind !== undefined && !KINDS.includes(step.kind)) p.push(`kind must be one of ${KINDS.join(', ')}`);
  if (step.counts != null) {
    if (typeof step.counts !== 'object') p.push('counts must be an object or null');
    else for (const k of ['passed', 'failed', 'skipped']) if (typeof step.counts[k] !== 'number') p.push(`counts.${k} must be a number`);
  }
  if (step.failures !== undefined && !Array.isArray(step.failures)) p.push('failures must be an array');
  if (Array.isArray(step.failures)) step.failures.forEach((/** @type {any} */ f, /** @type {number} */ i) => typeof f?.test !== 'string' && p.push(`failures[${i}].test must be a string`));
  if (step.scope !== undefined && !['all', 'files'].includes(step.scope?.kind)) p.push('scope.kind must be "all" or "files"');
  return p;
}

/**
 * Applies the honesty rules to an externally written step: it may be downgraded to `failed`, never upgraded.
 * @param {Step} step
 * @returns {Step}
 */
export function applyHonesty(step) {
  if (step.status !== 'passed') return step;
  /** @type {string[]} */
  const problems = [...(step.problems ?? [])];
  if (step.exitCode !== 0) problems.push(`status passed but exitCode is ${step.exitCode}`);
  const kind = step.kind ?? 'custom';
  if (COUNTED_KINDS.includes(kind)) {
    const c = step.counts;
    const pg = /** @type {any} */ (step.details)?.pgtap;
    /** @type {Counts | null} */
    let merged = c ?? null;
    if (kind === 'db' && merged) {
      const tests = pg?.tests ?? (c?.tests ?? (c ? (c.passed ?? 0) + (c.failed ?? 0) + (c.skipped ?? 0) : undefined));
      merged = { ...c, tests, files: pg?.files ?? c?.files ?? (tests === 0 ? 0 : 1), result: pg?.result ?? c?.result ?? ((c?.failed ?? 0) > 0 ? 'FAIL' : tests > 0 ? 'PASS' : 'UNKNOWN') };
    }
    const problem = zeroExitProblem({ kind, allowEmpty: step.allowEmpty }, merged);
    if (problem) problems.push(problem);
    else if ((merged?.failed ?? 0) > 0) problems.push(`status passed but counts.failed is ${merged?.failed}`);
  }
  if (problems.length === (step.problems ?? []).length) return step;
  return { ...step, status: 'failed', problems };
}

/**
 * add-step: merges ONE step into the evidence file (spec 4.2.4 steps 1, 4, 5). Other steps and unknown fields are kept.
 * @param {{ file: string, step: any, requiredSteps?: string[], git?: Evidence['git'], environment?: Evidence['environment'], now?: string }} p
 * @returns {{ evidence: Evidence, step: Step }}
 */
export function addStep({ file, step, requiredSteps, git, environment, now }) {
  const problems = validateStep(step);
  if (problems.length) throw new Error(`invalid step: ${problems.join('; ')}`);
  const prev = readEvidence(file) ?? { schemaVersion: 2, steps: [], requiredSteps: requiredSteps ?? [], args: [] };
  const { stale: _stale, ...rest } = /** @type {Step} */ (step);
  void _stale;
  const clean = applyHonesty(/** @type {Step} */ (rest));
  const evidence = assembleEvidence({
    prev,
    fresh: [clean],
    planOrder: [],
    args: Array.isArray(prev.args) ? prev.args : [],
    requiredSteps: requiredSteps?.length ? requiredSteps : Array.isArray(prev.requiredSteps) ? prev.requiredSteps : [],
    git,
    environment: environment ?? prev.environment,
    finishedAt: now,
    markStale: false,
  });
  writeJsonAtomic(file, evidence);
  return { evidence, step: clean };
}

// ------------------------------------------------------------------------------------------------ summary

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/**
 * Summary table of the steps run in this invocation plus the verdict and the skips.
 * @param {Evidence} ev
 * @param {number} totalMs
 * @param {number} [now]
 */
export function formatSummary(ev, totalMs, now = Date.now()) {
  const rows = ev.steps.map((s) => [s.name + (s.stale ? ' (stale)' : ''), s.status.toUpperCase(), s.stale || s.status === 'skipped' || s.status === 'not-run' ? '-' : formatDuration(s.wallMs), describeCounts(s.kind ?? 'custom', s.counts)]);
  const header = ['step', 'status', 'time', 'counts'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => /** @type {string} */ (r[i]).length)));
  /** @param {string[]} cells */
  const line = (cells) => cells.map((c, i) => c.padEnd(/** @type {number} */ (widths[i]))).join('  ').trimEnd();
  /** @type {string[]} */
  const notes = [];
  for (const s of ev.steps) {
    if (s.stale) continue;
    const c = s.counts;
    if (c && ((c.skipped ?? 0) > 0 || (c.todo ?? 0) > 0 || (c.didNotRun ?? 0) > 0)) {
      const approved = s.approvedSkips ?? [];
      if (approved.length) for (const a of approved) notes.push(`SKIP ${s.name}: ${a.test} (approved by ${a.approvedBy}: ${a.approvalRef}; ${a.reason})`);
      const held = (c.skipped ?? 0) + (c.todo ?? 0) + (c.didNotRun ?? 0);
      if (held > approved.length) notes.push(`WARNING ${s.name}: ${held - approved.length} skipped/todo/did-not-run without approval. These proved nothing: un-skip or get an approval from the user.`);
    }
    if (s.status === 'skipped' && s.approval) notes.push(`SKIP step ${s.name}: ${s.approval.reason} (approved by ${s.approval.approvedBy}: ${s.approval.approvalRef})`);
    if (s.skipReason) notes.push(`NOTE ${s.name}: skipped, ${s.skipReason}`);
    for (const pr of s.problems ?? []) notes.push(`FAILED ${s.name}: ${pr}`);
    if ((c?.flaky ?? 0) > 0) notes.push(`WARNING ${s.name}: ${c?.flaky} FLAKY (passed only on retry): not a clean pass.`);
  }
  const verdict = evaluateEvidence(ev, now);
  return [
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
    ...(notes.length ? ['', ...notes] : []),
    '',
    `${verdict.ok ? 'GATE PASSED' : 'GATE FAILED'} (ok:${verdict.ok}) in ${formatDuration(totalMs)}; complete:${verdict.complete}`,
    ...(verdict.complete ? [] : verdict.reasons.map((r) => `  incomplete: ${r}`)),
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------ environment

/** @param {string} root @returns {Record<string, string>} versions read from node_modules, no process spawned */
export function readToolVersions(root) {
  const wanted = { playwright: '@playwright/test', vitest: 'vitest', jest: 'jest', cypress: 'cypress', 'supabase-cli': 'supabase' };
  /** @type {Record<string, string>} */
  const out = {};
  for (const [label, pkgName] of Object.entries(wanted)) {
    try {
      const v = JSON.parse(readFileSync(join(root, 'node_modules', pkgName, 'package.json'), 'utf8')).version;
      if (typeof v === 'string') out[label] = v;
    } catch {
      /* not installed at the root */
    }
  }
  return out;
}

/** @param {string} root @returns {Evidence['git'] | undefined} */
export function gitInfo(root) {
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
  try {
    // Only when `root` is itself the work tree top (a scratch copy inside another repo must not report that repo's HEAD).
    const top = git(['rev-parse', '--show-toplevel']);
    if (resolve(top).toLowerCase() !== resolve(root).toLowerCase()) return undefined;
    const head = git(['rev-parse', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--', '.', ':(exclude).gate']).length > 0;
    return { head, dirty };
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ build freshness

const NOT_SOURCE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?)$|(^|[\\/])(testing|__tests__|node_modules|\.next|\.git|dist|coverage|\.turbo)([\\/]|$)/;

/**
 * @param {string} dir
 * @param {(file: string, mtimeMs: number) => void} visit
 */
function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (NOT_SOURCE.test(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, visit);
    else if (e.isFile()) visit(full, statSync(full).mtimeMs);
  }
}

/**
 * Most recently modified build input under `entries` (directories or files, relative to root).
 * @param {string} root @param {string[]} entries
 * @returns {{ mtimeMs: number, file: string } | null}
 */
export function newestSource(root, entries) {
  /** @type {{ mtimeMs: number, file: string } | null} */
  let best = null;
  /** @param {string} file @param {number} mtimeMs */
  const consider = (file, mtimeMs) => {
    if (!best || mtimeMs > best.mtimeMs) best = { mtimeMs, file: relative(root, file).split('\\').join('/') };
  };
  for (const entry of entries) {
    const full = resolve(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, consider);
    else if (st.isFile()) consider(full, st.mtimeMs);
  }
  return best;
}

/**
 * Pure comparison: a build is stale when a source file is newer than the build id file written at the end of the build.
 * @param {number | null} builtAtMs @param {{ mtimeMs: number, file: string } | null} newest
 */
export function compareBuild(builtAtMs, newest) {
  if (builtAtMs === null) return /** @type {const} */ ({ status: 'missing' });
  if (newest && newest.mtimeMs > builtAtMs) return /** @type {const} */ ({ status: 'stale', builtAtMs, newer: newest });
  return /** @type {const} */ ({ status: 'fresh', builtAtMs });
}

/**
 * @param {{ root: string, buildIdFile: string, sourceDirs: string[] }} p
 * @returns {{ freshness: ReturnType<typeof compareBuild>, id?: string }}
 */
export function checkBuildFreshness({ root, buildIdFile, sourceDirs }) {
  const file = resolve(root, buildIdFile);
  const built = existsSync(file) ? statSync(file).mtimeMs : null;
  const freshness = compareBuild(built, newestSource(root, sourceDirs));
  return { freshness, ...(built !== null ? { id: readFileSync(file, 'utf8').trim() } : {}) };
}

// ------------------------------------------------------------------------------------------------ processes

/** Kills `pid` and its descendants (only the tree this runner started). @param {number} pid */
export function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

const MAX_CAPTURE = 16 * 1024 * 1024;

/**
 * Runs one shell command (shell:true, so pnpm's .cmd shim works on Windows) with live passthrough, a log file tee, and a
 * hard timeout that kills the process tree.
 * @param {string} command
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number, logFile?: string, quiet?: boolean,
 *   onSpawn?: (pid: number | undefined) => void }} opts
 * @returns {Promise<{ exitCode: number | null, timedOut: boolean, wallMs: number, output: string }>}
 */
export function runCommand(command, opts) {
  const started = performance.now();
  const log = opts.logFile ? (mkdirSync(dirname(opts.logFile), { recursive: true }), createWriteStream(opts.logFile, { flags: 'w' })) : null;
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    opts.onSpawn?.(child.pid);
    let captured = '';
    let timedOut = false;
    let settled = false;
    /** @param {'stdout' | 'stderr'} stream */
    const capture = (stream) => (/** @type {Buffer} */ data) => {
      const chunk = data.toString('utf8');
      if (!opts.quiet) (stream === 'stdout' ? process.stdout : process.stderr).write(chunk);
      log?.write(chunk);
      captured += chunk;
      if (captured.length > MAX_CAPTURE) captured = captured.slice(captured.length - MAX_CAPTURE);
    };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, opts.timeoutMs);
    /** @param {number | null} exitCode */
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const wallMs = Math.round(performance.now() - started);
      const done = () => resolvePromise({ exitCode, timedOut, wallMs, output: captured });
      if (log) log.end(done);
      else done();
    };
    child.once('error', (err) => {
      captured += `\nspawn error: ${err.message}\n`;
      log?.write(`\nspawn error: ${err.message}\n`);
      finish(null);
    });
    child.once('close', (code) => finish(code));
  });
}

// ------------------------------------------------------------------------------------------------ free port

/** @param {number} port @returns {Promise<boolean>} */
function isFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.once('listening', () => server.close(() => resolvePromise(true)));
    // No host: binds the wildcard address, which collides with anything already listening on that port.
    server.listen(port);
  });
}

/**
 * First free port from `start` upward (up to 100 tries), else an OS-assigned one. No waiting involved.
 * @param {number} [start]
 * @param {(p: number) => Promise<boolean>} [probe]
 * @returns {Promise<number>}
 */
export async function pickFreePort(start = DEFAULT_PORT, probe = isFree) {
  for (let p = start; p < start + 100 && p <= 65535; p++) if (await probe(p)) return p;
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePromise(port));
    });
  });
}

/** Log file name for a step: ':' is not valid in Windows file names. @param {string} name */
export const logName = (name) => `${name.replace(/[^a-z0-9_-]/gi, '-')}.log`;
