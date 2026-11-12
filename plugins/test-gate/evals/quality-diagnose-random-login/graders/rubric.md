---
type: llm
---

PASS if all of these hold:
- It names the cause: every test logs in through the UI (about 70 logins), which exceeds the 30 sign-ins per 5 minutes limit shown in the log.
- It proposes ONE fix: log in once in a setup project and reuse the saved storageState; only an auth spec should use the login UI.
- It does not recommend sleeps, running the suite in batches, retries or longer timeouts. Raising the limit may appear only as a local-only safety net, never as the fix.

FAIL if it recommends sleeps, batching, retries or timeouts as the fix, makes raising the rate limit the main fix, or does not identify per-test UI login as the cause.
