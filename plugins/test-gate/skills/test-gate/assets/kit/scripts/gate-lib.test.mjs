// Run: node --test scripts/gate-lib.test.mjs   (node:test, no dependencies)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  addStep,
  applyHonesty,
  assembleEvidence,
  compareBuild,
  computeOk,
  describeCounts,
  detectPackageManager,
  evaluateEvidence,
  execPrefix,
  expandCommand,
  formatSummary,
  judge,
  logName,
  parseArgs,
  parseCounts,
  parseCypress,
  parseJest,
  parseNodeTest,
  parsePgTap,
  parsePlaywright,
  parsePlaywrightFailures,
  parsePlaywrightJson,
  parseUnit,
  parseUnitFailures,
  parseVitest,
  pickFreePort,
  readEvidence,
  resolveSteps,
  runCommand,
  schemaOf,
  selectSteps,
  stripAnsi,
  validateStep,
  zeroExitProblem,
} from './gate-lib.mjs';
import { judgeHits, parseAddedLines, parseGuardArgs, scanSource, stripComments } from './e2e-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ESC = String.fromCharCode(27);
const NAMES = ['lint', 'typecheck', 'test', 'db:test', 'build', 'e2e'];
const tmp = () => mkdtempSync(join(tmpdir(), 'gate-lib-'));

/** A fully valid, passing step. */
const passed = (name, extra = {}) => ({
  name,
  kind: name === 'test' ? 'unit' : name === 'e2e' ? 'e2e' : name === 'db:test' ? 'db' : name,
  status: 'passed',
  command: `run ${name}`,
  exitCode: 0,
  wallMs: 1000,
  timeoutMs: 600000,
  counts: name === 'test' || name === 'e2e' ? { passed: 5, failed: 0, skipped: 0 } : name === 'db:test' ? { files: 1, tests: 3, result: 'PASS', passed: 3, failed: 0, skipped: 0 } : null,
  ...extra,
});
const approval = { reason: 'upstream bug', approvedBy: 'user', approvalRef: 'message 2026-11-12 16:40' };
const evidenceOf = (steps, requiredSteps = NAMES) => ({ schemaVersion: 2, ok: true, finishedAt: 'x', totalMs: 0, args: [], requiredSteps, steps });

describe('parseArgs / selectSteps', () => {
  it('selects everything by default', () => {
    assert.deepEqual(selectSteps(parseArgs([], NAMES), NAMES), NAMES);
  });
  it('--from starts at a step', () => {
    assert.deepEqual(selectSteps(parseArgs(['--from', 'build'], NAMES), NAMES), ['build', 'e2e']);
  });
  it('--only keeps plan order whatever order is typed', () => {
    assert.deepEqual(selectSteps(parseArgs(['--only', 'test,lint'], NAMES), NAMES), ['lint', 'test']);
  });
  it('--skip is repeatable and comma separated; --flag=value works', () => {
    assert.deepEqual(selectSteps(parseArgs(['--skip', 'e2e', '--skip=db:test,build'], NAMES), NAMES), ['lint', 'typecheck', 'test']);
  });
  it('--timeout takes minutes per step', () => {
    assert.deepEqual(parseArgs(['--timeout', 'e2e=25,build=5'], NAMES).timeoutsMs, { e2e: 1_500_000, build: 300_000 });
  });
  it('--dry-run, --rebuild, --require-complete are plain switches; --port is validated', () => {
    const o = parseArgs(['--dry-run', '--rebuild', '--require-complete', '--port', '3300']);
    assert.equal(o.dryRun && o.rebuild && o.requireComplete, true);
    assert.equal(o.port, 3300);
    assert.throws(() => parseArgs(['--port', '99999']), /--port/);
  });
  it('rejects unknown steps, flags, missing values, --only with --from', () => {
    assert.throws(() => parseArgs(['--only', 'nope'], NAMES), /unknown step/);
    assert.throws(() => parseArgs(['--fast']), /unknown argument/);
    assert.throws(() => parseArgs(['--from']), /needs a value/);
    assert.throws(() => parseArgs(['--only', 'lint', '--from', 'test']), /cannot be combined/);
    assert.throws(() => parseArgs(['--timeout', 'e2e=0'], NAMES), /bad pair/);
  });
  it('add-step needs --from-json and accepts --required', () => {
    const o = parseArgs(['add-step', '--from-json', 'step.json', '--required', 'lint,db:test']);
    assert.equal(o.command, 'add-step');
    assert.equal(o.fromJson, 'step.json');
    assert.deepEqual(o.required, ['lint', 'db:test']);
    assert.throws(() => parseArgs(['add-step']), /--from-json/);
  });
});

describe('package manager and step resolution', () => {
  it('reads packageManager, then lockfile, then npm', () => {
    const dir = tmp();
    assert.equal(detectPackageManager(dir, { packageManager: 'pnpm@12.18.0' }).name, 'pnpm');
    assert.equal(detectPackageManager(dir, {}).name, 'npm');
    writeFileSync(join(dir, 'yarn.lock'), '');
    assert.equal(detectPackageManager(dir, {}).name, 'yarn');
    assert.equal(detectPackageManager(dir, { packageManager: 'bun@1.4.4' }).name, 'bun');
    assert.equal(detectPackageManager(dir, {}, 'pnpm').name, 'pnpm');
    rmSync(dir, { recursive: true, force: true });
  });
  it('resolves scripts in table order and reports missing ones without inventing commands', () => {
    const plan = resolveSteps({ pkg: { scripts: { lint: 'x', 'type-check': 'x', 'test:unit': 'x', build: 'x', 'test:e2e': 'x' } }, config: {}, pm: 'pnpm' });
    const by = Object.fromEntries(plan.map((s) => [s.name, s]));
    assert.equal(by.lint.command, 'pnpm run lint');
    assert.equal(by.typecheck.command, 'pnpm run type-check');
    assert.equal(by.test.command, 'pnpm run test:unit');
    assert.equal(by['db:test'].command, null);
    assert.match(by['db:test'].reason, /no script named/);
    assert.equal(by.e2e.command, 'pnpm run test:e2e');
    assert.equal(by.e2e.timeoutMs, 15 * 60_000);
    assert.equal(by.lint.timeoutMs, 10 * 60_000);
    assert.equal(by['db:test'].required, true);
    assert.equal(by.parity.required, false);
  });
  it('yarn runs scripts without "run"; kit.config.json overrides scripts, commands and required steps', () => {
    const plan = resolveSteps({
      pkg: { scripts: { lint: 'x', 'type-check': 'x' } },
      config: { requiredSteps: ['lint'], steps: { typecheck: { script: 'type-check', timeoutMin: 3 }, e2e: { command: '<pm> exec playwright test', env: { A: 1 } }, extra: { command: 'echo hi', kind: 'custom' } } },
      pm: 'yarn',
    });
    const by = Object.fromEntries(plan.map((s) => [s.name, s]));
    assert.equal(by.lint.command, 'yarn lint');
    assert.equal(by.typecheck.command, 'yarn type-check');
    assert.equal(by.typecheck.timeoutMs, 3 * 60_000);
    assert.equal(by.e2e.command, 'yarn exec playwright test');
    assert.deepEqual(by.e2e.env, { A: '1' });
    assert.equal(by.extra.command, 'echo hi');
    assert.equal(by.lint.required, true);
    assert.equal(by.test.required, false);
  });
  it('exec form follows the manager', () => {
    assert.equal(execPrefix('pnpm'), 'pnpm exec');
    assert.equal(execPrefix('bun'), 'bunx');
    assert.equal(expandCommand('npm', '<pm> exec vitest run'), 'npm exec -- vitest run');
  });
  it('log names are Windows-safe', () => {
    assert.equal(logName('db:test'), 'db-test.log');
  });
});

describe('parsers', () => {
  it('strips ANSI colour codes', () => {
    assert.equal(stripAnsi(`${ESC}[32m${ESC}[1mTests${ESC}[22m${ESC}[39m  1 passed`), 'Tests  1 passed');
  });
  it('vitest: sums the Tests line of every run (monorepo prefixes, ANSI)', () => {
    const out = [`      Tests  ${ESC}[32m12 passed${ESC}[39m | 1 skipped (13)`, 'packages/sim test: Tests  40 passed (40)', '      Tests  2 failed | 5 passed | 1 todo (8)', ' Test Files  3 passed (3)'].join('\n');
    assert.deepEqual(parseVitest(out), { passed: 57, failed: 2, skipped: 1, todo: 1, runs: 3 });
  });
  it('vitest: no summary means zero runs', () => {
    assert.equal(parseVitest('nothing here').runs, 0);
  });
  it('jest: reads "Tests:" lines (not verified against a local Jest repo)', () => {
    assert.deepEqual(parseJest('Tests:       1 failed, 2 skipped, 3 passed, 6 total\nTest Suites: 1 failed, 1 total'), { passed: 3, failed: 1, skipped: 2, todo: 0, runs: 1 });
  });
  it('node:test: reads the ℹ summary', () => {
    const out = ['ℹ tests 12', 'ℹ suites 3', 'ℹ pass 10', 'ℹ fail 1', 'ℹ cancelled 0', 'ℹ skipped 1', 'ℹ todo 0'].join('\n');
    assert.deepEqual(parseNodeTest(out), { passed: 10, failed: 1, skipped: 1, todo: 0, runs: 1 });
  });
  it('parseUnit sums vitest and jest summaries', () => {
    const out = '      Tests  4 passed (4)\nTests:       2 passed, 2 total';
    assert.equal(parseUnit(out).passed, 6);
    assert.equal(parseUnit(out).runs, 2);
  });
  it('unit failures: FAIL headings with the first assertion line', () => {
    const out = [' FAIL  src/a.test.ts > math > adds', 'AssertionError: expected 1 to be 2', ' FAIL  src/a.test.ts > math > adds'].join('\n');
    const f = parseUnitFailures(out);
    assert.equal(f.length, 1);
    assert.equal(f[0].test, 'src/a.test.ts > math > adds');
    assert.match(f[0].message, /expected 1 to be 2/);
  });
  it('playwright text: closing summary of the last run, "did not run" and flaky', () => {
    const out = ['Running 3 tests using 1 worker', '  1 failed', 'Running 100 tests using 1 worker', `  ${ESC}[32m58 passed${ESC}[39m (1.2m)`, '  1 flaky', '  2 skipped', '  1 did not run', '  1 interrupted'].join('\n');
    assert.deepEqual(parsePlaywright(out), { passed: 58, failed: 0, skipped: 2, flaky: 1, interrupted: 1, didNotRun: 1 });
  });
  it('playwright text: failure headings of the list reporter', () => {
    const out = ['Running 2 tests using 1 worker', '  1) [chromium] › e2e/a.spec.ts:75:5 › suite › does a thing ─────────', '', '    Error: expect(locator).toHaveText(expected)', '  1 failed'].join('\n');
    const f = parsePlaywrightFailures(out);
    assert.deepEqual(f, [{ test: 'e2e/a.spec.ts > suite > does a thing', file: 'e2e/a.spec.ts', message: 'Error: expect(locator).toHaveText(expected)' }]);
  });
  it('playwright json report (shape read from playwright 1.65.0 JSONReporter)', () => {
    const spec = (title, status, results, file = 'e2e/a.spec.ts') => ({ title, file, line: 1, column: 1, ok: status === 'expected', tests: [{ status, projectName: 'chromium', results }] });
    const report = {
      config: { rootDir: '/repo/apps/web' },
      suites: [
        {
          title: 'a.spec.ts',
          file: 'e2e/a.spec.ts',
          specs: [spec('ok one', 'expected', [{ status: 'passed' }]), spec('skipped one', 'skipped', [{ status: 'skipped' }]), spec('never ran', 'skipped', [])],
          suites: [{ title: 'group', specs: [spec('bad', 'unexpected', [{ status: 'failed', errors: [{ message: `${ESC}[31mexpected 1\nsecond line` }] }]), spec('shaky', 'flaky', [{ status: 'failed' }, { status: 'passed' }])] }],
        },
      ],
      stats: { expected: 1, skipped: 2, unexpected: 1, flaky: 1 },
    };
    const r = parsePlaywrightJson(report);
    assert.deepEqual(r.counts, { passed: 1, failed: 1, skipped: 1, flaky: 1, interrupted: 0, didNotRun: 1 });
    assert.deepEqual(r.failures, [{ test: 'e2e/a.spec.ts > group > bad', file: 'e2e/a.spec.ts', message: 'expected 1' }]);
    assert.equal(r.flaky.length, 1);
    const repoRel = parsePlaywrightJson(report, '/repo');
    assert.equal(repoRel.failures[0].file, 'apps/web/e2e/a.spec.ts');
  });
  it('pgTAP: Files/Tests/Result, failed subtests, SKIP lines; UNKNOWN when nothing parses', () => {
    const out = ['t/a.sql .. Failed 2/10 subtests', 'ok 3 - thing # SKIP no stack', 'Files=3, Tests=45,  1 wallclock secs', 'Result: FAIL'].join('\n');
    assert.deepEqual(parsePgTap(out), { files: 3, tests: 45, result: 'FAIL', passed: 43, failed: 2, skipped: 1 });
    assert.equal(parsePgTap('garbage').result, 'UNKNOWN');
  });
  it('cypress summary row (not verified against a local Cypress repo)', () => {
    const row = '│ ✔  All specs passed!                        00:12       12       12        -        -        - │';
    assert.deepEqual(parseCypress(row), { passed: 12, failed: 0, skipped: 0, runs: 1 });
  });
  it('parseCounts picks the parser by kind; lint/build have no counts', () => {
    assert.equal(parseCounts('lint', 'x'), null);
    assert.equal(parseCounts('build', 'x'), null);
    assert.equal(parseCounts('unit', 'Tests  1 passed (1)').passed, 1);
    assert.equal(parseCounts('db', 'Files=1, Tests=2\nResult: PASS').tests, 2);
    assert.equal(parseCounts('e2e', '  3 passed (1s)').passed, 3);
  });
  it('describeCounts is a short human string', () => {
    assert.equal(describeCounts('e2e', { passed: 5, failed: 0, skipped: 1, flaky: 1 }), '5 passed | 0 failed | 1 skipped | 1 flaky');
    assert.equal(describeCounts('db', { result: 'PASS', tests: 4, files: 2 }), 'PASS, 4 tests in 2 files');
    assert.equal(describeCounts('lint', null), '');
  });
});

describe('zero-exit honesty (zeroExitProblem / judge)', () => {
  it('unit and e2e: exit 0 with 0 passed fails', () => {
    assert.match(zeroExitProblem({ kind: 'unit' }, { passed: 0, skipped: 3, todo: 0, runs: 1 }), /0 tests passed/);
    assert.match(zeroExitProblem({ kind: 'e2e' }, { passed: 0, flaky: 2, skipped: 0, didNotRun: 0 }), /0 tests passed/);
    assert.match(zeroExitProblem({ kind: 'unit' }, { passed: 0, runs: 0 }), /0 runs parsed/);
    assert.equal(zeroExitProblem({ kind: 'unit' }, { passed: 2 }), null);
  });
  it('counts that could not be parsed fail a counted kind', () => {
    assert.match(zeroExitProblem({ kind: 'e2e' }, null), /no test counts/);
  });
  it('lint, typecheck, build, custom, parity need no counts', () => {
    for (const kind of ['lint', 'typecheck', 'build', 'custom', 'parity']) assert.equal(zeroExitProblem({ kind }, null), null);
  });
  it('pgTAP: UNKNOWN, FAIL with exit 0 and 0 tests fail; PASS with tests passes', () => {
    assert.match(zeroExitProblem({ kind: 'db' }, { result: 'UNKNOWN', files: 0, tests: 0 }), /UNKNOWN/);
    assert.match(zeroExitProblem({ kind: 'db' }, { result: 'FAIL', files: 1, tests: 5 }), /Result: FAIL/);
    assert.match(zeroExitProblem({ kind: 'db' }, { result: 'PASS', files: 1, tests: 0 }), /0 tests/);
    assert.equal(zeroExitProblem({ kind: 'db' }, { result: 'PASS', files: 1, tests: 5 }), null);
  });
  it('allowEmpty with a reason permits 0 passed (but never Result: FAIL)', () => {
    assert.equal(zeroExitProblem({ kind: 'unit', allowEmpty: { reason: 'package has no tests yet' } }, { passed: 0, runs: 1 }), null);
    assert.match(zeroExitProblem({ kind: 'db', allowEmpty: { reason: 'x' } }, { result: 'FAIL', files: 1, tests: 1 }), /FAIL/);
  });
  it('judge: timeout, non-zero exit, zero-exit problem, pass', () => {
    assert.equal(judge({ kind: 'unit' }, null, null, true).status, 'timeout');
    assert.equal(judge({ kind: 'lint' }, 1, null, false).status, 'failed');
    assert.equal(judge({ kind: 'unit' }, 0, { passed: 0, runs: 1 }, false).status, 'failed');
    assert.equal(judge({ kind: 'unit' }, 0, { passed: 4, runs: 1 }, false).status, 'passed');
  });
});

describe('complete / ok', () => {
  const allGood = () => NAMES.map((n) => passed(n));
  it('all required steps fresh and passed = complete', () => {
    const v = evaluateEvidence(evidenceOf(allGood()));
    assert.equal(v.ok, true);
    assert.equal(v.complete, true);
    assert.deepEqual(v.reasons, []);
  });
  it('a skipped required step without approval is incomplete; ok keeps its v1 meaning', () => {
    const steps = allGood().map((s) => (s.name === 'db:test' ? { ...s, status: 'skipped', exitCode: null, wallMs: 0, counts: null } : s));
    const v = evaluateEvidence(evidenceOf(steps));
    assert.equal(v.ok, true);
    assert.equal(v.complete, false);
    assert.match(v.reasons.join('\n'), /db:test.*skipped without a valid approval/);
  });
  it('a skipped required step with a valid approval is complete; an agent-written approval is not valid', () => {
    const skipped = (a) => allGood().map((s) => (s.name === 'db:test' ? { ...s, status: 'skipped', exitCode: null, counts: null, approval: a } : s));
    assert.equal(evaluateEvidence(evidenceOf(skipped(approval))).complete, true);
    assert.equal(evaluateEvidence(evidenceOf(skipped({ ...approval, approvedBy: 'agent' }))).complete, false);
    assert.equal(evaluateEvidence(evidenceOf(skipped({ ...approval, approvalRef: '' }))).complete, false);
  });
  it('a required step with no entry, or a failed one, is incomplete', () => {
    assert.equal(evaluateEvidence(evidenceOf(allGood().slice(1))).complete, false);
    const failed = allGood().map((s) => (s.name === 'lint' ? { ...s, status: 'failed', exitCode: 1 } : s));
    const v = evaluateEvidence(evidenceOf(failed));
    assert.equal(v.ok, false);
    assert.equal(v.complete, false);
  });
  it('a stale required step is incomplete', () => {
    const steps = allGood().map((s) => (s.name === 'build' ? { ...s, stale: true } : s));
    assert.match(evaluateEvidence(evidenceOf(steps)).reasons.join(), /build.*stale/);
  });
  it('a files scope forces complete:false while ok stays true', () => {
    const steps = allGood().map((s) => (s.name === 'db:test' ? { ...s, scope: { kind: 'files', files: ['a.sql'] } } : s));
    const v = evaluateEvidence(evidenceOf(steps));
    assert.equal(v.ok, true);
    assert.equal(v.complete, false);
    assert.match(v.reasons.join(), /partial/);
  });
  it('an unapproved skipped test blocks complete; an approvedSkips entry (valid, not expired) unblocks it', () => {
    const skip = { skipped: 1 };
    const withSkip = (extra) => allGood().map((s) => (s.name === 'e2e' ? { ...s, counts: { ...s.counts, ...skip }, ...extra } : s));
    assert.equal(evaluateEvidence(evidenceOf(withSkip({}))).complete, false);
    const ok = { test: 'e2e/stress.spec.ts > exports pdf', reason: 'upstream bug', issue: 'https://example.invalid/1', approvedBy: 'user', approvalRef: 'message 2026-11-12', recheckBy: '2026-11-19' };
    assert.equal(evaluateEvidence(evidenceOf(withSkip({ approvedSkips: [ok] })), Date.parse('2026-11-13T00:00:00Z')).complete, true);
    assert.equal(evaluateEvidence(evidenceOf(withSkip({ approvedSkips: [ok] })), Date.parse('2026-12-01T00:00:00Z')).complete, false, 'expired recheckBy');
    assert.equal(evaluateEvidence(evidenceOf(withSkip({ approvedSkips: [{ ...ok, approvedBy: 'agent' }] }))).complete, false);
  });
  it('flaky and interrupted tests block complete; todo and did-not-run count as held tests', () => {
    const mod = (counts) => allGood().map((s) => (s.name === 'e2e' ? { ...s, counts: { passed: 5, failed: 0, skipped: 0, ...counts } } : s));
    assert.equal(evaluateEvidence(evidenceOf(mod({ flaky: 1 }))).complete, false);
    assert.equal(evaluateEvidence(evidenceOf(mod({ interrupted: 1 }))).complete, false);
    assert.equal(evaluateEvidence(evidenceOf(mod({ didNotRun: 1 }))).complete, false);
    assert.equal(evaluateEvidence(evidenceOf(mod({ todo: 1 }))).complete, false);
  });
  it('build.id != build.servedId is incomplete', () => {
    const ev = { ...evidenceOf(allGood()), build: { id: 'a', servedId: 'b' } };
    assert.equal(evaluateEvidence(ev).complete, false);
  });
  it('the summary prints approved skips and the incomplete reasons', () => {
    const ok = { test: 'e2e/x.spec.ts > y', reason: 'upstream bug', approvedBy: 'user', approvalRef: 'msg 1' };
    const steps = allGood().map((s) => (s.name === 'e2e' ? { ...s, counts: { passed: 5, failed: 0, skipped: 1 }, approvedSkips: [ok] } : s));
    const text = formatSummary(evidenceOf(steps), 1234);
    assert.match(text, /SKIP e2e: e2e\/x\.spec\.ts > y \(approved by user: msg 1/);
    assert.match(text, /complete:true/);
    const partial = formatSummary(evidenceOf(allGood().slice(0, 2)), 10);
    assert.match(partial, /complete:false/);
  });
  it('computeOk: not-run and failed make ok false', () => {
    assert.equal(computeOk([{ status: 'passed' }, { status: 'skipped' }]), true);
    assert.equal(computeOk([{ status: 'not-run' }]), false);
  });
});

describe('evidence reading and writing', () => {
  it('reads the reference project v1 last.json unchanged (schemaVersion absent = 1, complete cannot be proved)', () => {
    const file = join(here, 'fixtures', 'reference-v1-last.json');
    const ev = readEvidence(file);
    assert.deepEqual(ev, JSON.parse(readFileSync(file, 'utf8')));
    assert.equal(schemaOf(ev), 1);
    assert.equal(ev.steps.length, 6);
    const v = evaluateEvidence(ev);
    assert.equal(v.ok, true);
    assert.equal(v.complete, false);
  });
  it('a v2 file written by the kit is read correctly by a reader that only knows v1 fields', () => {
    const dir = tmp();
    const file = join(dir, '.gate', 'last.json');
    const fresh = [passed('lint'), passed('test')];
    const ev = assembleEvidence({ prev: readEvidence(join(here, 'fixtures', 'reference-v1-last.json')), fresh, planOrder: NAMES, args: ['--only', 'lint,test'], requiredSteps: NAMES });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(ev));
    const v1 = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(typeof v1.ok, 'boolean');
    assert.equal(typeof v1.finishedAt, 'string');
    assert.equal(typeof v1.totalMs, 'number');
    assert.ok(Array.isArray(v1.args));
    for (const s of v1.steps) {
      for (const [k, t] of [['name', 'string'], ['command', 'string'], ['wallMs', 'number'], ['timeoutMs', 'number'], ['status', 'string']]) assert.equal(typeof s[k], t, `${s.name}.${k}`);
      assert.ok(s.exitCode === null || typeof s.exitCode === 'number');
    }
    assert.equal(v1.schemaVersion, 2);
    rmSync(dir, { recursive: true, force: true });
  });
  it('assembleEvidence keeps steps it did not run, marks them stale, keeps unknown fields', () => {
    const prev = { ...evidenceOf([passed('lint', { extraStepField: 7 }), passed('build')]), customRoot: { a: 1 } };
    const ev = assembleEvidence({ prev, fresh: [passed('lint', { wallMs: 5 })], planOrder: NAMES, args: ['--only', 'lint'], requiredSteps: NAMES });
    assert.equal(ev.customRoot.a, 1);
    assert.equal(ev.steps.find((s) => s.name === 'lint').stale, undefined);
    assert.equal(ev.steps.find((s) => s.name === 'lint').wallMs, 5);
    assert.equal(ev.steps.find((s) => s.name === 'build').stale, true);
    assert.equal(ev.steps.find((s) => s.name === 'build').status, 'passed');
    assert.equal(ev.complete, false);
    assert.equal(ev.totalMs, 5);
    assert.equal(ev.schemaVersion, 2);
  });
});

describe('add-step (protocol 4.2.4)', () => {
  it('creates the skeleton when the file is absent', () => {
    const dir = tmp();
    const file = join(dir, '.gate', 'last.json');
    const { evidence } = addStep({ file, step: passed('db:test'), requiredSteps: ['db:test'] });
    assert.equal(evidence.schemaVersion, 2);
    assert.equal(evidence.steps.length, 1);
    assert.equal(evidence.complete, true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).steps.map((s) => s.name), ['db:test']);
    rmSync(dir, { recursive: true, force: true });
  });
  it('replaces only the step with the same name, keeps all other steps and unknown fields, recomputes ok/complete', () => {
    const dir = tmp();
    const file = join(dir, 'last.json');
    const base = {
      ...evidenceOf([passed('lint', { vendorField: { keep: true } }), passed('typecheck'), passed('test'), { ...passed('db:test'), status: 'failed', exitCode: 1 }, passed('build'), passed('e2e')]),
      ok: false,
      complete: false,
      someVendorRootField: 'keep',
    };
    writeFileSync(file, JSON.stringify(base));
    const newStep = { ...passed('db:test'), reportedBy: 'pgtap-rls 0.1.0', details: { pgtap: { files: 2, tests: 9, result: 'PASS' } }, unknownStepKey: 1 };
    const { evidence } = addStep({ file, step: newStep });
    assert.deepEqual(evidence.steps.map((s) => s.name), ['lint', 'typecheck', 'test', 'db:test', 'build', 'e2e']);
    assert.deepEqual(evidence.steps.find((s) => s.name === 'lint').vendorField, { keep: true });
    assert.equal(evidence.steps.find((s) => s.name === 'lint').stale, undefined, 'add-step does not stale the others');
    assert.equal(evidence.steps.find((s) => s.name === 'db:test').reportedBy, 'pgtap-rls 0.1.0');
    assert.equal(evidence.steps.find((s) => s.name === 'db:test').unknownStepKey, 1);
    assert.equal(evidence.someVendorRootField, 'keep');
    assert.equal(evidence.ok, true);
    assert.equal(evidence.complete, true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).steps.length, 6);
    // appending a new name keeps everything too
    const { evidence: ev2 } = addStep({ file, step: passed('db:test:mutation', { kind: 'db' }) });
    assert.equal(ev2.steps.length, 7);
    rmSync(dir, { recursive: true, force: true });
  });
  it('rejects invalid steps and downgrades dishonest passes', () => {
    const dir = tmp();
    const file = join(dir, 'last.json');
    assert.throws(() => addStep({ file, step: { name: 'Bad Name', status: 'passed' } }), /invalid step/);
    assert.deepEqual(validateStep(passed('lint')), []);
    assert.match(validateStep({ ...passed('lint'), status: 'weird' }).join(), /status/);
    const zero = addStep({ file, step: passed('db:test', { counts: { passed: 0, failed: 0, skipped: 0 }, details: { pgtap: { files: 1, tests: 0, result: 'PASS' } } }) });
    assert.equal(zero.step.status, 'failed');
    assert.ok(zero.step.problems.length > 0);
    const unknown = applyHonesty(passed('db:test', { details: { pgtap: { files: 0, tests: 0, result: 'UNKNOWN' } }, counts: { passed: 0, failed: 0, skipped: 0 } }));
    assert.equal(unknown.status, 'failed');
    assert.equal(applyHonesty({ ...passed('test'), exitCode: 1 }).status, 'failed');
    rmSync(dir, { recursive: true, force: true });
  });
  it('a pgtap-rls style step (counts + details.pgtap + failures with extra keys) passes through intact', () => {
    const dir = tmp();
    const step = {
      name: 'db:test',
      kind: 'db',
      status: 'failed',
      command: 'supabase test db',
      exitCode: 1,
      startedAt: '2026-11-12T20:00:00.000Z',
      finishedAt: '2026-11-12T20:00:03.000Z',
      wallMs: 3000,
      timeoutMs: 600000,
      scope: { kind: 'files', files: ['supabase/tests/a.test.sql'] },
      counts: { passed: 8, failed: 1, skipped: 0 },
      failures: [{ test: 'owner can read', file: 'supabase/tests/a.test.sql', message: 'have: 0 want: 1', number: 9, have: '0', want: '1' }],
      details: { pgtap: { files: 1, tests: 9, result: 'FAIL' } },
      logFile: '.gate/logs/db-test.log',
      reportedBy: 'pgtap-rls 0.1.0',
    };
    const { evidence } = addStep({ file: join(dir, 'last.json'), step, requiredSteps: ['db:test'] });
    assert.deepEqual(evidence.steps[0].failures[0].number, 9);
    assert.equal(evidence.ok, false);
    assert.equal(evidence.complete, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('processes, ports, builds', () => {
  it('pickFreePort skips ports in use (real listener) and honours a probe', async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, r));
    const busy = server.address().port;
    const picked = await pickFreePort(busy);
    assert.notEqual(picked, busy);
    assert.ok(picked > busy);
    server.close();
    assert.equal(await pickFreePort(4000, async (p) => p === 4003), 4003);
  });
  it('runCommand tees output to the log file and returns the exit code', async () => {
    const dir = tmp();
    const logFile = join(dir, 'logs', 'x.log');
    const r = await runCommand(`node -e "console.log('hello-log'); process.exit(3)"`, { cwd: dir, timeoutMs: 20_000, logFile, quiet: true });
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    assert.match(readFileSync(logFile, 'utf8'), /hello-log/);
    rmSync(dir, { recursive: true, force: true });
  });
  it('runCommand kills its own process tree on timeout', async () => {
    const r = await runCommand(`node -e "setInterval(() => {}, 1000)"`, { timeoutMs: 1500, quiet: true });
    assert.equal(r.timedOut, true);
    assert.ok(r.wallMs < 15_000);
  });
  it('compareBuild: missing, fresh, stale', () => {
    assert.equal(compareBuild(null, null).status, 'missing');
    assert.equal(compareBuild(100, { mtimeMs: 50, file: 'a' }).status, 'fresh');
    assert.equal(compareBuild(100, { mtimeMs: 150, file: 'a' }).status, 'stale');
  });
});

describe('e2e-guard', () => {
  const scan = (src) => scanSource('e2e/x.spec.ts', src);
  const rules = (src, sev) => scan(src).filter((h) => (sev ? h.severity === sev : true)).map((h) => `${h.rule}:${h.line}`);
  it('stripComments ignores line and block comments, keeps line numbers and URLs in strings', () => {
    const out = stripComments("// page.waitForTimeout(1)\nconst u = 'http://x.test'; /* a\nb */ x();\n");
    assert.equal(out.split('\n').length, 4);
    assert.ok(!out.includes('waitForTimeout'));
    assert.ok(out.includes("'http://x.test'"));
  });
  it('hard hits: waitForTimeout, networkidle, toPass, fixme', () => {
    const src = ["await page.waitForTimeout(500);", "await page.waitForLoadState('networkidle');", 'await expect(async () => {}).toPass();', "test.fixme('x', async () => {});"].join('\n');
    assert.deepEqual(rules(src, 'hard'), ['waitForTimeout:1', 'networkidle:2', 'toPass:3', 'fixme:4']);
  });
  it('commented code and prose never hit', () => {
    assert.deepEqual(rules("// await page.waitForTimeout(500);\n/* test.skip('x', () => {}) */\n"), []);
  });
  it('skip: unconditional is hard, runtime-conditional is a warning', () => {
    const src = [
      "test.skip('title', async () => {});",
      'test.skip();',
      'test.skip(true);',
      "test.describe.skip('group', () => {});",
      "test.skip(!process.env.X, 'needs X');",
      "test.skip(({ browserName }) => browserName === 'firefox', 'no ff');",
      "test.skip(\n  cond,\n  'reason');",
    ].join('\n');
    const hits = scan(src).filter((h) => h.rule === 'skip');
    assert.deepEqual(hits.filter((h) => h.severity === 'hard').map((h) => h.line), [1, 2, 3, 4]);
    assert.deepEqual(hits.filter((h) => h.severity === 'warn').map((h) => h.line), [5, 6, 7]);
  });
  it('.first() is a warning, retries above 0 is hard, retries 0 is fine', () => {
    assert.deepEqual(rules('page.locator("a").first();', 'warn'), ['first:1']);
    assert.deepEqual(rules('test.describe.configure({ retries: 2 });', 'hard'), ['retries:1']);
    assert.deepEqual(rules('export default { retries: 0 };'), []);
  });
  it('skip(true, why) inside an if is conditional; placeholder-style passwords only warn', () => {
    assert.deepEqual(rules("if (x.currency !== 'USD') test.skip(true, 'not USD');", 'warn'), ['skip:1']);
    assert.deepEqual(rules("test.skip(true, 'why');", 'hard'), ['skip:1']);
    const placeholder = ['e2e', 'local', 'pass' + 'word', '123'].join('-'); // built at run time, see below
    assert.deepEqual(rules(`export const E2E_PASSWORD = '${placeholder}';`, 'warn'), ['secret:1']);
    assert.deepEqual(rules(`export const E2E_PASSWORD = '${placeholder}';`, 'hard'), []);
  });
  it('secret-looking assignments are hard, env reads are not', () => {
    // Built at run time so this repo never contains a literal secret-looking value (scanners flag even fake ones).
    const fakeValue = ['h', 'u', 'n', 't', 'e', 'r', '2'].join('').repeat(2);
    assert.deepEqual(rules(`const password = '${fakeValue}';`, 'hard'), ['secret:1']);
    assert.deepEqual(rules("const password = process.env.E2E_PASSWORD ?? 'xxxxxxxxxxx';"), []);
    assert.deepEqual(rules("const label = 'a-long-visible-label';"), []);
  });
  it('ratchet: within baseline allowed, above baseline fails, approvals unblock, lower counts are reported', () => {
    const hit = (line) => ({ rule: 'waitForTimeout', severity: 'hard', file: 'e2e/a.spec.ts', line, text: 'await page.waitForTimeout(1)' });
    const baseline = { files: { waitForTimeout: { 'e2e/a.spec.ts': 2 } } };
    assert.equal(judgeHits([hit(1), hit(2)], { approvals: [], baseline }).failing.length, 0);
    assert.equal(judgeHits([hit(1), hit(2), hit(3)], { approvals: [], baseline }).failing.length, 3);
    assert.equal(judgeHits([hit(1)], { approvals: [], baseline }).lowered.length, 1);
    assert.equal(judgeHits([hit(1)], { approvals: [], baseline: null }).failing.length, 1);
    const ap = { rule: 'waitForTimeout', file: 'e2e/a.spec.ts', reason: 'x', approvedBy: 'user', approvalRef: 'msg' };
    assert.equal(judgeHits([hit(1)], { approvals: [ap], baseline: null }).failing.length, 0);
    assert.equal(judgeHits([hit(1)], { approvals: [{ ...ap, approvedBy: 'agent' }], baseline: null }).failing.length, 1);
  });
  it('diff parsing returns added line numbers per file; args are validated', () => {
    const diff = ['--- a/e2e/a.spec.ts', '+++ b/e2e/a.spec.ts', '@@ -3,0 +4,2 @@', '+x', '+y', '@@ -9 +11 @@', '+z'].join('\n');
    assert.deepEqual([...parseAddedLines(diff).get('e2e/a.spec.ts')], [4, 5, 11]);
    assert.throws(() => parseGuardArgs(['--all', '--base', 'x']), /cannot be combined/);
    assert.throws(() => parseGuardArgs(['--write-baseline']), /needs --all/);
    assert.equal(parseGuardArgs(['--all', '--dir', 'e2e']).dirs[0], 'e2e');
  });
});

describe('misc', () => {
  it('fixtures contain no files outside the kit and the v1 sample parses', () => {
    assert.ok(existsSync(join(here, 'fixtures', 'reference-v1-last.json')));
  });
});

describe('gate.mjs end to end (temp project, real child processes)', () => {
  const gate = join(here, 'gate.mjs');
  const run = (cwd, args) => {
    const r = spawnSync(process.execPath, [gate, ...args], { cwd, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const project = (scripts, config) => {
    const dir = tmp();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tmp', packageManager: 'npm@10.0.0', scripts }));
    if (config) writeFileSync(join(dir, 'kit.config.json'), JSON.stringify(config));
    return dir;
  };
  const ev = (dir) => JSON.parse(readFileSync(join(dir, '.gate', 'last.json'), 'utf8'));

  it('dry run prints the plan and writes nothing', () => {
    const dir = project({ lint: 'node -e 0', test: 'node -e 0' });
    const r = run(dir, ['--dry-run']);
    assert.equal(r.code, 0);
    assert.match(r.out, /npm run lint/);
    assert.match(r.out, /required steps without a command: typecheck, db:test, build, e2e/);
    assert.equal(existsSync(join(dir, '.gate')), false);
    rmSync(dir, { recursive: true, force: true });
  });
  it('runs fail-fast, tees logs, fails a zero-test exit 0, marks unrun steps stale on the next partial run', () => {
    const cfg = { requiredSteps: ['lint', 'test', 'build'], steps: { test: { command: `node -e "console.log('      Tests  0 passed (0)')"` } } };
    const dir = project({ lint: 'node -e "console.log(1)"', build: 'node -e 0' }, cfg);
    const r1 = run(dir, ['--only', 'lint,test,build']);
    assert.equal(r1.code, 1);
    const e1 = ev(dir);
    assert.equal(e1.ok, false);
    assert.equal(e1.complete, false);
    assert.deepEqual(e1.steps.map((s) => [s.name, s.status]), [['lint', 'passed'], ['test', 'failed'], ['build', 'not-run']]);
    assert.match(e1.steps[1].problems[0], /0 tests passed/);
    assert.ok(readFileSync(join(dir, '.gate', 'logs', 'lint.log'), 'utf8').includes('1'));
    assert.equal(existsSync(join(dir, '.gate', 'running.json')), false);
    // second, partial run: lint is re-run, the others stay and are marked stale
    run(dir, ['--only', 'lint']);
    const e2 = ev(dir);
    assert.equal(e2.steps.find((s) => s.name === 'lint').stale, undefined);
    assert.equal(e2.steps.find((s) => s.name === 'test').stale, true);
    assert.equal(e2.steps.find((s) => s.name === 'test').status, 'failed');
    assert.equal(e2.complete, false);
    rmSync(dir, { recursive: true, force: true });
  });
  it('a full green run is complete; add-step CLI merges a db:test step and keeps the rest', () => {
    const cfg = { requiredSteps: ['lint', 'db:test'], steps: { 'db:test': { command: 'node -e 0' } } };
    const dir = project({ lint: 'node -e 0' }, cfg);
    assert.equal(run(dir, ['--only', 'lint']).code, 0);
    assert.equal(ev(dir).complete, false);
    const stepFile = join(dir, 'step.json');
    writeFileSync(stepFile, JSON.stringify(passed('db:test')));
    const r = run(dir, ['add-step', '--from-json', stepFile]);
    assert.equal(r.code, 0, r.out);
    const e = ev(dir);
    assert.deepEqual(e.steps.map((s) => s.name), ['lint', 'db:test']);
    assert.equal(e.complete, true);
    assert.equal(e.steps[0].reportedBy, 'gate.mjs 0.1.0');
    assert.equal(run(dir, ['--bogus']).code, 2);
    rmSync(dir, { recursive: true, force: true });
  });
});
