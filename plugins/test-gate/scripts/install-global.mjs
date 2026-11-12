#!/usr/bin/env node
// @ts-check
// install-global.mjs: installs the test-gate skill once for every agent on this machine (spec 2.2, decision D17).
//   1. copies skills/test-gate/ to ~/.agents/skills/test-gate/ (the one real copy, with a .installed-from file)
//   2. links ~/.claude/skills/test-gate and ~/.config/opencode/skills/test-gate to it (Windows: directory junctions)
//   3. adds { path: "~/.agents/skills", include_only: ["test-gate"] } to ~/.gemini/config/skills.json (Antigravity)
// Codex needs nothing (it reads ~/.agents/skills). Dry-run by default; --apply writes. It never deletes anything.
// Plain ESM, Node 20+, no dependencies, no network.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL = 'test-gate';
export const AGY_PATH = '~/.agents/skills';

export const USAGE = `install-global.mjs: install the ${SKILL} skill for Claude Code, Codex, opencode and Antigravity on this machine.

Usage: node install-global.mjs [--apply] [--home <dir>] [--source <dir>] [--copy] [--force-replace-link-only] [--help]

Plan (dry-run unless --apply):
  <home>/.agents/skills/${SKILL}                 the one real copy (plain copy + .installed-from); updated in place when it has
                                                 .installed-from; refused when it exists without it (not ours)
  <home>/.claude/skills/${SKILL}                 link to the copy (Windows: junction); a failed link falls back to a copy
  <home>/.config/opencode/skills/${SKILL}        same
  <home>/.gemini/config/skills.json              entry { "path": "${AGY_PATH}", "include_only": ["${SKILL}"] } (Antigravity); an
                                                 existing file is merged and a timestamped .bak copy is written first
Codex reads ${AGY_PATH} directly, so it needs nothing more.
  --home <dir>   use <dir> instead of the user's home (tests: a fake home)
  --source <dir> skill folder to install (default: ../skills/${SKILL} next to this script)
  --copy         copy into the Claude Code and opencode folders instead of linking (the copies are recorded in .installed-from)
  --force-replace-link-only
                 replace an existing link (or junction) that points somewhere else with a link to the copy. Only the link is
                 replaced, never its target. A real folder or file in the way is never replaced: move it yourself.
It never deletes files. Exit codes: 0 ok, 1 something was refused, 2 usage error.`;

/** @typedef {{ apply: boolean, home: string, source: string, copy: boolean, forceReplaceLinkOnly: boolean, help: boolean }} Options */

/** @param {string[]} argv @returns {Options} */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = { apply: false, home: homedir(), source: resolve(HERE, '..', 'skills', SKILL), copy: false, forceReplaceLinkOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq === -1 ? a : a.slice(0, eq);
    const value = () => {
      if (eq !== -1) return a.slice(eq + 1);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) throw new Error(`${flag} needs a value`);
      i++;
      return n;
    };
    switch (flag) {
      case '--apply': o.apply = true; break;
      case '--home': o.home = resolve(value()); break;
      case '--source': o.source = resolve(value()); break;
      case '--copy': o.copy = true; break;
      case '--force-replace-link-only': o.forceReplaceLinkOnly = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown argument "${a}" (see --help)`);
    }
  }
  return o;
}

/** @param {string} p @returns {import('node:fs').Stats | null} */
function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** Every file under dir (relative, posix), sorted. @param {string} dir @returns {string[]} */
export function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.installed-from') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** Hash of the names and contents of the installed files (drift detection). @param {string} dir */
export function contentHash(dir) {
  const h = createHash('sha256');
  for (const f of listFiles(dir)) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

/** @param {string} source */
function sourceInfo(source) {
  /** @type {{ commit: string, dirty: boolean | null }} */
  let git = { commit: 'unknown', dirty: null };
  try {
    const run = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git = { commit: run(['rev-parse', 'HEAD']), dirty: run(['status', '--porcelain']) !== '' };
  } catch {
    /* not a git work tree */
  }
  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(resolve(source, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? 'unknown';
  } catch {
    /* no plugin.json next to the skill */
  }
  return { ...git, version };
}

/**
 * @typedef {{ kind: string, path: string, action: 'create' | 'update' | 'ok' | 'refuse' | 'replace-link', detail: string }} Step
 */

/**
 * Plans the three parts. Reads only (it may call git in the source folder).
 * @param {Options} o
 */
export function plan(o) {
  const copyDir = join(o.home, '.agents', 'skills', SKILL);
  const claudeDir = join(o.home, '.claude', 'skills', SKILL);
  const opencodeDir = join(o.home, '.config', 'opencode', 'skills', SKILL);
  const skillsJson = join(o.home, '.gemini', 'config', 'skills.json');
  /** @type {Step[]} */
  const steps = [];

  if (!existsSync(join(o.source, 'SKILL.md'))) {
    steps.push({ kind: 'copy', path: copyDir, action: 'refuse', detail: `source has no SKILL.md: ${o.source}` });
    return { steps, copyDir, claudeDir, opencodeDir, skillsJson };
  }

  // 1. the real copy
  const st = lstatOrNull(copyDir);
  const files = listFiles(o.source);
  if (!st) steps.push({ kind: 'copy', path: copyDir, action: 'create', detail: `copy ${files.length} files from ${o.source}` });
  else if (st.isSymbolicLink()) steps.push({ kind: 'copy', path: copyDir, action: 'refuse', detail: 'is a link; the real copy must be a folder (copying through a link would write somewhere else)' });
  else if (!st.isDirectory()) steps.push({ kind: 'copy', path: copyDir, action: 'refuse', detail: 'exists and is not a folder' });
  else if (existsSync(join(copyDir, '.installed-from'))) steps.push({ kind: 'copy', path: copyDir, action: 'update', detail: `overwrite ${files.length} files in place (extra files stay)` });
  else steps.push({ kind: 'copy', path: copyDir, action: 'refuse', detail: 'exists without .installed-from (not installed by this script); move it away first' });

  // 2. links (or copies with --copy) for Claude Code and opencode
  for (const [kind, p] of /** @type {Array<[string, string]>} */ ([['claude', claudeDir], ['opencode', opencodeDir]])) {
    const s = lstatOrNull(p);
    if (!s) steps.push({ kind, path: p, action: 'create', detail: o.copy ? 'copy of the skill folder' : `link -> ${copyDir}` });
    else if (s.isSymbolicLink()) {
      let same = false;
      try {
        same = existsSync(copyDir) && realpathSync(p) === realpathSync(copyDir);
      } catch {
        same = false;
      }
      if (same) steps.push({ kind, path: p, action: 'ok', detail: 'already a link to the copy' });
      else if (o.forceReplaceLinkOnly) steps.push({ kind, path: p, action: 'replace-link', detail: `link points elsewhere (${safeReadlink(p)}); replace the link only, its target stays` });
      else steps.push({ kind, path: p, action: 'refuse', detail: `link points elsewhere (${safeReadlink(p)}); pass --force-replace-link-only to replace the link (its target stays)` });
    } else if (s.isDirectory() && existsSync(join(p, '.installed-from')) && o.copy) steps.push({ kind, path: p, action: 'update', detail: 'previous copy of this script; overwrite files in place' });
    else steps.push({ kind, path: p, action: 'refuse', detail: 'a real folder or file exists here; it is never replaced, move it yourself' });
  }

  // 3. Antigravity skills.json
  steps.push(planSkillsJson(skillsJson));
  return { steps, copyDir, claudeDir, opencodeDir, skillsJson };
}

/** @param {string} p */
function safeReadlink(p) {
  try {
    return readlinkSync(p);
  } catch {
    return '?';
  }
}

/**
 * Merges the entry into the parsed skills.json. Pure. Returns the new object and what happened.
 * @param {any} current parsed file or null
 * @returns {{ next: any, change: 'create' | 'add-entry' | 'add-name' | 'ok' | 'refuse', detail: string }}
 */
export function mergeSkillsJson(current) {
  if (current === null) return { next: { entries: [{ path: AGY_PATH, include_only: [SKILL] }] }, change: 'create', detail: 'new file with one entry' };
  if (typeof current !== 'object' || Array.isArray(current)) return { next: current, change: 'refuse', detail: 'the file is not a JSON object' };
  if (current.entries !== undefined && !Array.isArray(current.entries)) return { next: current, change: 'refuse', detail: '"entries" is not an array' };
  const entries = Array.isArray(current.entries) ? current.entries : [];
  const norm = (/** @type {unknown} */ p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const found = entries.find((/** @type {any} */ e) => e && typeof e === 'object' && norm(e.path) === norm(AGY_PATH));
  if (!found) return { next: { ...current, entries: [...entries, { path: AGY_PATH, include_only: [SKILL] }] }, change: 'add-entry', detail: `entry added, ${entries.length} existing entries kept` };
  const excluded = Array.isArray(found.exclude) && found.exclude.some((/** @type {string} */ pat) => {
    try {
      return new RegExp(pat).test(SKILL);
    } catch {
      return false;
    }
  });
  if (excluded) return { next: current, change: 'refuse', detail: `the ${AGY_PATH} entry has an "exclude" pattern that matches ${SKILL}; edit it by hand` };
  if (!Array.isArray(found.include_only)) return { next: current, change: 'ok', detail: `the ${AGY_PATH} entry already loads every skill in it` };
  if (found.include_only.includes(SKILL)) return { next: current, change: 'ok', detail: `the ${AGY_PATH} entry already lists ${SKILL}` };
  const next = { ...current, entries: entries.map((/** @type {any} */ e) => (e === found ? { ...e, include_only: [...e.include_only, SKILL] } : e)) };
  return { next, change: 'add-name', detail: `${SKILL} appended to include_only of the ${AGY_PATH} entry` };
}

/** @param {string} file @returns {Step} */
function planSkillsJson(file) {
  /** @type {any} */
  let current = null;
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return { kind: 'agy', path: file, action: 'refuse', detail: `cannot parse the existing file: ${/** @type {Error} */ (err).message}` };
    }
  }
  const m = mergeSkillsJson(current);
  const action = m.change === 'refuse' ? 'refuse' : m.change === 'ok' ? 'ok' : current === null ? 'create' : 'update';
  return { kind: 'agy', path: file, action, detail: m.detail };
}

/** @param {string} target @param {string} linkPath */
function makeLink(target, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true });
  // 'junction' needs no admin rights on Windows and requires an absolute target; the type is ignored elsewhere.
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Removes only a link (never a folder with content). @param {string} p */
function removeLinkOnly(p) {
  const s = lstatSync(p);
  if (!s.isSymbolicLink()) throw new Error(`refusing to remove a non-link: ${p}`);
  try {
    unlinkSync(p);
  } catch {
    rmSync(p, { recursive: false, force: false }); // Windows junctions are removed like an empty folder
  }
}

/**
 * Applies the plan. Returns the list of what was done.
 * @param {Options} o @param {ReturnType<typeof plan>} pl
 * @returns {string[]}
 */
export function apply(o, pl) {
  /** @type {string[]} */
  const done = [];
  const byKind = (/** @type {string} */ k) => /** @type {Step} */ (pl.steps.find((s) => s.kind === k));
  const info = sourceInfo(o.source);
  /** @type {Record<string, string>} */
  const links = {};

  const copyStep = byKind('copy');
  if (copyStep.action === 'create' || copyStep.action === 'update') {
    mkdirSync(pl.copyDir, { recursive: true });
    cpSync(o.source, pl.copyDir, { recursive: true, force: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
    done.push(`${copyStep.action === 'create' ? 'created' : 'updated'} ${pl.copyDir}`);
  }
  const copyOk = copyStep.action !== 'refuse' && existsSync(join(pl.copyDir, 'SKILL.md'));

  for (const [kind, p] of /** @type {Array<[string, string]>} */ ([['claude', pl.claudeDir], ['opencode', pl.opencodeDir]])) {
    const s = byKind(kind);
    if (s.action === 'refuse' || s.action === 'ok') {
      if (s.action === 'ok') links[p] = 'link';
      continue;
    }
    if (!copyOk) {
      done.push(`skipped ${p}: the real copy is not in place`);
      continue;
    }
    if (s.action === 'replace-link') removeLinkOnly(p);
    if (o.copy) {
      mkdirSync(p, { recursive: true });
      cpSync(o.source, p, { recursive: true, force: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
      links[p] = 'copy';
      done.push(`copied ${p}`);
      continue;
    }
    try {
      makeLink(pl.copyDir, p);
      links[p] = 'link';
      done.push(`linked ${p} -> ${pl.copyDir}`);
    } catch (err) {
      // Link creation failed (permissions, filesystem): fall back to a copy and say so loudly.
      mkdirSync(p, { recursive: true });
      cpSync(o.source, p, { recursive: true, force: true, filter: (src) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(src) });
      links[p] = 'copy';
      done.push(`WARNING link failed (${/** @type {NodeJS.ErrnoException} */ (err).code ?? /** @type {Error} */ (err).message}); copied ${p} instead, recorded in .installed-from (re-run to refresh it)`);
    }
  }

  if (copyOk && (copyStep.action === 'create' || copyStep.action === 'update')) {
    const record = { skill: SKILL, source: o.source, ...info, contentHash: contentHash(o.source), installedAt: new Date().toISOString(), tool: 'install-global.mjs', links };
    writeFileSync(join(pl.copyDir, '.installed-from'), `${JSON.stringify(record, null, 2)}\n`);
    for (const [p, mode] of Object.entries(links)) if (mode === 'copy' && existsSync(p)) copyFileSync(join(pl.copyDir, '.installed-from'), join(p, '.installed-from'));
    done.push(`wrote ${join(pl.copyDir, '.installed-from')}`);
  } else if (copyOk) {
    for (const [p, mode] of Object.entries(links)) if (mode === 'copy' && existsSync(p) && existsSync(join(pl.copyDir, '.installed-from'))) copyFileSync(join(pl.copyDir, '.installed-from'), join(p, '.installed-from'));
  }

  const agy = byKind('agy');
  if (agy.action === 'create' || agy.action === 'update') {
    const existing = existsSync(pl.skillsJson) ? JSON.parse(readFileSync(pl.skillsJson, 'utf8')) : null;
    const m = mergeSkillsJson(existing);
    if (existing !== null) {
      const bak = `${pl.skillsJson}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      copyFileSync(pl.skillsJson, bak);
      done.push(`backed up ${pl.skillsJson} -> ${bak}`);
    }
    mkdirSync(dirname(pl.skillsJson), { recursive: true });
    writeFileSync(pl.skillsJson, `${JSON.stringify(m.next, null, 2)}\n`);
    done.push(`${agy.action === 'create' ? 'created' : 'updated'} ${pl.skillsJson} (${m.detail})`);
  }
  return done;
}

/** @param {string[]} argv @param {(s: string) => void} [out] @returns {number} */
export function main(argv, out = (s) => console.log(s)) {
  /** @type {Options} */
  let o;
  try {
    o = parseArgs(argv);
  } catch (err) {
    console.error(`install-global: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  const pl = plan(o);
  out(`install-global (${o.apply ? 'APPLY' : 'DRY RUN, nothing is written'})  home: ${o.home}\nsource: ${o.source}${o.copy ? '   (--copy: no links)' : ''}\n`);
  for (const s of pl.steps) out(`  [${s.action.padEnd(12)}] ${s.kind.padEnd(8)} ${s.path}\n                 ${s.detail}`);
  const refused = pl.steps.filter((s) => s.action === 'refuse');
  if (o.apply) {
    /** @type {string[]} */
    let done = [];
    try {
      done = apply(o, pl);
    } catch (err) {
      console.error(`install-global: failed: ${/** @type {Error} */ (err).message}`);
      return 1;
    }
    out(`\nDone:\n${done.map((d) => `  ${d}`).join('\n') || '  (nothing to do)'}`);
  } else out('\nNothing written. Re-run with --apply to perform the steps above.');
  if (refused.length) {
    out(`\n${refused.length} step(s) refused (see above); the rest was ${o.apply ? 'applied' : 'planned'}.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
