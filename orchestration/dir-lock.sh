#!/usr/bin/env bash
# Sourced helpers: a lock that is a directory (mkdir is atomic everywhere).
#
#   . orchestration/dir-lock.sh
#   dir_lock_acquire <lock-dir> <wait-seconds> <stale-seconds> <label> || exit 75
#   ...
#   dir_lock_release <lock-dir>
#
# The holder writes "<pid> <label>" to <lock-dir>/owner. A lock is broken when
# its holder pid is gone (killed before it could release) or the lock is older
# than <stale-seconds>. While waiting, DIR_LOCK_ON_WAIT (a function name, if
# set) is called once with the holder's label, and DIR_LOCK_CANCEL (a function
# name, if set) is checked each poll: non-zero exit = stop waiting (return 130).

DIR_LOCK_POLL="${DIR_LOCK_POLL:-2}"

# mtime in epoch seconds: BSD stat (macOS) first, then GNU.
_dir_lock_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || date +%s; }

dir_lock_acquire() {
  local dir="$1" wait="$2" stale="$3" label="$4" waited=0 told="" owner pid age
  mkdir -p "$(dirname "$dir")"
  while ! mkdir "$dir" 2>/dev/null; do
    owner="$(cat "$dir/owner" 2>/dev/null || true)"
    pid="${owner%% *}"
    age=$(( $(date +%s) - $(_dir_lock_mtime "$dir") ))
    if { [[ "$pid" =~ ^[0-9]+$ ]] && ! kill -0 "$pid" 2>/dev/null; } || [ "$age" -ge "$stale" ]; then
      echo "dir-lock: breaking $(basename "$dir") held ${age}s by: ${owner:-unknown}" >&2
      rm -rf "$dir"
      continue
    fi
    if [ -n "${DIR_LOCK_CANCEL:-}" ] && ! "$DIR_LOCK_CANCEL"; then return 130; fi
    [ "$waited" -ge "$wait" ] && return 75
    if [ -z "$told" ] && [ -n "${DIR_LOCK_ON_WAIT:-}" ]; then "$DIR_LOCK_ON_WAIT" "${owner#* }"; told=1; fi
    sleep "$DIR_LOCK_POLL"
    waited=$(( waited + DIR_LOCK_POLL ))
  done
  printf '%s %s\n' "$$" "$label" > "$dir/owner"
  return 0
}

# Releases only a lock this process holds.
dir_lock_release() {
  local dir="$1" owner
  owner="$(cat "$dir/owner" 2>/dev/null || true)"
  [ "${owner%% *}" = "$$" ] && rm -rf "$dir"
  return 0
}
