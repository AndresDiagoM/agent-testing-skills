# test-gate

An agent skill that makes a coding agent run and supervise quality gates (lint, typecheck, unit, DB, build, e2e) in JS/TS projects fast and honestly: one full run per gate, hard time caps, login once, waits on signals, no weakened tests, and a machine-readable evidence file.

## Problems this solves

- **The e2e suite logs in through the UI in every test and hits the auth rate limit.** Logins fail at random after the 30th test. Fix: one `setup` project + `storageState`, per-spec users, local-scope logout.
- **An agent "fixes" a flaky test with retries, `test.fixme`, a broader locator or a longer timeout.** The run turns green and coverage disappears. Fix: retries stay at 0, a banned-moves list, a subtractive-diff check, and a skip protocol that needs user or orchestrator approval.
- **An agent splits a test suite into batches with sleeps** to dodge a rate limit, and a 2-minute suite becomes a 1 h 41 min gate. Fix: one full run per gate, per-step caps, a supervisor that reads the log at ~30 min.
- **A Playwright healer marks tests `fixme` to go green.** Fix: skips need approval, an issue link, a re-check date and an entry in the evidence file.
- **Clicks happen before React hydrated, and the "fix" is `networkidle`, `waitForTimeout` or `toPass`.** Fix: a ready helper that waits for two app signals; time waits are banned.
- **2 or more Playwright Chromium processes on Windows stall requests in 10 s steps.** Fix: `channel: 'chrome'` and one worker, with the measurements.
- **An e2e run tests a stale build or a stale server on the same port.** Fix: free port, build id checked against the build on disk, kill only your own process tree.
- **There is no machine-readable evidence that tests ran.** An agent says "all pass" and nobody can check. Fix: `.gate/last.json` with command, exit code, duration, counts, skips, and a `complete` field.
- **A builder agent writes e2e specs it never ran.** Fix: builders run their own e2e before reporting.
- **How do I brief or supervise another agent that runs tests?** A brief template, a supervisor loop and red flags are included.

## What other testing skills leave out

Based on the review in `agent-testing-skills-critique.md` (reference project, 2026-11-12; it read files of each source, and "not covered" means no hits in the files reviewed). Each source below is useful for what it is built for; `test-gate` is meant to sit next to them, not replace them.

| Source | Covers well | Not covered in the files reviewed |
|---|---|---|
| Playwright Test Agents (planner, generator, healer) | Plan, generate, heal split; traceable plans; fix one error at a time | Time budget or full-run cap; auth and data-isolation guidance; evidence format. The healer prompt allows `test.fixme()` |
| currents `playwright-best-practices` | Activity-to-file routing table; don't/do tables; version-tagged content | Windows, rate limits, time budget, supervision, report format. Examples use `networkidle`, `globalSetup` auth and retries on CI |
| testdino `playwright-skill` | Version tags; trace analysis; guidance on reviewing healer output | Windows, supervision, time budget. Some guides lead with `globalSetup` auth; retries on CI in examples |
| superpowers verification skill | "No completion claims without fresh evidence"; the claim/requires table | Time budget, single-full-run rule, evidence file format, e2e specifics |
| mattpocock `tdd` | Behaviour through public interfaces; tautological-test warning | e2e, DB and flake handling; asks the user to confirm seams, which a non-interactive agent cannot do |
| `playwright-cli` | Browser driving, snapshot refs, small context | Gates, flake policy, reporting; Windows only for URL escaping |
| anthropics `webapp-testing` | Server lifecycle helper; black-box script rule | Test runner, auth, assertions; teaches `networkidle` waits |

Cross-cutting gaps named in the critique: one full run per gate, supervision of other agents, enforceable healer discipline, the Windows Chromium stall, auth rate limits, machine-readable evidence, DB-level tests (see the sibling `pgtap-rls` skill), portability across agents and package managers.

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

Other agents ([Agent Skills](https://agentskills.io) standard):
```
npx skills add AndresDiagoM/agent-testing-skills --skill test-gate
```

## What is in v0.1

`SKILL.md` (14 rules), nine references plus the evidence schema, and an optional kit (`gate.mjs`, `e2e-guard.mjs`) in `skills/test-gate/assets/kit/`. Not yet: kit app templates (ready helper, auth setup), the Stop hook, the kit installer and `e2e-changed` (all v0.2; the references show the recipes as snippets). `references/cypress-jest.md` is documented but not verified against a local repo.

## Tested with

- [ ] Claude Code (evals not yet run)
- [ ] opencode / Codex / other: not tested

Verified against Playwright 1.65.0, Vitest 5.1.0, Next 16.4.6 (reference project lockfile, 2026-11-12); see `references/versions.md`.

## License

Apache-2.0
