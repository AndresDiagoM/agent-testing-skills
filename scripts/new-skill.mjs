#!/usr/bin/env node
// Crea plugins/<name>/ a partir de _template/ y lo registra en .claude-plugin/marketplace.json.
// Uso: node scripts/new-skill.mjs <name> "<description: qué hace y cuándo usarla>"
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [name, description] = process.argv.slice(2);

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (!name || !description) fail('uso: node scripts/new-skill.mjs <name> "<description>"');
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64)
  fail('name: hasta 64 caracteres, solo a-z, 0-9 y guiones simples, sin guion al inicio ni al final');
if (/claude|anthropic/.test(name)) fail('name no puede contener "claude" ni "anthropic"');
if (description.length > 1024) fail(`description tiene ${description.length} caracteres (máximo 1024)`);
if (/<[^>]+>/.test(description)) fail('description no puede contener etiquetas XML');

const dest = join(root, 'plugins', name);
if (existsSync(dest)) fail(`ya existe ${dest}`);

const title = name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
cpSync(join(root, '_template'), dest, { recursive: true });

function fill(dir) {
  for (const entry of readdirSync(dir)) {
    let p = join(dir, entry);
    if (entry.includes('__NAME__')) {
      const np = join(dir, entry.replaceAll('__NAME__', name));
      renameSync(p, np);
      p = np;
    }
    if (statSync(p).isDirectory()) {
      fill(p);
      continue;
    }
    let text = readFileSync(p, 'utf8');
    if (p.endsWith('.json')) {
      text = text.replaceAll('__DESCRIPTION__', JSON.stringify(description).slice(1, -1));
    } else if (p.endsWith('SKILL.md')) {
      // A JSON string is a valid YAML double-quoted scalar: safe for colons, quotes, etc.
      text = text.replace('description: __DESCRIPTION__', `description: ${JSON.stringify(description)}`);
    }
    text = text.replaceAll('__DESCRIPTION__', description).replaceAll('__NAME__', name).replaceAll('__TITLE__', title);
    writeFileSync(p, text);
  }
}
fill(dest);

const mpPath = join(root, '.claude-plugin', 'marketplace.json');
const mp = JSON.parse(readFileSync(mpPath, 'utf8'));
mp.plugins.push({ name, source: `./plugins/${name}`, description });
mp.plugins.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(mpPath, JSON.stringify(mp, null, 2) + '\n');

console.log(`Creada plugins/${name}/ y registrada en marketplace.json.`);
console.log(`Siguiente: editar plugins/${name}/skills/${name}/SKILL.md, luego node scripts/check-skill.mjs ${name}`);
