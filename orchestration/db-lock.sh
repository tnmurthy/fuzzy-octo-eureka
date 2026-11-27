#!/usr/bin/env bash
# Runs a command while holding the lock on the shared local Supabase.
#
#   orchestration/db-lock.sh supabase db reset
#   orchestration/db-lock.sh npm test
#
# Every project's local Supabase stack is one shared database. Two agents that
# reset it or run suites against it at the same time break each other's runs
# with failures that look like product bugs. Agents wrap those commands in this;
# anything else (typecheck, lint, unit tests with no database) does not need it.
#
# The lock is a directory, because mkdir is atomic on every filesystem here. A
# lock whose holder pid is gone, or older than DB_LOCK_STALE seconds, is
# assumed abandoned and is broken with a message (orchestration/dir-lock.sh).
set -euo pipefail

LOCK_DIR="${DB_LOCK_DIR:-$HOME/.agent-locks/supabase-local.lock}"
WAIT_SECONDS="${DB_LOCK_WAIT:-1800}"
STALE_SECONDS="${DB_LOCK_STALE:-3600}"
POLL_SECONDS=5

[ $# -ge 1 ] || { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

. "$(cd "$(dirname "$0")" && pwd)/dir-lock.sh"
_db_waiting() { echo "db-lock: waiting for the local database; held by: $1" >&2; }
DIR_LOCK_POLL=$POLL_SECONDS DIR_LOCK_ON_WAIT=_db_waiting \
  dir_lock_acquire "$LOCK_DIR" "$WAIT_SECONDS" "$STALE_SECONDS" "agent=${AGENT_NAME:-human} dir=$PWD cmd=$*" \
  || { echo "db-lock: gave up after ${WAIT_SECONDS}s; held by: $(cat "$LOCK_DIR/owner" 2>/dev/null || echo unknown)" >&2; exit 75; }
trap 'dir_lock_release "$LOCK_DIR"' EXIT INT TERM

"$@"
