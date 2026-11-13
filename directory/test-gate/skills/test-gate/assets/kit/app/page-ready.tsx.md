# Template: `page-ready.tsx`

Code template shipped as Markdown in the directory edition (full edition: `assets/kit/app/page-ready.tsx`).
Copy the code below into the user's repository as `page-ready.tsx` and adapt it as the references say.
The plugin never runs it.

```tsx
'use client';

/**
 * page-ready.tsx (Next.js App Router template).
 * Do not render it by hand: wrap each route's default export with `withPageReady` (with-page-ready.tsx).
 *
 * Sets `data-page-ready="<pathname>"` on <html> once the page it is rendered in has hydrated and its effects have run.
 * Rendered LAST in the page content, so the effects of the page's own components (shortcuts, listeners) ran before
 * it; it then waits one extra commit so state those effects queued is committed before the signal appears.
 * The path travels with it, so a redirect makes the test wait for the page it landed on.
 *
 * Guarantee: the page's own component tree hydrated and its effects ran. NOT covered: lazily loaded islands
 * (next/dynamic, widgets that load a script): wait for their own element in the spec. The attribute is removed when
 * the page unmounts, so a client-side navigation shows no stale value. Contract with e2e/goto-ready.ts
 * (E2E_PAGE_READY_ATTR); rename both sides together.
 */
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

export function PageReady() {
  const pathname = usePathname();
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    // The second commit, queued outside the effect body on purpose (see above).
    queueMicrotask(() => setSettled(true));
  }, []);

  useEffect(() => {
    if (!settled) return;
    const root = document.documentElement;
    root.dataset.pageReady = pathname;
    return () => {
      if (root.dataset.pageReady === pathname) delete root.dataset.pageReady;
    };
  }, [settled, pathname]);

  return null;
}
```
