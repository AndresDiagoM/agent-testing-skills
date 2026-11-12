#!/usr/bin/env bash
# Builds a small Playwright project with a ready helper and a spec that clicks before hydration.
set -e
mkdir -p e2e docs
cat > package.json <<'EOF'
{ "name": "demo-app", "private": true, "scripts": { "test:e2e": "playwright test" }, "devDependencies": { "@playwright/test": "^1.65.0" } }
EOF
cat > playwright.config.ts <<'EOF'
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  retries: 0,
  workers: 1,
  use: { baseURL: 'http://localhost:3200' },
});
EOF
cat > docs/testing.md <<'EOF'
# Testing notes

The app sets two attributes on <html>:
- data-hydrated="true" once React hydrated the root;
- data-page-ready="<pathname>" once the page body hydrated and its effects ran.

e2e tests navigate with `gotoReady` from e2e/fixtures.ts, which waits for both.
EOF
cat > e2e/fixtures.ts <<'EOF'
import { test as base, expect, type Page } from '@playwright/test';

export async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await page.locator('html[data-hydrated="true"]').waitFor({ state: 'attached', timeout: 45_000 });
  await page.waitForFunction(
    () => document.documentElement.dataset.pageReady === window.location.pathname,
    undefined,
    { timeout: 45_000 },
  );
}

export const test = base.extend<{ gotoReady: (url: string) => Promise<void> }>({
  gotoReady: async ({ page }, provide) => {
    await provide((url) => gotoReady(page, url));
  },
});

export { expect };
EOF
cat > e2e/reports.spec.ts <<'EOF'
import { test, expect } from '@playwright/test';

test.describe('reports', () => {
  test('exports the current report', async ({ page }) => {
    await page.goto('/reports');
    await page.getByRole('button', { name: 'Export' }).click();
    await expect(page.getByTestId('export-status')).toHaveText('Done');
    await expect(page.getByRole('link', { name: 'Download' })).toBeVisible();
    await expect(page.getByTestId('export-count')).toHaveText('12 rows');
  });
});
EOF
