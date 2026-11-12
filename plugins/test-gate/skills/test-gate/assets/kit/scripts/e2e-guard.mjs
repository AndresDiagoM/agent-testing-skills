#!/usr/bin/env node
// @ts-check
// e2e-guard.mjs: flags test changes that WEAKEN a test (fewer assertions or test() blocks, deleted or excluded test files,
// skip/fixme/only, bigger timeouts, new retries, waitForTimeout/networkidle/toPass, expect(...).catch, tautologies; review-only:
// .first(), CSS locators, looser matchers). Applies to unit and e2e test files. Rules live in guard-core.mjs.
// Plain ESM, Node 20+, no dependencies, no network.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, analyze, countHard, formatReport, isTestFile, judgeHits, normPath, parseTestIgnore, scanSource } from './guard-core.mjs';

export { scanSource, stripComments, judgeHits, countHard, HARD_RULES } from './guard-core.mjs';

export const VERSION = '0.2.0';
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage', 'playwright-report', 'test-results', '.auth']);
const DEFAULT_DIRS = ['e2e', 'tests/e2e', 'test/e2e', 'apps/web/e2e'];

export const USAGE = `e2e-guard.mjs ${VERSION}: flags test changes that weaken a test (unit and e2e files).

Usage:
  node e2e-guard.mjs [--base <ref>] [--head <ref>] [--staged] [--files a,b] [--json] [--json-file <p>]   diff mode (default)
  node e2e-guard.mjs --all [--dir <d>]... [--file <f>]... [--write-baseline [--allow-raise]]            legacy repos
  common: [--root <dir>] [--config <file>] [--baseline <file>] [--help] [--version]

Diff mode (default)
  Compares every changed test file (working tree, index and untracked files) with the merge-base of HEAD and the default branch.
  Base order: --base, $TEST_GUARD_BASE, kit.config.json guard.baseBranch, origin/main, main, origin/master, master (else HEAD).
  --staged compares the index; --head <ref> compares two commits (audit a branch); --files limits it to some paths.
  BLOCK (exit 1): fewer assertions or test()/it() blocks in a changed file, deleted test files or files moved out of the suite,
    skip/fixme/only/todo markers, larger or new timeouts, new retries, waitForTimeout/sleep/networkidle/toPass, assertions that
    cannot fail (expect(...).catch, expect(true).toBe(true)), secret-looking literals.
  REVIEW (listed, exit 0): .first()/.last()/.nth(), a CSS or text locator replacing getByRole/TestId/Label, looser matchers,
    assertions inside an if or try/catch.
  Approval: only a comment ADDED by the same change, on the line or just above it: // test-guard: approved <reason>
    (-- test-guard: approved <reason> in SQL). Removed assertions or tests: // test-guard: approved-removal <n> <reason> inside
    the change or within 3 lines of it (n >= how many were removed). Old or distant approvals never count.
  A deleted file cannot carry a comment: list it in kit.config.json guard.approvedDeletions (the user approves that edit).

--all
  Scans every file of the e2e dirs (--dir, else the first of ${DEFAULT_DIRS.join(', ')}) with the line scanner: hard hits are
  waitForTimeout, networkidle, toPass, fixme, unconditional skip, retries above 0 and secret-looking literals; warnings are
  runtime-conditional skips and .first(). Hard hits above the ratchet baseline (e2e-guard.baseline.json) fail.
  --write-baseline writes the baseline; it refuses to raise an existing count unless --allow-raise (the user's call).

Config (optional): kit.config.json "guard": { baseBranch, extraTestFiles[globs], assertionHelpers[], arrayAssertionHelpers[],
  maxNewTimeoutMs, approvedDeletions[], testIgnore[], playwrightConfigs[], dirs[], baseline }.
Exit codes: 0 clean, 1 blocking findings, 2 usage or git error. Last output line: e2e-guard: BLOCK=n APPROVED=n REVIEW=n files=n.`;

/**
 * @typedef {{ all: boolean, base?: string, head?: string, staged: boolean, files: string[], dirs: string[], extraFiles: string[],
 *   root?: string, config?: string, baseline?: string, writeBaseline: boolean, allowRaise: boolean, json: boolean, jsonFile?: string,
 *   help: boolean, version: boolean }} CliOptions
 */

/** @param {string[]} argv @returns {CliOptions} */
export function parseGuardArgs(argv) {
  /** @type {CliOptions} */
  const o = { all: false, staged: false, files: [], dirs: [], extraFiles: [], writeBaseline: false, allowRaise: false, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const raw = /** @type {string} */ (argv[i]);
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? undefined : raw.slice(eq + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
      return next;
    };
    switch (flag) {
      case '--all': o.all = true; break;
      case '--base': o.base = value(); break;
      case '--head': o.head = value(); break;
      case '--staged': o.staged = true; break;
      case '--files': o.files.push(...value().split(',').map((s) => normPath(s.trim())).filter(Boolean)); break;
      case '--dir': o.dirs.push(value()); break;
      case '--file': o.extraFiles.push(value()); break;
      case '--root': o.root = resolve(value()); break;
      case '--config': o.config = value(); break;
      case '--baseline': o.baseline = value(); break;
      case '--write-baseline': o.writeBaseline = true; break;
      case '--allow-raise': o.allowRaise = true; break;
      case '--json': o.json = true; break;
      case '--json-file': o.jsonFile = value(); break;
      case '--version': o.version = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown argument "${raw}" (see --help)`);
    }
  }
  if (o.all && (o.base || o.head || o.staged)) throw new Error('--all cannot be combined with --base, --head or --staged');
  if (o.staged && o.head) throw new Error('--staged and --head cannot be combined');
  if (o.writeBaseline && !o.all) throw new Error('--write-baseline needs --all');
  if (o.allowRaise && !o.writeBaseline) throw new Error('--allow-raise needs --write-baseline');
  return o;
}

/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
/** @param {string[]} args @param {string} cwd @returns {string | null} */
const gitOrNull = (args, cwd) => {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
};

/**
 * Parses `git diff --name-status -z -M` output.
 * @param {string} out
 * @returns {Array<{ status: 'A' | 'M' | 'D' | 'R', oldPath: string | null, path: string }>}
 */
export function parseNameStatus(out) {
  const parts = out.split('\0').filter((p) => p !== '');
  /** @type {Array<{ status: 'A' | 'M' | 'D' | 'R', oldPath: string | null, path: string }>} */
  const rows = [];
  for (let i = 0; i < parts.length; ) {
    const code = /** @type {string} */ (/** @type {string} */ (parts[i++])[0]);
    if (code === 'R' || code === 'C') {
      const from = /** @type {string} */ (parts[i++]);
      const to = /** @type {string} */ (parts[i++]);
      rows.push({ status: code === 'R' ? 'R' : 'A', oldPath: code === 'R' ? normPath(from) : null, path: normPath(to) });
    } else {
      const p = normPath(/** @type {string} */ (parts[i++]));
      rows.push({ status: code === 'A' ? 'A' : code === 'D' ? 'D' : 'M', oldPath: code === 'A' ? null : p, path: p });
    }
  }
  return rows;
}

/**
 * Guard section of kit.config.json (or of the file given with --config) merged over the defaults. The `testIgnore` globs of every
 * Playwright config found in the repo (read as data, nothing is executed) tell which paths a renamed test escapes to.
 * @param {string} root @param {string} [explicit]
 */
export function loadGuardConfig(root, explicit) {
  const file = resolve(root, explicit ?? 'kit.config.json');
  /** @type {any} */
  let guard = {};
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      guard = parsed && typeof parsed === 'object' ? (parsed.guard ?? (explicit ? parsed : {})) : {};
    } catch (err) {
      throw new Error(`cannot parse ${file}: ${/** @type {Error} */ (err).message}`);
    }
  } else if (explicit) throw new Error(`config file not found: ${file}`);
  /** @type {string[]} */
  let pwFiles = Array.isArray(guard.playwrightConfigs) ? guard.playwrightConfigs.map(String) : [];
  if (pwFiles.length === 0) {
    const listed = gitOrNull(['ls-files', '-z', '--', '*playwright.config.*'], root);
    pwFiles = listed ? listed.split('\0').filter(Boolean) : [];
  }
  /** @type {string[]} */
  const fromPlaywright = [];
  for (const f of pwFiles) {
    const abs = resolve(root, f);
    if (!existsSync(abs)) continue;
    const dir = normPath(dirname(normPath(f)));
    for (const g of parseTestIgnore(readFileSync(abs, 'utf8'))) {
      fromPlaywright.push(g);
      if (dir && dir !== '.') fromPlaywright.push(`${dir}/${g.replace(/^\.?\//, '')}`);
    }
  }
  return {
    config: {
      ...DEFAULT_CONFIG,
      ...(Array.isArray(guard.extraTestFiles) ? { extraTestFiles: guard.extraTestFiles.map(String) } : {}),
      ...(Array.isArray(guard.assertionHelpers) ? { assertionHelpers: guard.assertionHelpers.map(String) } : {}),
      ...(Array.isArray(guard.arrayAssertionHelpers) ? { arrayAssertionHelpers: guard.arrayAssertionHelpers.map(String) } : {}),
      ...(typeof guard.maxNewTimeoutMs === 'number' ? { maxNewTimeoutMs: guard.maxNewTimeoutMs } : {}),
      ...(Array.isArray(guard.approvedDeletions) ? { approvedDeletions: guard.approvedDeletions } : {}),
      testIgnore: [...new Set([...DEFAULT_CONFIG.testIgnore, ...(Array.isArray(guard.testIgnore) ? guard.testIgnore.map(String) : []), ...fromPlaywright])],
    },
    baseBranch: typeof guard.baseBranch === 'string' ? guard.baseBranch : undefined,
    dirs: Array.isArray(guard.dirs) ? guard.dirs.map(String) : [],
    baseline: typeof guard.baseline === 'string' ? guard.baseline : undefined,
  };
}

/**
 * The commit diff mode compares against: the merge-base of HEAD and the first base ref that exists (so a default branch that
 * moved ahead does not show up as deleted tests). Falls back to HEAD (the uncommitted change) when no base ref exists.
 * @param {string} root @param {{ requested?: string, baseBranch?: string, head?: string, env?: Record<string, string | undefined> }} o
 * @returns {{ base: string, note?: string }}
 */
export function resolveBase(root, { requested, baseBranch, head = 'HEAD', env = process.env }) {
  const named = [requested, env.TEST_GUARD_BASE, baseBranch].filter(Boolean);
  const candidates = requested
    ? [requested]
    : [...new Set([...named, ...(baseBranch ? [`origin/${baseBranch}`] : []), 'origin/main', 'main', 'origin/master', 'master'])].filter(/** @returns {x is string} */ (x) => Boolean(x));
  for (const ref of candidates) {
    if (gitOrNull(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root) === null) continue;
    const mb = gitOrNull(['merge-base', ref, head], root)?.trim();
    return { base: mb || ref };
  }
  if (requested) throw new Error(`base ref not found (${requested}): pass another --base <ref>`);
  return { base: 'HEAD', note: `no base ref found (${candidates.join(', ')}); comparing with HEAD, so only uncommitted changes are checked` };
}

/**
 * @param {string} root @param {CliOptions} opts @param {ReturnType<typeof loadGuardConfig>} loaded
 * @returns {{ pairs: import('./guard-core.mjs').FilePair[], base: string, note?: string }}
 */
export function collectPairs(root, opts, loaded) {
  const headRef = opts.head ?? 'HEAD';
  const { base, note } = resolveBase(root, { requested: opts.base, baseBranch: loaded.baseBranch, head: headRef });
  const diffArgs = ['diff', '--name-status', '-z', '-M', ...(opts.staged ? ['--cached'] : []), base, ...(opts.head ? [opts.head] : []), '--'];
  const rows = parseNameStatus(git(diffArgs, root));
  if (!opts.head && !opts.staged) {
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0').filter(Boolean).map(normPath);
    for (const p of untracked) if (!rows.some((r) => r.path === p)) rows.push({ status: 'A', oldPath: null, path: p });
  }
  const wanted = opts.files.length ? new Set(opts.files) : null;
  /** @type {import('./guard-core.mjs').FilePair[]} */
  const pairs = [];
  for (const row of rows) {
    if (wanted && !wanted.has(row.path) && !(row.oldPath && wanted.has(row.oldPath))) continue;
    if (!isTestFile(row.path, loaded.config) && !(row.oldPath && isTestFile(row.oldPath, loaded.config))) continue;
    const oldText = row.oldPath ? gitOrNull(['show', `${base}:${row.oldPath}`], root) : null;
    /** @type {string | null} */
    let newText = null;
    if (row.status !== 'D') {
      if (opts.head) newText = gitOrNull(['show', `${opts.head}:${row.path}`], root);
      else if (opts.staged) newText = gitOrNull(['show', `:${row.path}`], root);
      else {
        const abs = resolve(root, row.path);
        newText = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      }
      if (newText === null) continue;
    }
    pairs.push({ status: row.status, oldPath: row.oldPath, path: row.path, oldText, newText });
  }
  return { pairs, base, note };
}

/** @param {string} dir @param {string[]} out */
function listFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else if (e.isFile() && EXTS.has(extname(e.name))) out.push(full);
  }
}

/**
 * `--all`: line scanner over whole files plus the ratchet baseline.
 * @param {CliOptions} o @param {string} root @param {ReturnType<typeof loadGuardConfig>} loaded
 */
function runAll(o, root, loaded) {
  const dirList = o.dirs.length ? o.dirs : loaded.dirs.length ? loaded.dirs : DEFAULT_DIRS.filter((d) => existsSync(resolve(root, d))).slice(0, 1);
  const dirs = dirList.map((d) => resolve(root, d));
  if (dirs.length === 0 && o.extraFiles.length === 0) {
    console.error(`e2e-guard: no e2e directory found (tried ${DEFAULT_DIRS.join(', ')}); pass --dir <d>.`);
    return 2;
  }
  /** @type {string[]} */
  const all = [];
  for (const d of dirs) listFiles(d, all);
  for (const f of o.extraFiles) all.push(resolve(root, f));
  /** @type {import('./guard-core.mjs').Hit[]} */
  let hits = [];
  for (const full of [...new Set(all)]) {
    let src;
    try {
      if (!statSync(full).isFile()) continue;
      src = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    hits = hits.concat(scanSource(normPath(relative(root, full)), src));
  }
  const baselineName = o.baseline ?? loaded.baseline ?? 'e2e-guard.baseline.json';
  const baselineFile = resolve(root, baselineName);
  /** @type {any} */
  let baseline = null;
  if (existsSync(baselineFile)) {
    try {
      baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    } catch (err) {
      console.error(`e2e-guard: cannot parse ${baselineName}: ${/** @type {Error} */ (err).message}`);
      return 2;
    }
  }
  if (o.writeBaseline) {
    const { total, files } = countHard(hits);
    if (baseline && !o.allowRaise) {
      /** @type {string[]} */
      const raised = [];
      for (const [rule, perFile] of Object.entries(files)) for (const [file, n] of Object.entries(perFile)) if (n > (baseline.files?.[rule]?.[file] ?? 0)) raised.push(`${rule} in ${file}: ${baseline.files?.[rule]?.[file] ?? 0} -> ${n}`);
      if (raised.length) {
        console.error(`e2e-guard: refusing to raise the baseline (counts may only go down):\n  ${raised.join('\n  ')}\nFix them, or pass --allow-raise on the user's instruction.`);
        return 1;
      }
    }
    writeFileSync(baselineFile, `${JSON.stringify({ version: 1, note: 'e2e-guard ratchet: counts may only go down', counts: total, files }, null, 2)}\n`);
    console.log(`e2e-guard: wrote ${baselineName}: ${Object.entries(total).map(([k, v]) => `${k}=${v}`).join(', ') || 'no hard hits'}`);
    return 0;
  }
  const { failing, allowed, lowered } = judgeHits(hits, { baseline });
  const warns = hits.filter((h) => h.severity === 'warn');
  if (o.json) {
    console.log(JSON.stringify({ mode: 'all', failing, allowed: allowed.length, warnings: warns, lowered }, null, 2));
    return failing.length ? 1 : 0;
  }
  /** @param {import('./guard-core.mjs').Hit[]} list */
  const fmt = (list) => list.map((h) => `  ${h.file}:${h.line}  [${h.rule}]  ${h.text}`).join('\n');
  console.log(`e2e-guard ${VERSION} (--all; ${new Set(hits.map((h) => h.file)).size} files with hits)`);
  if (failing.length) console.log(`\nHARD FAILURES (${failing.length})${baseline ? ' above the baseline' : ''}:\n${fmt(failing)}`);
  if (allowed.length) console.log(`within the baseline (not failing): ${allowed.length}`);
  if (lowered.length) console.log(`\nbelow the baseline (lower it with --all --write-baseline):\n  ${lowered.join('\n  ')}`);
  const byRule = (/** @type {string} */ r) => warns.filter((h) => h.rule === r);
  if (byRule('skip').length) console.log(`\nWARN runtime-conditional skips (${byRule('skip').length}): each must show up in the evidence skipped count:\n${fmt(byRule('skip'))}`);
  if (byRule('first').length) console.log(`\nWARN .first() (${byRule('first').length}): fine for lists, wrong to dodge strict-mode duplicates; review by hand:\n${fmt(byRule('first'))}`);
  if (byRule('secret').length) console.log(`\nWARN password-like literals with placeholder values (${byRule('secret').length}): prefer values generated at run time (rule 13):\n${fmt(byRule('secret'))}`);
  console.log(`\n${failing.length ? 'FAILED' : 'PASSED'}: ${failing.length} hard failure(s), ${warns.length} warning(s)`);
  return failing.length ? 1 : 0;
}

/** @param {string[]} argv */
export function main(argv) {
  /** @type {CliOptions} */
  let o;
  try {
    o = parseGuardArgs(argv);
  } catch (err) {
    console.error(`e2e-guard: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  if (o.version) {
    console.log(VERSION);
    return 0;
  }
  try {
    const top = gitOrNull(['rev-parse', '--show-toplevel'], o.root ?? process.cwd())?.trim();
    const root = o.root ?? top ?? process.cwd();
    const loaded = loadGuardConfig(root, o.config);
    if (o.all) return runAll(o, root, loaded);
    if (!top) {
      console.error('e2e-guard: diff mode needs a git work tree; use --all.');
      return 2;
    }
    const { pairs, base, note } = collectPairs(root, o, loaded);
    const report = analyze(pairs, loaded.config);
    const payload = { ...report, base, mode: o.head ? 'range' : o.staged ? 'staged' : 'working-tree' };
    if (o.jsonFile) {
      const target = resolve(root, o.jsonFile);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
    }
    if (note) console.error(`e2e-guard: ${note}`);
    console.log(o.json ? JSON.stringify(payload, null, 2) : formatReport(report, { base: base.slice(0, 10) }));
    return report.ok ? 0 : 1;
  } catch (err) {
    const e = /** @type {Error & { stderr?: string }} */ (err);
    console.error(`e2e-guard: ${e.stderr?.trim() || e.message}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
