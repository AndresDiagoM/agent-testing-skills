// Run: node --test scripts/kit-tools.test.mjs   (node:test, no dependencies)
// Tests of e2e-changed.mjs (mapping, dry run), hooks/stop-gate.mjs (planning, budget, exit codes) and install.mjs (dry-run, apply,
// overwrite, patches) on throwaway directories.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCommand, mapChangedToSpecs } from './e2e-changed.mjs';
import { chunkArgs, expandPm, guardBase, isGuardedTestFile, main as stopMain, packageOf, parseBudget, planTasks, truncateOutput } from '../hooks/stop-gate.mjs';
import { detectPm, fillConfig, gitignoreLines, main as installMain, parseArgs as parseInstallArgs, plan as installPlan, scriptsToAdd } from '../install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const KIT = join(here, '..');
const dirs = [];
const tmp = (prefix = 'kit-tools-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const write = (root, rel, content) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), content));
const gitIn = (dir, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
const gitRepo = (files = {}) => {
  const dir = tmp();
  gitIn(dir, 'init', '-q', '-b', 'main');
  write(dir, 'package.json', JSON.stringify({ name: 'x', packageManager: 'pnpm@12.0.0' }));
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '-m', 'base');
  return dir;
};
const listAll = (root) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(relative(root, f).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
};

// ------------------------------------------------------------------------------------------------------------ e2e-changed

describe('e2e-changed mapping', () => {
  const map = JSON.parse(readFileSync(join(KIT, 'e2e-changed.map.json'), 'utf8'));
  const specs = ['auth.spec.ts', 'dashboard.spec.ts', 'settings.spec.ts', 'sub/deep.spec.ts'];
  it('the shipped example parses and maps a route to its specs', () => {
    const s = mapChangedToSpecs(['src/app/dashboard/page.tsx'], specs, map);
    assert.deepEqual(s.specs, ['dashboard.spec.ts']);
    assert.equal(s.all, false);
  });
  it('a changed spec selects itself (nested too); a deleted spec is dropped', () => {
    assert.deepEqual(mapChangedToSpecs(['e2e/sub/deep.spec.ts', 'e2e/gone.spec.ts'], specs, map).specs, ['sub/deep.spec.ts']);
  });
  it('shared e2e files and playwright config select the whole suite with the reason', () => {
    for (const f of ['e2e/fixtures.ts', 'playwright.config.ts', 'e2e/helpers/x.ts']) {
      const s = mapChangedToSpecs([f], specs, map);
      assert.equal(s.all, true, f);
      assert.deepEqual(s.specs, [...specs].sort());
      assert.match(s.allReasons[0], /shared e2e infrastructure/);
    }
    assert.equal(mapChangedToSpecs(['e2e/.auth/owner.json'], specs, map).all, false);
  });
  it('a route marked ALL selects the whole suite; an unmapped app file falls back to the whole suite, never silently to nothing', () => {
    assert.equal(mapChangedToSpecs(['src/components/ui/button.tsx'], specs, map).all, true);
    const unknown = mapChangedToSpecs(['src/app/brand-new/page.tsx'], specs, map);
    assert.equal(unknown.all, true);
    assert.match(unknown.allReasons[0], /nothing can be ruled out/);
  });
  it('unit tests, docs and files outside the app are reported as unmapped and select nothing', () => {
    const s = mapChangedToSpecs(['src/lib/a.test.ts', 'README.md', 'docs/x.txt'], specs, map);
    assert.deepEqual(s.specs, []);
    assert.equal(s.all, false);
    assert.equal(s.unmapped.length, 3);
  });
  it('windows separators are normalised; several routes can add specs', () => {
    assert.deepEqual(mapChangedToSpecs(['src\\app\\settings\\page.tsx'], specs, map).specs, ['dashboard.spec.ts', 'settings.spec.ts']);
  });
  it('buildCommand fills <pm> exec and {specs}, quoting odd names', () => {
    assert.equal(buildCommand('<pm> exec playwright test --workers=1 {specs}', 'pnpm', 'e2e', ['a.spec.ts', 'my spec.spec.ts']), 'pnpm exec playwright test --workers=1 e2e/a.spec.ts "e2e/my spec.spec.ts"');
    assert.match(buildCommand('<pm> exec playwright test {specs}', 'npm', 'e2e/', ['a.spec.ts']), /^npm exec -- playwright test e2e\/a\.spec\.ts$/);
  });
  it('CLI --dry-run on a temp git repo prints the mapping and the command and runs nothing', () => {
    const dir = gitRepo({ 'e2e/a.spec.ts': '// a\n', 'e2e/b.spec.ts': '// b\n', 'src/app/dashboard/page.tsx': 'x\n', 'e2e-changed.map.json': JSON.stringify({ routes: [{ pattern: '^src/app/dashboard/', specs: ['b.spec.ts'] }], fullSuiteFallback: '^src/', command: '<pm> exec playwright test {specs}' }) });
    write(dir, 'src/app/dashboard/page.tsx', 'changed\n');
    const r = spawnSync(process.execPath, [join(here, 'e2e-changed.mjs'), '--dry-run'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /specs -> b\.spec\.ts/);
    assert.match(r.stdout, /pnpm exec playwright test e2e\/b\.spec\.ts/);
    assert.match(r.stdout, /E2E_REPEAT=3/);
    write(dir, 'src/other/x.ts', 'new\n');
    const full = spawnSync(process.execPath, [join(here, 'e2e-changed.mjs'), '--dry-run', '--repeat', '5'], { cwd: dir, encoding: 'utf8' });
    assert.match(full.stdout, /FULL suite/);
    assert.match(full.stdout, /E2E_REPEAT=5/);
  });
  it('CLI: nothing affected exits 0, a missing map and bad arguments exit 2', () => {
    const dir = gitRepo({ 'e2e/a.spec.ts': 'x\n', 'e2e-changed.map.json': '{}' });
    const none = spawnSync(process.execPath, [join(here, 'e2e-changed.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(none.status, 0);
    assert.match(none.stdout, /nothing to run/);
    assert.equal(spawnSync(process.execPath, [join(here, 'e2e-changed.mjs'), '--map', 'nope.json'], { cwd: dir, encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [join(here, 'e2e-changed.mjs'), '--repeat', '0'], { cwd: dir, encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [join(here, 'e2e-changed.mjs'), '--help'], { cwd: dir, encoding: 'utf8' }).status, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------- stop-gate

describe('stop-gate planning (pure)', () => {
  const pkgs = { '': { devDependencies: { eslint: '1', vitest: '1' }, scripts: { 'type-check': 'tsc' } }, 'apps/web': { scripts: { typecheck: 'tsc' } }, 'packages/a': { scripts: {} } };
  const ctx = (cfg, extra = {}) => ({ cfg, pm: 'pnpm', pkgJson: (d) => pkgs[d] ?? {}, ...extra });
  it('does nothing for docs only; the guard task appears for test files when the guard script exists', () => {
    assert.deepEqual(planTasks(['README.md'], ctx({ lintChanged: true })), []);
    const t = planTasks(['e2e/a.spec.ts'], ctx({ guard: true }, { guardBase: 'abc123' }));
    assert.deepEqual(t.map((x) => [x.name, x.cmds[0], x.infraCodes]), [['e2e-guard', 'node scripts/e2e-guard.mjs --base abc123', [2]]]);
    assert.deepEqual(planTasks(['e2e/a.spec.ts'], ctx({ guard: false })), []);
    assert.deepEqual(planTasks(['e2e/a.spec.ts'], ctx({}, { exists: (f) => f !== 'scripts/e2e-guard.mjs' })), []);
  });
  it('an unsafe base ref falls back to HEAD', () => {
    assert.match(planTasks(['a.test.ts'], ctx({}, { guardBase: 'x; rm' }))[0].cmds[0], /--base HEAD$/);
  });
  it('default commands: eslint on changed files, typecheck per package, vitest related per package (relative paths)', () => {
    const tasks = planTasks(['apps/web/src/a.ts', 'packages/a/b.ts', 'src/root.ts'], ctx({ lintChanged: true, typecheck: true, relatedTests: true, packages: ['apps/*', 'packages/*'] }));
    const by = Object.fromEntries(tasks.map((t) => [t.name, t]));
    assert.match(by.lint.cmds[0], /^pnpm exec eslint --no-warn-ignored "apps\/web\/src\/a\.ts" "packages\/a\/b\.ts" "src\/root\.ts"$/);
    assert.deepEqual([by['typecheck apps/web'].cmds, by['typecheck apps/web'].cwd], [['pnpm run typecheck'], 'apps/web']);
    assert.deepEqual([by['typecheck .'].cmds, by['typecheck .'].cwd], [['pnpm run type-check'], '']);
    assert.equal(by['typecheck packages/a'], undefined, 'no typecheck script there');
    assert.match(by['related tests apps/web'].cmds[0], /^pnpm exec vitest related --run --passWithNoTests "src\/a\.ts"$/);
    assert.equal(by['related tests apps/web'].cwd, 'apps/web');
  });
  it('disabled options and missing tools plan nothing; npm and yarn forms differ', () => {
    assert.deepEqual(planTasks(['src/a.ts'], ctx({})), []);
    assert.deepEqual(planTasks(['src/a.ts'], { cfg: { lintChanged: true }, pm: 'npm', pkgJson: () => ({}) }), [], 'no eslint dependency: skipped, not failed');
    const npm = planTasks(['src/a.ts'], { cfg: { lintChanged: true }, pm: 'npm', pkgJson: () => ({ devDependencies: { eslint: '1' } }) });
    assert.match(npm[0].cmds[0], /^npm exec -- eslint/);
    assert.equal(expandPm('yarn', '<pm> exec jest {files}'), 'yarn exec jest {files}');
  });
  it('custom command strings get <pm>, {files} and {pkg}', () => {
    const tasks = planTasks(['src/a.ts'], ctx({ lintChanged: '<pm> exec biome check {files}', typecheck: 'tsc -p {pkg}', relatedTests: '<pm> exec jest --findRelatedTests {files}' }));
    assert.deepEqual(tasks.map((t) => t.cmds[0]), ['pnpm exec biome check "src/a.ts"', 'tsc -p .', 'pnpm exec jest --findRelatedTests "src/a.ts"']);
  });
  it('helpers: packageOf, chunkArgs, truncateOutput, parseBudget, isGuardedTestFile', () => {
    assert.equal(packageOf('apps/web/x.ts', ['apps/*']), 'apps/web');
    assert.equal(packageOf('x.ts', ['apps/*']), '');
    assert.equal(packageOf('apps/x.ts', ['apps/*']), '', 'a file directly in apps/ is not in a package');
    assert.equal(chunkArgs(['a'.repeat(5000), 'b'.repeat(5000)]).length, 2);
    assert.match(truncateOutput(Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'), 5), /95 more lines/);
    assert.equal(parseBudget({}), 90000);
    assert.equal(parseBudget({}, 5000), 5000);
    assert.equal(parseBudget({ STOP_GATE_BUDGET_MS: '123' }, 5000), 123);
    assert.equal(isGuardedTestFile('e2e/helpers/x.ts'), true);
    assert.equal(isGuardedTestFile('src/a.ts'), false);
  });
});

describe('stop-gate main(): exit codes, budget, switches', () => {
  const FAIL = 'node -e "console.error(\'boom\'); process.exit(1)" -- {files}';
  const OK = 'node -e "process.exit(0)" -- {files}';
  const setup = (stopGate, withChange = true) => {
    const dir = gitRepo({ 'kit.config.json': JSON.stringify({ stopGate }), 'src/a.ts': 'export const a = 1;\n' });
    if (withChange) write(dir, 'src/a.ts', 'export const a = 2;\n');
    return dir;
  };
  const input = (dir, extra = {}) => JSON.stringify({ cwd: dir, ...extra });
  const go = async (dir, env = {}, extra = {}) => {
    const err = [];
    const code = await stopMain(input(dir, extra), env, { write: (s) => err.push(s) });
    return { code, err: err.join('') };
  };
  it('a failing command blocks with exit 2 and shows its output; a passing one lets the agent stop', async () => {
    const bad = await go(setup({ lintChanged: FAIL }));
    assert.equal(bad.code, 2);
    assert.match(bad.err, /lint FAILED/);
    assert.match(bad.err, /boom/);
    assert.equal((await go(setup({ lintChanged: OK }))).code, 0);
  });
  it('STOP_GATE=off, stop_hook_active, no changes, no git and bad input all exit 0', async () => {
    assert.equal((await go(setup({ lintChanged: FAIL }), { STOP_GATE: 'off' })).code, 0);
    assert.equal((await go(setup({ lintChanged: FAIL }), {}, { stop_hook_active: true })).code, 0);
    assert.equal((await go(setup({ lintChanged: FAIL }, false))).code, 0);
    assert.equal(await stopMain(JSON.stringify({ cwd: tmp() }), {}, { write() {} }), 0);
    assert.equal(await stopMain('not json', {}, { write() {} }), 0);
  });
  it('a command that outlives the budget is killed: exit 0 with a warning, the budget is the one asked for', async () => {
    const dir = setup({ lintChanged: 'node -e "setTimeout(() => {}, 60000)" -- {files}', budgetMs: 60000 });
    const t0 = Date.now();
    const r = await go(dir, { STOP_GATE_BUDGET_MS: '700' });
    assert.equal(r.code, 0);
    assert.match(r.err, /timed out \(budget 1 s\)/);
    assert.ok(Date.now() - t0 < 20000);
  });
  it('a timeout does not hide a real failure from a faster task', async () => {
    const dir = setup({ lintChanged: FAIL, relatedTests: 'node -e "setTimeout(() => {}, 60000)" -- {files}' });
    const r = await go(dir, { STOP_GATE_BUDGET_MS: '1500' });
    assert.equal(r.code, 2);
    assert.match(r.err, /not finished within the budget/);
  });
  it('the guard task: findings (exit 1) block, an infrastructure error (exit 2) does not', async () => {
    const mk = (code) => {
      const dir = gitRepo({ 'kit.config.json': JSON.stringify({ stopGate: { guard: true } }), 'e2e/a.spec.ts': 'x\n', 'scripts/e2e-guard.mjs': `console.error('guard says no'); process.exit(${code});\n` });
      write(dir, 'e2e/a.spec.ts', 'y\n');
      return dir;
    };
    const blocked = await go(mk(1));
    assert.equal(blocked.code, 2);
    assert.match(blocked.err, /e2e-guard FAILED/);
    const infra = await go(mk(2));
    assert.equal(infra.code, 0);
    assert.match(infra.err, /could not start/);
  });
  it('with the real e2e-guard installed, a weakened spec blocks the stop and an approved one does not', async () => {
    const spec = ["import { test, expect } from '@playwright/test';", "test('a', async ({ page }) => {", '  await expect(page.getByRole("heading")).toBeVisible();', '  await expect(page).toHaveURL(/x/);', '});', ''].join('\n');
    const dir = gitRepo({ 'kit.config.json': JSON.stringify({ stopGate: { guard: true } }), 'e2e/a.spec.ts': spec });
    for (const f of ['e2e-guard.mjs', 'guard-core.mjs']) write(dir, `scripts/${f}`, readFileSync(join(here, f), 'utf8'));
    gitIn(dir, 'add', '-A');
    gitIn(dir, 'commit', '-q', '-m', 'kit');
    write(dir, 'e2e/a.spec.ts', spec.replace('  await expect(page).toHaveURL(/x/);\n', ''));
    assert.equal((await go(dir)).code, 2);
    write(dir, 'e2e/a.spec.ts', spec.replace('  await expect(page).toHaveURL(/x/);\n', '  // test-guard: approved-removal 1 covered by the unit test\n'));
    assert.equal((await go(dir)).code, 0);
  });
  it('guardBase is HEAD on the default branch and the merge-base when the branch is ahead', () => {
    const dir = gitRepo({ 'a.txt': '1\n' });
    assert.equal(guardBase(dir), 'HEAD');
    const base = gitIn(dir, 'rev-parse', 'HEAD').trim();
    gitIn(dir, 'checkout', '-q', '-b', 'feat');
    write(dir, 'a.txt', '2\n');
    gitIn(dir, 'commit', '-qam', 'ahead');
    assert.equal(guardBase(dir), base);
  });
  it('the CLI entry: --help exits 0 and the settings snippet is valid JSON that calls the hook', () => {
    const r = spawnSync(process.execPath, [join(KIT, 'hooks', 'stop-gate.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const snippet = JSON.parse(readFileSync(join(KIT, 'hooks', 'settings.snippet.json'), 'utf8'));
    assert.match(snippet.hooks.Stop[0].hooks[0].command, /stop-gate\.mjs/);
    assert.ok(snippet.hooks.Stop[0].hooks[0].timeout > 90);
    const piped = spawnSync(process.execPath, [join(KIT, 'hooks', 'stop-gate.mjs')], { input: '{}', encoding: 'utf8', env: { ...process.env, STOP_GATE: 'off' } });
    assert.equal(piped.status, 0);
  });
});

// ------------------------------------------------------------------------------------------------------------- install.mjs

describe('install.mjs', () => {
  const target = (extra = {}) => {
    const dir = tmp('install-');
    write(dir, 'package.json', JSON.stringify({ name: 't', packageManager: 'pnpm@12.0.0', scripts: { lint: 'x' } }, null, 2));
    write(dir, 'src/app.ts', 'export const app = 1;\n');
    for (const [p, c] of Object.entries(extra)) write(dir, p, c);
    return dir;
  };
  const run = (args) => {
    const out = [];
    const code = installMain(args, (s) => out.push(s));
    return { code, out: out.join('\n') };
  };
  it('--help, usage errors and bad targets', () => {
    assert.equal(run(['--help']).code, 0);
    assert.equal(run([]).code, 2);
    assert.equal(run(['--target', join(tmpdir(), 'does-not-exist-xyz')]).code, 2);
    assert.equal(run(['--target', tmp(), '--with', 'nope']).code, 2);
    assert.equal(run(['--target', target(), '--with', 'app']).code, 2, 'the app group needs --app-dir');
    assert.throws(() => parseInstallArgs(['--zzz']), /unknown argument/);
  });
  it('dry run lists every file and writes nothing', () => {
    const dir = target();
    const before = listAll(dir);
    const r = run(['--target', dir, '--with', 'all']);
    assert.equal(r.code, 0);
    for (const f of ['scripts/gate.mjs', 'scripts/gate-lib.mjs', 'scripts/e2e-guard.mjs', 'scripts/guard-core.mjs', 'kit.config.json', 'scripts/e2e-changed.mjs', 'e2e-changed.map.json', '.claude/hooks/stop-gate.mjs', 'e2e/goto-ready.ts', 'e2e/auth.setup.ts']) assert.match(r.out, new RegExp(`\\[new\\s*\\] ${f.replace(/[.]/g, '\\.')}`), f);
    assert.match(r.out, /DRY RUN/);
    assert.match(r.out, /Nothing written/);
    assert.match(r.out, /Stop hook entry/);
    assert.deepEqual(listAll(dir), before);
  });
  it('--apply writes exactly the listed files, leaves app code and package.json alone, and is idempotent', () => {
    const dir = target();
    const before = listAll(dir);
    const dry = run(['--target', dir]);
    const listed = [...dry.out.matchAll(/\[new\s*\] (\S+)/g)].map((m) => m[1]);
    const appliedOut = run(['--target', dir, '--apply']);
    assert.equal(appliedOut.code, 0);
    assert.deepEqual(listAll(dir), [...before, ...listed].sort());
    assert.equal(readFileSync(join(dir, 'src/app.ts'), 'utf8'), 'export const app = 1;\n');
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts.gate, undefined);
    const cfg = JSON.parse(readFileSync(join(dir, 'kit.config.json'), 'utf8'));
    assert.equal(cfg.e2e.buildIdFile, undefined, 'placeholder keys are dropped');
    assert.equal(cfg.e2e.serverCommand, 'pnpm run start', '<pm> is filled with the detected manager');
    assert.equal(cfg.steps.e2e.command, '<pm> exec playwright test', 'command templates keep <pm>');
    assert.match(appliedOut.out, /dropped keys/);
    const again = run(['--target', dir, '--apply']);
    assert.match(again.out, /Wrote 0 file/);
    assert.equal([...again.out.matchAll(/\[same/g)].length, listed.length);
  });
  it('a differing file is kept unless --overwrite; the kit config of the repo is never replaced silently', () => {
    const dir = target({ 'scripts/gate.mjs': '// mine\n', 'kit.config.json': '{"mine":true}\n' });
    const r = run(['--target', dir, '--apply']);
    assert.match(r.out, /\[differs\] scripts\/gate\.mjs/);
    assert.equal(readFileSync(join(dir, 'scripts/gate.mjs'), 'utf8'), '// mine\n');
    assert.equal(readFileSync(join(dir, 'kit.config.json'), 'utf8'), '{"mine":true}\n');
    const o = run(['--target', dir, '--apply', '--overwrite']);
    assert.match(o.out, /\[replace\] scripts\/gate\.mjs/);
    assert.equal(readFileSync(join(dir, 'scripts/gate.mjs'), 'utf8'), readFileSync(join(here, 'gate.mjs'), 'utf8'));
  });
  it('--patch-package-json adds only missing scripts and keeps indentation; without the flag it prints them', () => {
    const dir = target();
    const noPatch = run(['--target', dir, '--apply', '--with', 'changed']);
    assert.match(noPatch.out, /package\.json is not edited/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts.gate, undefined);
    write(dir, 'package.json', JSON.stringify({ name: 't', scripts: { lint: 'x', gate: 'mine' } }, null, '\t'));
    run(['--target', dir, '--apply', '--with', 'changed', '--patch-package-json']);
    const text = readFileSync(join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(text);
    assert.equal(pkg.scripts.gate, 'mine');
    assert.equal(pkg.scripts['gate:guard'], 'node scripts/e2e-guard.mjs');
    assert.equal(pkg.scripts['e2e:changed'], 'node scripts/e2e-changed.mjs');
    assert.match(text, /^\{\n\t"name"/);
  });
  it('--patch-gitignore appends only missing lines, once', () => {
    const dir = target({ '.gitignore': 'node_modules' });
    run(['--target', dir, '--apply', '--with', 'e2e', '--patch-gitignore']);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.gate/\ne2e/.auth/\n');
    run(['--target', dir, '--apply', '--with', 'e2e', '--patch-gitignore']);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules\n.gate/\ne2e/.auth/\n');
  });
  it('the e2e and app groups are copied whole into the chosen dirs; README files stay in the kit', () => {
    const dir = target();
    const r = run(['--target', dir, '--apply', '--with', 'e2e', '--e2e-dir', 'tests/e2e', '--app-dir', 'src/e2e-support']);
    assert.equal(r.code, 0, r.out);
    const kitE2e = readdirSync(join(KIT, 'e2e')).filter((f) => !/\.md$/i.test(f));
    const kitApp = readdirSync(join(KIT, 'app')).filter((f) => !/\.md$/i.test(f));
    for (const f of kitE2e) assert.ok(existsSync(join(dir, 'tests/e2e', f)), f);
    for (const f of kitApp) assert.ok(existsSync(join(dir, 'src/e2e-support', f)), f);
    assert.ok(kitE2e.includes('goto-ready.ts') && kitE2e.includes('auth.setup.ts'));
    assert.equal(existsSync(join(dir, 'tests/e2e/README.md')), false);
    assert.equal(readFileSync(join(dir, 'src/app.ts'), 'utf8'), 'export const app = 1;\n');
  });
  it('refuses to write outside the target', () => {
    const dir = target();
    assert.equal(run(['--target', dir, '--with', 'e2e', '--e2e-dir', '../outside']).code, 2);
  });
  it('fillConfig, detectPm, scriptsToAdd, gitignoreLines', () => {
    const f = fillConfig(JSON.stringify({ a: '<dir>/x', b: ['<dir>/y', 'ok'], c: '<pm> exec t', d: { e: '<name>' }, e2e: { serverCommand: '<pm> run start' }, _notes: ['<dir> stays'] }), 'yarn');
    assert.deepEqual(JSON.parse(f.text), { b: ['ok'], c: '<pm> exec t', d: {}, e2e: { serverCommand: 'yarn run start' }, _notes: ['<dir> stays'] });
    assert.ok(f.removed.includes('a') && f.removed.includes('b') && f.removed.includes('d.e'));
    const g = fillConfig(JSON.stringify({ guard: { dirs: ['e2e'], extraTestFiles: ['e2e/helpers/**', 'other/x'] }, e2e: { authRoles: [{ statePath: 'e2e/.auth/o.json' }] } }), 'npm', 'tests/e2e');
    assert.deepEqual(JSON.parse(g.text), { guard: { dirs: ['tests/e2e'], extraTestFiles: ['tests/e2e/helpers/**', 'other/x'] }, e2e: { authRoles: [{ statePath: 'tests/e2e/.auth/o.json' }] } });
    const dir = tmp();
    assert.equal(detectPm(dir), 'npm');
    write(dir, 'yarn.lock', '');
    assert.equal(detectPm(dir), 'yarn');
    write(dir, 'package.json', '{"packageManager":"bun@1.2.0"}');
    assert.equal(detectPm(dir), 'bun');
    assert.deepEqual(scriptsToAdd({ scripts: { gate: 'x' } }, { withGroups: [] }), { 'gate:guard': 'node scripts/e2e-guard.mjs' });
    assert.deepEqual(gitignoreLines({ withGroups: ['e2e'], e2eDir: 'tests/e2e' }), ['.gate/', 'tests/e2e/.auth/']);
    const p = installPlan({ ...parseInstallArgs(['--target', target()]) });
    assert.ok(p.entries.every((e) => e.status === 'new'));
  });
  it('the files the installer ships exist in the kit and never include tests', () => {
    const p = installPlan(parseInstallArgs(['--target', target(), '--with', 'all']));
    for (const e of p.entries) assert.doesNotMatch(e.rel, /\.test\./);
    assert.ok(statSync(join(KIT, 'install.mjs')).isFile());
  });
});
