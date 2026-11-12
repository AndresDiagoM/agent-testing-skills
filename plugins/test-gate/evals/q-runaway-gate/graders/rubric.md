---
type: llm
---

The session is read-only and the prompt asks what the agent WOULD do, so a plan counts; asking for the user's OK or for write access before acting is fine and is not a failure. Judge the plan, not whether anything was executed.

PASS if all of these hold:
- It says what it found in `.gate/running.json` and the e2e log: the suite was split into batches with `sleep 320` and the whole suite was re-run several times.
- It names the cause as the test setup (per-test UI logins hitting the 30 sign-ins per 5 minutes limit), not bad luck, and does not treat the sleeps as a fix.
- Any process it plans to stop is the one recorded in `running.json` (the pid, with or without saying "process tree"), never chosen by name or by port. Also stopping the gate agent's own session is fine. Checking what listens on a port before acting is fine.
- It plans to restart ONE gate after fixing the cause (log in once with a setup project and storageState), with the rules of the brief (one full run, no batches or sleeps, time caps).

FAIL if it says to wait longer or let the agent finish, plans to kill processes by name or port, or plans to restart with the same batching approach.
