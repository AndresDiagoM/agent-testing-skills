# E2E authentication: log in once

Read when writing or fixing login, sessions or users in e2e. Origin: reference-project incidents 1, 7 and 10 (2026-11-12). About 70 UI logins in 91 tests hit the local auth limit of 30 sign-ins per 5 minutes and failed at random.

## The recipe (Playwright)

A `setup` project signs in once per role and saves `storageState` to a git-ignored file. Every other project depends on it and reuses the state. (verified against Playwright 1.65.0, 2026-11-12: kit templates type-check and list their tests; the reference project's config uses exactly this.)

Kit templates, copy and adapt (parameters are documented at the top of each file):
- `assets/kit/e2e/auth.setup.ts`: one setup test per role (from `kit.config.json` `e2e.authRoles`, default one role), credentials only from `E2E_<ROLE>_EMAIL` and `E2E_<ROLE>_PASSWORD`, navigation through the ready helper, state saved as `<role>-<runId>.json`.
- `assets/kit/e2e/playwright.config.snippet.ts`: the `setup` project, the dependent project with `use.storageState`, `retries: 0`, one worker on Windows.

```ts
// playwright.config.ts (excerpt)
projects: [
  { name: 'setup', testMatch: /auth\.setup\.ts/, fullyParallel: true },
  { name: 'app', dependencies: ['setup'], use: { storageState: 'e2e/.auth/owner-<runId>.json' } },
],
```

Several roles: one setup test per role, one dependent project per role, each with its own state file.

## Rules

- **Only the auth spec** exercises the real login, logout and redirects.
- **Logged-out tests** use an empty state: `test.use({ storageState: { cookies: [], origins: [] } })`.
- **`globalSetup` is not an auth mechanism here.** It may exist only for the non-browser build-id preflight (`assets/kit/e2e/preflight.ts`), never to log in. This resolves the setup-project versus `globalSetup` split found in third-party skills.
- **Per-spec users:** a spec file that writes data gets its own user, created fresh in the setup project (template: `kit.config.json` `e2e.specUsers` plus the `provisionUser` hook) and deleted in a teardown project (`assets/kit/e2e/README.md` has the sketch). The address carries the run id (`E2E_RUN_ID`, set once per run by the config snippet) so two runs on one backend do not delete each other's users. The password is generated at run time (`E2E_SPEC_PASSWORD`), never written down.
- **Logout is never global inside a spec.** Use local scope (`signOut({ scope: 'local' })` in Supabase terms). A global sign-out revokes the shared session, so it runs only as a teardown after everything else (Playwright runs a teardown even when tests fail).
- **Rate limits:** the cause is fixed first (shared session, setup project). Raising a LOCAL limit (for example Supabase `config.toml` `[auth.rate_limit]`) is only a safety net and carries a comment saying it is local-only. Never batch, sleep or retry around a limit.
- **Secrets:** read credentials from the environment or generate them at run time. A literal value, even an invented one, trips gitleaks and GitGuardian (incident 10). Write fixtures so a scanner finds nothing.
- **Setup is slow? Fix it:** do not move login back into each test. Keep about 45 s for post-login navigation on Windows as margin (the template does).

## Symptoms to recognise

- Logins fail after roughly the 30th test with a "too many requests" message: per-test UI login. Apply the recipe.
- Tests pass alone but fail together: shared data. Give each data-writing spec its own user.
- A test that signs out breaks the next test: global logout in a spec. Switch to local scope.

## Existing suite already logs in per test

Do not rewrite everything at once. Add the setup project, point one project at the saved state, move specs over a file at a time, run each moved file, then run the full suite once.

Cypress equivalent: `cy.session()` (SKILL.md routing table).
