// node --test scripts/test/   Cross-check of tap-to-evidence against the test-gate kit (the owner of the evidence schema).
// Needs the sibling plugin in the same repo (plugins/test-gate); skipped when it is not there (standalone install).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateEvidence, main } from '../tap-to-evidence.mjs';
import { checkSchema } from './schema-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const kit = join(here, '..', '..', '..', '..', '..', 'test-gate', 'skills', 'test-gate', 'assets', 'kit');
const have = existsSync(join(kit, 'scripts', 'gate.mjs')) && existsSync(join(kit, 'evidence.schema.json'));
const skip = have ? false : 'plugins/test-gate kit not found next to this plugin';
const quiet = async (fn) => {
  const e = console.error; const l = console.log; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; }
};

/** A scratch project with the kit installed under scripts/ and lint + db:test required. */
function project({ withKit = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tap-int-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'scratch', packageManager: 'npm@10.0.0', scripts: { lint: 'node -e 0' } }));
  writeFileSync(join(dir, 'kit.config.json'), JSON.stringify({ requiredSteps: ['lint', 'db:test'], steps: { 'db:test': { command: 'node -e 0' } } }));
  if (withKit) {
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['gate.mjs', 'gate-lib.mjs']) copyFileSync(join(kit, 'scripts', f), join(dir, 'scripts', f));
  }
  return dir;
}
const gateRun = (dir, args) => spawnSync(process.execPath, [join(kit, 'scripts', 'gate.mjs'), '--root', dir, ...args], { encoding: 'utf8' });
const readEv = (dir) => JSON.parse(readFileSync(join(dir, '.gate', 'last.json'), 'utf8'));
const schema = () => JSON.parse(readFileSync(join(kit, 'evidence.schema.json'), 'utf8'));
const normalize = (ev) => JSON.parse(JSON.stringify(ev, (k, v) => (['finishedAt', 'startedAt', 'git', 'environment'].includes(k) ? undefined : v)));
const fixture = (n) => join(here, 'fixtures', n);

test('tap-to-evidence step merged into a gate.mjs-written v2 file validates against evidence.schema.json', { skip }, async () => {
  const dir = project();
  try {
    const r = gateRun(dir, ['--only', 'lint']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readEv(dir).complete, false, 'db:test still missing');
    const ev = join(dir, '.gate', 'last.json');
    const code = await quiet(() => main(['parse', '--log', fixture('all-pass.txt'), '--command', 'supabase test db', '--exit-code', '0', '--wall-ms', '4200', '--evidence', ev]));
    assert.equal(code, 0);
    const out = readEv(dir);
    assert.deepEqual(checkSchema(out, schema()), []);
    assert.deepEqual(out.steps.map((s) => s.name), ['lint', 'db:test']);
    const db = out.steps[1];
    assert.equal(db.status, 'passed');
    assert.equal(db.reportedBy, 'pgtap-rls 0.3.1');
    assert.equal(db.counts.skipped, 0);
    assert.equal(db.details.pgtap.files, 2);
    assert.equal(out.steps[0].reportedBy, 'gate.mjs 0.1.0', 'lint step untouched');
    assert.equal(out.ok, true);
    assert.equal(out.complete, true, 'lint (gate.mjs) + db:test (tap-to-evidence) = complete');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('failing and mutation steps validate too; a surviving mutation breaks ok', { skip }, async () => {
  const dir = project();
  try {
    assert.equal(gateRun(dir, ['--only', 'lint']).status, 0);
    const ev = join(dir, '.gate', 'last.json');
    const run = (log, extra) => quiet(() => main(['parse', '--log', fixture(log), '--command', 'supabase test db', '--evidence', ev, ...extra]));
    assert.equal(await run('one-fail.txt', ['--exit-code', '1']), 1);
    let out = readEv(dir);
    assert.deepEqual(checkSchema(out, schema()), []);
    assert.equal(out.ok, false);
    assert.equal(out.complete, false);
    assert.equal(out.steps[1].failures[0].number, 3);
    // A detected mutation (pg_prove exit 1, red tests) is a custom step recorded as passed with exitCode 0.
    assert.equal(await run('all-pass.txt', ['--exit-code', '0']), 0);
    assert.equal(await run('one-fail.txt', ['--exit-code', '1', '--mutation']), 0);
    out = readEv(dir);
    assert.deepEqual(checkSchema(out, schema()), []);
    const m = out.steps.find((s) => s.name === 'db:test:mutation');
    assert.equal(m.status, 'passed', JSON.stringify(m.problems));
    assert.equal(m.kind, 'custom');
    assert.equal(m.exitCode, 0);
    assert.equal(m.details.pgtap.mutation.pgProveExitCode, 1);
    assert.equal(out.ok, true);
    assert.equal(out.complete, true);
    assert.equal(await run('all-pass.txt', ['--exit-code', '0', '--mutation']), 1);
    assert.equal(readEv(dir).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without the kit the built-in merge gives the same ok/complete/steps as gate.mjs add-step', { skip }, async () => {
  const withKit = project();
  const noKit = project({ withKit: false });
  try {
    for (const d of [withKit, noKit]) assert.equal(gateRun(d, ['--only', 'lint']).status, 0);
    for (const log of ['all-pass.txt', 'one-fail.txt', 'verbose.txt', 'zero.txt']) {
      for (const d of [withKit, noKit]) {
        await quiet(() => main(['parse', '--log', fixture(log), '--command', 'supabase test db', '--exit-code', log === 'all-pass.txt' ? '0' : '1',
          '--wall-ms', '1000', '--required', 'lint,db:test', '--evidence', join(d, '.gate', 'last.json'), ...(d === noKit ? ['--no-gate'] : [])]));
      }
      const a = normalize(readEv(withKit)); const b = normalize(readEv(noKit));
      assert.equal(a.ok, b.ok, log);
      assert.equal(a.complete, b.complete, log);
      assert.deepEqual(a.steps.map((s) => [s.name, s.status]), b.steps.map((s) => [s.name, s.status]), log);
      assert.deepEqual(a.steps.find((s) => s.name === 'db:test').counts, b.steps.find((s) => s.name === 'db:test').counts, log);
      assert.deepEqual(checkSchema(readEv(noKit), schema()), [], log);
    }
  } finally { rmSync(withKit, { recursive: true, force: true }); rmSync(noKit, { recursive: true, force: true }); }
});

test('evaluateEvidence mirror agrees with test-gate gate-lib on a scenario matrix', { skip }, async () => {
  const lib = await import(pathToFileURL(join(kit, 'scripts', 'gate-lib.mjs')).href);
  const ok = (n, extra = {}) => ({ name: n, kind: 'db', status: 'passed', command: 'c', exitCode: 0, wallMs: 5, timeoutMs: 9, counts: { passed: 3, failed: 0, skipped: 0 }, ...extra });
  const appr = { reason: 'r', approvedBy: 'user', approvalRef: 'msg' };
  const skips = (extra) => ok('a', { counts: { passed: 3, failed: 0, skipped: 1 }, ...extra });
  const scenarios = {
    'all green': { requiredSteps: ['a', 'b'], steps: [ok('a'), ok('b')] },
    'no required': { steps: [ok('a')] },
    'empty required': { requiredSteps: [], steps: [ok('a')] },
    'no steps, required': { requiredSteps: ['a'], steps: [] },
    'failed required': { requiredSteps: ['a'], steps: [ok('a', { status: 'failed', exitCode: 1 })] },
    'failed optional': { requiredSteps: ['a'], steps: [ok('a'), ok('x', { status: 'failed', exitCode: 1 })] },
    'not-run step': { requiredSteps: ['a'], steps: [ok('a'), ok('x', { status: 'not-run' })] },
    'stale required': { requiredSteps: ['a'], steps: [ok('a', { stale: true })] },
    'files scope required': { requiredSteps: ['a'], steps: [ok('a', { scope: { kind: 'files', files: ['f'] } })] },
    'files scope optional': { requiredSteps: ['a'], steps: [ok('a'), ok('x', { scope: { kind: 'files', files: ['f'] } })] },
    'unapproved skip': { requiredSteps: ['a'], steps: [skips({})] },
    'approved skip': { requiredSteps: ['a'], steps: [skips({ approvedSkips: [{ test: 't', ...appr }] })] },
    'approval by agent': { requiredSteps: ['a'], steps: [skips({ approvedSkips: [{ test: 't', ...appr, approvedBy: 'claude' }] })] },
    'expired approval': { requiredSteps: ['a'], steps: [skips({ approvedSkips: [{ test: 't', ...appr, recheckBy: '2020-01-01' }] })] },
    'skipped step no approval': { requiredSteps: ['a'], steps: [ok('a', { status: 'skipped', exitCode: null })] },
    'skipped step approved': { requiredSteps: ['a'], steps: [ok('a', { status: 'skipped', exitCode: null, approval: appr })] },
    flaky: { requiredSteps: ['a'], steps: [ok('a', { counts: { passed: 3, failed: 0, skipped: 0, flaky: 1 } })] },
    'build mismatch': { requiredSteps: ['a'], build: { id: '1', servedId: '2' }, steps: [ok('a')] },
    'null counts': { requiredSteps: ['a'], steps: [ok('a', { counts: null })] },
  };
  for (const [name, ev] of Object.entries(scenarios)) {
    const mine = evaluateEvidence(ev); const theirs = lib.evaluateEvidence(ev);
    assert.equal(mine.ok, theirs.ok, `${name}: ok`);
    assert.equal(mine.complete, theirs.complete, `${name}: complete`);
  }
});
