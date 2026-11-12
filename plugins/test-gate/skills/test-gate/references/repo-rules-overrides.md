# Repo rules, overrides and third-party testing skills

Read when the repo has its own testing rules, or a third-party testing skill (for example `playwright-best-practices`) is installed. Derived from the reference project's `.claude/skills/playwright-best-practices/OVERRIDES.md` (source skill: currents.dev, MIT, commit 0b75b58).

## Precedence

Repo rules (`AGENTS.md`, `CLAUDE.md`, `.claude/rules/*`) beat `test-gate`, which beats third-party skills.

## Division of labour

- `test-gate` owns: the gate, evidence, supervision, auth, waits, flake and skip policy, servers and builds.
- A locator and assertion skill owns: locators, web-first assertions, POM versus fixtures, accessibility, visual regression, API tests, mocks.
- `test-gate` does not teach locators, page objects or accessibility. When both load and conflict, the override block below decides.

## The OVERRIDES.md pattern

Keep third-party files untouched, so upstream updates diff cleanly:

1. Put `OVERRIDES.md` next to the third-party skill.
2. Add one banner line at the top of that skill's `SKILL.md`: "read OVERRIDES.md first; repo rules win".
3. Sections of `OVERRIDES.md`:
   - provenance: source, license, commit, install date, reviewed for scripts and hooks;
   - overridden by repo rules, grouped by topic, each citing the section it overrides;
   - still valid;
   - scope: which reference files matter for this stack.

## Paste-ready override block

Adapt the angle brackets to the repo.

```
## Overridden by repo rules (test-gate)
- Login: no globalSetup login and no login in each test. A `setup` project with
  `dependencies: ['setup']` and one storageState per role. Only the auth spec uses the UI.
  No per-worker auth: each spec that writes data uses its own user, created in setup.
  Logged-out test: test.use({ storageState: { cookies: [], origins: [] } }).
- Waits: never networkidle or waitForTimeout. Navigate with <ready helper> (waits for
  html[data-hydrated] and html[data-page-ready]). toPass only polls server state.
- Retries: ignore "retries on CI", retry-based quarantine and conditional skips on CI.
  A flaky test is fixed, not hidden or retried. Retries stay at 0.
- Parallelism: ignore undefined workers and extra browser projects. On Windows use
  channel 'chrome' and 1 worker.
- Server: ignore reuseExistingServer-by-default and the dev server. Free port, production
  build, build id verified against the build on disk.
- Package manager: every npm / npx in that skill means <the repo's manager and its exec>.
- Runs: one full suite per gate; on failure re-run only the failing file, then one final
  full run. No batches with pauses. Repeat-each only through <repo wrapper>.
- Selectors: test ids from one shared module; search inside `main`; no .first() to dodge
  duplicated streaming DOM.
- Logout: local scope inside specs; global logout only in a teardown.
- Data and database: no schema resets or volume wipes from e2e; schema changes only through
  the repo's migrations, with permission.
- Secrets: no literal passwords or tokens in tests, not even invented ones. Generate at
  run time or read from the environment.
- Dependencies: no CDN scripts, no new dependencies without noting them in the spec.

## Still valid
Role or label locators, web-first assertions, POM versus fixtures criteria, data isolation,
trace for diagnosis only, accessibility, visual regression, API tests, third-party mocks.
```

## Enforcement

An override that only lives in prose gets ignored under pressure. With the kit installed, `scripts/e2e-guard.mjs` turns the retries, skip, timeout and wait overrides into a check on the diff. Its exceptions are inline (`// test-guard: approved <reason>`, added in the same change) and listed in the guard section of the flaky reference. Shared helpers that hold assertions are added to `kit.config.json` `guard.extraTestFiles`; a repo's own rules file stays the place that says who may approve.

## When there is no override file

Write the rule in the repo's `AGENTS.md` (short) and the reasons in a rules file. The `AGENTS.md` lines stay short; the incident table that motivated each rule lives in the longer file.
