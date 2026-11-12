#!/usr/bin/env node
// @ts-check
// gate.mjs: runs the quality gate (lint, typecheck, test, db:test, build, e2e) once, in order, fail-fast, and writes the
// evidence file .gate/last.json (schema v2, see references/evidence-schema.md). Plain ESM, Node 20+, no dependencies.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  REPORTED_BY,
  VERSION,
  DEFAULT_PORT,
  addStep,
  assembleEvidence,
  checkBuildFreshness,
  detectPackageManager,
  evaluateEvidence,
  formatDuration,
  formatSummary,
  gitInfo,
  judge,
  killTree,
  loadConfig,
  logName,
  parseArgs,
  parseCounts,
  parseFailures,
  parsePlaywrightJson,
  pickFreePort,
  readEvidence,
  readToolVersions,
  resolveSteps,
  runCommand,
  selectSteps,
  writeJsonAtomic,
} from './gate-lib.mjs';

const USAGE = `gate.mjs ${VERSION}: quality gate runner with machine-readable evidence.

Usage:
  node gate.mjs [--dry-run] [--only a,b] [--from step] [--skip a,b] [--timeout step=min,...] [--port n] [--rebuild]
                [--require-complete] [--root dir] [--config file] [--evidence-dir dir]
  node gate.mjs add-step --from-json <file|-> [--required a,b] [--root dir] [--evidence-dir dir]
  node gate.mjs --help | --version

Runs, in order and fail-fast, the steps resolved from package.json scripts (lint, typecheck, test, db:test, build, e2e, parity)
or from kit.config.json at the repo root. The package manager comes from the packageManager field, then the lockfile.
Output of each step is shown live and tee'd to <evidence dir>/logs/<step>.log. <evidence dir>/running.json exists while a step runs.

  --dry-run           print the resolved plan, run nothing, write nothing
  --only / --from     select steps; --skip removes steps. A partial run is allowed but its evidence is complete:false
  --timeout e2e=20    per-step cap in minutes (defaults: 10, e2e 15). On timeout only the process tree this runner started is killed
  --port n            first port tried for e2e steps (default ${DEFAULT_PORT}); PORT is exported to the step
  --rebuild           when e2e would run without a build step in this run and the build is missing or older than the sources
                      (kit.config.json e2e.buildIdFile + e2e.sourceDirs), run the build step first instead of failing
  --require-complete  exit 1 unless the evidence says complete:true (default: exit code follows ok)
  --evidence-dir      default .gate (or evidence.dir in kit.config.json)

Evidence rules: a step that exits 0 but ran 0 passing tests FAILS (unless the step has allowEmpty); steps not run in this
invocation are kept and marked stale:true, never erased; complete needs every required step fresh and passed (or skipped with
a valid approval) and no unapproved skipped tests.

add-step merges ONE step object (JSON file, or - for stdin) into last.json: only the step with the same name is replaced,
other steps and unknown fields are kept, ok/complete/totalMs/finishedAt/git are recomputed, the write is atomic.
Required fields of a step: name, status, command, exitCode, wallMs, timeoutMs. See references/evidence-schema.md.`;

/** @param {string} p */
const posix = (p) => p.split('\\').join('/');

async function main() {
  const argv = process.argv.slice(2);
  /** @type {import('./gate-lib.mjs').GateOptions} */
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`gate: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(VERSION);
    return 0;
  }
  const root = resolve(opts.root ?? process.cwd());
  let config;
  try {
    config = loadConfig(root, opts.config).config;
  } catch (err) {
    console.error(`gate: ${/** @type {Error} */ (err).message}`);
    return 2;
  }
  const evidenceDir = resolve(root, opts.evidenceDir ?? config.evidence?.dir ?? '.gate');
  const evidenceFile = join(evidenceDir, 'last.json');

  if (opts.command === 'add-step') return runAddStep({ opts, root, config, evidenceFile });

  /** @type {Record<string, any>} */
  let pkg = {};
  const pkgFile = join(root, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
    } catch (err) {
      console.error(`gate: cannot parse ${pkgFile}: ${/** @type {Error} */ (err).message}`);
      return 2;
    }
  } else console.error(`gate: no package.json in ${root}; only steps with a configured command can run.`);
  const pm = detectPackageManager(root, pkg, config.packageManager);
  const plan = resolveSteps({ pkg, config, pm: pm.name });
  const names = plan.map((s) => s.name);
  try {
    opts = parseArgs(argv, names);
  } catch (err) {
    console.error(`gate: ${/** @type {Error} */ (err).message}\n\n${USAGE}`);
    return 2;
  }
  const requiredSteps = plan.filter((s) => s.required).map((s) => s.name);
  const extraRequired = Array.isArray(config.requiredSteps) ? config.requiredSteps.filter((/** @type {string} */ n) => !names.includes(n)) : [];
  const required = [...requiredSteps, ...extraRequired];

  let selected = selectSteps(opts, names);
  // A step without a command is only reported when it is required or was asked for with --only.
  const runnable = (/** @type {string} */ n) => Boolean(plan.find((s) => s.name === n)?.command);
  selected = selected.filter((n) => runnable(n) || plan.find((s) => s.name === n)?.required || opts.only?.includes(n));
  if (selected.length === 0) {
    console.error('gate: no steps selected.');
    return 2;
  }

  const e2eCfg = config.e2e ?? {};
  const hasE2e = selected.some((n) => plan.find((s) => s.name === n)?.kind === 'e2e' && runnable(n));
  const hasBuild = selected.some((n) => plan.find((s) => s.name === n)?.kind === 'build');
  /** @type {string | null} */
  let staleBuildProblem = null;
  /** @type {{ id?: string, builtAt?: string } | undefined} */
  let buildInfo;
  if (hasE2e && typeof e2eCfg.buildIdFile === 'string') {
    const sourceDirs = Array.isArray(e2eCfg.sourceDirs) ? e2eCfg.sourceDirs : [];
    const check = () => checkBuildFreshness({ root, buildIdFile: e2eCfg.buildIdFile, sourceDirs });
    if (!hasBuild) {
      const { freshness } = check();
      if (freshness.status === 'missing') staleBuildProblem = `${e2eCfg.buildIdFile} not found: there is no production build.`;
      else if (freshness.status === 'stale')
        staleBuildProblem = `the build (${new Date(freshness.builtAtMs).toISOString()}) is older than ${freshness.newer.file} (edited ${new Date(freshness.newer.mtimeMs).toISOString()}): e2e would test stale code.`;
      const buildPlan = plan.find((s) => s.kind === 'build' && s.command);
      if (staleBuildProblem && opts.rebuild && buildPlan) {
        console.log(`gate: ${staleBuildProblem} --rebuild: running the ${buildPlan.name} step first.`);
        selected = names.filter((n) => selected.includes(n) || n === buildPlan.name);
        staleBuildProblem = null;
      }
    }
  }

  if (opts.dryRun) {
    printPlan({ root, pm, plan, selected, required, configUsed: Boolean(config && Object.keys(config).length), evidenceFile, staleBuildProblem, opts });
    return 0;
  }

  mkdirSync(join(evidenceDir, 'logs'), { recursive: true });
  const runningFile = join(evidenceDir, 'running.json');
  const prev = readEvidenceSafe(evidenceFile);
  const git = gitInfo(root);
  const environment = { os: process.platform, node: process.versions.node, packageManager: typeof pkg.packageManager === 'string' ? pkg.packageManager : pm.name, tools: readToolVersions(root) };
  /** @type {import('./gate-lib.mjs').Step[]} */
  const fresh = [];
  const started = performance.now();
  /** @type {number | undefined} */
  let childPid;
  const onSignal = () => {
    if (childPid !== undefined) killTree(childPid);
    rmSync(runningFile, { force: true });
    console.error('\ngate: interrupted; the running step was killed and last.json keeps its previous content.');
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  /** @param {string} finishedAt */
  const persist = (finishedAt) => {
    const ev = assembleEvidence({ prev, fresh, planOrder: names, args: argv, requiredSteps: required, git, environment, build: buildInfo, finishedAt });
    writeJsonAtomic(evidenceFile, ev);
    return ev;
  };

  let failed = false;
  for (const name of selected) {
    const step = /** @type {import('./gate-lib.mjs').PlanStep} */ (plan.find((s) => s.name === name));
    const timeoutMs = opts.timeoutsMs[name] ?? step.timeoutMs;
    const prevStep = prev?.steps.find((s) => s.name === name);
    const base = { name, kind: step.kind, command: step.command ?? '', timeoutMs, scope: { kind: 'all' }, reportedBy: REPORTED_BY };
    if (!step.command) {
      fresh.push({ ...base, status: 'skipped', exitCode: null, wallMs: 0, counts: null, skipReason: step.reason ?? 'no command', ...(step.approval ? { approval: step.approval } : {}) });
      console.log(`gate: ${name}: skipped, ${step.reason ?? 'no command'}${step.required ? ' (required: the gate cannot be complete, ask the user what runs here)' : ''}`);
      persist(new Date().toISOString());
      continue;
    }
    if (failed) {
      if (!prevStep) fresh.push({ ...base, status: 'not-run', exitCode: null, wallMs: 0, counts: null });
      continue;
    }

    console.log(`\n=== gate: ${name} (${step.command}, timeout ${formatDuration(timeoutMs)}) ===`);
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, ...step.env };
    /** @type {number | undefined} */
    let port;
    /** @type {string | undefined} */
    let reportFile;
    if (step.kind === 'e2e') {
      if (staleBuildProblem) {
        console.error(`gate: ${staleBuildProblem} Run the build step first, pass --rebuild, or do not skip the build step.`);
        fresh.push({ ...base, status: 'failed', exitCode: null, wallMs: 0, counts: null, problems: [staleBuildProblem] });
        persist(new Date().toISOString());
        failed = true;
        continue;
      }
      port = await pickFreePort(opts.port ?? e2eCfg.portStart ?? DEFAULT_PORT);
      env.PORT = String(port);
      // With PLAYWRIGHT_BASE_URL set Playwright would skip its web server and hit whatever is already there.
      delete env.PLAYWRIGHT_BASE_URL;
      console.log(`gate: e2e uses port ${port}`);
      if (typeof e2eCfg.buildIdFile === 'string') {
        const { freshness, id } = checkBuildFreshness({ root, buildIdFile: e2eCfg.buildIdFile, sourceDirs: [] });
        if (freshness.status !== 'missing') buildInfo = { ...(id ? { id } : {}), builtAt: new Date(freshness.builtAtMs).toISOString() };
      }
      if (step.jsonReport) {
        reportFile = join(evidenceDir, 'reports', `${logName(name).replace(/\.log$/, '')}.json`);
        rmSync(reportFile, { force: true });
        // Read by Playwright's json reporter only when that reporter is active (config or --reporter=list,json in the command).
        env.PLAYWRIGHT_JSON_OUTPUT_FILE = reportFile;
      }
    }

    const logFile = join(evidenceDir, 'logs', logName(name));
    const startedAt = new Date();
    const run = await runCommand(step.command, {
      cwd: root,
      env,
      timeoutMs,
      logFile,
      onSpawn: (pid) => {
        childPid = pid;
        writeFileSync(runningFile, `${JSON.stringify({ step: name, command: step.command, pid, startedAt: startedAt.toISOString(), timeoutMs, ...(port !== undefined ? { port } : {}), logFile: posix(relative(root, logFile)) }, null, 2)}\n`);
      },
    });
    childPid = undefined;
    rmSync(runningFile, { force: true });

    let counts = parseCounts(step.kind, run.output);
    let failures = parseFailures(step.kind, run.output);
    /** @type {import('./gate-lib.mjs').Failure[]} */
    let flaky = [];
    if (reportFile && existsSync(reportFile) && statSync(reportFile).mtimeMs >= startedAt.getTime() - 1000) {
      try {
        const json = parsePlaywrightJson(JSON.parse(readFileSync(reportFile, 'utf8')), root);
        counts = json.counts;
        failures = json.failures;
        flaky = json.flaky;
      } catch (err) {
        console.error(`gate: could not read ${reportFile} (${/** @type {Error} */ (err).message}); using the text summary.`);
      }
    }
    const { status, problem } = judge({ kind: step.kind, allowEmpty: step.allowEmpty }, run.exitCode, counts, run.timedOut);
    if (run.timedOut) console.error(`\ngate: ${name} exceeded ${formatDuration(timeoutMs)} and was killed.`);
    if (problem) console.error(`\ngate: ${name} FAILED: ${problem}.`);
    fresh.push({
      ...base,
      status,
      exitCode: run.exitCode,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      wallMs: run.wallMs,
      ...(prevStep?.status === 'passed' && !prevStep.stale && prevStep.wallMs ? { previousPassMs: prevStep.wallMs } : {}),
      ...(port !== undefined ? { port } : {}),
      counts,
      ...(failures.length ? { failures } : {}),
      ...(flaky.length ? { flaky } : {}),
      ...(step.approvedSkips ? { approvedSkips: step.approvedSkips } : {}),
      ...(step.allowEmpty ? { allowEmpty: step.allowEmpty } : {}),
      ...(problem ? { problems: [problem] } : {}),
      logFile: posix(relative(root, logFile)),
    });
    persist(new Date().toISOString());
    if (status !== 'passed') failed = true;
  }

  const totalMs = Math.round(performance.now() - started);
  const evidence = persist(new Date().toISOString());
  console.log(`\n${formatSummary(evidence, totalMs)}\n(evidence: ${posix(relative(root, evidenceFile))})`);
  const verdict = evaluateEvidence(evidence);
  if (!verdict.ok) return 1;
  if (opts.requireComplete && !verdict.complete) return 1;
  return 0;
}

/** @param {string} file */
function readEvidenceSafe(file) {
  try {
    return readEvidence(file);
  } catch (err) {
    console.error(`gate: ${/** @type {Error} */ (err).message}; it will be replaced.`);
    return null;
  }
}

/**
 * @param {{ root: string, pm: { name: string, source: string }, plan: import('./gate-lib.mjs').PlanStep[], selected: string[], required: string[],
 *   configUsed: boolean, evidenceFile: string, staleBuildProblem: string | null, opts: import('./gate-lib.mjs').GateOptions }} p
 */
function printPlan({ root, pm, plan, selected, required, configUsed, evidenceFile, staleBuildProblem, opts }) {
  console.log(`gate ${VERSION} dry run (nothing is executed or written)`);
  console.log(`root:            ${root}`);
  console.log(`package manager: ${pm.name} (${pm.source})`);
  console.log(`config:          ${configUsed ? 'kit.config.json' : 'none (defaults)'}`);
  console.log(`evidence:        ${posix(relative(root, evidenceFile))}`);
  const rows = plan.map((s) => {
    const sel = selected.includes(s.name);
    const timeout = opts.timeoutsMs[s.name] ?? s.timeoutMs;
    return [s.name, s.kind, sel ? 'run' : 'skip', s.required ? 'yes' : 'no', s.command ? formatDuration(timeout) : '-', s.command ?? `(${s.reason ?? 'no command'})`];
  });
  const header = ['step', 'kind', 'plan', 'required', 'cap', 'command'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => /** @type {string} */ (r[i]).length)));
  /** @param {string[]} cells */
  const line = (cells) => cells.map((c, i) => c.padEnd(/** @type {number} */ (widths[i]))).join('  ').trimEnd();
  console.log(`\n${line(header)}\n${line(widths.map((w) => '-'.repeat(w)))}\n${rows.map(line).join('\n')}`);
  const missing = plan.filter((s) => s.required && !s.command).map((s) => s.name);
  if (missing.length) console.log(`\nrequired steps without a command: ${missing.join(', ')} -> the gate can never be complete until a script or kit.config.json command exists.`);
  console.log(`\nrequiredSteps: ${required.join(', ')}`);
  if (staleBuildProblem) console.log(`e2e would fail: ${staleBuildProblem}`);
  if (opts.only || opts.from || opts.skip.length) console.log('partial selection: the evidence will say complete:false.');
}

/** @param {{ opts: import('./gate-lib.mjs').GateOptions, root: string, config: Record<string, any>, evidenceFile: string }} p */
function runAddStep({ opts, root, config, evidenceFile }) {
  let raw;
  try {
    raw = opts.fromJson === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(root, /** @type {string} */ (opts.fromJson)), 'utf8');
  } catch (err) {
    console.error(`add-step: cannot read ${opts.fromJson}: ${/** @type {Error} */ (err).message}`);
    return 2;
  }
  let step;
  try {
    step = JSON.parse(raw);
  } catch (err) {
    console.error(`add-step: ${opts.fromJson} is not valid JSON: ${/** @type {Error} */ (err).message}`);
    return 2;
  }
  const requiredSteps = opts.required ?? (Array.isArray(config.requiredSteps) ? config.requiredSteps : undefined);
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    /* no package.json: environment.packageManager stays unknown */
  }
  const prev = readEvidenceSafe(evidenceFile);
  try {
    const { evidence, step: written } = addStep({
      file: evidenceFile,
      step,
      requiredSteps,
      git: gitInfo(root),
      environment: prev?.environment ?? { os: process.platform, node: process.versions.node, packageManager: typeof pkg.packageManager === 'string' ? pkg.packageManager : detectPackageManager(root, pkg).name, tools: readToolVersions(root) },
    });
    const v = evaluateEvidence(evidence);
    console.log(`add-step: ${written.name} ${written.status} merged into ${posix(relative(root, evidenceFile))} (${evidence.steps.length} steps, ok:${v.ok}, complete:${v.complete})`);
    for (const p of written.problems ?? []) console.log(`add-step: ${written.name} downgraded to failed: ${p}`);
    if (!v.complete) for (const r of v.reasons) console.log(`  incomplete: ${r}`);
    return written.status === 'passed' ? 0 : 1;
  } catch (err) {
    console.error(`add-step: ${/** @type {Error} */ (err).message}`);
    return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`gate: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
