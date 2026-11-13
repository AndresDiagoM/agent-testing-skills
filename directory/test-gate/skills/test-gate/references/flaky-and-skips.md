# Flaky tests, red tests and skips

Read when a test is flaky, red, or about to be skipped. Origin: the critique of Playwright's healer and of third-party skills (agent-testing-skills-critique.md, sections 1-3) and reference-project incident 4.

Why this exists: an agent told to "make the test pass" will take the cheapest path: retry, widen the locator, drop the assertion, mark it `fixme`. The run goes green and coverage disappears. A skip is a defensible outcome of healing and never a merge-ready one.

## Diagnose in this order

1. Read the failure message and the trace of that one test.
2. Run only that file, repeated and shuffled, to see whether it is order- or timing-dependent. (Playwright's `--repeat-each` and `--shuffle`; check the installed version's `--help`, not re-verified against the versions table.) If the repo restricts `--repeat-each` (the reference project does, because it would also repeat the setup project), use its wrapper.
3. Hydration: was the click before the ready signal? Use the waiting recipe.
4. Shared data: does another spec write what this one reads? Per-spec users.
5. Server and build: stale build on the port, or the wrong server? Windows with 2+ bundled Chromium?
6. Only then consider the app: the test may have found a real bug. Report it; do not bury it.

## Retries

The setting stays at 0 everywhere, CI included. A test that passes on retry is reported as FLAKY and never counts as a clean pass; the gate is then not complete. (the reference project's config has one CI retry today; that is the repo's own choice and the evidence still marks it flaky.)

## Banned moves (the enforceable list)

- retries above 0
- broader locators (a regex or `.first()` that makes the match easier)
- removed or negated assertions, weaker expected values
- `test.skip`, `test.fixme`, `test.slow` used to get past a failure
- longer timeouts to hide a race
- `networkidle`, `waitForTimeout`, `toPass` for UI state
- `.first()` to escape strict mode

## Subtractive-diff check

Before reporting, diff the spec. If assertions or steps decreased, that is a weakening: justify it to the supervisor or restore it. "The assertion was wrong" is allowed only with the evidence that shows why.

## Skip protocol

A skip is allowed only when all of these exist:

1. **Approval** from the user, or from the orchestrator quoting a standing user instruction. The agent that writes the skip can never approve it.
2. **A linked issue.**
3. **A re-check date.**

The skip goes in the evidence file (`approvedSkips[]`, with `approvedBy`, `approvalRef`, `issue`, `recheckBy`) and in the first lines of the final report. A skipped test without approval makes the gate incomplete. A runtime-conditional skip (`test.skip(cond, ...)`) is a silent hole: it must still show up in the skipped count.

## Test the test

A test that cannot fail is not a test. Expected values come from an independent source (a fixture, a spec, a recorded API response), not from the code under test. When fixing a test, make it fail on purpose once (revert the fix or change the expected value) to confirm it still detects the bug.

## Enforcing it: the guard (kit, optional)

`scripts/e2e-guard.mjs` compares every changed test file (unit and e2e) with the merge-base of HEAD and the default branch.

- **Blocks (exit 1):** fewer assertions or `test()` blocks, deleted or excluded test files, `skip`/`fixme`/`only`, larger or new timeouts, new `retries`, `waitForTimeout`/`networkidle`/`toPass`, `expect(...).catch`, tautologies such as `expect(true).toBe(true)`, secret-looking literals.
- **Reviews (listed, never block):** `.first()`, CSS locators replacing role or test-id locators, looser matchers, assertions inside an `if`.
- **Approval:** only a comment ADDED by the same change, on the line or just above it: `// test-guard: approved <reason>` (`--` in SQL). Removed assertions or tests: `// test-guard: approved-removal <n> <reason>` inside the change or within 3 lines of it, with n at least the number removed. Old or distant comments never count. The comment is the request: the user or orchestrator still decides (rule 9), so name who approved in the reason.
- **Deleted test files** cannot carry a comment: they are approved only in `kit.config.json` `guard.approvedDeletions`, an edit the user approves.
- **Legacy repos:** `--all` scans every file, and a ratchet baseline (`e2e-guard.baseline.json`) lets existing violations stand while the count may only go down. There is no approvals file.

No guard in the repo? Read the diff of the spec and apply the same list by hand.
