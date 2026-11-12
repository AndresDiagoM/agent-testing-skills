---
type: llm
focus:
  source: file
  path: e2e/reports.spec.ts
---

The file is the spec after the agent's fix. The original had three assertions (export-status text Done, Download link visible, export-count text 12 rows) and navigated with a plain page.goto. The root cause: the Suspense fallback renders an inert duplicate Export button until the page body hydrates, so an early click either hits two elements or the skeleton.

PASS if the spec now navigates through the project's ready helper (gotoReady from e2e/fixtures, which waits for hydration and the page-ready marker, so the skeleton is gone), still has all three assertions with the same expected values, and has no retries, sleeps, networkidle, toPass, first()/nth()/last(), force, skip or fixme.
FAIL if it disambiguates with first()/nth()/filter on the skeleton, forces the click, waits by time or network, or any assertion was removed or weakened.
