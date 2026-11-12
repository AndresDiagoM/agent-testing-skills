# Why test-gate and pgtap-rls exist

## The incident
On 2026-11-12 a coding agent acting as a quality gate spent **1 h 41 min** on an end-to-end suite whose tests take about **2 minutes**. Every test signed in through the UI (~70 sign-ins), the local Supabase auth limit is 30 sign-ins per 5 minutes, and the agent split the suite into five batches with `sleep 320` between them, re-running the full suite after each fix. After fixing the cause (sign in once with a Playwright setup project and `storageState`), the full suite ran in 117 s with ~15 sign-ins.

Nine more incidents from the same day (tests clicking before hydration, specs that were never run, stale servers, Windows browser stalls, test doubles drifting from the real database, a fake secret flagged by scanners) shaped the rules in these skills.

## What we looked at
Before writing these skills we read ten testing skills and guides that agents use today (snapshot of 2026-11-12; each project may have changed since):

| Source | What it does well | What it does not cover (for our problems) |
|---|---|---|
| Playwright Test Agents (planner / generator / healer) | Plan → generate → heal split; traceability from test to plan; seed tests for setup | The healer's prompt asks it to make the test pass and allows `test.fixme()`; no time budget, auth reuse, data isolation or evidence format |
| currents-dev playwright-best-practices | Activity-to-file routing, Do/Don't tables, version tags | Lists `networkidle` as an option in one file; auth examples lead with `globalSetup`; examples use `retries: CI ? 2 : 0`; no Windows, rate-limit, budget or supervision guidance |
| testdino playwright-skill | Treats healer output as a code review; version tags; `--shuffle` | ~2 MB of guides that the skill asks to open even for familiar APIs; auth guide leads with `globalSetup`; retries `CI ? 2 : 0` |
| obra/superpowers (TDD, verification) | "No completion claims without fresh verification evidence" | Unit tests only; no evidence file format, time budget or single-run rule |
| mattpocock/skills tdd | Behaviour through public interfaces; avoids tautological tests | No browser, database or gate guidance |
| microsoft/playwright-cli | Small context, attach-and-record flow | A browser driver, not a test-quality policy |
| anthropics/skills webapp-testing | Black-box scripts, server lifecycle helper | Recommends waiting for `networkidle`; Python only; no auth or assertions |
| Supabase RLS / pgTAP docs and agent skills | Rolled-back tests, "add a temporary `using (true)` policy to check a test" | No pgTAP skill exists; no anon or service_role examples; silent UPDATE/DELETE denials not covered |
| antfu/skills vitest | Small index + one file per topic | API cheat-sheet; no gate or flake policy |
| wshobson e2e-testing-patterns | Testing pyramid, short | Generic; retries in examples; no auth reuse, hydration, isolation or budget |

## The eight gaps these skills fill
1. **One full run per gate** with a time cap per step (test-gate).
2. **Supervision of other agents:** stop on sleeps, batches and repeated full runs; the reviewer re-runs the gates (test-gate).
3. **Fixer discipline as a check, not advice:** no retries, `fixme`, `skip`, broader locators or longer timeouts; a skip needs approval and appears in the evidence (test-gate, `e2e-guard`).
4. **Windows:** two or more Playwright-bundled Chromium processes stall in 10 s steps; use the installed Chrome (test-gate).
5. **Auth rate limits:** sign in once, per-spec users, fix the cause (test-gate).
6. **Machine-readable evidence:** `.gate/last.json` with command, exit code, duration, counts and failing tests (test-gate, shared with pgtap-rls).
7. **Database tests and doubles parity:** allow and deny per role, silent denials, mutation check, functions and grants (pgtap-rls).
8. **Portability:** plain SKILL.md for Claude Code, Codex, opencode and Antigravity; commands read from `package.json` instead of hard-coded `npm`/`npx` (both).

## Design choices
- `SKILL.md` under 5 KB with the always-on rules; topic references load only when needed.
- One recipe per topic, so the skill never contradicts itself.
- Every version-dependent tip says which version it was checked against.
- No secrets in examples, not even fake ones, and no destructive commands.
- Repo rules win: the `OVERRIDES.md` pattern lets a repo correct a third-party skill without forking it.

Source of the comparison: an internal review of each project's files on 2026-11-12, with file and line references, kept in the author's project notes.
