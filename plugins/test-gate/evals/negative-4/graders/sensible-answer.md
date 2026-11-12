---
type: llm
---

PASS if the answer explains React hydration (server HTML, then client attach) and gives a sensible outline for a Vercel deploy workflow. A deploy workflow may legitimately mention CI checks, lint, unit tests or e2e on a preview URL as part of the pipeline; that is not a failure.
FAIL if it answers with the test-gate skill's own rules instead of explaining hydration and deployment: a `.gate/last.json` evidence file, "login once" with storageState, `gotoReady` or hydration-marker waiting helpers for Playwright, supervising gate agents with time caps. Also FAIL if it does not engage with one of the two questions.
