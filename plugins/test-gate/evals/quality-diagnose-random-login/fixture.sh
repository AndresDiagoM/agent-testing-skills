#!/usr/bin/env bash
# Builds a tiny Playwright project whose tests all log in through the UI (70 logins), plus the log of a failing run.
set -e
mkdir -p e2e/helpers
cat > package.json <<'EOF'
{ "name": "demo-app", "private": true, "scripts": { "test:e2e": "playwright test" }, "devDependencies": { "@playwright/test": "^1.65.0" } }
EOF
cat > playwright.config.ts <<'EOF'
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 4,
  retries: 0,
  use: { baseURL: 'http://localhost:3000' },
});
EOF
cat > e2e/helpers/login.ts <<'EOF'
import { expect, type Page } from '@playwright/test';

// Signs in through the login form. Credentials come from the environment.
export async function loginViaUi(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(process.env.E2E_EMAIL ?? '');
  await page.getByLabel('Password').fill(process.env.E2E_PASS ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/dashboard/, { timeout: 10_000 });
}
EOF
for f in 1 2 3 4 5 6 7; do
  {
    echo "import { test, expect } from '@playwright/test';"
    echo "import { loginViaUi } from './helpers/login';"
    echo
    echo "test.describe('feature $f', () => {"
    echo "  test.beforeEach(async ({ page }) => {"
    echo "    await loginViaUi(page);"
    echo "  });"
    for t in 1 2 3 4 5 6 7 8 9 10; do
      echo
      echo "  test('case $t', async ({ page }) => {"
      echo "    await page.goto('/feature-$f');"
      echo "    await expect(page.getByRole('heading', { name: 'Feature $f' })).toBeVisible();"
      echo "  });"
    done
    echo "});"
  } > e2e/feature$f.spec.ts
done
{
  echo "Running 70 tests using 4 workers"
  n=0
  for f in 1 2 3 4 5 6 7; do for t in 1 2 3 4 5 6 7 8 9 10; do
    n=$((n+1))
    if [ $n -le 30 ]; then
      echo "  ok  $n [chromium] > feature$f.spec.ts > feature $f > case $t (1.1s)"
    else
      echo "  x   $n [chromium] > feature$f.spec.ts > feature $f > case $t (10.2s)"
    fi
  done; done
  echo
  echo "  1) feature4.spec.ts > feature 4 > case 1"
  echo "     Error: expect(page).toHaveURL(expected)"
  echo "     Expected pattern: /dashboard/"
  echo "     Received string:  \"http://localhost:3000/login?error=over_request_rate_limit\""
  echo "     Page text: \"Too many sign-in attempts. Rate limit: 30 sign-ins per 5 minutes. Try again later.\""
  echo "     at helpers/login.ts:10"
  echo
  echo "  40 failed, 30 passed (2.4m)"
} > e2e-output.log
