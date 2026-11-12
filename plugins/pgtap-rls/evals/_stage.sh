#!/usr/bin/env bash
# Shared by every quality case: `source "$(dirname "$0")/../_stage.sh"; stage "$(dirname "$0")"`.
# Runs as the scaffold script (empty workspace, cwd = workspace). It copies ONLY the supabase/ folder of a disposable
# copy of the reference project into the workspace and records how to reach the already running local stack.
# The scaffold gets no EVAL_* variables, so the source path comes from RLS_EVAL_SRC (works only if your shell passes it)
# or from <repo>/.eval-work/rls-src.txt (git-ignored; one line: the path of the disposable project copy).
# Never starts, stops, resets or migrates anything; never reads the live project folder.
stage() {
  local here repo src db ref net
  here="$(cd "$1" && pwd)"
  repo="$(cd "$here/../../../.." && pwd)"
  src="${RLS_EVAL_SRC:-}"
  if [ -z "$src" ] && [ -f "$repo/.eval-work/rls-src.txt" ]; then src="$(tr -d '\r' < "$repo/.eval-work/rls-src.txt")"; fi
  if [ -z "$src" ]; then echo "set RLS_EVAL_SRC or write the path of a disposable project copy into $repo/.eval-work/rls-src.txt" >&2; exit 1; fi
  case "$src" in [A-Za-z]:*) command -v wslpath >/dev/null && src="$(wslpath -u "$src")" || src="$(cygpath -u "$src")";; esac
  [ -d "$src/supabase/migrations" ] || { echo "no supabase/migrations under $src" >&2; exit 1; }
  cp -r "$src/supabase" ./supabase
  rm -rf supabase/.temp supabase/.branches supabase/snippets supabase/.env* supabase/functions
  db="$(docker ps --filter 'name=^supabase_db_' --filter status=running --format '{{.Names}}')"
  [ "$(printf '%s\n' "$db" | grep -c .)" = 1 ] || { echo "expected exactly one running supabase_db_* container, got: $db" >&2; exit 1; }
  ref="${db#supabase_db_}"; net="supabase_network_$ref"
  docker network inspect "$net" >/dev/null || { echo "no docker network $net" >&2; exit 1; }
  cat > eval-env.txt <<EOT
Environment of this task (written by the eval harness).
The local Supabase stack is already running: DB on 127.0.0.1:54322, Docker network $net.
This workspace has no linked project, so the CLI needs the network name:
  supabase test db --network-id $net <path...>
Allowed: that command (any .sql file path works, also outside supabase/) and SQL inside begin ... rollback.
Forbidden: starting, stopping, resetting or migrating the stack, db push, --remote, --linked. Never commit data.
EOT
}
