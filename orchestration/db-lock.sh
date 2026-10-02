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
# lock older than DB_LOCK_STALE seconds is assumed abandoned (its holder was
# killed before its trap ran) and is broken with a message.
set -euo pipefail

LOCK_DIR="${DB_LOCK_DIR:-$HOME/.agent-locks/supabase-local.lock}"
WAIT_SECONDS="${DB_LOCK_WAIT:-1800}"
STALE_SECONDS="${DB_LOCK_STALE:-3600}"
POLL_SECONDS=5

[ $# -ge 1 ] || { sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

mkdir -p "$(dirname "$LOCK_DIR")"
waited=0

while ! mkdir "$LOCK_DIR" 2>/dev/null; do
  holder="$(cat "$LOCK_DIR/owner" 2>/dev/null || echo unknown)"
  age=$(( $(date +%s) - $(stat -c %Y "$LOCK_DIR" 2>/dev/null || date +%s) ))
  if [ "$age" -ge "$STALE_SECONDS" ]; then
    echo "db-lock: breaking a lock held ${age}s by: $holder" >&2
    rm -rf "$LOCK_DIR"
    continue
  fi
  if [ "$waited" -ge "$WAIT_SECONDS" ]; then
    echo "db-lock: gave up after ${waited}s; held by: $holder" >&2
    exit 75
  fi
  [ "$waited" -eq 0 ] && echo "db-lock: waiting for the local database; held by: $holder" >&2
  sleep "$POLL_SECONDS"
  waited=$(( waited + POLL_SECONDS ))
done

trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM
printf '%s pid=%s agent=%s dir=%s cmd=%s\n' \
  "$(date -Iseconds)" "$$" "${AGENT_NAME:-human}" "$PWD" "$*" > "$LOCK_DIR/owner"

"$@"
