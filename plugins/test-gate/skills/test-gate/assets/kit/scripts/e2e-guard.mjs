#!/usr/bin/env node
// @ts-check
// e2e-guard.mjs: static guard for e2e specs. HARD failures (waitForTimeout, networkidle, toPass, fixme, unconditional skip,
// retries above 0, secret-looking literals) fail the run unless approved in .gate/approvals.json or within the ratchet baseline
// e2e-guard.baseline.json (counts may only go down). WARNINGS (runtime-conditional test.skip(cond, ...), .first()) are listed only.
// Comments are ignored. Plain ESM, Node 20+, no dependencies.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const VERSION = '0.1.0';
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'coverage', 'playwright-report', 'test-results', '.auth']);
const DEFAULT_DIRS = ['e2e', 'tests/e2e', 'test/e2e', 'apps/web/e2e'];
export const HARD_RULES = ['waitForTimeout', 'networkidle', 'toPass', 'fixme', 'skip', 'retries', 'secret'];

const USAGE = `e2e-guard.mjs ${VERSION}: static guard for e2e specs.

Usage:
  node e2e-guard.mjs [--all | --base <ref>] [--dir <d>]... [--file <f>]... [--root <dir>] [--baseline <file>] [--approvals <file>]
                     [--write-baseline [--allow-raise]] [--json] [--help]

Modes
  default       scans the files changed in the working tree (git diff -U0 HEAD, or against --base <ref>) plus untracked files
                inside the scanned dirs; only ADDED lines can fail. New code gets no baseline allowance.
  --all         scans every file of the scanned dirs; hard hits above the baseline (e2e-guard.baseline.json) fail.
Scanned dirs: --dir (repeatable), else the first existing of ${DEFAULT_DIRS.join(', ')}. --file adds single files (for example playwright.config.ts).

HARD (exit 1): waitForTimeout, 'networkidle', toPass, .fixme(, unconditional skip (test.skip('title', ...), test.skip(), skip(true),
  test.describe.skip, it.skip, describe.skip), retries above 0, secret-looking literal assignments.
WARN (listed, exit 0): runtime-conditional test.skip(cond, reason) (also "if (c) test.skip(true, reason)"), .first(), and
  password-like literals whose value looks like a placeholder (hyphenated words).

Approvals: .gate/approvals.json = [{ "rule", "file", "text"?, "reason", "approvedBy": "user"|"orchestrator", "approvalRef" }].
  A hard hit is allowed when an approval matches rule + file (and, when given, "text" is contained in the line).
Baseline: --write-baseline writes e2e-guard.baseline.json with per-rule, per-file counts; it refuses to raise an existing count
  unless --allow-raise. Counts may only go down. Exit codes: 0 clean, 1 hard failures, 2 usage error.`;

/**
 * @typedef {{ rule: string, severity: 'hard' | 'warn', file: string, line: number, text: string }} Hit
 */

/**
 * Blanks comments (keeps newlines and string contents) so line numbers survive.
 * @param {string} src
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  /** @type {string | null} */
  let quote = null;
  while (i < src.length) {
    const c = /** @type {string} */ (src[i]);
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && n !== undefined) {
        out += n;
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < src.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i++;
  }
  return out;
}

/**
 * First argument text of the call whose "(" is at `open`, or null when the call has no arguments.
 * @param {string} text @param {number} open
 */
function firstArg(text, open) {
  let depth = 0;
  /** @type {string | null} */
  let quote = null;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = /** @type {string} */ (text[i]);
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i).trim() || null;
    } else if (c === ',' && depth === 1) return text.slice(start, i).trim();
  }
  return text.slice(start).trim() || null;
}

/** Hyphenated words with at least two alphabetic segments ('local-dev-password-123'): a human placeholder, not a key. @param {string} v */
function isPlaceholder(v) {
  const parts = v.split('-');
  return parts.length >= 3 && parts.every((p) => /^[a-z0-9]+$/i.test(p)) && parts.filter((p) => /^[a-z]{3,}$/i.test(p)).length >= 2;
}

const SECRET_NAME =/(pass(?:word|wd)?|secret|api[_-]?key|token|authorization|private[_-]?key)/i;

/**
 * Scans one file's source (comments are ignored).
 * @param {string} file posix path used in the report
 * @param {string} source
 * @returns {Hit[]}
 */
export function scanSource(file, source) {
  const text = stripComments(source);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  /** @param {number} offset */
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (/** @type {number} */ (lineStarts[mid]) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const srcLines = source.split(/\r?\n/);
  /** @type {Hit[]} */
  const hits = [];
  /** @param {string} rule @param {'hard' | 'warn'} severity @param {number} offset */
  const add = (rule, severity, offset) => {
    const line = lineOf(offset);
    hits.push({ rule, severity, file, line, text: (srcLines[line - 1] ?? '').trim().slice(0, 160) });
  };
  for (const m of text.matchAll(/\.waitForTimeout\s*\(/g)) add('waitForTimeout', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/['"`]networkidle['"`]/g)) add('networkidle', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\.toPass\s*\(/g)) add('toPass', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\.fixme\s*\(/g)) add('fixme', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\bretries\s*:\s*([^,}\n]*)/g)) {
    if (/\b[1-9]\d*\b/.test(/** @type {string} */ (m[1]))) add('retries', 'hard', m.index ?? 0);
  }
  for (const m of text.matchAll(/\bdescribe(?:\.\w+)*\.skip\b/g)) add('skip', 'hard', m.index ?? 0);
  for (const m of text.matchAll(/\b(?:test|it)\.skip\b(\s*\()?/g)) {
    if (!m[1]) continue; // a bare reference, not a call
    const idx = m.index ?? 0;
    const arg = firstArg(text, idx + m[0].length - 1);
    // No argument, a string title or a literal true: the test never runs. Anything else is decided at run time.
    const lineStart = text.lastIndexOf('\n', idx) + 1;
    // `if (cond) test.skip(true, 'why')` is decided at run time, whatever the literal says.
    const guarded = /\bif\s*\(.*\)\s*$|&&\s*$|\?\s*$/.test(text.slice(lineStart, idx));
    const unconditional = !guarded && (arg === null || /^['"`]/.test(arg) || arg === 'true');
    add('skip', unconditional ? 'hard' : 'warn', idx);
  }
  for (const m of text.matchAll(/\.first\s*\(\s*\)/g)) add('first', 'warn', m.index ?? 0);
  for (const m of text.matchAll(/(['"]?)([A-Za-z_][\w-]*)\1\s*[:=]\s*(['"`])([^'"`\s$\\]{8,})\3/g)) {
    if (!SECRET_NAME.test(/** @type {string} */ (m[2]))) continue;
    const lineText = srcLines[lineOf(m.index ?? 0) - 1] ?? '';
    if (/process\.env|import\.meta\.env/.test(lineText)) continue;
    // Placeholder-style values (hyphenated words such as 'local-dev-password-123') only warn: rule 13 still says to generate
    // values at run time. Any other password-like literal is a hard failure.
    add('secret', isPlaceholder(/** @type {string} */ (m[4])) ? 'warn' : 'hard', m.index ?? 0);
  }
  for (const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|\bsk_(?:live|test)_[A-Za-z0-9]{12,}|\bAKIA[0-9A-Z]{16}\b/g)) add('secret', 'hard', m.index ?? 0);
  // One line may match two secret patterns: keep one hit per rule and line.
  const seen = new Set();
  return hits
    .filter((h) => {
      const key = `${h.rule}:${h.line}:${h.severity}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
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

/** @param {string} p */
const posix = (p) => p.split('\\').join('/');

/** An approval needs a real approver and reference (decision D5). @param {any} a */
export function isValidApproval(a) {
  return Boolean(a) && ['user', 'orchestrator'].includes(a.approvedBy) && typeof a.approvalRef === 'string' && a.approvalRef.trim() !== '' && typeof a.rule === 'string' && typeof a.file === 'string';
}

/**
 * @param {Hit} hit @param {any[]} approvals
 */
export function isApproved(hit, approvals) {
  return approvals.some((a) => isValidApproval(a) && a.rule === hit.rule && posix(a.file) === hit.file && (!a.text || hit.text.includes(a.text)));
}

/**
 * Counts of hard hits per rule and per file.
 * @param {Hit[]} hits
 */
export function countHard(hits) {
  /** @type {Record<string, number>} */
  const total = {};
  /** @type {Record<string, Record<string, number>>} */
  const files = {};
  for (const h of hits) {
    if (h.severity !== 'hard') continue;
    total[h.rule] = (total[h.rule] ?? 0) + 1;
    const perFile = (files[h.rule] ??= {});
    perFile[h.file] = (perFile[h.file] ?? 0) + 1;
  }
  return { total, files };
}

/**
 * Applies approvals and the ratchet baseline to the hard hits.
 * @param {Hit[]} hits @param {{ approvals: any[], baseline: any | null }} ctx
 * @returns {{ failing: Hit[], allowed: Hit[], approved: Hit[], lowered: string[] }}
 */
export function judgeHits(hits, { approvals, baseline }) {
  const hard = hits.filter((h) => h.severity === 'hard');
  const approved = hard.filter((h) => isApproved(h, approvals));
  const open = hard.filter((h) => !isApproved(h, approvals));
  if (!baseline) return { failing: open, allowed: [], approved, lowered: [] };
  const { files } = countHard(open);
  /** @type {Hit[]} */
  const failing = [];
  /** @type {Hit[]} */
  const allowed = [];
  for (const h of open) {
    const base = baseline.files?.[h.rule]?.[h.file] ?? 0;
    const now = files[h.rule]?.[h.file] ?? 0;
    // Over its baseline: every hit of that rule in that file is listed (which one is new cannot be told from counts alone).
    if (now > base) failing.push(h);
    else allowed.push(h);
  }
  /** @type {string[]} */
  const lowered = [];
  for (const [rule, perFile] of Object.entries(baseline.files ?? {})) {
    for (const [file, n] of Object.entries(/** @type {Record<string, number>} */ (perFile))) {
      const now = files[rule]?.[file] ?? 0;
      if (now < n) lowered.push(`${rule} in ${file}: ${n} -> ${now}`);
    }
  }
  return { failing, allowed, approved, lowered };
}

/** @param {string[]} argv */
export function parseGuardArgs(argv) {
  const o = { all: false, base: /** @type {string | undefined} */ (undefined), dirs: /** @type {string[]} */ ([]), files: /** @type {string[]} */ ([]), root: process.cwd(), baseline: 'e2e-guard.baseline.json', approvals: '.gate/approvals.json', writeBaseline: false, allowRaise: false, json: false, help: false };
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
      case '--dir': o.dirs.push(value()); break;
      case '--file': o.files.push(value()); break;
      case '--root': o.root = resolve(value()); break;
      case '--baseline': o.baseline = value(); break;
      case '--approvals': o.approvals = value(); break;
      case '--write-baseline': o.writeBaseline = true; break;
      case '--allow-raise': o.allowRaise = true; break;
      case '--json': o.json = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown argument "${raw}" (see --help)`);
    }
  }
  if (o.all && o.base) throw new Error('--all and --base cannot be combined');
  if (o.writeBaseline && !o.all) throw new Error('--write-baseline needs --all');
  return o;
}

/**
 * Added line numbers per file from `git diff -U0` output.
 * @param {string} diff
 * @returns {Map<string, Set<number>>}
 */
export function parseAddedLines(diff) {
  /** @type {Map<string, Set<number>>} */
  const out = new Map();
  /** @type {string | null} */
  let file = null;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      if (file && !out.has(file)) out.set(file, new Set());
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let k = 0; k < count; k++) out.get(file)?.add(start + k);
    }
  }
  return out;
}

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  /** @type {ReturnType<typeof parseGuardArgs>} */
  let o;
  try {
    o = parseGuardArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`e2e-guard: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    console.log(USAGE);
    return 0;
  }
  const dirs = (o.dirs.length ? o.dirs : DEFAULT_DIRS.filter((d) => existsSync(resolve(o.root, d))).slice(0, 1)).map((d) => resolve(o.root, d));
  if (dirs.length === 0 && o.files.length === 0) {
    console.error(`e2e-guard: no e2e directory found (tried ${DEFAULT_DIRS.join(', ')}); pass --dir <d>.`);
    return 2;
  }
  /** @type {string[]} */
  const all = [];
  for (const d of dirs) listFiles(d, all);
  for (const f of o.files) all.push(resolve(o.root, f));

  /** @type {Map<string, Set<number>> | null} */
  let added = null;
  /** @type {Set<string>} */
  const untracked = new Set();
  if (!o.all) {
    try {
      added = parseAddedLines(git(['diff', '-U0', '--no-color', o.base ?? 'HEAD', '--'], o.root));
      for (const f of git(['ls-files', '--others', '--exclude-standard'], o.root).split(/\r?\n/).filter(Boolean)) untracked.add(f);
    } catch (err) {
      console.error(`e2e-guard: diff mode needs a git work tree (${/** @type {Error} */ (err).message.split('\n')[0]}); use --all.`);
      return 2;
    }
  }

  /** @type {Hit[]} */
  let hits = [];
  for (const full of [...new Set(all)]) {
    const rel = posix(relative(o.root, full));
    if (added && !untracked.has(rel) && !added.has(rel)) continue;
    let src;
    try {
      if (!statSync(full).isFile()) continue;
      src = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    let found = scanSource(rel, src);
    const lines = added?.get(rel);
    if (added && !untracked.has(rel) && lines) found = found.filter((h) => lines.has(h.line));
    hits = hits.concat(found);
  }

  let approvals = [];
  const approvalsFile = resolve(o.root, o.approvals);
  if (existsSync(approvalsFile)) {
    try {
      const parsed = JSON.parse(readFileSync(approvalsFile, 'utf8'));
      approvals = Array.isArray(parsed) ? parsed : Array.isArray(parsed.approvals) ? parsed.approvals : [];
    } catch (err) {
      console.error(`e2e-guard: cannot parse ${o.approvals}: ${/** @type {Error} */ (err).message}`);
      return 2;
    }
  }
  const baselineFile = resolve(o.root, o.baseline);
  /** @type {any} */
  let baseline = null;
  if (existsSync(baselineFile)) {
    try {
      baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
    } catch (err) {
      console.error(`e2e-guard: cannot parse ${o.baseline}: ${/** @type {Error} */ (err).message}`);
      return 2;
    }
  }

  if (o.writeBaseline) {
    const { total, files } = countHard(hits.filter((h) => !isApproved(h, approvals)));
    if (baseline && !o.allowRaise) {
      const raised = [];
      for (const [rule, perFile] of Object.entries(files)) for (const [file, n] of Object.entries(perFile)) if (n > (baseline.files?.[rule]?.[file] ?? 0)) raised.push(`${rule} in ${file}: ${baseline.files?.[rule]?.[file] ?? 0} -> ${n}`);
      if (raised.length) {
        console.error(`e2e-guard: refusing to raise the baseline (counts may only go down):\n  ${raised.join('\n  ')}\nFix them, or add an approval to .gate/approvals.json, or pass --allow-raise on the user's instruction.`);
        return 1;
      }
    }
    writeFileSync(baselineFile, `${JSON.stringify({ version: 1, note: 'e2e-guard ratchet: counts may only go down', counts: total, files }, null, 2)}\n`);
    console.log(`e2e-guard: wrote ${o.baseline}: ${Object.entries(total).map(([k, v]) => `${k}=${v}`).join(', ') || 'no hard hits'}`);
    return 0;
  }

  const useBaseline = o.all ? baseline : null;
  const { failing, allowed, approved, lowered } = judgeHits(hits, { approvals, baseline: useBaseline });
  const warns = hits.filter((h) => h.severity === 'warn');
  if (o.json) {
    console.log(JSON.stringify({ mode: o.all ? 'all' : 'diff', failing, allowed: allowed.length, approved: approved.length, warnings: warns, lowered }, null, 2));
    return failing.length ? 1 : 0;
  }
  /** @param {Hit[]} list */
  const fmt = (list) => list.map((h) => `  ${h.file}:${h.line}  [${h.rule}]  ${h.text}`).join('\n');
  console.log(`e2e-guard ${VERSION} (${o.all ? '--all' : 'diff mode'}; ${new Set(hits.map((h) => h.file)).size} files with hits)`);
  if (failing.length) console.log(`\nHARD FAILURES (${failing.length})${useBaseline ? ' above the baseline' : ''}:\n${fmt(failing)}`);
  if (approved.length) console.log(`\napproved by .gate/approvals.json: ${approved.length}`);
  if (allowed.length) console.log(`within the baseline (not failing): ${allowed.length}`);
  if (lowered.length) console.log(`\nbelow the baseline (lower it with --all --write-baseline):\n  ${lowered.join('\n  ')}`);
  const byRule = (/** @type {string} */ r) => warns.filter((h) => h.rule === r);
  if (byRule('skip').length) console.log(`\nWARN runtime-conditional skips (${byRule('skip').length}): each must show up in the evidence skipped count:\n${fmt(byRule('skip'))}`);
  if (byRule('first').length) console.log(`\nWARN .first() (${byRule('first').length}): fine for lists, wrong to dodge strict-mode duplicates; review by hand:\n${fmt(byRule('first'))}`);
  if (byRule('secret').length) console.log(`\nWARN password-like literals with placeholder values (${byRule('secret').length}): prefer values generated at run time (rule 13):\n${fmt(byRule('secret'))}`);
  console.log(`\n${failing.length ? 'FAILED' : 'PASSED'}: ${failing.length} hard failure(s), ${warns.length} warning(s)`);
  return failing.length ? 1 : 0;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
