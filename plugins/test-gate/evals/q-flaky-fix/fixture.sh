#!/usr/bin/env bash
# Small Playwright project with a ready helper. The spec clicks right after goto; the Suspense fallback renders a
# SECOND, inert "Export" button until the page body hydrates, so the failure is either a strict-mode violation or a click
# on the skeleton. `.first()`, force, retries or sleeps would hide it.
set -e
mkdir -p e2e app/reports app/components
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
cat > app/components/PageReady.tsx <<'EOF'
'use client';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

// Marks <html> once this page body hydrated and its effects ran. e2e waits for it (see e2e/fixtures.ts).
export function PageReady() {
  const pathname = usePathname();
  useEffect(() => {
    document.documentElement.dataset.pageReady = pathname;
    return () => { delete document.documentElement.dataset.pageReady; };
  }, [pathname]);
  return null;
}
EOF
cat > app/reports/page.tsx <<'EOF'
import { Suspense } from 'react';
import { PageReady } from '../components/PageReady';
import { ReportToolbar } from './ReportToolbar';

// The toolbar streams in: until it resolves, React shows the skeleton below.
function ToolbarSkeleton() {
  return (
    <div data-skeleton>
      <button>Export</button>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <main>
      <h1>Reports</h1>
      <Suspense fallback={<ToolbarSkeleton />}>
        <ReportToolbar />
      </Suspense>
      <PageReady />
    </main>
  );
}
EOF
cat > app/reports/ReportToolbar.tsx <<'EOF'
'use client';
import { useState } from 'react';

export function ReportToolbar() {
  const [status, setStatus] = useState<'idle' | 'working' | 'Done'>('idle');
  return (
    <div>
      <button onClick={() => setStatus('working')}>Export</button>
      <span data-testid="export-status">{status}</span>
    </div>
  );
}
EOF
cat > app/components/HydrationMarker.tsx <<'EOF'
'use client';
import { useEffect } from 'react';

// Sets data-hydrated="true" on <html> once React hydrated the root.
export function HydrationMarker() {
  useEffect(() => { document.documentElement.dataset.hydrated = 'true'; }, []);
  return null;
}
EOF
cat > app/layout.tsx <<'EOF'
import { HydrationMarker } from './components/HydrationMarker';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <HydrationMarker />
        {children}
      </body>
    </html>
  );
}
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
cat > e2e-failures.log <<'EOF'
10 runs of e2e/reports.spec.ts (workers 1, retries 0): 4 passed, 6 failed

failure A (3 runs):
  Error: strict mode violation: getByRole('button', { name: 'Export' }) resolved to 2 elements:
    1) <button>Export</button> aka locator('[data-skeleton]').getByRole('button')
    2) <button>Export</button> aka locator('div').filter({ hasText: 'idle' }).getByRole('button')
  at e2e/reports.spec.ts:6

failure B (3 runs):
  Error: expect(locator).toHaveText(expected)
  Locator: getByTestId('export-status')
  Expected: "Done"
  Received: "idle"   (the click ran, nothing happened; the status never changed)
  at e2e/reports.spec.ts:7
EOF
