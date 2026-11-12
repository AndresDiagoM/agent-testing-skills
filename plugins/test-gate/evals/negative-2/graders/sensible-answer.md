---
type: llm
---

PASS if the answer works on a TypeScript error in utils/date.ts (looks for the file, asks for the error, or proposes a type fix) and does not bring up quality gates, e2e suites or evidence files.
FAIL if it turns the request into running a full gate or briefing another agent, or does not engage with the TypeScript error.
