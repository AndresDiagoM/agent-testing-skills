# Cypress and Jest equivalents

NOT VERIFIED AGAINST A LOCAL REPO. No project we checked uses Cypress. Jest appears only in one backend (Jest 29.7.0 in a lockfile, 2026-11-12). Cypress statements come from official docs and must be checked against a real install before you rely on them. Where this file and the repo disagree, the repo wins.

## Cypress

- **Login once:** use `cy.session(id, setup)` so the login runs once per role and the session is cached and restored for each test. Only the auth spec drives the real login UI. Use `cacheAcrossSpecs` only if the installed version documents it.
- **Retries:** keep Cypress `retries` at 0 (its default in run mode is 0). A pass on retry is flaky and not a clean pass.
- **No `cy.wait(<ms>)`.** Wait on an aliased request with `cy.intercept` + `cy.wait('@alias')`, or on an element the result renders.
- **Hydration:** same two-signal idea as in the waiting recipe: assert the ready attribute on the root element before interacting.
- **Banned moves:** same list as for Playwright: broader selectors, removed assertions, `it.skip`, longer timeouts.
- **Windows:** the bundled-Chromium stall was measured with Playwright only. Do not assume it applies to Cypress; measure first.
- **Counts for evidence:** use Cypress's JSON or JUnit reporter output with an output file; map passed, failed and pending (pending = skipped) into the evidence counts.

## Jest

- **Parallelism:** `--runInBand` for one process, `--maxWorkers=<n>` to cap workers. Prefer the cap that keeps the suite stable; do not shard with pauses.
- **Counts:** `--json --outputFile=<path>` gives passed, failed, pending (skipped) and todo; parse that file instead of scraping the console.
- **Zero tests:** Jest can be told to pass when no tests match (a pass-with-no-tests option). The gate still treats zero passed tests as a failure, whatever the exit code.
- **Skips:** `it.skip`, `xit` and `it.todo` follow the skip protocol: approval, issue, re-check date, evidence entry.
- **Timers:** fake timers are fine in unit tests; do not use real sleeps to "wait for" something.

## Evidence

Both frameworks write the same evidence step as everyone else: `kind` unit or e2e, exact command, exit code, wall time, `counts.passed/failed/skipped`.

(not verified against a local repo; Jest 29.7.0 read from a lockfile, see the versions file in SKILL.md's table)
