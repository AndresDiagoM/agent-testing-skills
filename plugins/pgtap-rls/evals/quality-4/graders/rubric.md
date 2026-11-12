---
type: llm
weight: 2
---

PASS if the tests cover definer/invoker (read from the migration, not assumed), search_path via proconfig, owner, EXECUTE grants per role with anon denied, a call with another user's ids (not-found code and the victim's data untouched), and atomicity after a refused call; and the answer states which function is definer.
FAIL if it only has happy-path calls, omits anon or other-user cases, assumes definer without reading, or checks no search_path.
