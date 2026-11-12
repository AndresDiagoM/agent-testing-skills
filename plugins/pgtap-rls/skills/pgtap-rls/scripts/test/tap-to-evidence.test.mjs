// node --test scripts/test/   (Node 20+, no dependencies). real-cli-3.1.0-* fixtures are REAL captures; the rest are synthetic: see fixtures/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTap, buildStep, decideStatus, mergeEvidence, guardCommand, stripAnsi, main, REPORTED_BY, VERSION,
} from '../tap-to-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(here, 'fixtures', n), 'utf8');
const step = (name, exitCode = 0, extra = {}) => buildStep({ parsed: parseTap(fx(name)), exitCode, wallMs: 1234, command: 'supabase test db', ...extra });
const tmp = () => mkdtempSync(join(tmpdir(), 'tap-ev-'));
const quiet = async (fn) => {
  const e = console.error; const l = console.log; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.error = e; console.log = l; }
};

test('all pass: counts and status', () => {
  const p = parseTap(fx('all-pass.txt'));
  assert.deepEqual([p.files, p.tests, p.result, p.failedCount], [2, 30, 'PASS', 0]);
  const s = step('all-pass.txt');
  assert.equal(s.status, 'passed');
  assert.deepEqual(s.counts, { passed: 30, failed: 0, skipped: 0, files: 2, tests: 30, result: 'PASS' }, 'skipped is a number (test-gate schema)');
  assert.deepEqual(s.details.pgtap, { files: 2, tests: 30, result: 'PASS', skipsVisible: false, statusReasons: [] });
  assert.equal(s.kind, 'db');
  assert.equal(s.reportedBy, REPORTED_BY);
  assert.equal(REPORTED_BY, `pgtap-rls ${VERSION}`);
  assert.equal(s.failures, undefined);
});

test('one failing test: failure entry has file, number, have, want', () => {
  const s = step('one-fail.txt', 1);
  assert.equal(s.status, 'failed');
  assert.equal(s.counts.failed, 1);
  assert.equal(s.counts.passed, 29);
  assert.deepEqual(s.failures, [{
    test: 'A does not see B portfolios', file: 'supabase/tests/database/01_rls.test.sql',
    message: 'have: 1; want: 0', number: 3, have: '1', want: '0',
  }]);
  assert.ok(s.failures.every((f) => f.file === undefined || typeof f.file === 'string'), 'schema: failure.file is a string when present');
});

test('plan mismatch is failed even though the Failed count is 0', () => {
  const s = step('plan-mismatch.txt', 1);
  assert.equal(s.status, 'failed');
  assert.ok(s.failures.some((f) => f.test === 'plan' && /planned 5 tests but ran 4/.test(f.message)));
  assert.equal(s.failures.filter((f) => f.test === 'plan').length, 1, 'plan mismatch listed once');
  assert.ok(s.details.pgtap.statusReasons.includes('plan mismatch'));
});

test('test died mid-file: failed, first SQL error recorded', () => {
  const s = step('died-midfile.txt', 3);
  assert.equal(s.status, 'failed');
  assert.match(s.details.pgtap.firstSqlError, /relation "public.nope" does not exist/);
  assert.ok(s.failures.some((f) => /did not finish cleanly/.test(f.message)));
});

test('zero files / zero tests / unparsable output are failed, never passed', () => {
  for (const f of ['zero-files.txt', 'garbage.txt']) {
    const s = step(f, 0);
    assert.equal(s.status, 'failed', f);
    assert.equal(s.counts.passed, 0);
  }
  assert.equal(decideStatus({ parsed: parseTap(''), exitCode: 0 }).status, 'failed');
});

test('exit code non-zero fails an otherwise clean log; Result FAIL with exit 0 fails too', () => {
  assert.equal(step('all-pass.txt', 2).status, 'failed');
  assert.equal(step('one-fail.txt', 0).status, 'failed');
});

test('timeout status', () => {
  const s = buildStep({ parsed: parseTap(''), exitCode: null, timedOut: true, wallMs: 600000 });
  assert.equal(s.status, 'timeout');
  assert.equal(s.exitCode, null);
});

test('ANSI and CRLF are handled', () => {
  const raw = fx('ansi-crlf.txt');
  assert.ok(raw.includes('\r\n') && raw.includes(String.fromCharCode(27)));
  assert.ok(!stripAnsi(raw).includes(String.fromCharCode(27)));
  const p = parseTap(raw);
  assert.deepEqual([p.files, p.tests, p.result], [2, 30, 'PASS']);
  assert.equal(step('ansi-crlf.txt').status, 'passed');
});

test('verbose output exposes skipped; unapproved skips are flagged', () => {
  const s = step('verbose-skip.txt', 1);
  assert.equal(s.counts.skipped, 1);
  assert.equal(s.details.pgtap.skipsUnapproved, true);
  const ok = step('verbose-skip.txt', 1, { approvedSkips: [{ test: 'x', reason: 'r', approvedBy: 'user', approvalRef: 'msg' }] });
  assert.equal(ok.details.pgtap.skipsUnapproved, undefined);
});

test('mutation step: passed only when the mutated copy fails as expected', () => {
  const killed = step('one-fail.txt', 1, { mutation: true, name: 'db:test:mutation' });
  assert.equal(killed.status, 'passed');
  assert.equal(killed.details.pgtap.mutation.killed, true);
  assert.equal(killed.failures, undefined);
  assert.equal(killed.details.pgtap.mutation.killedBy[0].number, 3);
  const survived = step('all-pass.txt', 0, { mutation: true, name: 'db:test:mutation' });
  assert.equal(survived.status, 'failed');
  assert.equal(survived.details.pgtap.mutation.killed, false);
  assert.equal(step('garbage.txt', 1, { mutation: true }).status, 'failed');
});

// ---- real captures from `supabase test db` (CLI 3.1.0, local stack, 2026-11-12) ----
// The wrapper's log holds stdout and stderr; the stderr half (Target line, psql NOTICE/ERROR, "error running container") is appended.
const real = (name) => fx(`real-cli-3.1.0-${name}.txt`);
const realLog = (name) => real(name) + fx(`real-cli-3.1.0-${name}.stderr.txt`);

test('REAL pass: 14 files, 370 tests, Result PASS (default output has no "ok N" lines and no progress counters)', () => {
  for (const text of [real('pass'), realLog('pass')]) {
    const p = parseTap(text);
    assert.deepEqual([p.files, p.tests, p.result, p.failedCount, p.verbose], [14, 370, 'PASS', 0, false]);
    assert.deepEqual([p.failures, p.dubious, p.planMismatches, p.parseErrors, p.sqlErrors], [[], [], [], [], []], 'NOTICE lines are not errors');
  }
  const s = buildStep({ parsed: parseTap(realLog('pass')), exitCode: 0, wallMs: 5568, command: 'supabase test db' });
  assert.equal(s.status, 'passed');
  assert.deepEqual(s.counts, { passed: 370, failed: 0, skipped: 0, files: 14, tests: 370, result: 'PASS' });
  assert.equal(s.details.pgtap.skipsVisible, false);
});

test('REAL fail: one wrong expectation gives file, test number, name, have and want', () => {
  const s = buildStep({ parsed: parseTap(realLog('fail')), exitCode: 1, wallMs: 2812, command: 'supabase test db /work/scratch/01_rls_wrong.test.sql' });
  assert.equal(s.status, 'failed');
  assert.deepEqual([s.counts.passed, s.counts.failed, s.counts.tests], [21, 1, 22]);
  assert.deepEqual(s.failures, [{ test: 'A does not see B portfolios', file: '/work/scratch/01_rls_wrong.test.sql', message: 'have: 0; want: 1', number: 2, have: '0', want: '1' }]);
});

test('REAL plan mismatch: "Failed 0" in the summary line, still failed, listed once', () => {
  const s = buildStep({ parsed: parseTap(realLog('plan')), exitCode: 1, command: 'supabase test db' });
  assert.equal(s.status, 'failed');
  assert.ok(s.details.pgtap.statusReasons.includes('plan mismatch'));
  assert.deepEqual(s.failures.filter((f) => f.test === 'plan').map((f) => [f.have, f.want]), [['4', '5']]);
});

test('REAL died file: Dubious + Non-zero exit status, first SQL error recorded from stderr', () => {
  const s = buildStep({ parsed: parseTap(realLog('died')), exitCode: 1, command: 'supabase test db' });
  assert.equal(s.status, 'failed');
  assert.match(s.details.pgtap.firstSqlError, /relation "public.does_not_exist" does not exist/);
  assert.ok(s.failures.some((f) => /did not finish cleanly/.test(f.message)));
  assert.deepEqual(parseTap(realLog('died')).parseErrors.map((e) => e.message), ['Bad plan. You planned 2 tests but ran 1.'], 'stderr lines after the summary are not swallowed');
});

test('REAL skip(): default pg_prove output cannot show it, so counts.skipped is 0 and skipsVisible is false', () => {
  const p = parseTap(realLog('skip'));
  assert.deepEqual([p.files, p.tests, p.result], [1, 3, 'PASS'], 'the skipped test is counted among Tests=3');
  assert.equal(p.skippedCount, null);
  const s = buildStep({ parsed: p, exitCode: 0, command: 'supabase test db' });
  assert.equal(s.counts.skipped, 0);
  assert.equal(s.details.pgtap.skipsVisible, false);
});

const existing = () => ({
  schemaVersion: 2, ok: true, complete: true, finishedAt: 'old', totalMs: 5000, args: ['--only', 'e2e'],
  requiredSteps: ['lint', 'db:test'], git: { head: 'abc', dirty: false }, customRootField: { keep: 'me' },
  steps: [
    { name: 'lint', status: 'passed', command: 'pnpm lint', exitCode: 0, wallMs: 10, timeoutMs: 1, counts: null, futureField: 7 },
    { name: 'db:test', status: 'failed', command: 'old', exitCode: 1, wallMs: 99, timeoutMs: 600000, counts: { files: 1, tests: 1, result: 'FAIL' },
      failures: [{ test: 'stale' }], port: 54322, details: { other: { a: 1 }, pgtap: { old: true } } },
  ],
});

test('merge replaces only db:test, keeps other steps and unknown root fields', () => {
  const before = existing();
  const merged = mergeEvidence(before, step('all-pass.txt'), '2026-11-12T00:00:00.000Z');
  assert.deepEqual(merged.steps[0], before.steps[0], 'lint step untouched');
  assert.deepEqual(merged.customRootField, { keep: 'me' });
  assert.deepEqual(merged.git, before.git);
  assert.deepEqual(merged.args, ['--only', 'e2e']);
  const db = merged.steps[1];
  assert.equal(db.status, 'passed');
  assert.equal(db.failures, undefined, 'old failures dropped');
  assert.equal(db.port, undefined, 'same-name step is replaced as a whole, exactly like gate.mjs add-step');
  assert.equal(db.details.other, undefined);
  assert.equal(db.details.pgtap.old, undefined);
  assert.equal(merged.ok, true);
  assert.equal(merged.complete, true);
  assert.equal(merged.finishedAt, '2026-11-12T00:00:00.000Z');
  assert.equal(merged.steps.length, 2);
  assert.equal(before.steps[1].status, 'failed', 'input not mutated');
});

test('files scope forces complete:false (ok keeps its meaning)', () => {
  const partial = step('all-pass.txt', 0, { scope: { kind: 'files', files: ['supabase/tests/database/01_rls.test.sql'] } });
  const merged = mergeEvidence(existing(), partial);
  assert.equal(merged.ok, true);
  assert.equal(merged.complete, false);
  assert.deepEqual(merged.steps[1].scope, { kind: 'files', files: ['supabase/tests/database/01_rls.test.sql'] });
});

test('failed step sets ok false; a new file without requiredSteps is never complete', () => {
  assert.equal(mergeEvidence(existing(), step('one-fail.txt', 1)).ok, false);
  const fresh = mergeEvidence(null, step('all-pass.txt'));
  assert.equal(fresh.schemaVersion, 2);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.complete, false);
  assert.equal(fresh.steps.length, 1);
});

test('stale required step blocks complete', () => {
  const e = existing();
  e.steps[0].stale = true;
  assert.equal(mergeEvidence(e, step('all-pass.txt')).complete, false);
});

test('guardCommand refuses remote, linked, db reset, db push, down -v, force-reset', () => {
  for (const bad of ['supabase test db --remote', 'supabase test db --linked', 'supabase db reset', 'supabase  db   push',
    'docker compose down -v', 'docker compose down --volumes', 'x --force-reset']) {
    assert.ok(guardCommand(bad), bad);
  }
  assert.equal(guardCommand(['supabase', 'test', 'db', 'supabase/tests/database/01_rls.test.sql']), null);
  assert.equal(guardCommand('pnpm db:test'), null);
});

test('CLI parse: writes atomically, leaves no temp files, other steps survive', async () => {
  const dir = tmp();
  try {
    const ev = join(dir, '.gate', 'last.json');
    mkdirSync(join(dir, '.gate'));
    writeFileSync(ev, JSON.stringify(existing()));
    const code = await quiet(() => main(['parse', '--log', join(here, 'fixtures', 'all-pass.txt'), '--command', 'supabase test db', '--exit-code', '0', '--wall-ms', '4200', '--evidence', ev]));
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(ev, 'utf8'));
    assert.equal(written.steps[0].name, 'lint');
    assert.equal(written.steps[1].wallMs, 4200);
    assert.equal(written.steps[1].exitCode, 0);
    assert.equal(written.customRootField.keep, 'me');
    assert.deepEqual(readdirSync(join(dir, '.gate')).filter((f) => f.endsWith('.tmp')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: corrupt evidence file is not overwritten; run refuses --remote and db reset', async () => {
  const dir = tmp();
  try {
    const ev = join(dir, 'last.json');
    writeFileSync(ev, '{ not json');
    const c1 = await quiet(() => main(['parse', '--log', join(here, 'fixtures', 'all-pass.txt'), '--command', 'x', '--exit-code', '0', '--evidence', ev]));
    const c2 = await quiet(() => main(['run', '--evidence', ev, '--', 'supabase', 'test', 'db', '--remote']));
    const c3 = await quiet(() => main(['run', '--evidence', ev, '--', 'supabase', 'db', 'reset']));
    assert.deepEqual([c1, c2, c3], [2, 2, 2]);
    assert.equal(readFileSync(ev, 'utf8'), '{ not json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI run: executes a command, tees the log, records the step with a non-zero exit', async () => {
  const dir = tmp();
  try {
    const ev = join(dir, '.gate', 'last.json');
    const script = join(dir, 'fake.mjs');
    writeFileSync(script, `console.log(${JSON.stringify(fx('one-fail.txt'))}); process.exit(1);`);
    const code = await quiet(() => main(['run', '--quiet', '--evidence', ev, '--timeout-min', '1', '--', process.execPath, script]));
    assert.equal(code, 1);
    const w = JSON.parse(readFileSync(ev, 'utf8'));
    assert.equal(w.steps[0].exitCode, 1);
    assert.equal(w.steps[0].status, 'failed');
    assert.equal(w.steps[0].logFile, '.gate/logs/db-test.log');
    assert.ok(existsSync(join(dir, '.gate', 'logs', 'db-test.log')));
    assert.equal(w.steps[0].failures[0].number, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--help prints usage and exits 0', async () => {
  const lines = [];
  const orig = console.log; console.log = (m) => lines.push(m);
  const code = await main(['--help']);
  console.log = orig;
  assert.equal(code, 0);
  assert.match(lines.join('\n'), /Usage:/);
});

test('script version matches plugin.json when reachable; no network APIs used', () => {
  const pj = join(here, '..', '..', '..', '..', '.claude-plugin', 'plugin.json');
  if (existsSync(pj)) assert.equal(JSON.parse(readFileSync(pj, 'utf8')).version, VERSION);
  for (const f of ['tap-to-evidence.mjs', 'mutate-test.mjs']) {
    const src = readFileSync(join(here, '..', f), 'utf8');
    assert.ok(!/https?:\/\/|\bfetch\(|node:(net|http|https|dns|tls)\b/.test(src), `${f} must not use the network`);
  }
});
