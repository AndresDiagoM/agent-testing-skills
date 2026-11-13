# Kit e2e templates (Playwright)

Copy into the repo's e2e folder (`install.mjs` does it, dry-run first). Each file documents its parameters at the top.

| File | Role |
|---|---|
| `goto-ready.ts` | `gotoReady(page, url)` and a `gotoReady` fixture: waits for `html[data-hydrated]` and `html[data-page-ready]` |
| `auth.setup.ts` | `setup` project: one login per role (and per-spec user), saves `storageState` per run id |
| `preflight.ts` | `globalSetup`: build-id check only (needs `../app/health-route.ts` and `build-id.ts`) |
| `playwright.config.snippet.ts` | The config choices to merge: setup + dependent project, `retries: 0`, Windows Chrome and 1 worker, `reuseExistingServer: false` |

App-side templates are in `../app/` (Next App Router only). Other frameworks implement the same two attributes.

Credentials are read from `E2E_<ROLE>_EMAIL` / `E2E_<ROLE>_PASSWORD`; per-spec passwords are generated per run by the
config. Nothing here holds a secret. Git-ignore `e2e/.auth/`.

## Per-spec users need a teardown

`auth.setup.ts` creates them (your `provisionUser` hook). Delete them in a project the setup project names as its
`teardown`, so it also runs when tests fail. Sketch (one file, matched by that project's `testMatch`):

```ts
// e2e/cleanup.teardown.ts
import { test as teardown } from '@playwright/test';
teardown('delete this run\'s e2e users', async () => {
  const run = process.env.E2E_RUN_ID ?? '';
  // delete every address e2e-<spec>-<run>@<domain> of THIS run id, through your backend's admin API
});
```

In `playwright.config.ts`: `{ name: 'setup', ..., teardown: 'cleanup' }` and
`{ name: 'cleanup', testMatch: /cleanup\.teardown\.ts/ }`. A global sign-out (revokes every session of a user) belongs
only in a teardown; specs sign out with local scope.
