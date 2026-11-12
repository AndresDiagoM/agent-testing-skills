/**
 * playwright.config.snippet.ts: the test-gate recipe as a config you MERGE into the repo's own playwright.config.ts
 * (it also runs on its own, which is how the kit checks it compiles). Copy the pieces, keep these choices:
 *
 *   - `setup` project logs in once per role (auth.setup.ts), `app` depends on it and reuses `storageState`. No globalSetup login.
 *   - `retries: 0` everywhere, CI included. A pass-on-retry is FLAKY, not green. (The `retries` key is deliberately not env-driven.)
 *   - Windows: installed Chrome (`channel: 'chrome'`) and ONE worker; 2+ bundled Chromium stall requests in 10 s steps.
 *   - `reuseExistingServer: false`: never attach to a server you did not start (it may serve a stale build).
 *   - globalSetup = preflight.ts only (build-id check). Waits go through goto-ready.ts.
 *
 * Parameters (env first, then kit.config.json `e2e`, then the default). kit.config.json is found by walking up from
 * the cwd; E2E_KIT_CONFIG points at another file.
 *   PORT                    port of the server this config starts.       kit.config e2e.portStart   default 3200
 *   PLAYWRIGHT_BASE_URL     attach to a server YOU started (no webServer; preflight still checks its build id).
 *   E2E_SERVER_COMMAND      command that starts the app on $PORT.        kit.config e2e.serverCommand
 *                           (default `npm run start -- --port <port>`: replace it with the repo's start script)
 *   E2E_BROWSER_CHANNEL     "chrome" on win32, bundled Chromium elsewhere; "" forces the bundled one, "msedge" Edge.
 *                           kit.config e2e.channelOnWindows overrides the win32 default.
 *   E2E_WORKERS             default 1 on win32, 2 elsewhere.
 *   E2E_RUN_ID              set here once per invocation when absent (3-16 lowercase letters or digits). It goes into the
 *                           state files and the per-spec user addresses, so two runs on one backend do not collide.
 *   E2E_SPEC_PASSWORD       generated here at run time when absent; used only for per-spec users. Never a literal.
 *   E2E_AUTH_DIR            folder of the saved sessions, default e2e/.auth (git-ignore it).
 *   E2E_TEST_DIR            test folder relative to this file, default ./e2e
 * Credentials of the roles are read by auth.setup.ts (E2E_<ROLE>_EMAIL / E2E_<ROLE>_PASSWORD), not here.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

interface KitE2e {
  portStart?: number;
  serverCommand?: string;
  channelOnWindows?: string;
  authRoles?: { name: string; statePath?: string }[];
}

function readKitE2e(): KitE2e {
  let dir = process.cwd();
  const explicit = process.env.E2E_KIT_CONFIG;
  for (;;) {
    const file = explicit ?? path.join(dir, 'kit.config.json');
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { e2e?: KitE2e }).e2e ?? {};
    const parent = path.dirname(dir);
    if (explicit || parent === dir) return {};
    dir = parent;
  }
}
const kit = readKitE2e();

// One id per invocation (or the one you exported), set BEFORE workers fork so every process agrees on it.
process.env.E2E_RUN_ID ||= randomBytes(4).toString('hex');
process.env.E2E_SPEC_PASSWORD ||= randomBytes(18).toString('base64url');
const runId = process.env.E2E_RUN_ID;

// Same formula as auth.setup.ts: <name>-<runId>.json, or the role's statePath with -<runId> before the extension.
const firstRole = kit.authRoles?.[0] ?? { name: 'owner' };
const storageState = path.resolve(
  process.cwd(),
  firstRole.statePath
    ? firstRole.statePath.replace(/(\.json)?$/, `-${runId}.json`)
    : path.join(process.env.E2E_AUTH_DIR || 'e2e/.auth', `${firstRole.name}-${runId}.json`),
);

const isWindows = process.platform === 'win32';
const channel =
  (process.env.E2E_BROWSER_CHANNEL ?? (isWindows ? (kit.channelOnWindows ?? 'chrome') : '')) || undefined;
const desktop = { ...devices['Desktop Chrome'], channel };

const port = Number(process.env.PORT) || kit.portStart || 3200;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: process.env.E2E_TEST_DIR || './e2e',
  globalSetup: './e2e/preflight.ts', // build-id check only; path relative to this file
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS) || (isWindows ? 1 : 2),
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    // Independent logins (one per role / per-spec user) run in parallel. Add `teardown: 'cleanup'` and a cleanup
    // project here when the suite creates per-spec users (see README.md).
    { name: 'setup', testMatch: /auth\.setup\.ts/, fullyParallel: true, use: desktop },
    // Several roles: one more project per role, each with its own storageState file.
    // E2E_REPEAT (set by e2e-changed.mjs) repeats the specs here, never the login in `setup`.
    { name: 'app', dependencies: ['setup'], testIgnore: /auth\.setup\.ts/, repeatEach: Number(process.env.E2E_REPEAT) || 1, use: { ...desktop, storageState } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: process.env.E2E_SERVER_COMMAND || kit.serverCommand || `npm run start -- --port ${port}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
