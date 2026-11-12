---
name: test-gate
description: "Run and supervise quality gates (lint, typecheck, unit, DB, build, e2e) in JS/TS projects that use Playwright or Cypress with Vitest or Jest, and leave machine-readable evidence. Use when asked to run, re-run or fix \"the gate\" or an e2e suite, to diagnose flaky or slow e2e tests, to write or review e2e specs (login, waiting, hydration), or to brief or supervise another agent that runs tests. Enforces one full run per gate, per-step time caps, login-once auth, signal-based waits and no weakened tests. Not for writing a unit test for one function, fixing a type or lint error, or general debugging."
license: Apache-2.0
compatibility: "Node 20+ for the optional kit; any package manager"
---

# Test Gate

Repo rules (`AGENTS.md`, `CLAUDE.md`, `OVERRIDES.md`) win over this skill.

## Rules (in order)

1. Read the repo rules and `package.json` scripts first. Never invent commands.
2. Evidence or it did not happen: each gate leaves command, exit code, duration and counts in `.gate/last.json` (or pasted raw output). "Tests pass" in prose counts for nothing; a reviewer re-runs.
3. One full run per gate. On failure fix, re-run only the failing file, then one final full run.
4. Never split a suite into batches or add sleeps. A rate limit or flake is a bug in the test setup: fix the cause.
5. Every step has a time cap and the gate stops at the first failure. Past ~30 min the supervisor reads the log; it does not wait.
6. Log in once (setup project + `storageState`, or `cy.session`). Only the auth spec uses the login UI. Specs that write data get their own user. Sign out with local scope.
7. Wait on signals, never on time: no `networkidle`, `waitForTimeout` or `toPass` for UI. Navigate through a ready helper.
8. Fix a flaky test at its cause. Never add retries (keep them at 0), broader locators, removed or negated assertions, `skip`/`fixme` or longer timeouts to get green.
9. A skip needs approval from the user or the orchestrator (never the agent writing it), a linked issue and an evidence entry.
10. Use a free port, check the served build id against the build on disk, kill only processes you started.
11. On Windows use the installed Chrome (`channel: 'chrome'`) and one worker; 2+ Playwright-bundled Chromium stall.
12. Builders run their own e2e for what they touched before reporting. A spec never run is not delivered.
13. No literal secrets, not even fake ones, and no destructive commands in tests, examples or briefs. Generate values at run time.
14. Delegating or supervising: use the brief template in `references/supervision.md`. An agent's report is not evidence.

## Steps

1. Detect the package manager (`packageManager` field, then lockfile) and resolve each step from `scripts`.
2. Plan the steps (lint, typecheck, unit, db, build, e2e) with caps; report any missing script, do not guess.
3. Run each step once, fail fast, keep its log under `.gate/logs/`.
4. Write the evidence file (`complete` is true only if every required step ran and passed or has an approved skip).
5. Report wall time, passed/failed/skipped per suite, skips and the evidence path.

## References (read only what the task needs)

| Task | File |
|---|---|
| Running or designing a gate, scripts, caps, no-kit mode | `references/gate-run.md` |
| Writing or reading `.gate/last.json` | `references/evidence-schema.md` |
| Login, storageState, per-spec users, logout | `references/e2e-auth.md` |
| Writing specs, hydration, intermittent failures | `references/e2e-waiting.md` |
| Flaky, red or about-to-skip test | `references/flaky-and-skips.md` |
| Servers, ports, builds, Windows, WSL | `references/servers-builds-windows.md` |
| Briefing or watching another agent | `references/supervision.md` |
| Repo has its own rules or a third-party testing skill | `references/repo-rules-overrides.md` |
| Cypress or Jest project | `references/cypress-jest.md` |
| Which versions each tip was checked against | `references/versions.md` |
