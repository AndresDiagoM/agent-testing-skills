#!/usr/bin/env node
// tap-to-evidence.mjs: parse pg_prove / TAP output from `supabase test db` and record ONE step
// (default name "db:test") in the shared evidence file (.gate/last.json, schema v2 of the test-gate skill).
// Plain ESM, Node 20+, zero dependencies, no network. Run with --help.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.3.1';
export const REPORTED_BY = `pgtap-rls ${VERSION}`; // format documented by test-gate: "<skill> <version>"
const MAX_MSG = 300;
const MAX_FAILURES = 100;

// ------------------------------------------------------------------------------------------------ parsing

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
export const stripAnsi = (text) => String(text).replace(ANSI, '');

const clip = (s, n = MAX_MSG) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};

/** Expands "3, 5-7" into [3,5,6,7]. */
function expandNumbers(text) {
  const out = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b && i - a < 10000; i++) out.push(i);
  }
  return out;
}

/**
 * Pure parser of pg_prove output (default or verbose). Never throws.
 * Returns what the output SAYS; status decisions live in decideStatus().
 */
export function parseTap(output) {
  const lines = stripAnsi(output).split(/\r\n|\r|\n/);
  const res = {
    files: 0,
    tests: 0,
    result: 'UNKNOWN',
    hasSummary: false,
    failedCount: 0,
    skippedCount: null, // null unless the output exposes ok/not ok lines (verbose mode)
    verbose: false,
    planMismatches: [], // { file, planned, ran }
    dubious: [], // { file, reason }
    parseErrors: [],
    sqlErrors: [],
    failures: [], // { test, file, message, number, have, want }
  };

  const byKey = new Map();
  let currentFile = null;
  let last = null; // last failure object, receives have/want lines
  let summaryFile = null;
  let inParseErrors = false;
  let skipped = 0;

  const failureFor = (file, number) => {
    const key = `${file ?? ''}#${number}`;
    let f = byKey.get(key);
    if (!f) {
      f = { test: null, file: file ?? null, message: null, number, have: null, want: null };
      byKey.set(key, f);
      res.failures.push(f);
    }
    return f;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) { inParseErrors = false; continue; }
    if (/^\S/.test(raw)) inParseErrors = false; // continuation lines of "Parse errors:" are indented

    // progress line: "<path> .. ok" | "<path> .. 3/22" | "<path> .. Dubious, test returned 3 ..." | "<path> .. Failed 1/22 subtests"
    const prog = /^(\S.*?)\s+\.{2,}\s*(.*)$/.exec(line);
    if (prog && /\.\w+$/.test(prog[1].trim())) {
      currentFile = prog[1].trim();
      last = null;
      const rest = prog[2];
      const dub = /^Dubious, test returned (\d+)/.exec(rest);
      if (dub) res.dubious.push({ file: currentFile, reason: clip(rest) });
      const inlineErr = /ERROR:\s+(.*)$/.exec(rest);
      if (inlineErr) res.sqlErrors.push(clip(inlineErr[1]));
      continue;
    }

    // verbose TAP
    const tapLine = /^(not ok|ok) (\d+)(?:\s*-?\s*(.*))?$/.exec(line);
    if (tapLine) {
      res.verbose = true;
      const [, status, num, restRaw] = tapLine;
      const rest = restRaw ?? '';
      if (/#\s*skip/i.test(rest)) skipped++;
      if (status === 'not ok' && !/#\s*TODO/i.test(rest)) {
        const f = failureFor(currentFile, Number(num));
        f.test = f.test ?? (rest.replace(/\s*#.*$/, '').trim() || null);
        last = f;
      } else last = null;
      continue;
    }

    // real CLI 3.1.0: the Dubious line stands alone after the "<path> .." line (it is not on the progress line)
    const dubLine = /^Dubious, test returned (\d+)/.exec(line);
    if (dubLine) { res.dubious.push({ file: currentFile, reason: clip(line) }); continue; }

    // diagnostics from pgTAP: "# Failed test 3: "description""
    const failed = /^#\s+Failed test (\d+)(?::\s*(.*))?$/.exec(line);
    if (failed) {
      const f = failureFor(currentFile, Number(failed[1]));
      const desc = (failed[2] ?? '').trim().replace(/^"(.*)"$/, '$1');
      if (desc) f.test = f.test ?? desc;
      last = f;
      continue;
    }
    const hw = /^#\s+(have|want|caught|wanted):\s?(.*)$/.exec(line);
    if (hw && last) {
      const key = hw[1] === 'have' || hw[1] === 'caught' ? 'have' : 'want';
      last[key] = clip(hw[2]);
      continue;
    }
    const planned = /^#\s+Looks like you planned (\d+) tests? but ran (\d+)/.exec(line);
    if (planned) {
      res.planMismatches.push({ file: currentFile, planned: Number(planned[1]), ran: Number(planned[2]) });
      continue;
    }
    if (/^#\s+Looks like your test (?:exited|died)/.test(line)) {
      res.dubious.push({ file: currentFile, reason: clip(line.replace(/^#\s*/, '')) });
      continue;
    }
    if (last && /^#\s/.test(line) && !/^#\s+Looks like/.test(line) && !last.message) {
      last.message = clip(line.replace(/^#\s*/, ''));
      continue;
    }

    // psql errors
    const sqlErr = /^(?:psql:\S+?:\d+:\s*)?ERROR:\s+(.*)$/.exec(line);
    if (sqlErr) { res.sqlErrors.push(clip(sqlErr[1])); continue; }

    // "Test Summary Report"
    // real CLI 3.1.0 prints "(Wstat: 768 (exited 3) Tests: 1 Failed: 0)" for a file that exited non-zero
    const sum = /^(\S.*?)\s+\(Wstat: (\d+)(?: \([^)]*\))? Tests: (\d+) Failed: (\d+)\)$/.exec(line);
    if (sum) {
      summaryFile = sum[1].trim();
      res.failedCount += Number(sum[4]);
      inParseErrors = false;
      continue;
    }
    const failedList = /^\s+Failed tests?:\s+(.*)$/.exec(line);
    if (failedList && summaryFile) {
      for (const n of expandNumbers(failedList[1])) failureFor(summaryFile, n);
      continue;
    }
    const nz = /^\s+Non-zero exit status: (\d+)/.exec(line);
    if (nz && summaryFile) { res.dubious.push({ file: summaryFile, reason: `Non-zero exit status: ${nz[1]}` }); continue; }
    const pe = /^\s+Parse errors:\s*(.*)$/.exec(line);
    if (pe && summaryFile) {
      inParseErrors = true;
      res.parseErrors.push({ file: summaryFile, message: clip(pe[1]) });
      const mm = /planned (\d+) tests? but ran (\d+)/.exec(pe[1]);
      if (mm) res.planMismatches.push({ file: summaryFile, planned: Number(mm[1]), ran: Number(mm[2]) });
      continue;
    }
    if (inParseErrors && /^\s{4,}\S/.test(raw)) {
      const cur = res.parseErrors.at(-1);
      if (cur) cur.message = clip(`${cur.message} ${line}`);
      continue;
    }

    const files = /Files=(\d+),\s*Tests=(\d+)/.exec(line);
    if (files) { res.files = Number(files[1]); res.tests = Number(files[2]); res.hasSummary = true; continue; }
    const result = /^Result:\s*(PASS|FAIL)/.exec(line);
    if (result) { res.result = result[1]; continue; }
    if (/^Bad plan|^No plan found/.test(line.trim())) { res.parseErrors.push({ file: summaryFile, message: clip(line) }); }
  }

  if (res.verbose) res.skippedCount = skipped;

  // Give every failure a readable name and message.
  for (const f of res.failures) {
    f.test = f.test ?? `test #${f.number}`;
    if (f.have != null || f.want != null) f.message = clip(`have: ${f.have ?? ''}; want: ${f.want ?? ''}`);
    else if (!f.message) f.message = 'reported as failed; no diagnostics captured';
  }
  // Files that died or have a bad plan without a failing assertion still need an entry.
  for (const d of res.dubious) {
    if (!res.failures.some((f) => f.file === d.file && f.number === null)) {
      res.failures.push({ test: d.file ?? 'test file', file: d.file, message: clip(`test file did not finish cleanly: ${d.reason}`), number: null, have: null, want: null });
    }
  }
  const seenPlans = new Set();
  res.planMismatches = res.planMismatches.filter((p) => {
    const k = `${p.file ?? ''}|${p.planned}|${p.ran}`;
    if (seenPlans.has(k)) return false;
    seenPlans.add(k);
    return true;
  });
  for (const p of res.planMismatches) {
    res.failures.push({ test: 'plan', file: p.file, message: `planned ${p.planned} tests but ran ${p.ran}`, number: null, have: String(p.ran), want: String(p.planned) });
  }
  const numbered = res.failures.filter((f) => f.number !== null).length;
  res.failedCount = Math.max(res.failedCount, numbered);
  return res;
}

// ------------------------------------------------------------------------------------------------ step building

/** Decides status from facts. Never "passed" on unparsable output, zero tests, zero files or a bad plan. */
export function decideStatus({ parsed, exitCode, timedOut }) {
  const reasons = [];
  if (timedOut) return { status: 'timeout', reasons: ['killed by the wrapper timeout'] };
  // test-gate honesty rule 1: exitCode comes from the process the writer started. No exit code = no "passed".
  if (exitCode === null || exitCode === undefined) reasons.push('exit code not provided (pass --exit-code when parsing a saved log)');
  else if (exitCode !== 0) reasons.push(`exit code ${exitCode}`);
  if (!parsed.hasSummary) reasons.push('no "Files=N, Tests=M" summary found (unparsable output)');
  if (parsed.hasSummary && parsed.files === 0) reasons.push('0 test files ran');
  if (parsed.hasSummary && parsed.tests === 0) reasons.push('0 tests ran');
  if (parsed.result === 'FAIL') reasons.push('Result: FAIL');
  if (parsed.result === 'UNKNOWN') reasons.push('no "Result:" line');
  if (parsed.failedCount > 0) reasons.push(`${parsed.failedCount} failed test(s)`);
  if (parsed.planMismatches.length) reasons.push('plan mismatch');
  if (parsed.dubious.length) reasons.push('a test file died or exited non-zero');
  if (parsed.parseErrors.length) reasons.push('TAP parse errors');
  return { status: reasons.length ? 'failed' : 'passed', reasons };
}

/** Builds the evidence step object (test-gate schema v2) from parsed output and run facts. */
export function buildStep({ parsed, name = 'db:test', command = '', exitCode = null, wallMs = null, timeoutMs = 600000,
  timedOut = false, scope = { kind: 'all' }, logFile = null, startedAt = null, finishedAt = new Date().toISOString(),
  approvedSkips = null, mutation = false, supabaseCli = null }) {
  const decided = decideStatus({ parsed, exitCode, timedOut });
  let status = decided.status;
  let mutationInfo = null;
  let recordedExit = exitCode ?? null;
  if (mutation) {
    // A mutation run is GOOD when the mutated copy turns red for the right reason: tests ran, some failed.
    const killed = !timedOut && parsed.hasSummary && parsed.tests > 0 && parsed.failedCount > 0 && parsed.result === 'FAIL'
      && !parsed.planMismatches.length && !parsed.dubious.length;
    status = timedOut ? 'timeout' : killed ? 'passed' : 'failed';
    mutationInfo = {
      killed,
      pgProveExitCode: exitCode ?? null,
      note: killed ? 'mutation detected: the mutated copy failed as expected' : 'mutation NOT detected (or the run was unusable): the deny tests are vacuous or the run is invalid',
      killedBy: killed ? parsed.failures.slice(0, MAX_FAILURES).map((f) => ({ test: f.test, file: f.file, number: f.number })) : [],
    };
    // test-gate rejects "passed" with a non-zero exitCode. For this step the verdict is the CHECK's, so a detected
    // mutation records exitCode 0; the raw pg_prove exit code stays in details.pgtap.mutation.pgProveExitCode.
    if (killed) recordedExit = 0;
  }
  const tests = parsed.tests;
  const failed = parsed.failedCount;
  const step = {
    name,
    // A mutation step is a check about the tests, not a test run: "custom" keeps test-gate's db honesty rules
    // (Result: FAIL on a passed step is a contradiction) from downgrading a correctly detected mutation.
    kind: mutation ? 'custom' : 'db',
    status,
    command,
    exitCode: recordedExit,
    ...(startedAt ? { startedAt } : {}),
    finishedAt,
    wallMs: wallMs ?? 0,
    timeoutMs,
    counts: {
      passed: Math.max(0, tests - failed),
      failed,
      // Non-verbose pg_prove prints no ok/not ok lines, so skips are invisible: 0 here means "none seen", and
      // details.pgtap.skipsVisible says whether the output could have shown any.
      skipped: parsed.skippedCount ?? 0,
      // legacy pgTAP keys, accepted by the schema (counts allows additional properties); test-gate's summary reads them
      files: parsed.files,
      tests,
      result: parsed.result,
    },
    scope,
    reportedBy: REPORTED_BY,
  };
  if (!mutation && parsed.failures.length) {
    // schema: failure.file must be a string when present, so null fields are omitted
    step.failures = parsed.failures.slice(0, MAX_FAILURES).map((f) => ({
      test: f.test,
      ...(f.file ? { file: f.file } : {}),
      message: clip(f.message ?? '', MAX_MSG),
      ...(f.number !== null && f.number !== undefined ? { number: f.number } : {}),
      ...(f.have != null ? { have: f.have } : {}),
      ...(f.want != null ? { want: f.want } : {}),
    }));
  }
  if (approvedSkips && approvedSkips.length) step.approvedSkips = approvedSkips;
  if (logFile) step.logFile = logFile;
  step.details = {
    pgtap: {
      files: parsed.files,
      tests,
      result: parsed.result,
      skipsVisible: parsed.verbose,
      ...(supabaseCli ? { supabaseCli } : {}),
      statusReasons: status === 'passed' ? [] : decided.reasons,
      ...(parsed.sqlErrors.length ? { firstSqlError: parsed.sqlErrors[0] } : {}),
      ...(parsed.failures.length > MAX_FAILURES ? { failuresTruncated: parsed.failures.length - MAX_FAILURES } : {}),
      ...(parsed.skippedCount !== null && parsed.skippedCount > 0 && !(approvedSkips && approvedSkips.length >= parsed.skippedCount)
        ? { skipsUnapproved: true } : {}),
      ...(mutationInfo ? { mutation: mutationInfo } : {}),
    },
  };
  return step;
}

// ------------------------------------------------------------------------------------------------ merge (test-gate rules)
// Mirror of test-gate's gate-lib.mjs (addStep / evaluateEvidence / validateStep / applyHonesty), used when the repo has
// no kit (scripts/gate.mjs). With the kit present, tap-to-evidence calls `gate.mjs add-step` instead. A cross-check
// test (test/evidence.test.mjs) runs both on the same inputs and compares ok/complete.

const STEP_NAME_RE = /^[a-z0-9:_-]+$/;
const STATUSES = ['passed', 'failed', 'timeout', 'skipped', 'not-run'];
const KINDS = ['lint', 'typecheck', 'unit', 'db', 'build', 'e2e', 'parity', 'custom'];

/** Problems that make a step object invalid for the shared file (empty = valid). */
export function validateStep(step) {
  const p = [];
  if (!step || typeof step !== 'object' || Array.isArray(step)) return ['step must be a JSON object'];
  if (typeof step.name !== 'string' || !STEP_NAME_RE.test(step.name)) p.push('name must match [a-z0-9:_-]+');
  if (!STATUSES.includes(step.status)) p.push(`status must be one of ${STATUSES.join(', ')}`);
  if (typeof step.command !== 'string' || !step.command) p.push('command (exact command line) is required');
  if (!(step.exitCode === null || typeof step.exitCode === 'number')) p.push('exitCode must be a number or null');
  if (typeof step.wallMs !== 'number') p.push('wallMs must be a number');
  if (typeof step.timeoutMs !== 'number') p.push('timeoutMs must be a number');
  if (step.kind !== undefined && !KINDS.includes(step.kind)) p.push(`kind must be one of ${KINDS.join(', ')}`);
  if (step.counts != null) {
    if (typeof step.counts !== 'object') p.push('counts must be an object or null');
    else for (const k of ['passed', 'failed', 'skipped']) if (typeof step.counts[k] !== 'number') p.push(`counts.${k} must be a number`);
  }
  if (Array.isArray(step.failures)) step.failures.forEach((f, i) => { if (typeof f?.test !== 'string') p.push(`failures[${i}].test must be a string`); });
  if (step.scope !== undefined && !['all', 'files'].includes(step.scope?.kind)) p.push('scope.kind must be "all" or "files"');
  return p;
}

const isValidApproval = (a) => Boolean(a) && ['user', 'orchestrator'].includes(a.approvedBy)
  && typeof a.approvalRef === 'string' && a.approvalRef.trim() !== '' && typeof a.reason === 'string' && a.reason.trim() !== '';
const approvalExpired = (a, now) => {
  if (typeof a?.recheckBy !== 'string') return false;
  const when = Date.parse(a.recheckBy.includes('T') ? a.recheckBy : `${a.recheckBy}T23:59:59.999Z`);
  return Number.isFinite(when) && when < now;
};

/** `ok` = every recorded step passed or was skipped (v1 meaning; an empty list is ok; stale and not-run steps count). */
export const computeOk = (steps) => steps.every((s) => s.status === 'passed' || s.status === 'skipped');

/** `complete` per test-gate: ok AND every requiredSteps entry fresh, passed in scope "all" (no unapproved skips, no flaky), or skipped with approval. */
export function evaluateEvidence(ev, now = Date.now()) {
  const steps = Array.isArray(ev.steps) ? ev.steps : [];
  const ok = computeOk(steps);
  const reasons = [];
  if (!ok) reasons.push('ok is false (a recorded step did not pass)');
  const required = Array.isArray(ev.requiredSteps) ? ev.requiredSteps : [];
  if (required.length === 0) reasons.push('requiredSteps is absent or empty (a v1 file cannot prove completeness)');
  for (const name of required) {
    const s = steps.find((x) => x.name === name);
    if (!s) { reasons.push(`required step "${name}" has no entry`); continue; }
    if (s.stale) { reasons.push(`required step "${name}" is stale (not run in the latest invocation)`); continue; }
    if (s.status === 'skipped') {
      if (!(isValidApproval(s.approval) && !approvalExpired(s.approval, now))) reasons.push(`required step "${name}" was skipped without a valid approval`);
      continue;
    }
    if (s.status !== 'passed') { reasons.push(`required step "${name}" is ${s.status}`); continue; }
    if (s.scope && s.scope.kind !== 'all') reasons.push(`step "${name}" ran with scope "${s.scope.kind}" (partial)`);
    const c = s.counts;
    if (c) {
      const approved = (s.approvedSkips ?? []).filter((a) => isValidApproval(a) && !approvalExpired(a, now)).length;
      const held = (c.skipped ?? 0) + (c.todo ?? 0) + (c.didNotRun ?? 0);
      if (held > approved) reasons.push(`step "${name}" has ${held - approved} skipped/todo/did-not-run test(s) without a valid approvedSkips entry`);
      if ((c.flaky ?? 0) > 0) reasons.push(`step "${name}" has ${c.flaky} flaky test(s)`);
      if ((c.interrupted ?? 0) > 0) reasons.push(`step "${name}" has ${c.interrupted} interrupted test(s)`);
    }
  }
  if (ev.build && ev.build.servedId !== undefined && ev.build.id !== undefined && ev.build.id !== ev.build.servedId) reasons.push('build.id differs from build.servedId');
  return { ok, complete: reasons.length === 0, reasons };
}

/** test-gate honesty rules for kind "db": a passed step with exit != 0, Result FAIL/UNKNOWN, 0 files or 0 tests becomes failed. */
function applyHonesty(step) {
  if (step.status !== 'passed') return step;
  const problems = [...(step.problems ?? [])];
  if (step.exitCode !== 0) problems.push(`status passed but exitCode is ${step.exitCode}`);
  if (step.kind === 'db') {
    const c = step.counts;
    const pg = step.details?.pgtap;
    if (!c) problems.push('no test counts were parsed from the output');
    else {
      const tests = pg?.tests ?? c.tests ?? (c.passed ?? 0) + (c.failed ?? 0) + (c.skipped ?? 0);
      const files = pg?.files ?? c.files ?? (tests === 0 ? 0 : 1);
      const result = pg?.result ?? c.result ?? ((c.failed ?? 0) > 0 ? 'FAIL' : tests > 0 ? 'PASS' : 'UNKNOWN');
      const empty = Boolean(step.allowEmpty?.reason);
      if (result === 'FAIL') problems.push('pgTAP reported "Result: FAIL" although the exit code was 0');
      else if (result === 'UNKNOWN') problems.push('no parsable pg_prove summary (Result: UNKNOWN)');
      else if (!empty && (files === 0 || tests === 0)) problems.push(`pgTAP ran ${tests} tests in ${files} files`);
      else if ((c.failed ?? 0) > 0) problems.push(`status passed but counts.failed is ${c.failed}`);
    }
  }
  if (problems.length === (step.problems ?? []).length) return step;
  return { ...step, status: 'failed', problems };
}

/**
 * Merge rule (test-gate 4.2.4, same as `gate.mjs add-step`): replace only the step with the same name (in place) or append,
 * keep every other step and every unknown root field, recompute ok/complete/totalMs/finishedAt.
 * Pure; returns a new object. `requiredSteps` (optional) replaces the file's list. git/environment are left as they are.
 */
export function mergeEvidence(existing, step, now = new Date().toISOString(), requiredSteps = null) {
  const problems = validateStep(step);
  if (problems.length) throw new Error(`invalid step: ${problems.join('; ')}`);
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? structuredClone(existing) : {};
  const prev = Array.isArray(base.steps) ? base : { ...base, steps: [] };
  const { stale: _stale, ...rest } = step;
  void _stale;
  const clean = applyHonesty(rest);
  const steps = [...prev.steps];
  const idx = steps.findIndex((s) => s && s.name === clean.name);
  if (idx >= 0) steps[idx] = clean; else steps.push(clean);
  const required = requiredSteps?.length ? requiredSteps : Array.isArray(prev.requiredSteps) ? prev.requiredSteps : [];
  const { ok, complete } = evaluateEvidence({ ...prev, requiredSteps: required, steps });
  return {
    ...prev,
    schemaVersion: 2,
    ok,
    complete,
    finishedAt: now,
    totalMs: steps.filter((s) => !s.stale).reduce((a, s) => a + (s.wallMs || 0), 0),
    args: Array.isArray(prev.args) ? prev.args : [],
    requiredSteps: required,
    steps,
  };
}

/** Reads the evidence file. Missing = null. Corrupt = throws (never overwrite what we cannot read). */
export function readEvidence(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('root is not an object');
    return v;
  } catch (e) {
    throw new Error(`evidence file ${path} is not valid JSON (${e.message}); refusing to overwrite it`);
  }
}

/** Atomic write: temp file in the same folder, then rename. */
export function writeEvidenceAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ guard

const FORBIDDEN = [
  [/(^|\s)--remote(\s|=|$)/, '--remote'],
  [/(^|\s)--linked(\s|=|$)/, '--linked'],
  [/\bdb\s+reset\b/, 'db reset'],
  [/\bdb\s+push\b/, 'db push'],
  [/\bdown\b[^&|;]*\s(-v|--volumes)(\s|$)/, 'down -v'],
  [/--force-reset/, '--force-reset'],
];

/** Returns the forbidden fragment found in a command line, or null. */
export function guardCommand(argvOrString) {
  const text = Array.isArray(argvOrString) ? argvOrString.join(' ') : String(argvOrString);
  for (const [re, label] of FORBIDDEN) if (re.test(text)) return label;
  return null;
}

// ------------------------------------------------------------------------------------------------ CLI

const HELP = `tap-to-evidence ${VERSION}

Parse pg_prove / TAP output from "supabase test db" and record ONE step in the shared evidence file.

Usage:
  node tap-to-evidence.mjs parse --log <file|-> [options]
  node tap-to-evidence.mjs run [options] -- <command...>

Options:
  --evidence <path>      Evidence file (default .gate/last.json)
  --name <step>          Step name (default db:test; db:test:mutation with --mutation)
  --mutation             Mutation run: "passed" means the mutated copy FAILED as expected (tests ran, some red)
  --scope-files a,b      Partial run: scope {kind:"files"}; a required step with this scope is never "complete"
  --command "<text>"     parse: REQUIRED, the command that produced the log (recorded as is)
  --exit-code <n>        parse: exit code of that command (recorded; non-zero = failed)
  --wall-ms <n>          parse: wall time in ms
  --timeout-min <n>      run: kill the command after n minutes (default 10)
  --approved-skips <f>   JSON file with approvedSkips[] ({test,reason,approvedBy,approvalRef,...}); approvedBy must be user|orchestrator
  --supabase-cli <ver>   Recorded in details.pgtap.supabaseCli
  --required a,b         requiredSteps of the evidence file (default: keep the file's list)
  --gate <path>          test-gate's gate.mjs to call (default <root>/scripts/gate.mjs when it exists)
  --no-gate              never call gate.mjs; use the built-in copy of test-gate's merge rules
  --quiet                run: do not echo the command output (it is still captured in the log file)
  --dry-run              Print the resulting evidence JSON; write nothing
  --json                 Print the step as JSON on stdout (after the human summary)
  --help                 This text

Rules: status is "passed" only when exit code is 0 (parse needs --exit-code), a "Files=N, Tests=M" summary exists, N>0, M>0,
Result is PASS, no failed test, no plan mismatch, no died file. Unknown fields and other steps in the evidence file
are preserved. counts.skipped is a number: 0 when the output cannot show skips (non-verbose pg_prove). "run" refuses commands containing --remote, --linked, db reset, db push, down -v, --force-reset.
Exit code: 0 recorded step passed, 1 failed/timeout, 2 usage error or refused command.`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  let i = 0;
  const takesValue = new Set(['log', 'evidence', 'name', 'scope-files', 'command', 'exit-code', 'wall-ms', 'timeout-min', 'approved-skips', 'supabase-cli', 'required', 'gate']);
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (takesValue.has(key)) {
        out.flags[key] = eq > 0 ? a.slice(eq + 1) : argv[++i];
        if (out.flags[key] === undefined) throw new Error(`--${key} needs a value`);
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

const toNum = (v, label) => {
  if (v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative number`);
  return n;
};

function loadApprovedSkips(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(data)) throw new Error('--approved-skips file must contain a JSON array');
  for (const s of data) {
    if (!s || typeof s.test !== 'string' || typeof s.reason !== 'string') throw new Error('each approved skip needs "test" and "reason"');
    if (s.approvedBy !== 'user' && s.approvedBy !== 'orchestrator') throw new Error('approvedBy must be "user" or "orchestrator", never the agent that writes the skip');
    if (!s.approvalRef) throw new Error('each approved skip needs "approvalRef" (the message or standing instruction)');
  }
  return data;
}

function relPosix(fromDir, target) {
  const r = relative(fromDir, target);
  return (r.startsWith('..') ? target : r).split(sep).join('/');
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

function runCommand(argv, { timeoutMs, logPath, quiet = false }) {
  return new Promise((resolveRun) => {
    mkdirSync(dirname(logPath), { recursive: true });
    const log = createWriteStream(logPath);
    const started = Date.now();
    const isWin = process.platform === 'win32';
    const child = spawn(argv[0], argv.slice(1), { shell: isWin, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const sink = (stream, target) => stream.on('data', (chunk) => { log.write(chunk); if (!quiet) target.write(chunk); });
    sink(child.stdout, process.stdout);
    sink(child.stderr, process.stderr);
    child.on('error', (e) => { log.write(`\n[tap-to-evidence] spawn error: ${e.message}\n`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end(() => resolveRun({ code: timedOut ? null : code, timedOut, wallMs: Date.now() - started, startedAt: new Date(started).toISOString() }));
    });
  });
}

/**
 * Records the step in the shared evidence file. With the test-gate kit present (<root>/scripts/gate.mjs, or --gate <path>)
 * it delegates to `gate.mjs add-step`, so test-gate itself applies its merge, honesty and ok/complete rules.
 * Without the kit (or with --no-gate, or --dry-run) it uses mergeEvidence(), the mirror of those rules.
 * Returns { via, evidence, step } where step is the step as written (test-gate may downgrade a dishonest "passed").
 */
export function recordStep({ evidencePath, root, step, requiredSteps = null, gatePath = null, noGate = false, dryRun = false }) {
  const kit = gatePath ? resolve(gatePath) : join(root, 'scripts', 'gate.mjs');
  if (!noGate && !dryRun && existsSync(kit)) {
    const evDir = dirname(evidencePath);
    const tmpStep = join(mkdtempSync(join(tmpdir(), 'tap-step-')), 'step.json');
    try {
      writeFileSync(tmpStep, JSON.stringify(step));
      const argv = [kit, 'add-step', '--from-json', tmpStep, '--root', root, '--evidence-dir', evDir];
      if (requiredSteps?.length) argv.push('--required', requiredSteps.join(','));
      const r = spawnSync(process.execPath, argv, { encoding: 'utf8', cwd: root });
      if (r.stderr) console.error(r.stderr.trimEnd());
      if (r.error) throw r.error;
      if (r.status === 2 || r.status === null) throw new Error(`gate.mjs add-step failed: ${(r.stderr || r.stdout || '').trim()}`);
      if (r.stdout) console.error(r.stdout.trimEnd());
    } finally {
      try { rmSync(dirname(tmpStep), { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const evidence = readEvidence(evidencePath);
    return { via: 'gate.mjs add-step', evidence, step: evidence.steps.find((x) => x.name === step.name) ?? step };
  }
  const evidence = mergeEvidence(readEvidence(evidencePath), step, new Date().toISOString(), requiredSteps);
  return { via: 'mergeEvidence', evidence, step: evidence.steps.find((x) => x.name === step.name) };
}

export async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`error: ${e.message}`); return 2; }
  const mode = args._[0];
  if (args.flags.help || args.flags.h || !mode) { console.log(HELP); return mode || args.flags.help ? 0 : 2; }
  if (mode !== 'parse' && mode !== 'run') { console.error(`error: unknown mode "${mode}" (use parse or run)`); return 2; }

  try {
    const f = args.flags;
    const mutation = Boolean(f.mutation);
    const name = f.name || (mutation ? 'db:test:mutation' : 'db:test');
    if (!/^[a-z0-9:_-]+$/.test(name)) throw new Error('--name must match [a-z0-9:_-]+');
    const evidencePath = resolve(f.evidence || join('.gate', 'last.json'));
    const evDir = dirname(evidencePath);
    const root = evDir.endsWith(`${sep}.gate`) || evDir.endsWith('/.gate') ? dirname(evDir) : evDir;
    const scopeFiles = f['scope-files'] ? String(f['scope-files']).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const scope = scopeFiles.length ? { kind: 'files', files: scopeFiles } : { kind: 'all' };
    const approvedSkips = f['approved-skips'] ? loadApprovedSkips(f['approved-skips']) : null;

    let output; let exitCode = null; let wallMs = toNum(f['wall-ms'], '--wall-ms'); let timedOut = false;
    let command = f.command || ''; let logFile = null; let startedAt = null;
    const timeoutMs = Math.round((toNum(f['timeout-min'], '--timeout-min') ?? 10) * 60000);

    if (mode === 'parse') {
      if (!f.log) throw new Error('parse needs --log <file|->');
      if (!f.command) throw new Error('parse needs --command "<the command that produced the log>" (test-gate requires the exact command line)');
      output = f.log === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(f.log), 'utf8');
      exitCode = toNum(f['exit-code'], '--exit-code');
      if (f.log !== '-') logFile = relPosix(root, resolve(f.log));
    } else {
      const cmd = args.rest;
      if (!cmd || !cmd.length) throw new Error('run needs a command after "--"');
      const bad = guardCommand(cmd);
      if (bad) { console.error(`refused: the command contains "${bad}". This skill only runs the local test suite.`); return 2; }
      command = cmd.join(' ');
      const logPath = join(evDir, 'logs', `${name.replace(/:/g, '-')}.log`);
      logFile = relPosix(root, logPath);
      const r = await runCommand(cmd, { timeoutMs, logPath, quiet: Boolean(f.quiet) });
      exitCode = r.code; wallMs = r.wallMs; timedOut = r.timedOut; startedAt = r.startedAt;
      output = readFileSync(logPath, 'utf8');
    }

    const parsed = parseTap(output);
    const step = buildStep({
      parsed, name, command, exitCode, wallMs, timeoutMs, timedOut, scope, logFile, startedAt,
      approvedSkips, mutation, supabaseCli: f['supabase-cli'] || null,
      finishedAt: new Date().toISOString(),
    });
    const requiredSteps = f.required ? String(f.required).split(',').map((x) => x.trim()).filter(Boolean) : null;
    const rec = recordStep({ evidencePath, root, step, requiredSteps, gatePath: f.gate || null, noGate: Boolean(f['no-gate']), dryRun: Boolean(f['dry-run']) });
    const written = rec.step;

    const c = written.counts;
    console.error(`
[tap-to-evidence] ${name}: ${written.status} | files=${c.files} tests=${c.tests} passed=${c.passed} failed=${c.failed} skipped=${c.skipped}${step.details.pgtap.skipsVisible ? '' : ' (not visible in non-verbose output)'} | wall=${written.wallMs}ms`
      + (written.status === 'passed' ? '' : ` | ${[...(step.details.pgtap.statusReasons ?? []), ...(written.problems ?? [])].join('; ')}`));
    for (const x of (written.failures ?? []).slice(0, 10)) console.error(`  - ${x.file ?? '?'} #${x.number ?? '-'}: ${x.test} (${x.message})`);
    console.error(`[tap-to-evidence] ok=${rec.evidence.ok} complete=${rec.evidence.complete} (via ${rec.via})`);

    if (f['dry-run']) console.log(JSON.stringify(rec.evidence, null, 2));
    else {
      if (rec.via === 'mergeEvidence') writeEvidenceAtomic(evidencePath, rec.evidence);
      console.error(`[tap-to-evidence] wrote ${evidencePath}${scope.kind === 'files' ? ' (partial run: scope "files", never complete for a required step)' : ''}`);
      if (f.json) console.log(JSON.stringify(written, null, 2));
    }
    return written.status === 'passed' ? 0 : 1;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
