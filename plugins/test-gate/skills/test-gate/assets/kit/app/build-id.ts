/**
 * build-id.ts (Next.js template, server only; optional, pairs with health-route.ts).
 *
 * The id of the build THIS process serves, captured once and never re-read. A server that keeps running while a
 * rebuild rewrites `.next/BUILD_ID` must keep reporting the build it actually loaded; otherwise the e2e preflight
 * (GET health vs the id on disk) would pass against a stale server. Call `captureBuildIdAtStart()` from the
 * instrumentation hook, which runs at process start:
 *
 *   // instrumentation.ts (project root, or src/)
 *   export async function register() {
 *     if (process.env.NEXT_RUNTIME === 'nodejs') (await import('./app/build-id')).captureBuildIdAtStart();
 *   }
 *
 * Adjust the import path. Stored on globalThis because the instrumentation hook and the route bundle are separate
 * module instances. `next dev` has no BUILD_ID file: the id is null and the preflight is off (E2E_USE_BUILD unset).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = Symbol.for('kit.buildIdAtStart');
type Holder = { [KEY]?: { value: string | null } };

function readBuildId(): string | null {
  try {
    return readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Reads and remembers the build id. Idempotent: the first call wins. */
export function captureBuildIdAtStart(): string | null {
  const holder = globalThis as Holder;
  holder[KEY] ??= { value: readBuildId() };
  return holder[KEY].value;
}
