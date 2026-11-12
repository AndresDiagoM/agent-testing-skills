import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildMutationSql, mutateSource, main, POLICY_NAME } from '../mutate-test.mjs';

const SAMPLE = `-- sample
begin;
create extension if not exists pgtap with schema extensions;
select plan(2);
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select throws_ok($$select 1 from public.t$$, '42501', null, 'anon cannot read');
select * from finish();
rollback;
`;
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const quiet = async (fn) => {
  const l = console.log; const e = console.error; console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = l; console.error = e; }
};

test('policy SQL is valid per command (USING only for select/delete, WITH CHECK only for insert)', () => {
  const q = (cmd) => buildMutationSql({ table: 't', role: 'authenticated', cmd })[0];
  assert.match(q('select'), /for select to authenticated using \(true\);$/);
  assert.match(q('delete'), /for delete to authenticated using \(true\);$/);
  assert.match(q('insert'), /for insert to authenticated with check \(true\);$/);
  assert.match(q('update'), /using \(true\) with check \(true\);$/);
  assert.match(q('all'), /for all .* using \(true\) with check \(true\);$/);
  assert.ok(q('select').includes(POLICY_NAME));
});

test('grant mutation and identifier validation', () => {
  assert.deepEqual(buildMutationSql({ table: 't', role: 'anon', policy: false, grant: 'select' }), ['grant select on public.t to anon;']);
  assert.deepEqual(buildMutationSql({ role: 'anon', policy: false, grant: 'execute', fn: 'public.f(uuid)' }), ['grant execute on function public.f(uuid) to anon;']);
  assert.throws(() => buildMutationSql({ table: 't; drop table x', role: 'anon' }));
  assert.throws(() => buildMutationSql({ table: 't', role: 'anon; --' }));
  assert.throws(() => buildMutationSql({ table: 't', role: 'anon', cmd: 'truncate' }));
  assert.throws(() => buildMutationSql({ table: 't', role: 'anon', policy: false }));
  assert.throws(() => buildMutationSql({ role: 'anon', policy: false, grant: 'execute', fn: 'f(); drop' }));
});

test('mutation lands right after "select plan(", before any role switch', () => {
  const out = mutateSource(SAMPLE, ['create policy zz on public.t for select to anon using (true);']);
  const lines = out.split('\n');
  const iPlan = lines.findIndex((l) => l.startsWith('select plan('));
  const iPol = lines.findIndex((l) => l.startsWith('create policy zz'));
  const iRole = lines.findIndex((l) => l.startsWith('set local role'));
  assert.ok(iPlan < iPol && iPol < iRole);
  assert.ok(lines[0].startsWith('-- MUTATED COPY'));
});

test('CRLF files keep CRLF', () => {
  const out = mutateSource(SAMPLE.replace(/\n/g, '\r\n'), ['select 1;']);
  assert.ok(!/[^\r]\n/.test(out));
});

test('refuses files without begin; / rollback; / plan, or with commit;', () => {
  assert.throws(() => mutateSource(SAMPLE.replace('rollback;', '-- rollback;'), ['x']), /rollback/);
  assert.throws(() => mutateSource(SAMPLE.replace('begin;', ''), ['x']), /begin/);
  assert.throws(() => mutateSource(SAMPLE.replace('select plan(2);', ''), ['x']), /plan/);
  assert.throws(() => mutateSource(SAMPLE.replace('rollback;', 'commit;\nrollback;'), ['x']), /commit/);
});

test('CLI: original is byte-identical; a file without rollback; is refused and nothing is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  try {
    const f = join(dir, '10_x.test.sql');
    writeFileSync(f, SAMPLE);
    const before = sha(f);
    const outDir = join(dir, 'out');
    assert.equal(await quiet(() => main([f, '--table', 't', '--role', 'anon', '--cmd', 'select', '--out-dir', outDir])), 0);
    assert.equal(sha(f), before, 'original untouched');
    const g = join(dir, '11_bad.test.sql');
    writeFileSync(g, SAMPLE.replace('rollback;', ''));
    const gBefore = sha(g);
    assert.equal(await quiet(() => main([g, '--table', 't', '--role', 'anon', '--out-dir', outDir])), 2);
    assert.equal(sha(g), gBefore);
    const copies = readdirSync(outDir);
    assert.equal(copies.length, 1, 'only the first run wrote a copy');
    assert.ok(readFileSync(join(outDir, copies[0]), 'utf8').includes(POLICY_NAME));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI --in-folder writes _mutation_<name> next to the original and leaves the original alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  try {
    const f = join(dir, '10_x.test.sql');
    writeFileSync(f, SAMPLE);
    const before = sha(f);
    assert.equal(await quiet(() => main([f, '--table', 't', '--role', 'anon', '--in-folder'])), 0);
    assert.equal(sha(f), before);
    assert.ok(existsSync(join(dir, '_mutation_10_x.test.sql')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--help works and a missing --role is a usage error', async () => {
  assert.equal(await quiet(() => main(['--help'])), 0);
  const dir = mkdtempSync(join(tmpdir(), 'mut-'));
  try {
    const f = join(dir, 'a.test.sql');
    writeFileSync(f, SAMPLE);
    assert.equal(await quiet(() => main([f, '--table', 't'])), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
