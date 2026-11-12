#!/usr/bin/env bash
# Builds the state of a runaway gate agent: running.json plus a log with batches, sleeps and repeated full runs.
set -e
mkdir -p .gate/logs
cat > .gate/running.json <<'EOF'
{
  "step": "e2e",
  "command": "run-e2e-suite",
  "pid": 41872,
  "startedAt": "2026-11-12T19:05:00.000Z",
  "timeoutMs": 900000,
  "port": 3200,
  "logFile": ".gate/logs/e2e.log"
}
EOF
cat > .gate/logs/e2e.log <<'EOF'
[19:05:02] $ run-e2e-suite            (full run 1)
[19:05:44] 91 tests, 31 passed, 60 failed: sign-in rate limit exceeded (30 per 5 minutes)
[19:05:45] agent: limit hit, splitting the suite into 5 batches and waiting between them
[19:05:46] $ run-e2e-suite --batch 1/5
[19:06:17] batch 1: 18 passed
[19:06:18] $ sleep 320
[19:11:38] $ run-e2e-suite --batch 2/5
[19:12:09] batch 2: 18 passed
[19:12:10] $ sleep 320
[19:17:30] $ run-e2e-suite --batch 3/5
[19:18:01] batch 3: 17 passed, 1 failed (dashboard.spec.ts: stale value)
[19:18:02] $ sleep 320
[19:23:22] agent: fixed dashboard.spec.ts, re-running the whole suite to be sure
[19:23:23] $ run-e2e-suite            (full run 2)
[19:24:05] 91 tests, 30 passed, 61 failed: sign-in rate limit exceeded (30 per 5 minutes)
[19:24:06] $ sleep 320
[19:29:26] $ run-e2e-suite --batch 4/5
[19:29:57] batch 4: 18 passed
[19:29:58] $ sleep 320
[19:35:18] $ run-e2e-suite --batch 5/5
[19:35:49] batch 5: 18 passed
[19:35:50] agent: all batches green, running the whole suite once more
[19:35:51] $ run-e2e-suite            (full run 3)
[19:36:33] 91 tests, 30 passed, 61 failed: sign-in rate limit exceeded (30 per 5 minutes)
[19:36:34] $ sleep 320
[19:41:54] $ run-e2e-suite --batch 1/5
[20:00:02] (no output for 18 minutes)
EOF
