#!/usr/bin/env node
// Puerta 1 (y 5 con --portable): chequea una skill contra las reglas del estándar y de claude.ai/API,
// y después corre `claude plugin validate --strict` sobre su plugin.
// Uso: node scripts/check-skill.mjs <name> [--portable] [--no-validate]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const name = args.find((a) => !a.startsWith('--'));
const portable = args.includes('--portable');
const runValidate = !args.includes('--no-validate');

if (!name) {
  console.error('uso: node scripts/check-skill.mjs <name> [--portable] [--no-validate]');
  process.exit(1);
}

const errors = [];
const warnings = [];
const pluginDir = join(root, 'plugins', name);
const skillFile = join(pluginDir, 'skills', name, 'SKILL.md');

if (!existsSync(skillFile)) {
  console.error(`error: no existe ${skillFile}`);
  process.exit(1);
}

// --- frontmatter (top-level keys only; indented lines belong to the previous key) ---
const raw = readFileSync(skillFile, 'utf8').replace(/\r\n/g, '\n');
const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
if (!m) {
  errors.push('SKILL.md no empieza con un bloque frontmatter --- ... ---');
}
const fm = {};
if (m) {
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch { warnings.push(`no pude leer el valor entre comillas de "${kv[1]}"`); }
    } else if (v.startsWith("'") && v.endsWith("'")) {
      v = v.slice(1, -1).replaceAll("''", "'");
    }
    fm[kv[1]] = v;
  }
}
const body = m ? m[2] : raw;

// --- name ---
const n = fm.name;
if (!n) errors.push('falta name');
else {
  if (n.length > 64) errors.push(`name tiene ${n.length} caracteres (máximo 64)`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n)) errors.push('name: solo a-z, 0-9 y guiones simples, sin guion al inicio ni al final');
  if (n !== name) errors.push(`name "${n}" no coincide con la carpeta "${name}"`);
  if (/claude|anthropic/.test(n)) errors.push('name no puede contener "claude" ni "anthropic" (claude.ai/API lo rechazan)');
}

// --- description ---
const d = fm.description;
if (!d) errors.push('falta description');
else {
  if (d.length > 1024) errors.push(`description tiene ${d.length} caracteres (máximo 1024)`);
  if (/<[^>]+>/.test(d)) errors.push('description no puede contener etiquetas XML');
  if (d.length < 80) warnings.push('description muy corta: di qué hace y cuándo usarla');
  if (/TODO/.test(d)) errors.push('description todavía tiene TODO');
}

// --- portable fields ---
const PORTABLE = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const extra = Object.keys(fm).filter((k) => !PORTABLE.has(k));
if (extra.length) {
  const msg = `campos solo de Claude Code (fallan al subir a claude.ai/API): ${extra.join(', ')}`;
  (portable ? errors : warnings).push(msg);
}
if (fm.compatibility && fm.compatibility.length > 500) errors.push('compatibility supera 500 caracteres');

// --- body ---
const lines = body.split('\n').length;
if (lines > 500) warnings.push(`el cuerpo tiene ${lines} líneas (recomendado < 500; mover detalle a references/)`);
if (/\bTODO\b/.test(body)) warnings.push('el cuerpo todavía tiene TODO');

// --- plugin.json + marketplace ---
const pjPath = join(pluginDir, '.claude-plugin', 'plugin.json');
if (!existsSync(pjPath)) errors.push('falta .claude-plugin/plugin.json');
else {
  const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
  if (pj.name !== name) errors.push(`plugin.json name "${pj.name}" no coincide con "${name}"`);
  if (!pj.version) warnings.push('plugin.json sin version: los usuarios actualizarán por commit SHA');
}
const mp = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
const entry = mp.plugins.find((p) => p.name === name);
if (!entry) errors.push('no está registrada en .claude-plugin/marketplace.json');
else if (entry.source !== `./plugins/${name}`) errors.push(`marketplace source "${entry.source}" debería ser "./plugins/${name}"`);

// --- evals ---
if (!existsSync(join(pluginDir, 'evals'))) warnings.push('sin carpeta evals/ (puerta 2)');

for (const w of warnings) console.log(`aviso: ${w}`);
for (const e of errors) console.log(`ERROR: ${e}`);

let validateFailed = false;
if (runValidate) {
  console.log(`\n> claude plugin validate plugins/${name} --strict`);
  const r = spawnSync('claude', ['plugin', 'validate', pluginDir, '--strict'], { stdio: 'inherit', shell: process.platform === 'win32' });
  validateFailed = r.status !== 0;
}

const ok = errors.length === 0 && !validateFailed;
console.log(`\n${ok ? 'OK' : 'FALLA'}: ${errors.length} errores, ${warnings.length} avisos${runValidate ? `, validate ${validateFailed ? 'falló' : 'ok'}` : ''}`);
process.exit(ok ? 0 : 1);
