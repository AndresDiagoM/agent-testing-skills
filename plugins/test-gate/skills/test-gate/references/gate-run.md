# Running a gate

Read when running, designing or repairing a quality gate. Derived from the reference project's `scripts/gate-core.ts`, `gate.ts`, `gate-run.ts` and `.claude/rules/testing.md` sections 2-3.

## Detect the package manager (never hard-code one)

1. `package.json` `packageManager` field (for example `pnpm@12.18.0`).
2. Else the lockfile: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock` or `bun.lockb`.
3. Else npm.

On Windows run through a shell: pnpm and npm are `.cmd` shims. One-off binaries use the manager's exec form, chosen by step 1. Text from third-party docs that says `npm`/`npx` means "the repo's manager". If a repo pins a command per step (kit `kit.config.json`), that wins.

## Steps, script names and caps

Resolve each step from the repo (or workspace) `scripts`; first match wins. Command = the manager's `run <script>` form.

| Step | Script names tried, in order | Cap (min) |
|---|---|---|
| lint | `lint` | 10 |
| typecheck | `typecheck`, `type-check`, `check:types`, `tsc` | 10 |
| unit | `test`, `test:unit` | 10 |
| db:test | `db:test`, `test:db` | 10 |
| build | `build` | 10 |
| e2e | `test:e2e`, `e2e`, `playwright` | 15 |
| parity (optional) | `test:parity` | 10 |

Caps are the reference project's values; a repo may change them, never silently. The whole gate has a supervisor trigger at ~30 min and a hard stop (default 45 min).

A script that does not exist: the step is `skipped` with the reason "no script named ...". If the step is required, the gate is not complete: ask the user, do not invent a command.

## Procedure

1. Resolve scripts, plan the step list, record the plan (`requiredSteps`).
2. Run in order. Tee output to `.gate/logs/<step>.log` while it runs, so a supervisor can read it live. Record start time, the exact command, exit code and wall time from the process you started.
3. Stop at the first failure. Fix, re-run only the failing file, then one final full run of the gate.
4. Write the evidence file (the evidence schema is in the routing table of SKILL.md). Never write counts that were not parsed from output or a structured report.
5. Report: table of step, status, wall time, passed/failed/skipped, then the skips and the evidence path.

## Honesty checks

- A step that exits 0 but ran zero passing tests FAILS: all tests skipped, no spec matched, or a summary that cannot be parsed. This must never look green.
- Skipped, todo, did-not-run and flaky counts are warnings that block "complete". A pass on retry is FLAKY, not a clean pass.
- Partial runs (`--only`, `--from`, `--skip` style) are allowed, but the evidence says `complete: false`. A run of only e2e is not a gate pass.
- Prefer a structured report over scraping text: the test runner's JSON reporter or `--json` output with an output file. Check the flag names with the installed version's `--help`; they were not re-verified against the versions table.
- Optional `parity` step: if the repo compares hand-written test doubles with the real database (reference project: its parity script), run it as its own step. If the stack is down, report it skipped with a reason, never silently passed.

## With the kit (optional, `assets/kit/`)

`scripts/gate.mjs` implements all of the above in plain Node 20+ (`--dry-run` prints the plan, `add-step --from-json <file>` merges a step another tool produced). `scripts/e2e-guard.mjs` scans specs for banned moves. Install means adding files to the user's repo: tell the user the exact file list and get an OK first. The kit ships in v0.1 as core scripts only; app templates (ready helper, auth setup, stop hook, installer) ship in v0.2.

## Without the kit

Run the same procedure by hand with the repo's own commands and write `.gate/last.json` following the evidence schema. Add the file to `.gitignore` if it is not there (ask first).

## Never

- Run a full suite twice in one gate "to be sure".
- Use sleeps, batches or shards-with-pauses to dodge a limit.
- Report a step you did not run, or copy numbers from an earlier run.
