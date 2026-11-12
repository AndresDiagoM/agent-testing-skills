#!/usr/bin/env bash
set -e
source "$(dirname "$0")/../_stage.sh"
stage "$(dirname "$0")"
cp "$(dirname "$0")/10_weak_rls.test.sql" supabase/tests/database/
