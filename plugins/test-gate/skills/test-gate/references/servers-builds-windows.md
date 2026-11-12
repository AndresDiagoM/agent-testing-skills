# Servers, builds, ports and Windows

Read when starting a server, running e2e against a build, running concurrent runs, or working on Windows or WSL. Origin: reference-project incidents 8 and 9 (2026-11-12).

## Free port, one server you own

- Pick a free port yourself (for example `PORT=3200`, next free if taken) and pass it to both server and test runner.
- Never rely on `reuseExistingServer` against a server you did not start: Playwright can silently reuse a stale build left by an earlier run. Set it to false (`playwright.config.snippet.ts` does). To test a server you started yourself, attach with `PLAYWRIGHT_BASE_URL` and let the preflight verify its build id.
- Two runs at once need distinct ports and distinct run ids (an `E2E_RUN_ID` style variable used for users and state files).

## Verify the build you are testing

- The app exposes its build id (reference project: `GET /api/health` returns the id the server captured at start).
- Before the first test the runner compares it with the build id on disk (Next: `.next/BUILD_ID`). Mismatch: stop with a clear message, nothing is tested.
- A build older than its sources is stale: rebuild, or fail. Do not test it.
- Record `build.id`, `builtAt` and `servedId` in the evidence for e2e steps. `id` different from `servedId` makes the e2e invalid.
- For direct `playwright test` runs the check is `assets/kit/e2e/preflight.ts`, set as `globalSetup`: build-id check only, never auth or cleanup. It is active when `E2E_USE_BUILD=1`; the build id file and health path come from `kit.config.json` `e2e.buildIdFile` and `e2e.healthUrl` (or `E2E_BUILD_ID_FILE`, `E2E_HEALTH_URL`).
- App side: `assets/kit/app/health-route.ts` serves `{ ok, buildId }` (no secrets, no database), and `build-id.ts` captures the id once at process start from the instrumentation hook. Capturing at start matters: a server that keeps running while a rebuild rewrites `.next/BUILD_ID` must keep reporting the build it loaded, or the check passes against a stale server.

## Process ownership

- Kill only the process tree you started: `taskkill /T /PID <pid>` on Windows, the process group elsewhere. The pid comes from your own `.gate/running.json` or your spawn call.
- Never kill by port number or by process name: that can end another agent's server or the user's work.
- A port busy with something you did not start: stop and ask, or pick another port.

## Windows: use the installed Chrome

(verified against Playwright 1.65.0, 2026-11-12, measured in the reference project.) On Windows, 2 or more Playwright-bundled Chromium processes at once stall requests in 10 s steps against any server (`next start`, even a plain static server). One browser with several contexts is fine, and so is the installed Chrome.

- Looks like: logins or navigations that time out at 10 or 20 s with no error, mostly when e2e runs in parallel. It was first misdiagnosed as the app server serving static chunks.
- Fix: set `use.channel: 'chrome'` on `win32`, overridable by an environment variable (reference project: `E2E_BROWSER_CHANNEL`), and use one worker. Measured: 3 workers gained nothing (same tests, 2.0 min with 1 worker versus 2.1 to 2.5 min with 3).
- Keep about 45 s for post-login navigation as margin.
- Never weaken assertions or add retries for it.

Template: `assets/kit/e2e/playwright.config.snippet.ts` implements it:

```ts
const channel = (process.env.E2E_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'chrome' : '')) || undefined;
// workers: Number(process.env.E2E_WORKERS) || (win32 ? 1 : 2); retries: 0; reuseExistingServer: false
```

The port comes from `PORT` (or `kit.config.json` `e2e.portStart`, default 3200) and the start command from `E2E_SERVER_COMMAND` (or `e2e.serverCommand`): set it to the repo's own start script.

## WSL and Linux

Run everything inside WSL for a WSL project (Node from the project's `.nvmrc`), not through the Windows side, and never edit files on a `\wsl.localhost` path with Git Bash or sed. The bundled Chromium on Linux is fine: the Windows channel rule does not apply.

## Local databases and shared state

A local database stack (for example Supabase) is shared state. Agents do not start, stop or reset it unless the user said so. E2E never wipes volumes or resets schemas; schema changes go through the repo's migrations, with permission.

## Stalls to rule out before blaming the test

Port taken by a stale server, stale build served, 2+ bundled Chromium on Windows, an auth limit hit by per-test logins. Fix the cause. Do not sleep, batch or retry.
