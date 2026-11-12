#!/usr/bin/env node
// @ts-check
// install.mjs: copies the test-gate kit (scripts, optional hook and e2e/app templates) into a target repo.
// Dry-run by default: it prints every file and what would happen. It never edits application code, package.json, .gitignore or
// .claude/settings.json unless the specific flag is given (--patch-package-json, --patch-gitignore); otherwise it prints the snippet.
// Plain ESM, Node 20+, no dependencies, no network, never deletes anything.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.2.0';
export const GROUPS = ['changed', 'hook', 'e2e', 'app'];

export const USAGE = `install.mjs ${VERSION}: install the test-gate kit into a repo (dry-run by default).

Usage: node install.mjs --target <repo> [--apply] [--overwrite] [--with <groups>] [--e2e-dir <d>] [--app-dir <d>]
                        [--patch-package-json] [--patch-gitignore] [--help]

Always installed (core): scripts/gate.mjs, gate-lib.mjs, e2e-guard.mjs, guard-core.mjs and kit.config.json (made from
kit.config.example.json; keys that still hold an unfilled <placeholder> are dropped and listed).
  --with <groups>       comma list of optional groups, or "all" (not app):
                          changed  scripts/e2e-changed.mjs + e2e-changed.map.json
                          hook     .claude/hooks/stop-gate.mjs (Claude Code Stop hook; the settings entry is printed, never applied)
                          e2e      the Playwright templates of kit/e2e, copied together (default dir: e2e)
                          app      the app-side templates of kit/app, copied together; needs --app-dir (it adds files to app code)
  --e2e-dir <d>         where the e2e group goes (default e2e);  --app-dir <d>  where the app group goes (no default)
  --apply               write the files that do not exist yet (without it nothing is written)
  --overwrite           also replace files that exist and differ (never without this flag)
  --patch-package-json  add the scripts gate, gate:guard (and e2e:changed) when absent; existing scripts are never changed
  --patch-gitignore     append .gate/ (and <e2e-dir>/.auth/ with the e2e group) when absent
The tool prints every file it would write or skip. Tell the user the list and get an OK before --apply. Exit codes: 0 ok, 2 usage error.`;

/**
 * @typedef {{ target?: string, apply: boolean, overwrite: boolean, withGroups: string[], e2eDir: string, appDir?: string,
 *   patchPackageJson: boolean, patchGitignore: boolean, help: boolean }} Options
 * @typedef {{ rel: string, content: string, status: 'new' | 'same' | 'differs', note: string, group: string }} Entry
 */

/** @param {string[]} argv @returns {Options} */
export function parseArgs(argv) {
  /** @type {Options} */
  const o = { apply: false, overwrite: false, withGroups: [], e2eDir: 'e2e', patchPackageJson: false, patchGitignore: false, help: false };
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
      case '--target': o.target = resolve(value()); break;
      case '--apply': o.apply = true; break;
      case '--overwrite': o.overwrite = true; break;
      case '--with': {
        for (const g of value().split(',').map((s) => s.trim()).filter(Boolean)) {
          if (g === 'all') o.withGroups.push('changed', 'hook', 'e2e');
          else if (GROUPS.includes(g)) o.withGroups.push(g);
          else throw new Error(`unknown group "${g}" (groups: ${GROUPS.join(', ')}, all)`);
        }
        break;
      }
      case '--e2e-dir': o.e2eDir = value().replace(/\\/g, '/').replace(/\/+$/, ''); break;
      case '--app-dir': o.appDir = value().replace(/\\/g, '/').replace(/\/+$/, ''); break;
      case '--patch-package-json': o.patchPackageJson = true; break;
      case '--patch-gitignore': o.patchGitignore = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`unknown argument "${a}" (see --help)`);
    }
  }
  o.withGroups = [...new Set(o.withGroups)];
  if (o.withGroups.includes('app') && !o.appDir) throw new Error('the app group needs --app-dir <dir> (it adds files to application code, so no default)');
  if (o.appDir && !o.withGroups.includes('app')) o.withGroups.push('app');
  return o;
}

const PLACEHOLDER = /<(?!pm>)[^<>\s]+>/;

/**
 * Drops every key (and array element) whose string value still holds an unfilled <placeholder>. `<pm>` is a template, not a placeholder.
 * @param {any} value @param {string} at @param {string[]} removed
 * @returns {any}
 */
function dropPlaceholders(value, at, removed) {
  if (typeof value === 'string') return PLACEHOLDER.test(value) ? undefined : value;
  if (Array.isArray(value)) {
    const kept = value.map((v, i) => dropPlaceholders(v, `${at}[${i}]`, removed)).filter((v) => v !== undefined);
    if (kept.length !== value.length) {
      removed.push(at);
      return kept.length ? kept : undefined;
    }
    return kept;
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '_notes') {
        out[k] = v;
        continue;
      }
      const r = dropPlaceholders(v, at ? `${at}.${k}` : k, removed);
      if (r === undefined) {
        if (!removed.includes(at ? `${at}.${k}` : k) && !removed.some((x) => x.startsWith(`${at ? `${at}.${k}` : k}[`))) removed.push(at ? `${at}.${k}` : k);
      } else out[k] = r;
    }
    return out;
  }
  return value;
}

/** @param {string} root @returns {string} package manager of the target (packageManager field, then lockfile, else npm) */
export function detectPm(root) {
  try {
    const m = /^(npm|pnpm|yarn|bun)@/.exec(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager ?? '');
    if (m) return /** @type {string} */ (m[1]);
  } catch {
    /* no readable package.json */
  }
  for (const [file, name] of [['pnpm-lock.yaml', 'pnpm'], ['package-lock.json', 'npm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']]) {
    if (existsSync(join(root, /** @type {string} */ (file)))) return /** @type {string} */ (name);
  }
  return 'npm';
}

/**
 * kit.config.json content made from the example. e2e.serverCommand is read raw by the Playwright templates, so its <pm> is
 * replaced here by the target's package manager.
 * With --e2e-dir, the example paths rooted at e2e/ (guard.dirs, guard.extraTestFiles, e2e.authRoles[].statePath) follow it.
 * @param {string} exampleText @param {string} [pm] @param {string} [e2eDir] @returns {{ text: string, removed: string[] }}
 */
export function fillConfig(exampleText, pm = 'npm', e2eDir = 'e2e') {
  /** @type {string[]} */
  const removed = [];
  const filled = dropPlaceholders(JSON.parse(exampleText), '', removed);
  if (typeof filled?.e2e?.serverCommand === 'string') filled.e2e.serverCommand = filled.e2e.serverCommand.replace(/<pm>/g, pm);
  if (e2eDir !== 'e2e') {
    /** @param {any} v @returns {any} */
    const remap = (v) => (typeof v === 'string' ? v.replace(/^e2e(?=\/|$)/, e2eDir) : v);
    if (Array.isArray(filled?.guard?.dirs)) filled.guard.dirs = filled.guard.dirs.map(remap);
    if (Array.isArray(filled?.guard?.extraTestFiles)) filled.guard.extraTestFiles = filled.guard.extraTestFiles.map(remap);
    if (Array.isArray(filled?.e2e?.authRoles)) for (const r of filled.e2e.authRoles) if (r && typeof r.statePath === 'string') r.statePath = remap(r.statePath);
  }
  return { text: `${JSON.stringify(filled, null, 2)}\n`, removed };
}

/** @param {string} dir @returns {string[]} files relative to dir, posix, sorted */
function listTree(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** @param {string} a @param {string} b */
function lineDelta(a, b) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const l of a.split(/\r?\n/)) counts.set(l, (counts.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b.split(/\r?\n/)) {
    const n = counts.get(l) ?? 0;
    if (n > 0) counts.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return `+${added} -${removed} lines`;
}

/**
 * Builds the list of files the install would write, with their status against the target. Reads only.
 * @param {Options} o @param {string} [kit]
 * @returns {{ entries: Entry[], removedKeys: string[], notes: string[] }}
 */
export function plan(o, kit = KIT) {
  const target = /** @type {string} */ (o.target);
  /** @type {Array<{ src: string, rel: string, group: string, transform?: (s: string) => string }>} */
  const items = [];
  /** @type {string[]} */
  const removedKeys = [];
  /** @type {string[]} */
  const notes = [];
  for (const f of ['gate.mjs', 'gate-lib.mjs', 'e2e-guard.mjs', 'guard-core.mjs']) items.push({ src: `scripts/${f}`, rel: `scripts/${f}`, group: 'core' });
  items.push({
    src: 'kit.config.example.json',
    rel: 'kit.config.json',
    group: 'core',
    transform: (s) => {
      const r = fillConfig(s, detectPm(target), o.e2eDir);
      removedKeys.push(...r.removed);
      return r.text;
    },
  });
  if (o.withGroups.includes('changed')) {
    items.push({ src: 'scripts/e2e-changed.mjs', rel: 'scripts/e2e-changed.mjs', group: 'changed' }, { src: 'e2e-changed.map.json', rel: 'e2e-changed.map.json', group: 'changed' });
  }
  if (o.withGroups.includes('hook')) items.push({ src: 'hooks/stop-gate.mjs', rel: '.claude/hooks/stop-gate.mjs', group: 'hook' });
  if (o.withGroups.includes('e2e')) {
    for (const f of listTree(join(kit, 'e2e'))) {
      if (/\.md$/i.test(f)) continue;
      items.push({ src: `e2e/${f}`, rel: `${o.e2eDir}/${f}`, group: 'e2e' });
    }
    notes.push(`${o.e2eDir}/playwright.config.snippet.ts is a snippet to merge into playwright.config.ts, not a config; auth.setup.ts imports goto-ready.ts, so the e2e group is installed whole`);
  }
  if (o.withGroups.includes('app') && o.appDir) {
    for (const f of listTree(join(kit, 'app'))) {
      if (/\.md$/i.test(f)) continue;
      items.push({ src: `app/${f}`, rel: `${o.appDir}/${f}`, group: 'app' });
    }
    notes.push(`${o.appDir}: the app templates are new files only; wiring them into the app (layout, routes) is a separate change that needs the user's OK`);
  }
  /** @type {Entry[]} */
  const entries = [];
  for (const it of items) {
    const srcPath = join(kit, it.src);
    if (!existsSync(srcPath)) {
      notes.push(`kit file missing, skipped: ${it.src}`);
      continue;
    }
    const raw = readFileSync(srcPath, 'utf8');
    const content = it.transform ? it.transform(raw) : raw;
    const dest = resolve(target, it.rel);
    if (dest !== target && !dest.startsWith(target + sep)) throw new Error(`refusing to write outside the target: ${it.rel}`);
    let status = /** @type {'new' | 'same' | 'differs'} */ ('new');
    let note = '';
    if (existsSync(dest)) {
      const cur = readFileSync(dest, 'utf8');
      if (cur.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) status = 'same';
      else {
        status = 'differs';
        note = lineDelta(cur, content);
      }
    }
    entries.push({ rel: it.rel, content, status, note, group: it.group });
  }
  return { entries, removedKeys, notes };
}

/**
 * Scripts the patch would add. @param {Record<string, any>} pkg @param {Options} o
 * @returns {Record<string, string>}
 */
export function scriptsToAdd(pkg, o) {
  /** @type {Record<string, string>} */
  const want = { gate: 'node scripts/gate.mjs', 'gate:guard': 'node scripts/e2e-guard.mjs' };
  if (o.withGroups.includes('changed')) want['e2e:changed'] = 'node scripts/e2e-changed.mjs';
  /** @type {Record<string, string>} */
  const add = {};
  for (const [k, v] of Object.entries(want)) if (!(pkg.scripts && k in pkg.scripts)) add[k] = v;
  return add;
}

/** @param {Options} o @returns {string[]} */
export function gitignoreLines(o) {
  return ['.gate/', ...(o.withGroups.includes('e2e') ? [`${o.e2eDir}/.auth/`] : [])];
}

/** @param {string[]} argv @param {(s: string) => void} [out] @returns {number} */
export function main(argv, out = (s) => console.log(s)) {
  /** @type {Options} */
  let o;
  try {
    o = parseArgs(argv);
  } catch (err) {
    console.error(`install: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  if (o.help) {
    out(USAGE);
    return 0;
  }
  if (!o.target) {
    console.error(`install: --target <repo> is required\n\n${USAGE}`);
    return 2;
  }
  if (!existsSync(o.target) || !statSync(o.target).isDirectory()) {
    console.error(`install: target is not a directory: ${o.target}`);
    return 2;
  }
  const pkgPath = join(o.target, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error(`install: no package.json in ${o.target}; the kit needs a JS/TS repo root`);
    return 2;
  }
  let result;
  try {
    result = plan(o);
  } catch (err) {
    console.error(`install: ${/** @type {Error} */ (err).message}`);
    return 2;
  }
  const { entries, removedKeys, notes } = result;
  out(`test-gate kit installer ${VERSION}: ${o.apply ? 'APPLY' : 'DRY RUN (nothing is written)'}  target: ${o.target}`);
  out(`groups: core${o.withGroups.length ? `, ${o.withGroups.join(', ')}` : ''}${o.overwrite ? '   (--overwrite on)' : ''}\n`);
  let written = 0;
  for (const e of entries) {
    const willWrite = e.status === 'new' || (e.status === 'differs' && o.overwrite);
    const label = e.status === 'new' ? 'new' : e.status === 'same' ? 'same' : o.overwrite ? 'replace' : 'differs';
    const tail = e.status === 'differs' ? (o.overwrite ? `  (${e.note})` : `  (${e.note}; kept, use --overwrite to replace)`) : e.status === 'same' ? '  (identical, skipped)' : `  (${Buffer.byteLength(e.content)} bytes)`;
    out(`  [${label.padEnd(7)}] ${e.rel}${tail}`);
    if (o.apply && willWrite) {
      const dest = resolve(/** @type {string} */ (o.target), e.rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, e.content);
      written++;
    }
  }
  if (removedKeys.length) out(`\nkit.config.json: dropped keys with an unfilled <placeholder> (fill them in by hand if needed): ${removedKeys.join(', ')}`);
  for (const n of notes) out(`note: ${n}`);

  // package.json
  const pkgText = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgText);
  const add = scriptsToAdd(pkg, o);
  const addList = Object.entries(add).map(([k, v]) => `"${k}": "${v}"`);
  if (addList.length === 0) out('\npackage.json: the gate scripts already exist, nothing to add');
  else if (o.patchPackageJson) {
    out(`\npackage.json: ${o.apply ? 'adding' : 'would add'} scripts ${addList.join(', ')}`);
    if (o.apply) {
      const indent = /^\t/m.test(pkgText) ? '\t' : (/^( +)"/m.exec(pkgText)?.[1] ?? '  ');
      pkg.scripts = { ...(pkg.scripts ?? {}), ...add };
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, indent)}${pkgText.endsWith('\n') ? '\n' : ''}`);
    }
  } else out(`\npackage.json is not edited. Add these scripts yourself (or pass --patch-package-json):\n  ${addList.join('\n  ')}`);

  // .gitignore
  const giPath = join(o.target, '.gitignore');
  const giText = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
  const have = new Set(giText.split(/\r?\n/).map((l) => l.trim()));
  const missing = gitignoreLines(o).filter((l) => !have.has(l) && !have.has(l.replace(/\/$/, '')));
  if (missing.length === 0) out('.gitignore: already ignores the gate output');
  else if (o.patchGitignore) {
    out(`.gitignore: ${o.apply ? 'appending' : 'would append'} ${missing.join(', ')}`);
    if (o.apply) writeFileSync(giPath, `${giText}${giText && !giText.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  } else out(`.gitignore is not edited. Add: ${missing.join(', ')} (or pass --patch-gitignore)`);

  if (o.withGroups.includes('hook')) {
    const snippet = readFileSync(join(KIT, 'hooks', 'settings.snippet.json'), 'utf8');
    out(`\n.claude/settings.json is never edited. Merge this Stop hook entry into it:\n${snippet.trimEnd()}`);
  }
  out(`\n${o.apply ? `Wrote ${written} file(s).` : 'Nothing written.'} Application code, playwright.config.ts and CI files are never touched.`);
  if (!o.apply) out('Re-run with --apply after the user has seen this list.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
