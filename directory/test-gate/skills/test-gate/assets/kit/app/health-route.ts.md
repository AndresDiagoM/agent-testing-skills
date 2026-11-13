# Template: `health-route.ts`

Code template shipped as Markdown in the directory edition (full edition: `assets/kit/app/health-route.ts`).
Copy the code below into the user's repository as `health-route.ts` and adapt it as the references say.
The plugin never runs it.

```ts
/**
 * health-route.ts (Next.js App Router template, optional). Install as app/api/health/route.ts and adjust the import.
 *
 * Public liveness and build-identity probe for e2e/preflight.ts (E2E_HEALTH_URL, default /api/health). It returns no
 * secrets and touches no database. If the app has an auth proxy/middleware, exclude exactly this path from it.
 * Needs build-id.ts and the instrumentation call described there; without it the id is read when this module first
 * loads, which can be after a rebuild, so the stale-server check would be weaker.
 */
import { NextResponse } from 'next/server';
import { captureBuildIdAtStart } from './build-id';

export const dynamic = 'force-dynamic';

const BUILD_ID = captureBuildIdAtStart();

export function GET(): NextResponse {
  return NextResponse.json({ ok: true, buildId: BUILD_ID }, { headers: { 'Cache-Control': 'no-store' } });
}
```
