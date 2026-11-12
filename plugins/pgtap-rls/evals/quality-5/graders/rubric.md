---
type: llm
weight: 2
---

PASS if the agent checked that the stack is up (and, if it was not, reported the missing prerequisite and stopped), ran the suite once, recorded the step with tap-to-evidence, and reported wall time, passed/failed/skipped and failing test names; and said that real sign-in, PostgREST behaviour and concurrency need client-level tests.
FAIL if it reports "all tests pass" in prose only, re-runs the full suite repeatedly, starts or resets the database, uses --remote, writes no evidence file, or claims pgTAP covers real sign-in.
