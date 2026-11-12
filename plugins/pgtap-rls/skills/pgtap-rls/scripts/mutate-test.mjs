#!/usr/bin/env node
// mutate-test.mjs: write a MUTATED COPY of a pgTAP test file to prove its deny tests can fail.
// The copy gets a temporary permissive policy (and/or a grant) right after `select plan(`, inside the file's own
// transaction, so `rollback;` removes it. The original file is never modified. Plain ESM, Node 20+, no dependencies.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POLICY_NAME = 'zz_mutation_tmp';
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const CMDS = new Set(['select', 'insert', 'update', 'delete', 'all']);
const PRIVS = new Set(['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'all', 'execute']);
const FUNC_SIG = /^[A-Za-z_][A-Za-z0-9_$.]*\([A-Za-z0-9_ ,.\[\]]*\)$/;

const HELP = `mutate-test: prove a pgTAP deny test can fail (mutation check)

Usage:
  node mutate-test.mjs <test-file.sql> --table <name> --role <role> [options]

Options:
  --schema <s>       Schema of the table (default public)
  --cmd <c>          select|insert|update|delete|all (default select). Policy mutation M1 (permissive, using/with check true)
  --no-policy        Skip the policy mutation (use with --grant)
  --grant <priv>     Grant mutation M2: grant <priv> on the table (or on --function when priv is execute) to --role
  --function <sig>   Function signature for --grant execute, e.g. public.get_balance(uuid)
  --out-dir <dir>    Where the scratch copy goes (default: OS temp folder, pgtap-rls-mutation/)
  --in-folder        Write the copy next to the original as _mutation_<name> (fallback if the CLI refuses paths
                     outside supabase/). You must delete it afterwards; never commit it.
  --json             Print a JSON result instead of text
  --help             This text

Behaviour: refuses a file without "begin;" or without "rollback;". Never edits the original, never touches
migrations, never connects to a database, never runs anything. It prints the path of the copy and the command to run
(by hand, against the LOCAL stack only). Expected result: the deny tests it names turn red. A deny test that stays
green is vacuous.`;

function die(msg, code = 2) { console.error(`error: ${msg}`); return code; }

function detectEol(text) { return text.includes('\r\n') ? '\r\n' : '\n'; }

/** Builds the SQL lines of the mutation. Pure. */
export function buildMutationSql({ schema = 'public', table, role, cmd = 'select', policy = true, grant = null, fn = null }) {
  for (const [label, v] of [['schema', schema], ['role', role]]) {
    if (!IDENT.test(String(v ?? ''))) throw new Error(`invalid ${label} "${v}" (plain identifier expected)`);
  }
  if (!fn && !IDENT.test(String(table ?? ''))) throw new Error(`invalid table "${table}" (plain identifier expected)`);
  if (!CMDS.has(cmd)) throw new Error(`invalid --cmd "${cmd}"`);
  const lines = [];
  if (policy) {
    if (!table) throw new Error('--table is required for the policy mutation');
    // SELECT and DELETE policies accept only USING; INSERT only WITH CHECK; UPDATE and ALL accept both.
    const clause = cmd === 'select' || cmd === 'delete' ? 'using (true)' : cmd === 'insert' ? 'with check (true)' : 'using (true) with check (true)';
    lines.push(`create policy ${POLICY_NAME} on ${schema}.${table} as permissive for ${cmd} to ${role} ${clause};`);
  }
  if (grant) {
    const g = String(grant).toLowerCase();
    if (!PRIVS.has(g)) throw new Error(`invalid --grant "${grant}"`);
    if (g === 'execute') {
      if (!fn || !FUNC_SIG.test(fn)) throw new Error('--grant execute needs --function <schema.name(argtypes)>');
      lines.push(`grant execute on function ${fn} to ${role};`);
    } else {
      if (!table) throw new Error('--grant needs --table');
      lines.push(`grant ${g} on ${schema}.${table} to ${role};`);
    }
  }
  if (!lines.length) throw new Error('nothing to mutate: pass a policy mutation or --grant');
  return lines;
}

/**
 * Inserts the mutation after the statement that holds the first `select plan(`. Pure; returns the new text.
 * Throws if the file has no begin;/rollback;/plan.
 */
export function mutateSource(source, mutationLines, { origName = 'test.sql', banner = true } = {}) {
  const eol = detectEol(source);
  const lines = source.split(/\r\n|\n/);
  const stripComment = (l) => l.replace(/--.*$/, '');
  const hasStmt = (re) => lines.some((l) => re.test(stripComment(l)));
  if (!hasStmt(/^\s*begin\s*;/i)) throw new Error('refused: the file has no "begin;" (a mutation must live inside a transaction)');
  if (!hasStmt(/^\s*rollback\s*;/i)) throw new Error('refused: the file has no "rollback;" (a mutation must never be committed)');
  if (hasStmt(/^\s*commit\s*;/i)) throw new Error('refused: the file contains "commit;"');
  let at = lines.findIndex((l) => /^\s*select\s+plan\s*\(/i.test(stripComment(l)));
  if (at < 0) throw new Error('refused: no "select plan(" line found (the mutation is inserted right after it)');
  while (at < lines.length - 1 && !stripComment(lines[at]).includes(';')) at++; // multi-line plan statement
  const injected = [
    '-- >>> mutate-test.mjs: temporary mutation, removed by rollback; <<<',
    ...mutationLines,
    '-- <<< end of mutation >>>',
  ];
  const out = [...lines.slice(0, at + 1), ...injected, ...lines.slice(at + 1)];
  if (banner) {
    out.unshift(`-- MUTATED COPY of ${origName} generated by mutate-test.mjs. Never commit it. Delete it after the run.`);
  }
  return out.join(eol);
}

export async function main(argv) {
  const flags = {};
  const pos = [];
  const withValue = new Set(['table', 'role', 'schema', 'cmd', 'grant', 'function', 'out-dir']);
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (!a.startsWith('--')) { pos.push(a); continue; }
      const eq = a.indexOf('=');
      const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (withValue.has(k)) {
        flags[k] = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (flags[k] === undefined) return die(`--${k} needs a value`);
      } else flags[k] = true;
    }
  } catch (e) { return die(e.message); }
  if (flags.help || flags.h) { console.log(HELP); return 0; }
  if (pos.length !== 1) { console.error(HELP); return 2; }

  const src = resolve(pos[0]);
  if (!existsSync(src)) return die(`file not found: ${src}`);
  let text;
  try { text = readFileSync(src, 'utf8'); } catch (e) { return die(e.message); }
  if (!flags.role) return die('--role is required (the role whose denial you are testing, e.g. authenticated)');

  let mutated; let mutation;
  try {
    mutation = buildMutationSql({
      schema: flags.schema || 'public', table: flags.table, role: flags.role, cmd: flags.cmd || 'select',
      policy: !flags['no-policy'], grant: flags.grant || null, fn: flags.function || null,
    });
    mutated = mutateSource(text, mutation, { origName: basename(src) });
  } catch (e) { return die(e.message); }

  const name = basename(src).replace(/\.sql$/i, '').replace(/\.test$/i, '');
  const stamp = `${Date.now()}-${process.pid}`;
  const outDir = flags['in-folder'] ? dirname(src) : resolve(flags['out-dir'] || join(tmpdir(), 'pgtap-rls-mutation'));
  const outName = flags['in-folder'] ? `_mutation_${basename(src)}` : `${name}_mutation_${stamp}.test.sql`;
  const out = join(outDir, outName);
  if (resolve(out) === src) return die('the output path equals the original; refusing');
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(out, mutated);
  } catch (e) { return die(`cannot write ${out}: ${e.message}`); }

  const runCmd = `supabase test db ${out}`;
  const result = { original: src, copy: out, mutation, run: runCmd, inFolder: Boolean(flags['in-folder']) };
  if (flags.json) { console.log(JSON.stringify(result, null, 2)); return 0; }
  console.log(`mutated copy written: ${out}\noriginal untouched:   ${src}\nmutation:\n${mutation.map((l) => `  ${l}`).join('\n')}`);
  console.log(`\nRun it by hand against the LOCAL stack only (this script runs nothing):\n  ${runCmd}`);
  console.log('Expected: exit code non-zero and the deny tests of this table/command/role named as failed.');
  console.log('If a deny test stays green it is vacuous: fix the test, then re-run the mutation.');
  console.log(`Afterwards delete the copy: ${out}`);
  if (!flags['in-folder']) console.log('If the CLI refuses a path outside supabase/, re-run with --in-folder (and delete the _mutation_ file afterwards).');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
