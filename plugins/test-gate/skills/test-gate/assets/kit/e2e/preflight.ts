/**
 * preflight.ts: Playwright `globalSetup` that does ONE thing, a build-id check. No login, no cleanup, no data.
 *
 * With E2E_USE_BUILD=1 the suite must test the production build that sits on disk. A server left on the port by an
 * earlier run (or `reuseExistingServer`) can serve an older build. This compares the id the running server reports
 * with the id on disk and stops the run before the first test when they differ. Without E2E_USE_BUILD it does nothing
 * (a dev server has no build id).
 *
 * Parameters (env first, then kit.config.json `e2e`, then the default):
 *   E2E_USE_BUILD       "1" turns the check on (the gate sets it for the e2e step).
 *   E2E_BUILD_ID_FILE   path of the id on disk.   kit.config e2e.buildIdFile   default .next/BUILD_ID
 *                       (an env value is relative to the cwd, a kit.config value to the folder of kit.config.json)
 *   E2E_HEALTH_URL      path the app serves.      kit.config e2e.healthUrl     default /api/health
 *                       It must answer JSON with a string field `buildId` (template: ../app/health-route.ts).
 *   PLAYWRIGHT_BASE_URL / PORT: where the server listens (same rule as the config snippet).
 * kit.config.json is found by walking up from the cwd; E2E_KIT_CONFIG points at another file.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig } from '@playwright/test';

interface KitFile {
  dir: string;
  e2e: { buildIdFile?: string; healthUrl?: string };
}

function readKit(): KitFile {
  let dir = process.cwd();
  const explicit = process.env.E2E_KIT_CONFIG;
  for (;;) {
    const file = explicit ?? path.join(dir, 'kit.config.json');
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { e2e?: KitFile['e2e'] };
      return { dir: path.dirname(path.resolve(file)), e2e: parsed.e2e ?? {} };
    }
    const parent = path.dirname(dir);
    if (explicit || parent === dir) return { dir: process.cwd(), e2e: {} };
    dir = parent;
  }
}

export default async function preflight(config: FullConfig): Promise<void> {
  if (process.env.E2E_USE_BUILD !== '1') return;

  const kit = readKit();
  const baseURL = config.projects[0]?.use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${process.env.PORT || 3200}`;
  const idFile = process.env.E2E_BUILD_ID_FILE
    ? path.resolve(process.cwd(), process.env.E2E_BUILD_ID_FILE)
    : path.resolve(kit.dir, kit.e2e.buildIdFile ?? '.next/BUILD_ID');
  const healthUrl = process.env.E2E_HEALTH_URL || kit.e2e.healthUrl || '/api/health';

  let expected: string;
  try {
    expected = readFileSync(idFile, 'utf8').trim();
  } catch {
    throw new Error(`e2e preflight: ${idFile} not found. Run the build before an E2E_USE_BUILD=1 run. Nothing was tested.`);
  }

  const url = new URL(healthUrl, baseURL).toString();
  let served: unknown;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    served = ((await res.json()) as { buildId?: unknown }).buildId;
  } catch (err) {
    throw new Error(`e2e preflight: GET ${url} failed (${err instanceof Error ? err.message : String(err)}). The server is not serving this build. Nothing was tested.`);
  }

  if (served !== expected) {
    throw new Error(
      `e2e preflight: the server on ${baseURL} serves build "${String(served)}" but ${idFile} says "${expected}". ` +
        'A stale server is running on this port: stop the one YOU started or use another PORT, then re-run. Nothing was tested.',
    );
  }
}
