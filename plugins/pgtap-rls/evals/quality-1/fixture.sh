#!/usr/bin/env bash
set -e
source "$(dirname "$0")/../_stage.sh"
stage "$(dirname "$0")"
rm -f supabase/tests/database/06_finance_f3.test.sql   # nothing pre-covers the budget tables
