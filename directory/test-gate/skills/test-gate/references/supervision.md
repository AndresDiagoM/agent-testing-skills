# Briefing and supervising agents that run tests

Read when you write a brief for a builder or gate agent, launch one, or watch one. Origin: reference-project incident 2 (2026-11-12): a gate agent took 1 h 41 min on an e2e suite that runs in about 2 min. Its brief did not forbid batches with sleeps, and nobody looked at the log. Incident 3: builders wrote specs and never ran them.

## Brief template (copy, fill the angle brackets)

```
GATE / BUILDER BRIEF
Goal: <one sentence>. Repo: <path>. Branch: <name>. Do not commit or push.
Read first: AGENTS.md, <repo testing rules>, skill test-gate (SKILL.md + references: <list>).
Files you may touch: <explicit disjoint list>. Everything else is read-only.
Run: the repo's gate commands from package.json (<list>). Use a free port: PORT=<n>. Distinct run id if another run may be active.
Rules (non-negotiable):
- One full run per gate. On a failure: fix, re-run ONLY the failing file, then ONE final full run.
- No batches, no sleep to dodge limits or flakes. A limit is a bug in the test setup: fix the cause.
- No retries, broader locators, removed assertions, skip/fixme, longer timeouts, networkidle, waitForTimeout.
- Login once through the setup project; specs that write data use their own user.
- Builders: run the e2e of the specs you wrote or changed, 3x, before you report.
Time caps: lint 10 min, typecheck 10, unit 10, db 10, build 10, e2e 15. If any step hits its cap, stop and report; do not retry blindly.
Stop and ask me if: a step runs past 30 min total, you need to skip a test, a port or process is occupied by something you did not start.
Report (max ~250 words): evidence file path (.gate/last.json), wall time per step, passed/failed/skipped per suite, flaky tests, skips requested, files touched, open questions.
```

No secrets and no destructive commands go in a brief. Say "e2e of the specs you touched", not "run the suite as many times as needed".

## Supervisor loop

While the agent runs:

1. Read `.gate/running.json` (step, command, pid, start time, cap, port, log file) and the tail of the newest `.gate/logs/*.log`.
2. Red flags:
   - `sleep` in the agent's commands, or the suite split into batches
   - a second full run of the same suite inside one gate
   - a step log with no new output for 5 minutes
   - a step over its cap
   - e2e wall time over 5 times the last passing run (`previousPassMs` in the evidence)
   - the whole gate past ~30 minutes
3. On a red flag: look before you wait. Stop only the process tree recorded in that agent's own `running.json`, diagnose the cause (usually the test setup: per-test logins, stale server, Windows browser), fix it, restart ONE gate. "I waited" is not an outcome.
4. Never stop an agent by process name or port, and never stop a process you did not start.

Without the kit there is no `running.json`: ask the agent to tee each step to a log file and to report its pid, and read that log.

## Reviewer rule

The agent's report is not evidence. Before accepting work the orchestrator reads the evidence file (the `complete` field, not the agent's prose), re-runs lint, typecheck and unit tests, and runs at least one full e2e itself. Read the diff of specs for weakening, or run the kit's `scripts/e2e-guard.mjs`, which blocks fewer assertions, skips, bigger timeouts, new retries and sleeps. An approval comment (`// test-guard: approved <reason>`) must be one the user or orchestrator asked for, never one the builder wrote to get past the guard.

## Builder rule

Every builder runs the e2e of what it touched before reporting: only the affected specs, repeated 3 times, setup once. The kit's `scripts/e2e-changed.mjs` does this (mapping in `e2e-changed.map.json`); otherwise run the affected files by name. With the kit's Stop hook (`hooks/stop-gate.mjs`) a builder is also blocked, within 90 s, on a weakened test, a lint or type error or a failing related unit test before it can stop; it never runs e2e. Unmapped or shared code means the full suite, with the reason stated. A spec that was never run is not delivered.

## Report format to demand

Wall time, passed/failed/skipped per suite, skips requested (first lines), flaky tests, evidence path, files touched.

## Parallel agents

Disjoint file lists, separate ports and run ids, and one owner for shared files (lockfile, root config). Two gates must never write one evidence file at the same time: use separate worktrees or repos.
