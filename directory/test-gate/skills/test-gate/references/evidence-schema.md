# Evidence file: `.gate/last.json` (schema v2)

Machine-readable result of the gate, one file per repo, git-ignored, overwritten atomically (temp file + rename). Full JSON Schema: `assets/kit/evidence.schema.json`. A file without `schemaVersion` is v1; v2 only adds fields. Readers ignore unknown fields, writers keep them.

## Rules for every writer
1. `exitCode`, `wallMs` and `counts` come from the process you ran, never from memory.
2. `passed` needs exit 0 and, for `unit`/`db`/`e2e` steps, `counts.passed > 0` (override only with `allowEmpty: {reason}`). pgTAP `Result: UNKNOWN`, 0 files or 0 tests is `failed`.
3. Skips: a skipped test needs an `approvedSkips[]` entry, a skipped step needs `approval`. `approvedBy` is `user` or `orchestrator` quoting a standing user instruction, never the agent writing it. Otherwise `complete` is false.
4. A pass on retry is `flaky`, never a clean pass. Keep retries at 0.
5. `message` fields: first line, at most 300 chars, no secrets.

## Root and step fields (v1 fields keep name, type, meaning)
| Field | Notes |
|---|---|
| `schemaVersion` `ok` `finishedAt` `totalMs` `args` | `ok` = every recorded step passed or was skipped (v1 meaning). `totalMs` = sum of non-stale `wallMs` |
| `complete` | `ok` AND every `requiredSteps` entry is fresh and passed (or skipped with valid `approval`), scope `all`, no unapproved skipped/todo/did-not-run tests, no flaky, `build.id == build.servedId`. Reviewers read this |
| `requiredSteps` `git` `environment` `build` | steps the repo requires; `git.head/dirty`; `environment.os/node/packageManager/tools`; `build.id/builtAt/servedId` |
| `steps[].name` | open set `[a-z0-9:_-]+`; conventional: `lint typecheck test db:test build e2e` |
| `kind` | `lint typecheck unit db build e2e parity custom` |
| `status` | `passed failed timeout skipped not-run` |
| required | `name status command exitCode wallMs timeoutMs` |
| optional | `startedAt finishedAt previousPassMs port counts failures[] flaky[] approvedSkips[] approval allowEmpty scope details logFile reportedBy skipReason problems` |
| `counts` | at least `passed failed skipped`; also `todo runs flaky interrupted didNotRun files tests result` |
| `failures[]` | `{test, file?, message?}`, extra keys allowed |
| `scope` | `{kind:"all"}` or `{kind:"files", files:[...]}`; `files` forces `complete:false` |
| `stale` | set by `gate.mjs` on steps it did not run in this invocation; a stale required step is incomplete |

`.gate/running.json` exists only while a step runs: `{step, command, pid, startedAt, timeoutMs, port, logFile}`. It holds the only pid a supervisor may kill. Logs go to `.gate/logs/<step>.log` (`:` becomes `-`: `db-test.log`).

## How another skill adds a step
1. Run your command, tee raw output to `.gate/logs/<name>.log`.
2. Write ONE step object as one JSON file (shape below).
3. Merge it: `node scripts/gate.mjs add-step --from-json step.json [--required lint,db:test]`. Only the step with that `name` is replaced or appended; other steps and unknown fields stay; `ok`, `complete`, `totalMs`, `finishedAt`, `git` are recomputed; the write is atomic. A dishonest `passed` is downgraded to `failed` with `problems[]`.
4. Without the kit: read the file (or start `{"schemaVersion":2,"steps":[],"requiredSteps":[],"args":[]}`), do the same merge by hand, write temp + rename. Never rename or delete steps you did not write.

## Example (valid JSON)
```json
{
  "schemaVersion": 2,
  "ok": true,
  "complete": false,
  "finishedAt": "2026-11-12T20:19:31.104Z",
  "totalMs": 3000,
  "args": [],
  "requiredSteps": ["db:test", "e2e"],
  "git": { "head": "7a91700748e25776f6ea10d3e7e8f8cac264b618", "dirty": false },
  "steps": [
    {
      "name": "db:test",
      "kind": "db",
      "status": "passed",
      "command": "supabase test db",
      "exitCode": 0,
      "startedAt": "2026-11-12T20:19:28.104Z",
      "finishedAt": "2026-11-12T20:19:31.104Z",
      "wallMs": 3000,
      "timeoutMs": 600000,
      "scope": { "kind": "all" },
      "counts": { "passed": 45, "failed": 0, "skipped": 0 },
      "details": { "pgtap": { "files": 3, "tests": 45, "result": "PASS" } },
      "logFile": ".gate/logs/db-test.log",
      "reportedBy": "pgtap-rls 0.3.1"
    }
  ]
}
```
Here `complete` is false because required step `e2e` has no entry.
