// Run: node --test scripts/guard.test.mjs   (node:test, no dependencies)
// Tests of guard-core.mjs (pure analysis) and of e2e-guard.mjs in diff mode and --all, on throwaway git repos.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, analyze, assertionsPerLine, diffBlocks, evalMs, isOutOfSuite, isTestFile, maskSql, maskTs, parseTestIgnore } from './guard-core.mjs';
import { collectPairs, loadGuardConfig, parseNameStatus, resolveBase } from './e2e-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GUARD = join(here, 'e2e-guard.mjs');
const L = (...lines) => `${lines.join('\n')}\n`;
const cleanup = [];
after(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** @returns {import('./guard-core.mjs').FilePair} */
function pair(oldText, newText, path = 'e2e/x.spec.ts', status) {
  const s = status ?? (oldText === null ? 'A' : newText === null ? 'D' : 'M');
  return { status: s, oldPath: oldText === null ? null : path, path, oldText, newText };
}
const run = (pairs, config = DEFAULT_CONFIG) => analyze(pairs, config);
const one = (o, n, p) => run([pair(o, n, p)]);
const rules = (r) => r.findings.map((f) => `${f.rule}:${f.severity}`);

const BASE = L("import { test, expect } from '@playwright/test';", "test('a', async ({ page }) => {", '  await expect(page.getByRole("heading")).toBeVisible();', '  await expect(page.getByTestId("n")).toHaveText("3");', '  await expect(page).toHaveURL(/home/);', '});');

describe('which files are guarded', () => {
  it('spec, test, e2e, setup, teardown, pgTAP and config files count; sources do not', () => {
    for (const p of ['e2e/a.spec.ts', 'src/b.test.tsx', 'e2e/c.e2e.ts', 'e2e/auth.setup.ts', 'e2e/x.teardown.ts', 'supabase/tests/database/01.test.sql', 'apps/w/playwright.config.ts', 'vitest.config.mts']) assert.equal(isTestFile(p), true, p);
    for (const p of ['src/lib/a.ts', 'supabase/migrations/1.sql', 'docs/x.md', 'e2e/helpers/html.ts']) assert.equal(isTestFile(p), false, p);
    assert.equal(isTestFile('e2e/helpers/html.ts', { extraTestFiles: ['e2e/helpers/**'] }), true);
  });
  it('testIgnore is read as data and matches by name at any depth', () => {
    const cfgText = "export default { testIgnore: ['**/generated/**', '*.draft.ts'], retries: 0 };";
    assert.deepEqual(parseTestIgnore(cfgText), ['**/generated/**', '*.draft.ts']);
    assert.equal(isOutOfSuite('e2e/a.draft.ts', { testIgnore: ['*.draft.ts'] }), true);
    assert.equal(isOutOfSuite('e2e/a.spec.ts', { testIgnore: ['*.draft.ts'] }), false);
    assert.equal(isOutOfSuite('e2e/a.spec.ts.disabled', { testIgnore: [] }), true);
  });
});

describe('masking and counting', () => {
  it('maskTs blanks comments, strings and regex bodies and keeps the layout', () => {
    const src = "const a = 'expect(x)'; // expect(y)\nconst r = /expect\\(/;\nexpect(real);";
    const out = maskTs(src);
    assert.equal(out.length, src.length);
    assert.equal((out.match(/expect\(/g) ?? []).length, 1);
  });
  it('maskSql blanks comments and dollar-quoted bodies', () => {
    const out = maskSql("select ok(true); -- ok(false)\nselect lives_ok($$ select ok(1) $$, 'ok(2)');");
    assert.equal((out.match(/\bok\(/g) ?? []).length, 1);
  });
  it('helpers count as one assertion, array helpers one per element', () => {
    const lines = ['await helper(page);', 'await arr(page, [a, b, c]);', 'expect(x1).toBe(1);'];
    assert.deepEqual(assertionsPerLine(lines, false, ['helper', 'arr'], ['arr']), [1, 3, 1]);
  });
  it('evalMs handles numeric separators, products and zero', () => {
    assert.equal(evalMs('45_000'), 45000);
    assert.equal(evalMs('10 * 1000'), 10000);
    assert.equal(evalMs('0'), Infinity);
    assert.ok(Number.isNaN(evalMs('someVar')));
  });
  it('diffBlocks ignores indentation-only changes', () => {
    assert.deepEqual(diffBlocks(['a', '  b'], ['a', 'b']), []);
  });
});

describe('BLOCK rules', () => {
  it('fewer assertions block; the same count does not', () => {
    const weaker = BASE.replace('  await expect(page.getByTestId("n")).toHaveText("3");\n', '');
    assert.deepEqual(rules(one(BASE, weaker)), ['assertions-removed:BLOCK']);
    assert.equal(one(BASE, BASE.replace('"3"', '"4"')).ok, true);
  });
  it('fewer test() blocks block', () => {
    const two = `${BASE}test('b', async () => {\n  await expect(1).toBe(1);\n});\n`;
    const r = one(two, BASE);
    assert.ok(rules(r).includes('tests-removed:BLOCK'));
  });
  it('skip, fixme, only, todo and describe.skip added', () => {
    for (const marker of ["test.skip('a', async () => {});", "test.fixme('a', async () => {});", "test.only('a', async () => {});", "test.describe.skip('g', () => {});", "xit('a', () => {});"]) {
      const r = one(BASE, `${BASE}${marker}\n`);
      assert.ok(rules(r).includes('skip-added:BLOCK'), marker);
    }
  });
  it('larger or new timeouts and test.slow block; a smaller one does not', () => {
    const o = L("test('a', async ({ page }) => {", '  await expect(page.locator("h1")).toBeVisible({ timeout: 5000 });', '});');
    assert.ok(rules(one(o, o.replace('5000', '30000'))).includes('timeout-increased:BLOCK'));
    assert.equal(one(o, o.replace('5000', '2000')).ok, true);
    const added = `${o}test.setTimeout(120000);\n`;
    assert.ok(rules(one(o, added)).includes('timeout-added:BLOCK'));
    assert.ok(rules(one(o, `${o}test.slow();\n`)).includes('timeout-added:BLOCK'));
  });
  it('a timeout const that grew blocks', () => {
    const o = L('const WAIT = 5_000;', "test('a', async ({ page }) => {", '  await expect(page.locator("h1")).toBeVisible({ timeout: WAIT });', '});');
    assert.ok(rules(one(o, o.replace('5_000', '60_000'))).includes('timeout-increased:BLOCK'));
  });
  it('new retries block, retries 0 does not', () => {
    const o = L('export default defineConfig({', '  retries: 0,', '});');
    assert.ok(rules(one(o, o.replace('retries: 0', 'retries: 2'), 'playwright.config.ts')).includes('retries-added:BLOCK'));
    assert.ok(rules(one(o, o.replace('retries: 0', "retries: process.env.CI ? 1 : 0"), 'playwright.config.ts')).includes('retries-added:BLOCK'));
    assert.equal(one(o, o.replace('retries: 0', 'retries: 0, workers: 1'), 'playwright.config.ts').ok, true);
  });
  it('waitForTimeout, sleep, networkidle (also over several lines) and toPass block', () => {
    assert.ok(rules(one(BASE, `${BASE}await page.waitForTimeout(500);\n`)).includes('sleep-added:BLOCK'));
    assert.ok(rules(one(BASE, `${BASE}await page.waitForLoadState('networkidle');\n`)).includes('networkidle-added:BLOCK'));
    assert.ok(rules(one(BASE, `${BASE}await page.waitForLoadState(\n  'networkidle',\n);\n`)).includes('networkidle-added:BLOCK'));
    assert.ok(rules(one(BASE, `${BASE}await expect(async () => {}).toPass();\n`)).includes('topass-added:BLOCK'));
  });
  it('assertions that cannot fail: .catch and literal subjects', () => {
    assert.ok(rules(one(BASE, `${BASE}await expect(page.locator('a')).toBeVisible().catch(() => {});\n`)).includes('assertion-swallowed:BLOCK'));
    assert.ok(rules(one(BASE, `${BASE}expect(true).toBe(true);\n`)).includes('assertion-tautology:BLOCK'));
  });
  it('secret-looking literals block; env reads and placeholders do not block', () => {
    const fake = ['h', 'u', 'n', 't', 'e', 'r', '2'].join('').repeat(2);
    assert.ok(rules(one(BASE, `${BASE}const password = '${fake}';\n`)).includes('secret-literal:BLOCK'));
    assert.equal(one(BASE, `${BASE}const password = process.env.E2E_PASSWORD ?? 'xxxxxxxxxxx';\n`).ok, true);
    const placeholder = ['e2e', 'local', 'pass' + 'word', '123'].join('-');
    const r = one(BASE, `${BASE}export const E2E_PASSWORD = '${placeholder}';\n`);
    assert.equal(r.ok, true);
    assert.ok(rules(r).includes('secret-literal:REVIEW'));
  });
  it('a deleted test file blocks, unless listed in approvedDeletions', () => {
    const r = run([pair(BASE, null)]);
    assert.deepEqual(rules(r), ['test-file-deleted:BLOCK']);
    const ok = run([pair(BASE, null)], { ...DEFAULT_CONFIG, approvedDeletions: [{ path: 'e2e/x.spec.ts', reason: 'moved to the unit layer, user ok' }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.findings[0].severity, 'APPROVED');
  });
  it('a test renamed out of the suite is a deletion; a rename inside it is not', () => {
    const out = run([{ status: 'R', oldPath: 'e2e/x.spec.ts', path: 'e2e/x.spec.ts.disabled', oldText: BASE, newText: BASE }]);
    assert.deepEqual(rules(out), ['test-file-deleted:BLOCK']);
    const inside = run([{ status: 'R', oldPath: 'e2e/x.spec.ts', path: 'e2e/y.spec.ts', oldText: BASE, newText: BASE }]);
    assert.equal(inside.ok, true);
  });
  it('assertions moved to another changed file are not a loss', () => {
    const a = L("test('a', async () => {", '  expect(x1).toBe(1);', '  expect(x2).toBe(2);', '});');
    const a2 = L("test('a', async () => {", '  expect(x1).toBe(1);', '});');
    const b = L("test('b', async () => {", '  expect(x3).toBe(3);', '});');
    const b2 = L("test('b', async () => {", '  expect(x3).toBe(3);', '  expect(x2).toBe(2);', '});');
    assert.equal(run([pair(a, a2, 'e2e/a.spec.ts'), pair(b, b2, 'e2e/b.spec.ts')]).ok, true);
    assert.equal(run([pair(a, a2, 'e2e/a.spec.ts')]).ok, false);
  });
  it('a new file is only checked for hard markers, not for counts', () => {
    assert.equal(one(null, BASE).ok, true);
    assert.equal(one(null, `${BASE}test.skip('x', async () => {});\n`).ok, false);
  });
  it('pgTAP: fewer assertions and a smaller plan block, skip() blocks', () => {
    const o = L('select plan(2);', 'select ok(true, "a");', 'select ok(true, "b");', 'select * from finish();');
    const n = L('select plan(1);', 'select ok(true, "a");', 'select * from finish();');
    const r = one(o, n, 'supabase/tests/database/a.test.sql');
    assert.deepEqual(new Set(rules(r)), new Set(['assertions-removed:BLOCK', 'plan-decreased:BLOCK']));
    assert.ok(rules(one(o, `${o}select skip('why', 1);\n`, 'supabase/tests/database/a.test.sql')).includes('skip-added:BLOCK'));
  });
});

describe('REVIEW rules never block', () => {
  it('.first(), CSS locators replacing role/testid, looser matchers, assertions in an if', () => {
    assert.deepEqual(rules(one(BASE, BASE.replace('page.getByRole("heading")', 'page.getByRole("heading").first()'))), ['locator-broadened:REVIEW']);
    const css = one(BASE, BASE.replace('page.getByTestId("n")', 'page.locator(".n")'));
    assert.ok(rules(css).includes('locator-weakened:REVIEW'));
    assert.equal(css.ok, true);
    const loose = one(BASE, BASE.replace('toHaveText("3")', 'toBeTruthy()'));
    assert.ok(loose.ok);
    assert.ok(rules(one(BASE, BASE.replace('toHaveURL(/home/)', 'toHaveURL(/.*/)'))).includes('assertion-loosened:REVIEW'));
    const cond = one(BASE, BASE.replace('  await expect(page.getByTestId("n"))', '  if (flag) await expect(page.getByTestId("n"))'));
    assert.ok(rules(cond).includes('assertion-conditional:REVIEW'));
    assert.equal(cond.ok, true);
  });
});

describe('approvals: only a comment ADDED in the same hunk counts', () => {
  const skipLine = "test.skip('flaky on ci', async () => {});";
  it('an added comment above or on the line approves a line finding', () => {
    const above = one(BASE, `${BASE}// test-guard: approved tracked in issue 12, user ok\n${skipLine}\n`);
    assert.equal(above.ok, true);
    assert.equal(above.findings[0].severity, 'APPROVED');
    assert.equal(above.approvals[0].reason, 'tracked in issue 12, user ok');
    assert.equal(one(BASE, `${BASE}${skipLine} // test-guard: approved user ok\n`).ok, true);
  });
  it('an approval without a reason, inside a string, or far away does not count', () => {
    assert.equal(one(BASE, `${BASE}// test-guard: approved\n${skipLine}\n`).ok, false);
    assert.equal(one(BASE, `${BASE}const s = '// test-guard: approved fake';\n${skipLine}\n`).ok, false);
    const far = `${BASE}// test-guard: approved old story\n${Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n${skipLine}\n`;
    assert.equal(one(BASE, far).ok, false);
  });
  it('a pre-existing approval comment approves nothing new', () => {
    const old = `${BASE}// test-guard: approved first skip\ntest.skip('first', async () => {});\n`;
    // the same comment text survives; a second, unapproved skip is added without its own comment
    const next = `${old}test.skip('second', async () => {});\n`;
    const r = one(old, next);
    assert.equal(r.ok, false);
    // and an edit of the approved line (comment kept) is not a new marker
    assert.equal(one(old, old.replace("'first'", "'first renamed'")).ok, true);
  });
  it('removed assertions: approved-removal n inside the hunk; n too small or an old comment does not', () => {
    const weaker = BASE.replace('  await expect(page.getByTestId("n")).toHaveText("3");\n', '  // test-guard: approved-removal 1 duplicated by the api test\n');
    assert.equal(one(BASE, weaker).ok, true);
    const small = BASE.replace('  await expect(page.getByTestId("n")).toHaveText("3");\n  await expect(page).toHaveURL(/home/);\n', '  // test-guard: approved-removal 1 covered elsewhere\n');
    assert.equal(one(BASE, small).ok, false);
    const stale = `// test-guard: approved-removal 1 covered elsewhere\n${BASE}`;
    assert.equal(one(stale, stale.replace('  await expect(page.getByTestId("n")).toHaveText("3");\n', '')).ok, false);
  });
  it('SQL approvals use --', () => {
    const o = L('select plan(1);', 'select ok(true);');
    const n = L('select plan(1);', '-- test-guard: approved the case was moved', "select skip('x', 1);", 'select ok(true);');
    assert.equal(one(o, n, 'supabase/tests/a.test.sql').ok, true);
  });
});

describe('git plumbing', () => {
  it('parseNameStatus handles A, M, D and renames', () => {
    assert.deepEqual(parseNameStatus('M\0a.ts\0A\0b.ts\0D\0c.ts\0R090\0old.ts\0new.ts\0'), [
      { status: 'M', oldPath: 'a.ts', path: 'a.ts' },
      { status: 'A', oldPath: null, path: 'b.ts' },
      { status: 'D', oldPath: 'c.ts', path: 'c.ts' },
      { status: 'R', oldPath: 'old.ts', path: 'new.ts' },
    ]);
  });
});

/** A temp git repo with a baseline commit on main. */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  cleanup.push(dir);
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...a], { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'baseline');
  return { dir, g, write: (p, c) => (mkdirSync(dirname(join(dir, p)), { recursive: true }), writeFileSync(join(dir, p), c)) };
}
const cli = (dir, args) => {
  const r = spawnSync(process.execPath, [GUARD, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe('e2e-guard CLI, diff mode (temp git repo)', () => {
  it('passes with no change, blocks a weakening edit, passes with an in-hunk approval', () => {
    const r = repo({ 'e2e/a.spec.ts': BASE, 'package.json': '{}' });
    assert.equal(cli(r.dir, []).code, 0);
    r.write('e2e/a.spec.ts', BASE.replace('  await expect(page.getByTestId("n")).toHaveText("3");\n', ''));
    const blocked = cli(r.dir, []);
    assert.equal(blocked.code, 1);
    assert.match(blocked.out, /assertions-removed/);
    assert.match(blocked.out, /e2e-guard: BLOCK=1/);
    r.write('e2e/a.spec.ts', BASE.replace('  await expect(page.getByTestId("n")).toHaveText("3");\n', '  // test-guard: approved-removal 1 covered by the api test\n'));
    const ok = cli(r.dir, []);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /APPROVED/);
  });
  it('compares with the merge-base: a weakening committed on the branch is still caught, main moving ahead is not a deletion', () => {
    const r = repo({ 'e2e/a.spec.ts': BASE, 'e2e/b.spec.ts': BASE, 'package.json': '{}' });
    r.g('checkout', '-q', '-b', 'feat');
    r.write('e2e/a.spec.ts', `${BASE}test.skip('x', async () => {});\n`);
    r.g('commit', '-qam', 'weaken');
    const caught = cli(r.dir, []);
    assert.equal(caught.code, 1, caught.out);
    assert.match(caught.out, /skip-added/);
    // main moves ahead by deleting b.spec.ts: from feat's point of view that is not our deletion
    r.g('checkout', '-q', 'main');
    r.g('rm', '-q', 'e2e/b.spec.ts');
    r.g('commit', '-qm', 'main drops b');
    r.g('checkout', '-q', 'feat');
    r.write('e2e/a.spec.ts', BASE);
    r.g('commit', '-qam', 'restore a');
    const clean = cli(r.dir, []);
    assert.equal(clean.code, 0, clean.out);
    assert.doesNotMatch(clean.out, /test-file-deleted/);
  });
  it('untracked new spec files are scanned; --files restricts; --base HEAD checks only uncommitted work', () => {
    const r = repo({ 'e2e/a.spec.ts': BASE, 'package.json': '{}' });
    r.g('checkout', '-q', '-b', 'feat');
    r.write('e2e/a.spec.ts', `${BASE}test.skip('x', async () => {});\n`);
    r.g('commit', '-qam', 'skip');
    r.write('e2e/new.spec.ts', `${BASE}await page.waitForTimeout(100);\n`);
    const all = cli(r.dir, ['--json']);
    const json = JSON.parse(all.out);
    assert.deepEqual(json.findings.map((f) => f.file).sort(), ['e2e/a.spec.ts', 'e2e/new.spec.ts']);
    const only = JSON.parse(cli(r.dir, ['--json', '--files', 'e2e/new.spec.ts']).out);
    assert.deepEqual(only.findings.map((f) => f.file), ['e2e/new.spec.ts']);
    const head = JSON.parse(cli(r.dir, ['--json', '--base', 'HEAD']).out);
    assert.deepEqual(head.findings.map((f) => f.file), ['e2e/new.spec.ts']);
  });
  it('a deleted test file blocks, approvedDeletions in kit.config.json approves it', () => {
    const r = repo({ 'e2e/a.spec.ts': BASE, 'package.json': '{}' });
    r.g('rm', '-q', 'e2e/a.spec.ts');
    assert.equal(cli(r.dir, []).code, 1);
    r.write('kit.config.json', JSON.stringify({ guard: { approvedDeletions: [{ path: 'e2e/a.spec.ts', reason: 'user ok' }] } }));
    assert.equal(cli(r.dir, []).code, 0);
  });
  it('guard config: extraTestFiles pulls helpers in, assertionHelpers count, baseBranch is honoured, testIgnore comes from playwright.config', () => {
    const helper = L('export async function check(page) {', '  await expect(page).toHaveURL(/a/);', '  await expect(page).toHaveTitle(/b/);', '}');
    const r = repo({ 'e2e/helpers/h.ts': helper, 'playwright.config.ts': "export default { testIgnore: ['**/drafts/**'] };\n", 'package.json': '{}' });
    r.write('e2e/helpers/h.ts', helper.replace('  await expect(page).toHaveTitle(/b/);\n', ''));
    assert.equal(cli(r.dir, []).code, 0, 'helpers are not guarded by default');
    r.write('kit.config.json', JSON.stringify({ guard: { extraTestFiles: ['e2e/helpers/**'] } }));
    assert.equal(cli(r.dir, []).code, 1);
    const loaded = loadGuardConfig(r.dir);
    assert.ok(loaded.config.testIgnore.includes('**/drafts/**'));
  });
  it('resolveBase: explicit ref must exist; no base ref falls back to HEAD with a note', () => {
    const r = repo({ 'package.json': '{}' });
    r.g('branch', '-m', 'trunk');
    assert.throws(() => resolveBase(r.dir, { requested: 'nope' }), /base ref not found/);
    const res = resolveBase(r.dir, { env: {} });
    assert.equal(res.base, 'HEAD');
    assert.match(res.note ?? '', /no base ref found/);
    assert.equal(resolveBase(r.dir, { baseBranch: 'trunk', env: {} }).note, undefined);
  });
  it('collectPairs: staged and range modes', () => {
    const r = repo({ 'e2e/a.spec.ts': BASE, 'package.json': '{}' });
    r.g('checkout', '-q', '-b', 'feat');
    r.write('e2e/a.spec.ts', `${BASE}test.skip('x', async () => {});\n`);
    r.g('add', '-A');
    const loaded = loadGuardConfig(r.dir);
    const staged = collectPairs(r.dir, { staged: true, files: [], dirs: [], extraFiles: [] }, loaded);
    assert.equal(staged.pairs.length, 1);
    r.g('commit', '-qm', 'skip');
    const range = collectPairs(r.dir, { head: 'HEAD', base: 'main', files: [], dirs: [], extraFiles: [], staged: false }, loaded);
    assert.equal(range.pairs[0].status, 'M');
    assert.ok(range.pairs[0].newText.includes('test.skip'));
  });
  it('outside git: diff mode exits 2, --all works; usage errors exit 2; --help exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-nogit-'));
    cleanup.push(dir);
    mkdirSync(join(dir, 'e2e'));
    writeFileSync(join(dir, 'e2e', 'a.spec.ts'), BASE);
    assert.equal(cli(dir, []).code, 2);
    assert.equal(cli(dir, ['--all']).code, 0);
    assert.equal(cli(dir, ['--nope']).code, 2);
    assert.equal(cli(dir, ['--all', '--base', 'x']).code, 2);
    assert.equal(cli(dir, ['--help']).code, 0);
  });
});

describe('e2e-guard --all and the ratchet baseline', () => {
  it('fails on hard hits, writes a baseline, then only a higher count fails; the baseline refuses to rise', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-all-'));
    cleanup.push(dir);
    mkdirSync(join(dir, 'e2e'));
    const spec = (n) => `${BASE}${Array.from({ length: n }, () => 'await page.waitForTimeout(10);').join('\n')}\n`;
    writeFileSync(join(dir, 'e2e', 'a.spec.ts'), spec(2));
    assert.equal(cli(dir, ['--all']).code, 1);
    const w = cli(dir, ['--all', '--write-baseline']);
    assert.equal(w.code, 0, w.out);
    const baseline = JSON.parse(readFileSync(join(dir, 'e2e-guard.baseline.json'), 'utf8'));
    assert.equal(baseline.counts.waitForTimeout, 2);
    assert.equal(cli(dir, ['--all']).code, 0);
    writeFileSync(join(dir, 'e2e', 'a.spec.ts'), spec(3));
    assert.equal(cli(dir, ['--all']).code, 1);
    assert.equal(cli(dir, ['--all', '--write-baseline']).code, 1, 'refuses to raise');
    assert.equal(cli(dir, ['--all', '--write-baseline', '--allow-raise']).code, 0);
    writeFileSync(join(dir, 'e2e', 'a.spec.ts'), spec(1));
    const lowered = cli(dir, ['--all']);
    assert.equal(lowered.code, 0);
    assert.match(lowered.out, /below the baseline/);
  });
  it('there is no approvals.json: a file with that name changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-noappr-'));
    cleanup.push(dir);
    mkdirSync(join(dir, 'e2e'));
    mkdirSync(join(dir, '.gate'));
    writeFileSync(join(dir, 'e2e', 'a.spec.ts'), `${BASE}await page.waitForTimeout(10);\n`);
    writeFileSync(join(dir, '.gate', 'approvals.json'), JSON.stringify([{ rule: 'waitForTimeout', file: 'e2e/a.spec.ts', reason: 'x', approvedBy: 'user', approvalRef: 'y' }]));
    assert.equal(cli(dir, ['--all']).code, 1);
    assert.equal(existsSync(join(here, 'approvals.json')), false);
    assert.doesNotMatch(readFileSync(join(here, 'e2e-guard.mjs'), 'utf8'), /approvals\.json/);
  });
});
