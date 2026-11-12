// Run: node --test scripts/install-global.test.mjs   (node:test, no dependencies)
// Every test uses a fake home (--home); the real home is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listFiles, main, mergeSkillsJson, parseArgs, plan } from './install-global.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dirs = [];
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const write = (root, rel, c) => (mkdirSync(dirname(join(root, rel)), { recursive: true }), writeFileSync(join(root, rel), c));

/** A tiny fake skill folder, so the tests stay fast. */
const fakeSource = () => {
  const s = tmp('ig-src-');
  write(s, 'SKILL.md', '---\nname: test-gate\n---\n# x\n');
  write(s, 'references/a.md', 'a\n');
  write(s, 'assets/kit/scripts/x.mjs', '// x\n');
  write(s, 'node_modules/skip.txt', 'never copied\n');
  return s;
};
const run = (args) => {
  const out = [];
  const code = main(args, (s) => out.push(s));
  return { code, out: out.join('\n') };
};
const everything = (root) => {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      out.push(f.slice(root.length));
      if (e.isDirectory()) walk(f);
    }
  };
  walk(root);
  return out;
};
const isLinkTo = (p, target) => lstatSync(p).isSymbolicLink() && realpathSync(p) === realpathSync(target);

describe('install-global with a fake home', () => {
  it('--help exits 0, bad arguments exit 2, the default source is the real skill folder', () => {
    assert.equal(run(['--help']).code, 0);
    assert.equal(run(['--nope']).code, 2);
    assert.equal(parseArgs([]).source, resolve(here, '..', 'skills', 'test-gate'));
    assert.equal(parseArgs([]).home, homedir());
    assert.ok(existsSync(join(parseArgs([]).source, 'SKILL.md')));
  });
  it('dry run (the default) prints the plan and writes nothing', () => {
    const home = tmp('ig-home-');
    const r = run(['--home', home, '--source', fakeSource()]);
    assert.equal(r.code, 0);
    assert.match(r.out, /DRY RUN/);
    assert.match(r.out, /\[create\s*\] copy/);
    assert.match(r.out, /\[create\s*\] agy/);
    assert.deepEqual(everything(home), []);
  });
  it('--apply creates the copy with .installed-from, both links, and the Antigravity entry; node_modules is not copied', () => {
    const home = tmp('ig-home-');
    const src = fakeSource();
    const r = run(['--home', home, '--source', src, '--apply']);
    assert.equal(r.code, 0, r.out);
    const copy = join(home, '.agents', 'skills', 'test-gate');
    assert.deepEqual(listFiles(copy), ['SKILL.md', 'assets/kit/scripts/x.mjs', 'references/a.md']);
    const rec = JSON.parse(readFileSync(join(copy, '.installed-from'), 'utf8'));
    assert.equal(rec.skill, 'test-gate');
    assert.equal(rec.source, src);
    assert.match(rec.contentHash, /^[0-9a-f]{64}$/);
    assert.ok(rec.installedAt);
    assert.ok(isLinkTo(join(home, '.claude', 'skills', 'test-gate'), copy));
    assert.ok(isLinkTo(join(home, '.config', 'opencode', 'skills', 'test-gate'), copy));
    assert.equal(readFileSync(join(home, '.claude', 'skills', 'test-gate', 'SKILL.md'), 'utf8'), readFileSync(join(src, 'SKILL.md'), 'utf8'));
    const skills = JSON.parse(readFileSync(join(home, '.gemini', 'config', 'skills.json'), 'utf8'));
    assert.deepEqual(skills, { entries: [{ path: '~/.agents/skills', include_only: ['test-gate'] }] });
  });
  it('a second apply is idempotent: links stay ok, the copy is refreshed in place, nothing is refused', () => {
    const home = tmp('ig-home-');
    const src = fakeSource();
    run(['--home', home, '--source', src, '--apply']);
    write(src, 'references/b.md', 'new\n');
    const again = run(['--home', home, '--source', src, '--apply']);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /\[ok\s*\] claude/);
    assert.match(again.out, /\[update\s*\] copy/);
    assert.ok(existsSync(join(home, '.claude', 'skills', 'test-gate', 'references', 'b.md')), 'the link sees the new file');
    assert.equal(JSON.parse(readFileSync(join(home, '.gemini', 'config', 'skills.json'), 'utf8')).entries.length, 1);
  });
  it('an update never deletes files that are no longer in the source', () => {
    const home = tmp('ig-home-');
    const src = fakeSource();
    run(['--home', home, '--source', src, '--apply']);
    rmSync(join(src, 'references', 'a.md'));
    run(['--home', home, '--source', src, '--apply']);
    assert.ok(existsSync(join(home, '.agents', 'skills', 'test-gate', 'references', 'a.md')));
  });
  it('a real folder in the way of a link is refused and left untouched; the other parts still apply', () => {
    const home = tmp('ig-home-');
    write(home, '.claude/skills/test-gate/SKILL.md', 'someone else');
    const r = run(['--home', home, '--source', fakeSource(), '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.out, /\[refuse\s*\] claude/);
    assert.equal(readFileSync(join(home, '.claude', 'skills', 'test-gate', 'SKILL.md'), 'utf8'), 'someone else');
    assert.equal(lstatSync(join(home, '.claude', 'skills', 'test-gate')).isSymbolicLink(), false);
    assert.ok(isLinkTo(join(home, '.config', 'opencode', 'skills', 'test-gate'), join(home, '.agents', 'skills', 'test-gate')));
    assert.ok(existsSync(join(home, '.gemini', 'config', 'skills.json')));
  });
  it('--force-replace-link-only does not help for a real folder, but replaces a link that points elsewhere (its target stays)', () => {
    const home = tmp('ig-home-');
    const src = fakeSource();
    const other = tmp('ig-other-');
    write(other, 'SKILL.md', 'other skill');
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
    symlinkSync(other, join(home, '.claude', 'skills', 'test-gate'), process.platform === 'win32' ? 'junction' : 'dir');
    const refused = run(['--home', home, '--source', src, '--apply']);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /points elsewhere/);
    assert.ok(isLinkTo(join(home, '.claude', 'skills', 'test-gate'), other));
    const forced = run(['--home', home, '--source', src, '--apply', '--force-replace-link-only']);
    assert.equal(forced.code, 0, forced.out);
    assert.ok(isLinkTo(join(home, '.claude', 'skills', 'test-gate'), join(home, '.agents', 'skills', 'test-gate')));
    assert.equal(readFileSync(join(other, 'SKILL.md'), 'utf8'), 'other skill', 'the old target is untouched');
  });
  it('an existing ~/.agents/skills/test-gate without .installed-from is not ours: refused, and no link is created to it', () => {
    const home = tmp('ig-home-');
    write(home, '.agents/skills/test-gate/SKILL.md', 'foreign copy');
    const r = run(['--home', home, '--source', fakeSource(), '--apply']);
    assert.equal(r.code, 1);
    assert.match(r.out, /not installed by this script/);
    assert.equal(readFileSync(join(home, '.agents', 'skills', 'test-gate', 'SKILL.md'), 'utf8'), 'foreign copy');
    assert.equal(existsSync(join(home, '.claude', 'skills', 'test-gate')), false);
  });
  it('--copy writes copies instead of links and records them', () => {
    const home = tmp('ig-home-');
    const r = run(['--home', home, '--source', fakeSource(), '--apply', '--copy']);
    assert.equal(r.code, 0, r.out);
    for (const p of [join(home, '.claude', 'skills', 'test-gate'), join(home, '.config', 'opencode', 'skills', 'test-gate')]) {
      assert.equal(lstatSync(p).isSymbolicLink(), false);
      assert.ok(existsSync(join(p, 'SKILL.md')));
      assert.ok(existsSync(join(p, '.installed-from')));
    }
    const rec = JSON.parse(readFileSync(join(home, '.agents', 'skills', 'test-gate', '.installed-from'), 'utf8'));
    assert.deepEqual(Object.values(rec.links), ['copy', 'copy']);
  });
  it('a source without SKILL.md is refused before anything is written', () => {
    const home = tmp('ig-home-');
    const r = run(['--home', home, '--source', tmp('ig-empty-'), '--apply']);
    assert.equal(r.code, 1);
    assert.deepEqual(everything(home), []);
  });
  it('plan() refuses to copy through a link at ~/.agents/skills/test-gate', () => {
    const home = tmp('ig-home-');
    const elsewhere = tmp('ig-else-');
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
    symlinkSync(elsewhere, join(home, '.agents', 'skills', 'test-gate'), process.platform === 'win32' ? 'junction' : 'dir');
    const p = plan({ ...parseArgs(['--home', home, '--source', fakeSource()]) });
    assert.equal(p.steps[0].action, 'refuse');
    assert.match(p.steps[0].detail, /is a link/);
  });
  it('the real skill folder installs into a fake home (all files, no tests excluded) and the script runs as a CLI', () => {
    const home = tmp('ig-home-');
    const r = spawnSync(process.execPath, [join(here, 'install-global.mjs'), '--home', home, '--apply'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const copy = join(home, '.agents', 'skills', 'test-gate');
    assert.ok(existsSync(join(copy, 'SKILL.md')));
    assert.ok(existsSync(join(copy, 'assets', 'kit', 'install.mjs')));
    assert.ok(existsSync(join(copy, '.installed-from')));
    assert.ok(isLinkTo(join(home, '.claude', 'skills', 'test-gate'), copy));
  });
});

describe('skills.json merge (Antigravity)', () => {
  it('creates, appends an entry, keeps other keys and entries', () => {
    assert.equal(mergeSkillsJson(null).change, 'create');
    const m = mergeSkillsJson({ inherits: [{ path: '/x.json' }], entries: [{ path: '~/mine' }] });
    assert.equal(m.change, 'add-entry');
    assert.deepEqual(m.next, { inherits: [{ path: '/x.json' }], entries: [{ path: '~/mine' }, { path: '~/.agents/skills', include_only: ['test-gate'] }] });
    assert.equal(mergeSkillsJson({}).change, 'add-entry');
  });
  it('an existing entry for the same path: add the name to include_only, or leave it alone', () => {
    const add = mergeSkillsJson({ entries: [{ path: '~/.agents/skills/', include_only: ['other'] }] });
    assert.equal(add.change, 'add-name');
    assert.deepEqual(add.next.entries[0].include_only, ['other', 'test-gate']);
    assert.equal(mergeSkillsJson({ entries: [{ path: '~/.agents/skills', include_only: ['test-gate'] }] }).change, 'ok');
    assert.equal(mergeSkillsJson({ entries: [{ path: '~/.agents/skills' }] }).change, 'ok');
  });
  it('refuses odd shapes and an exclude pattern that hides the skill', () => {
    assert.equal(mergeSkillsJson([]).change, 'refuse');
    assert.equal(mergeSkillsJson({ entries: 'x' }).change, 'refuse');
    assert.equal(mergeSkillsJson({ entries: [{ path: '~/.agents/skills', exclude: ['test-.*'] }] }).change, 'refuse');
  });
  it('an unparseable skills.json is refused, left as it is, and the rest still applies; an existing one is backed up', () => {
    const home = tmp('ig-home-');
    write(home, '.gemini/config/skills.json', '{ not json');
    const r = run(['--home', home, '--source', fakeSource(), '--apply']);
    assert.equal(r.code, 1);
    assert.equal(readFileSync(join(home, '.gemini', 'config', 'skills.json'), 'utf8'), '{ not json');
    const home2 = tmp('ig-home-');
    write(home2, '.gemini/config/skills.json', JSON.stringify({ entries: [{ path: '~/mine' }] }));
    run(['--home', home2, '--source', fakeSource(), '--apply']);
    const files = readdirSync(join(home2, '.gemini', 'config'));
    assert.ok(files.some((f) => f.startsWith('skills.json.bak-')));
    assert.equal(JSON.parse(readFileSync(join(home2, '.gemini', 'config', 'skills.json'), 'utf8')).entries.length, 2);
  });
});
