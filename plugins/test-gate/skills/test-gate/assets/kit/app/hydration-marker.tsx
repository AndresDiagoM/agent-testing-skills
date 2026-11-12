'use client';

/**
 * hydration-marker.tsx (Next.js App Router template).
 * Mount once in the root layout, inside <body>:  <HydrationMarker />
 *
 * Sets `data-hydrated="true"` on <html> once React has hydrated the ROOT. It changes nothing visually and runs in an
 * effect, so it cannot cause a hydration mismatch. The e2e helper (e2e/goto-ready.ts) waits for it.
 *
 * Guarantee: ONLY the root hydrated. A page body inside a Suspense boundary (loading.tsx, streaming) can still be
 * unhydrated, so a click at this point may be lost: render <PageReady /> too (page-ready.tsx). The attribute name is
 * the contract with goto-ready.ts (E2E_HYDRATED_ATTR); rename both sides together.
 */
import { useEffect } from 'react';

export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
