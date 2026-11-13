# test-gate

[![skills.sh](https://www.skills.sh/b/AndresDiagoM/agent-testing-skills)](https://www.skills.sh/andresdiagom/agent-testing-skills) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](../../LICENSE) [![Version 0.2.1](https://img.shields.io/badge/version-0.2.1-green)](CHANGELOG.md)

An agent skill that makes a coding agent run and supervise quality gates (lint, typecheck, unit, DB, build, e2e) in JS/TS projects fast and honestly: one full run per gate, hard time caps, login once, waits on signals, no weakened tests, and a machine-readable evidence file.

## Before / after

**Before** (a real incident, plus a common habit):
- An e2e gate took 1 h 41 min. Every test logged in through the UI and hit a limit of 30 sign-ins per 5 minutes. The agent split the suite into batches with sleeps of about 5 minutes. The tests themselves took about 30 s per batch.
- A flaky test got "fixed" with retries, `test.fixme` or a longer timeout. The run turned green and the coverage was gone.

**After** (what the skill makes the agent do):
- One full run per gate, with a time cap per step. No batches, no sleeps.
- Log in once in a `setup` project and reuse `storageState`. Only the auth spec uses the login UI.
- Fix the flaky test at its cause. A skip needs approval from you or the orchestrator, never from the agent that writes it.
- Leave `.gate/last.json` with the command, exit code, duration and counts of every step.

We have no measured "after" time for the incident, so none is claimed.

## Measured results

Claude Code `claude plugin eval` with Sonnet, 2026-11-12, three runs per case, with plugin version 0.1.0 loaded (later versions not re-evaluated). The eval cases are in [`evals/`](evals); raw result files are kept locally, not in the repo.

- Trigger and negative cases: 24/24 runs pass (8 cases). In the first pass one negative run failed because the grader was too strict; we reworded it and re-ran that case.
- Quality score with the skill minus without it: `builder-brief` +0.73, `runaway-gate` +0.17, `flaky-fix` +0.13, `random-login` 0.
- `random-login` showed no gain yet: the agent without the skill already found the fix.
- `builder-brief` was +0.61 in the full four-case run and +0.73 when re-run alone. Small samples, one model: read these as a direction, not a benchmark.

## Usage

In Claude Code, type `/test-gate:test-gate` (plugin install) or `/test-gate` (skill-folder install), or describe the task. The skill loads on its own for requests like:

- "Run the gate and tell me what failed."
- "Why is this e2e test flaky?"
- "Review my e2e spec for login and waiting problems."
- "Write the brief for an agent that builds the /reports page and runs the e2e."
- "The gate agent has been running for 55 minutes. What do you do?"
- "Set up login once for our Playwright suite."

Not for: writing a unit test for one function, fixing a type or lint error, or general debugging.

## What you get

`node scripts/gate.mjs` (optional kit, once installed in your repo) writes `.gate/last.json`. This is real output from a tiny fixture repo whose scripts only print test-runner summaries. It is trimmed (lint, typecheck, build and some fields such as `environment` removed). Schema: [`evidence-schema.md`](skills/test-gate/references/evidence-schema.md).

```jsonc
{
  "schemaVersion": 2,
  "ok": true,
  "complete": true,          // every required step ran and passed
  "finishedAt": "2026-11-13T00:38:14.284Z",
  "totalMs": 2609,
  "requiredSteps": ["lint", "typecheck", "test", "build", "e2e"],
  "git": { "head": "5ab6d018e3dfe0550e16541946f9b8ad4853b59a", "dirty": true },
  "steps": [
    { "name": "test", "kind": "unit", "status": "passed", "command": "npm run test",
      "exitCode": 0, "wallMs": 521, "timeoutMs": 600000, "scope": { "kind": "all" },
      "counts": { "passed": 31, "failed": 0, "skipped": 0, "todo": 0, "runs": 1 } },
    { "name": "e2e", "kind": "e2e", "status": "passed", "command": "npm run test:e2e",
      "exitCode": 0, "wallMs": 534, "timeoutMs": 900000, "port": 3200,
      "counts": { "passed": 12, "failed": 0, "skipped": 0, "flaky": 0 }, "logFile": ".gate/logs/e2e.log" }
  ]
}
```

## How it flows

```
brief ---> gate run ---------------------> evidence ----------> report
rules,     one full run per step,          .gate/last.json       wall time, counts,
caps,      cap per step,                   + logs under          skips, evidence path
scope      stop at first failure           .gate/logs/
              ^
              |  supervisor: reads .gate/running.json and the log at ~30 min,
              |  stops only the pid recorded there
Stop hook (optional kit, Claude Code): lint, typecheck, related unit tests and
the guard, 90 s budget, before the agent stops.
```

## Problems this solves

- **The e2e suite logs in through the UI in every test and hits the auth rate limit.** Logins fail at random after the 30th test. Fix: one `setup` project + `storageState`, per-spec users, local-scope logout.
- **An agent "fixes" a flaky test with retries, `test.fixme`, a broader locator or a longer timeout.** The run turns green and coverage disappears. Fix: retries stay at 0, a banned-moves list, a subtractive-diff check, and a skip protocol that needs user or orchestrator approval.
- **An agent splits a test suite into batches with sleeps** to dodge a rate limit, and a 2-minute suite becomes a 1 h 41 min gate. Fix: one full run per gate, per-step caps, a supervisor that reads the log at ~30 min.
- **An automated fixer (for example a Playwright healer agent) marks a test `fixme` and the run turns green.** The Playwright healer prompt does this only when it is confident the test is right, but an unattended run still loses that coverage. Fix: skips need approval, an issue link, a re-check date and an entry in the evidence file.
- **Clicks happen before React hydrated, and the "fix" is `networkidle`, `waitForTimeout` or `toPass`.** Fix: a ready helper that waits for two app signals; time waits are banned.
- **2 or more Playwright Chromium processes on Windows stall requests in 10 s steps.** Fix: `channel: 'chrome'` and one worker, with the measurements.
- **An e2e run tests a stale build or a stale server on the same port.** Fix: free port, build id checked against the build on disk, kill only your own process tree.
- **There is no machine-readable evidence that tests ran.** An agent says "all pass" and nobody can check. Fix: `.gate/last.json` with command, exit code, duration, counts, skips, and a `complete` field.
- **A builder agent writes e2e specs it never ran.** Fix: builders run their own e2e before reporting.
- **How do I brief or supervise another agent that runs tests?** A brief template, a supervisor loop and red flags are included.

## How other testing skills compare

Based on the upstream files as of 2026-11-12, at the commits listed in [docs/why.md](../../docs/why.md#sources). "Not covered" means not found in the files read at that commit. Each source below is useful for what it is built for; `test-gate` is meant to sit next to them, not replace them.

| Source | Covers well | Not covered in the files read |
|---|---|---|
| Playwright Test Agents (planner, generator, healer) | Plan, generate, heal split; `// spec:` and `// seed:` comments link a test to its plan; fixes one error at a time; says never to wait for `networkidle` | Time budget or full-run cap; auth reuse and data isolation; evidence format. The healer loops until the test passes and marks `test.fixme()` when it is confident the test is correct |
| currents `playwright-best-practices` | Activity-to-file routing table; don't/do tables; "Avoid when" notes; warns that retrying until pass hides systemic problems | Windows browser stalls, e2e login rate limits, time budget, supervision, report format. Its decision guide names global setup + `storageState` as the auth default; config examples use `retries: process.env.CI ? 2 : 0`; `networkidle` appears in two files |
| testdino `playwright-skill` | Notes the release that added newer APIs; trace analysis; guidance on reviewing healer output | Windows, supervision, time budget. Its auth decision guide names global setup + `storageState` as the default; `SKILL.md` sets `retries` to 2 in CI |
| superpowers verification skill | "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE"; the claim/requires table | Time budget, single-full-run rule, evidence file format, e2e specifics |
| mattpocock `tdd` | Behaviour through public interfaces; tautological-test warning | e2e, DB and flake handling are out of its scope; it asks the user to confirm seams before writing a test, which a non-interactive agent cannot do |
| `playwright-cli` | Browser driving, snapshot refs, small context, `--debug=cli` attach flow | A browser automation CLI, so gates, flake policy and reporting are out of its scope; Windows only for URL escaping |
| anthropics `webapp-testing` | Server lifecycle helper; black-box script rule | Built for ad-hoc interaction: no test runner, auth or assertions; recommends `networkidle` waits |

Cross-cutting areas these skills focus on: one full run per gate, supervision of other agents, enforceable fixer discipline, the Windows Chromium stall (the author's measurement), auth rate limits, machine-readable evidence, DB-level tests (see the sibling `pgtap-rls` skill), portability across agents and package managers.

## FAQ

- **How do I stop an AI agent from marking flaky tests as `fixme`?** Load this skill: rule 8 and 9, plus `references/flaky-and-skips.md`.
- **How do I log in once in Playwright?** `references/e2e-auth.md`.
- **Why does my Playwright suite stall on Windows?** `references/servers-builds-windows.md`.
- **Does it work with pnpm, npm, yarn, bun?** Yes. It reads `packageManager` or the lockfile and never hard-codes a manager.

## Install

Claude Code:
```
/plugin marketplace add AndresDiagoM/agent-testing-skills
/plugin install test-gate@agent-testing-skills
```

Other agents ([Agent Skills](https://agentskills.io) standard), with the [`skills`](https://github.com/vercel-labs/skills) CLI pinned to the version we tested:
```
npx skills@1.7.4 add AndresDiagoM/agent-testing-skills --skill test-gate
```

- Verified on 2026-11-12: `npx skills` installs into the Claude Code folder (`.claude/skills`) and into the opencode and Codex folder (`.agents/skills`).
- `scripts/install-global.mjs` (dry-run by default, `--apply` writes) puts one copy in `~/.agents/skills`, links it for Claude Code and opencode, and adds an entry to Antigravity's `skills.json`.
- Other agents that support Agent Skills should work, but we have not tested them.

## Updating and uninstalling

Claude Code (syntax from `claude plugin --help`):
```
/plugin marketplace update agent-testing-skills
/plugin update test-gate@agent-testing-skills
/plugin uninstall test-gate@agent-testing-skills
```
Outside a session: `claude plugin marketplace update agent-testing-skills`, then `claude plugin update test-gate@agent-testing-skills`. A restart applies the update.

With `npx`: re-run the `add` command above to get the latest version. The CLI also lists `update` and `remove` commands in its help (`npx skills@1.7.4 --help`); we have not tested them. If you copied the skill by hand, delete its folder.

What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## When something goes wrong

- **The skill does not load:** type `/test-gate:test-gate` (or `/test-gate`) or say "use the test-gate skill".
- **It loads for a task it should not:** the "Not for" line in Usage lists what it is not meant for. Tell the agent to ignore it for that task, and report it.
- **The kit's guard blocks a change that is legitimate:** add a comment `// test-guard: approved <reason>` in the same hunk as the change.
- **Anything else:** open an issue at https://github.com/AndresDiagoM/agent-testing-skills/issues.

## What is in v0.2.1

- `SKILL.md` (14 rules), ten references and the evidence schema (v2, shared with `pgtap-rls`).
- Optional repo kit in `skills/test-gate/assets/kit/`, installed with `node assets/kit/install.mjs --target <repo>` (dry-run by default):
  - `gate.mjs`: runs lint, typecheck, unit, DB, build and e2e once, with caps, and writes `.gate/last.json`.
  - `e2e-guard.mjs`: blocks weakened tests in a diff against the merge-base (fewer assertions, skip/fixme/only, longer timeouts, retries, sleeps); approvals only as `// test-guard: approved <reason>` in the same hunk; `--all` with a ratchet baseline for legacy suites.
  - `e2e-changed.mjs`: runs only the specs a change affects, repeated, with one login.
  - Stop hook for Claude Code (lint, typecheck, related unit tests and the guard, 90 s budget).
  - Templates: Playwright setup project + `storageState`, `gotoReady`, config snippet, build-id preflight, and Next.js hydration/page-ready markers.
- `scripts/install-global.mjs`: one copy in `~/.agents/skills` linked for Claude Code and opencode, plus Antigravity's `skills.json`.
- `references/cypress-jest.md` is documented but not verified against a local repo.

## Tested with

- [x] Claude Code: `claude plugin eval` trigger, negative and quality cases (2026-11-12)
- [x] Install via `npx skills add` into Claude Code, opencode and Codex skill folders (2026-11-12)
- [ ] Used in a real opencode / Codex / Antigravity session: not yet

Verified against Playwright 1.65.0, Vitest 5.1.0, Next 16.4.6 (2026-11-12); see `references/versions.md`. The kit was also tried on scratch copies of two real projects, on Windows and WSL (see the changelog).

## Privacy and network

The skill is plain Markdown. The kit scripts run locally with Node, make no network calls, send no telemetry and collect no data. They read your `package.json` and lockfile, run the commands your repo defines, and write only under `.gate/` (and the files you ask the installer to add).

## Contributing and changelog

- Contributing: [CONTRIBUTING.md](../../CONTRIBUTING.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

Apache-2.0
