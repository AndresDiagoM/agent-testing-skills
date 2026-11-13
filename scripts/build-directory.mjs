#!/usr/bin/env node
// Builds the Anthropic directory edition of each plugin: directory/<name>/.
//
// Why: the plugin directory accepts from non-Verified organizations only Markdown, text, JSON, YAML and
// PNG/JPEG/GIF/WebP/ICO files, none starting with "#!". The full plugins in plugins/<name>/ ship runnable
// scripts (.mjs), code templates (.ts, .tsx, .sql) and eval fixtures, so the directory refuses them.
//
// The directory edition keeps SKILL.md, the references and the JSON/Markdown assets. Code templates (files the
// agent copies into the user's repo and adapts) become Markdown references with the code in a fenced block.
// Runnable tools (scripts/, the kit installer, hooks) are left out: the SKILL.md note points to the full
// edition on GitHub and tells the agent never to fetch and run them without the user's OK.
//
// Usage:
//   node scripts/build-directory.mjs            # rebuild directory/<name>/ for every plugin
//   node scripts/build-directory.mjs --check    # fail if directory/ is stale or holds a refused file
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/AndresDiagoM/agent-testing-skills';
const PLUGINS = ['test-gate', 'pgtap-rls'];

const ALLOWED_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);
// Code templates: converted to <file>.md. Key = extension, value = fence language.
const TEMPLATE_LANG = { '.ts': 'ts', '.tsx': 'tsx', '.sql': 'sql', '.tmpl': 'ts' };
// Paths (relative to the skill folder) that hold runnable tools, never shipped in the directory edition.
const EXCLUDED_DIRS = ['scripts', 'assets/kit/scripts', 'assets/kit/hooks'];
const EXCLUDED_FILES = ['assets/kit/install.mjs', 'assets/kit/e2e-changed.map.json'];
// Plugin-level files copied as they are (anything else at plugin level is left out: evals, CHECKLIST, scripts).
const PLUGIN_FILES = ['.claude-plugin/plugin.json', '.claude-plugin/icon.png', 'CHANGELOG.md'];

const posix = (p) => p.split(path.sep).join('/');

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(posix(path.relative(base, full)));
  }
  return out.sort();
}

function isExcluded(rel) {
  return EXCLUDED_FILES.includes(rel) || EXCLUDED_DIRS.some((d) => rel === d || rel.startsWith(d + '/'));
}

function fenceFor(code) {
  let fence = '```';
  while (code.includes(fence)) fence += '`';
  return fence;
}

function templateToMarkdown(rel, code) {
  const name = path.posix.basename(rel);
  const saveAs = name.endsWith('.tmpl') ? name.slice(0, -'.tmpl'.length) : name;
  const lang = TEMPLATE_LANG[path.posix.extname(rel)];
  const fence = fenceFor(code);
  return [
    `# Template: \`${saveAs}\``,
    '',
    `Code template shipped as Markdown in the directory edition (full edition: \`${rel}\`).`,
    `Copy the code below into the user's repository as \`${saveAs}\` and adapt it as the references say.`,
    'The plugin never runs it.',
    '',
    fence + lang,
    code.replace(/\s+$/, ''),
    fence,
    '',
  ].join('\n');
}

function directoryNote(name, dropped, converted) {
  const lines = [
    '> **Directory edition.** This copy of the skill comes from the Anthropic plugin directory, which accepts only',
    '> Markdown, text, JSON, YAML and images from this publisher. So:',
  ];
  if (converted.length) {
    lines.push(`> - Code templates are shipped as Markdown: \`<file>.md\` holds the code of \`<file>\` (for example \`${converted[0]}.md\`).`);
  }
  if (dropped.length) {
    lines.push(
      `> - The optional scripts, and the files only they read, are not included: ${dropped.map((d) => `\`${d}\``).join(', ')}.`,
      `>   They are in the full edition at ${REPO_URL}/tree/main/plugins/${name}`,
      `>   (Claude Code: \`/plugin marketplace add AndresDiagoM/agent-testing-skills\`, then \`/plugin install ${name}@agent-testing-skills\`).`,
      '>   When a reference names one of them, do the step by hand or tell the user it needs the full edition.',
      '>   Never download and run them without the user\'s explicit OK.',
    );
  }
  return lines.join('\n') + '\n';
}

function relinkReadme(text, name, outDir) {
  // Relative links that do not resolve inside directory/<name>/ point to the full edition on GitHub.
  return text.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (m, target) => {
    const [file, anchor = ''] = target.split('#');
    if (!file.startsWith('..') && existsSync(path.join(outDir, file))) return m;
    const abs = posix(path.posix.normalize(`plugins/${name}/${file}`)).replace(/\/$/, '');
    const kind = existsSync(path.join(ROOT, abs)) && statSync(path.join(ROOT, abs)).isDirectory() ? 'tree' : 'blob';
    return `](${REPO_URL}/${kind}/main/${abs}${anchor ? '#' + anchor : ''})`;
  });
}

function buildPlugin(name, outRoot) {
  const src = path.join(ROOT, 'plugins', name);
  const out = path.join(outRoot, name);
  const skillSrc = path.join(src, 'skills', name);
  const write = (rel, data) => {
    const file = path.join(out, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
  };

  for (const rel of PLUGIN_FILES) {
    if (existsSync(path.join(src, rel))) write(rel, readFileSync(path.join(src, rel)));
  }

  const files = walk(skillSrc);
  const converted = [];
  const dropped = new Set();
  const kept = [];
  for (const rel of files) {
    const ext = path.posix.extname(rel);
    if (isExcluded(rel)) {
      const top = EXCLUDED_DIRS.find((d) => rel.startsWith(d + '/'));
      dropped.add(top ? top + '/' : rel);
      continue;
    }
    if (TEMPLATE_LANG[ext]) {
      converted.push(rel);
      continue;
    }
    if (ALLOWED_EXT.has(ext)) kept.push(rel);
    else dropped.add(rel);
  }

  const renames = converted.map((rel) => [rel, rel + '.md']).sort((a, b) => b[0].length - a[0].length);
  const rewrite = (text) => {
    for (const [from, to] of renames) {
      text = text.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\.md)', 'g'), to);
    }
    return text;
  };

  for (const rel of kept) {
    const buf = readFileSync(path.join(skillSrc, rel));
    if (IMAGE_EXT.has(path.posix.extname(rel))) {
      write(`skills/${name}/${rel}`, buf);
      continue;
    }
    let text = buf.toString('utf8');
    if (rel.endsWith('.md')) text = rewrite(text);
    if (rel === 'SKILL.md') {
      const end = text.indexOf('\n---', 4);
      const cut = text.indexOf('\n', end + 1) + 1;
      text = text.slice(0, cut) + '\n' + directoryNote(name, [...dropped], converted) + text.slice(cut);
    }
    write(`skills/${name}/${rel}`, text);
  }
  for (const rel of converted) {
    write(`skills/${name}/${rel}.md`, templateToMarkdown(rel, readFileSync(path.join(skillSrc, rel), 'utf8')));
  }

  const readme = readFileSync(path.join(src, 'README.md'), 'utf8');
  const banner = [
    `> **Directory edition** of \`${name}\`, built by \`scripts/build-directory.mjs\` from [\`plugins/${name}\`](${REPO_URL}/tree/main/plugins/${name}).`,
    '> Same skill and references; code templates ship as Markdown, and the optional runnable scripts are only in the full edition.',
    '',
  ].join('\n');
  const firstBreak = readme.indexOf('\n\n');
  write('README.md', relinkReadme(readme.slice(0, firstBreak + 2) + banner + '\n' + readme.slice(firstBreak + 2), name, out));
  return out;
}

// Mirrors the directory's file rules for non-Verified publishers.
function policyProblems(dir) {
  const problems = [];
  for (const rel of walk(dir)) {
    const ext = path.posix.extname(rel).toLowerCase();
    const buf = readFileSync(path.join(dir, rel));
    if (!ALLOWED_EXT.has(ext)) problems.push(`${rel}: type ${ext || '(none)'} not allowed`);
    if (/[:\\]/.test(rel)) problems.push(`${rel}: path has : or \\`);
    if (IMAGE_EXT.has(ext)) continue;
    if (buf.subarray(0, 2).toString() === '#!') problems.push(`${rel}: starts with #!`);
    if (buf.includes(0)) problems.push(`${rel}: NUL byte`);
    if (!Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) problems.push(`${rel}: not valid UTF-8`);
    if (rel.startsWith('.claude-plugin/') && rel !== '.claude-plugin/plugin.json') problems.push(`${rel}: unexpected .claude-plugin file`);
  }
  return problems;
}

function sameTree(a, b) {
  const fa = walk(a);
  const fb = walk(b);
  if (fa.join('\n') !== fb.join('\n')) return false;
  return fa.every((rel) => readFileSync(path.join(a, rel)).equals(readFileSync(path.join(b, rel))));
}

const check = process.argv.includes('--check');
const target = path.join(ROOT, 'directory');
let failed = false;

if (check) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'dir-edition-'));
  for (const name of PLUGINS) {
    const built = buildPlugin(name, tmp);
    const committed = path.join(target, name);
    if (!existsSync(committed) || !sameTree(built, committed)) {
      console.error(`directory/${name} is stale: run node scripts/build-directory.mjs`);
      failed = true;
    }
  }
  rmSync(tmp, { recursive: true, force: true });
} else {
  for (const name of PLUGINS) {
    rmSync(path.join(target, name), { recursive: true, force: true });
    buildPlugin(name, target);
    console.log(`built directory/${name}`);
  }
}

for (const name of PLUGINS) {
  const dir = path.join(target, name);
  if (!existsSync(dir)) continue;
  const problems = policyProblems(dir);
  for (const p of problems) console.error(`directory/${name}/${p}`);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
