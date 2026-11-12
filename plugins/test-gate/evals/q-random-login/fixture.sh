#!/usr/bin/env bash
# Playwright project that ALREADY logs in once (setup project + storageState). The suite still fails randomly:
# one spec signs out with the library default (global scope), which revokes the shared session for every other worker.
# The log also shows a rate-limit error (a symptom of the fallback re-login) as a tempting wrong fix.
set -e
mkdir -p e2e/helpers .auth supabase
cat > package.json <<'EOF'
{ "name": "demo-app", "private": true, "scripts": { "test:e2e": "playwright test" }, "devDependencies": { "@playwright/test": "^1.65.0", "@supabase/supabase-js": "^2.50.0" } }
EOF
cat > playwright.config.ts <<'EOF'
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 4,
  retries: 0,
  use: { baseURL: 'http://localhost:3000' },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: { storageState: '.auth/user.json' },
    },
  ],
});
EOF
cat > supabase/config.toml <<'EOF'
[auth.rate_limit]
# sign-ins and sign-ups per 5 minutes per IP
sign_in_sign_ups = 30
token_refresh = 150
EOF
cat > e2e/auth.setup.ts <<'EOF'
import { test as setup, expect } from '@playwright/test';

// Logs in once through the UI and saves the session for every other test.
setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL ?? '');
  await page.getByLabel('Password').fill(process.env.E2E_PASS ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10_000 });
  await page.context().storageState({ path: '.auth/user.json' });
});
EOF
cat > e2e/helpers/login.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

// Fallback used by the fixtures when a page bounces to /login.
export async function loginViaUi(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL ?? '');
  await page.getByLabel('Password').fill(process.env.E2E_PASS ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10_000 });
}
EOF
cat > e2e/helpers/api.ts <<'EOF'
import { createClient } from '@supabase/supabase-js';

// Signs out the session stored in the page's local storage, through the API.
export async function signOutViaApi(accessToken: string, refreshToken: string) {
  const supabase = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_ANON_KEY ?? '');
  await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
  await supabase.auth.signOut();
}
EOF
cat > e2e/fixtures.ts <<'EOF'
import { test as base, expect } from '@playwright/test';
import { loginViaUi } from './helpers/login';

// If a page bounces to /login, sign in again and continue.
export const test = base.extend({
  page: async ({ page }, provide) => {
    page.on('framenavigated', async (frame) => {
      if (frame === page.mainFrame() && frame.url().includes('/login?reason=')) await loginViaUi(page);
    });
    await provide(page);
  },
});
export { expect };
EOF
cat > e2e/account.spec.ts <<'EOF'
import { test, expect } from './fixtures';
import { signOutViaApi } from './helpers/api';

test.describe('account', () => {
  test('shows the profile', async ({ page }) => {
    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  });

  test('the session can be ended through the API', async ({ page }) => {
    await page.goto('/account');
    const raw = await page.evaluate(() => localStorage.getItem('sb-demo-auth-token'));
    const session = JSON.parse(raw ?? '{}');
    await signOutViaApi(session.access_token, session.refresh_token);
    await page.reload();
    await expect(page).toHaveURL(/login/);
  });
});
EOF
for f in 1 2 3 4 5 6; do
  {
    echo "import { test, expect } from './fixtures';"
    echo
    echo "test.describe('feature $f', () => {"
    for t in 1 2 3 4 5 6 7 8 9 10; do
      echo "  test('case $t', async ({ page }) => {"
      echo "    await page.goto('/feature-$f');"
      echo "    await expect(page.getByRole('heading', { name: 'Feature $f' })).toBeVisible();"
      echo "  });"
      echo
    done
    echo "});"
  } > e2e/feature$f.spec.ts
done
{
  echo "Running 63 tests using 4 workers"
  echo "  ok   1 [setup] > auth.setup.ts > authenticate (1.9s)"
  echo "  ok   2 [chromium] > feature1.spec.ts > feature 1 > case 1 (0.9s)"
  echo "  ok   3 [chromium] > account.spec.ts > account > shows the profile (0.8s)"
  echo "  ok   4 [chromium] > feature2.spec.ts > feature 2 > case 1 (0.9s)"
  echo "  ok   5 [chromium] > account.spec.ts > account > the session can be ended through the API (1.4s)"
  echo "  x    6 [chromium] > feature1.spec.ts > feature 1 > case 2 (1.1s)"
  echo "  x    7 [chromium] > feature2.spec.ts > feature 2 > case 2 (1.0s)"
  echo "  ok   8 [chromium] > feature3.spec.ts > feature 3 > case 1 (0.9s)"
  echo "  x    9 [chromium] > feature3.spec.ts > feature 3 > case 2 (1.0s)"
  echo "  ... 40 more, a different subset fails on every run (23 to 41 failures)"
  echo
  echo "  1) feature1.spec.ts > feature 1 > case 2"
  echo "     Error: expect(page).toHaveURL(expected)"
  echo "     Expected pattern: /dashboard/"
  echo "     Received string:  \"http://localhost:3000/login?reason=session_expired\""
  echo "     Server log: 401 POST /auth/v1/token?grant_type=refresh_token  error_code=session_not_found"
  echo
  echo "  2) feature2.spec.ts > feature 2 > case 2"
  echo "     (same as 1)"
  echo
  echo "  3) feature5.spec.ts > feature 5 > case 7"
  echo "     Error: expect(page).toHaveURL(expected)"
  echo "     Received string:  \"http://localhost:3000/login?error=over_request_rate_limit\""
  echo "     Page text: \"Too many sign-in attempts. Rate limit: 30 sign-ins per 5 minutes. Try again later.\""
  echo "     at helpers/login.ts:9"
  echo
  echo "  31 failed, 32 passed (1.1m)"
} > e2e-output.log
