# E2E waiting: signals, not time

Read when writing specs or when a spec fails intermittently. Origin: reference-project incidents 4 and 5 (2026-11-12): clicks before React hydrated, "fixed" by agents with retries and `networkidle`; and the duplicated DOM left by Next streaming.

## The recipe: two ready signals and one helper

The app exposes two attributes on `<html>`:

- `data-hydrated="true"`: React hydrated the ROOT only.
- `data-page-ready="<pathname>"`: the page body (inside its Suspense boundary) hydrated and its effects ran. It carries the path so a redirect waits for the page it landed on.

Tests navigate through one helper that waits for both. Generous timeout (45 s, `E2E_READY_TIMEOUT_MS`): it only costs time when something is wrong, and Windows needs the margin. (verified against Playwright 1.65.0 and Next 16.4.6, 2026-11-12: the kit templates type-check in a copy of the reference project, whose own `gotoReady` they derive from.)

Kit templates (parameters documented at the top of each file):
- `assets/kit/e2e/goto-ready.ts`: `gotoReady(page, url)` plus a `gotoReady` fixture. Throws a message naming the missing marker when the page never signals.
- `assets/kit/app/hydration-marker.tsx`: client component in the root layout, sets `data-hydrated` in an effect.
- `assets/kit/app/page-ready.tsx` and `with-page-ready.tsx`: wrap each route's default export with `withPageReady(...)`; sets `data-page-ready` to the pathname after a second commit and removes it on unmount, so client navigation shows no stale value.

Other frameworks: implement the same two attributes (root effect; last child of each page, set after a second commit) and keep the names in sync with `E2E_HYDRATED_ATTR` and `E2E_PAGE_READY_ATTR`.

## Banned (each one hides a real problem)

- `waitForLoadState('networkidle')`
- `waitForTimeout(...)` and any fixed sleep
- `toPass` to retry a UI click or assertion. It may only poll server state (a row exists, an API reports done).
- `.first()` to escape a strict-mode error.

Third-party skills teach some of these as normal; this file overrides them (SKILL.md routing table).

## No hydration marker available

Third-party app, or the repo will not take the app change: degraded mode. Wait with web-first assertions for a user-visible element that renders only after hydration, then interact. Write the degradation in the PR text. Never wait on time.

## Locators and strict mode

- Scope locators to `main`. Next streaming leaves a hidden copy of Suspense content in the DOM, which causes strict-mode "2 elements" errors. Scope to `main`; do not use `.first()` to dodge it.
- Share test ids from one module so a rename breaks typecheck instead of a spec.
- Lazy islands (`next/dynamic`, widgets that load a script) are not covered by the markers: wait for their own element.

## Debounce and async UI

Wait for the request or response, or for the element the result renders. Not a fixed delay. A search box with a debounce is the usual place a `waitForTimeout` creeps in: replace it with a wait on the results list or the network response.

## Intermittent failure checklist

1. Was the interaction before the ready signal? Use the helper.
2. Is the locator matching a hidden streaming copy? Scope to `main`.
3. Does another spec write the same data? Give each data-writing spec its own user.
4. Is it Windows with 2+ bundled Chromium (use `channel: 'chrome'`, one worker), or a stale build on the port?
5. Only then read the trace. Never add a retry.
