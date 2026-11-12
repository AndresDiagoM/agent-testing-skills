---
type: llm
focus:
  source: file
  path: brief.md
---

The file is a brief for an agent that builds a /reports page, writes its e2e, and runs the quality gate.

PASS if the brief has all of: an explicit list of files the agent may touch; a free port and a distinct run id; one full run per gate (on failure fix, re-run only the failing file, then one final full run); a ban on batches, sleeps, retries and weakening a test; login once through a setup project; per-step time caps; the requirement that the builder runs its own e2e for what it wrote before reporting; a report format that includes the evidence file path, wall times and passed/failed/skipped counts; and conditions to stop and ask.
FAIL if any of those is missing, or the brief says to run the suite as many times as needed.
