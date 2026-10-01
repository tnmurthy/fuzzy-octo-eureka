#!/usr/bin/env bash
# Hands one task to one agent, in its own worktree, and records the run.
#
#   orchestration/agent-dispatch.sh <agent> <repo> <branch> <prompt-file>
#
#   agent   claude | codex | agy | hermes | noop
#   repo    path to the git repository the task is in
#   branch  the branch the agent works on; a worktree is made for it beside
#           the repo as <repo>--<branch-with-slashes-as-dashes>
#
# Each run appends a start line and an end line to $AGENT_RUNS_DIR/runs.jsonl,
# which the Arunachala dashboard's Agent Runs tab reads, and writes the agent's
# full output to $AGENT_RUNS_DIR/<run-id>.log.
#
# agy runs in plan mode: review only. Headless, it cannot ask for tool
# permissions, so put the files it should review into the prompt itself.
# `noop` echoes the prompt; it exists to exercise this script.
set -euo pipefail

RUNS_DIR="${AGENT_RUNS_DIR:-/c/tt-ai-stack/04_internal/agent-runs}"
TIMEOUT_SECONDS="${AGENT_TIMEOUT:-3600}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Headless `claude -p` cannot ask for permission, so a builder run gets a
# narrow allow-list: edit files, git, the package and database tools, and the
# lock. Pushing is denied outright -- a dispatched agent commits, a person
# merges. Override with CLAUDE_ALLOWED_TOOLS for a different task shape.
CLAUDE_ALLOWED_TOOLS="${CLAUDE_ALLOWED_TOOLS:-Read Edit Write Glob Grep Bash(git:*) Bash(npm:*) Bash(npx:*) Bash(supabase:*) Bash(node:*) Bash(ls:*) Bash(cat:*) Bash($HERE/db-lock.sh:*)}"
CLAUDE_DENIED_TOOLS="${CLAUDE_DENIED_TOOLS:-Bash(git push:*) Bash(gh:*)}"
# Lets a run pick a model the login can use; empty means the CLI's default.
CODEX_MODEL="${CODEX_MODEL:-}"

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -eq 4 ] || usage

agent="$1"; repo="$(cd "$2" && pwd)"; branch="$3"; prompt_file="$4"
case "$agent" in claude|codex|agy|hermes|noop) ;; *) echo "unknown agent: $agent" >&2; usage ;; esac
[ -f "$prompt_file" ] || { echo "no prompt file: $prompt_file" >&2; exit 2; }
git -C "$repo" rev-parse --git-dir >/dev/null

# --- worktree -----------------------------------------------------------------
worktree="$(dirname "$repo")/$(basename "$repo")--${branch//\//-}"
if [ ! -d "$worktree" ]; then
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add -q "$worktree" "$branch"
  else
    git -C "$repo" worktree add -q -b "$branch" "$worktree"
  fi
fi

# --- prompt: the task plus the rules every agent works under --------------------
read -r -d '' rules <<EOF || true
You are working in $worktree on branch $branch. Rules:
- Work only inside that directory. Do not touch any other checkout.
- Commit on this branch. Never push to or merge into main.
- Wrap 'supabase db reset' and any test suite that uses the local database in
  $HERE/db-lock.sh, e.g. '$HERE/db-lock.sh npm test'. Other agents share it.
- Follow the AGENTS.md in this repository.

Task:
EOF
prompt="$rules"$'\n'"$(cat "$prompt_file")"

# --- run ------------------------------------------------------------------------
mkdir -p "$RUNS_DIR"
run_id="$(date +%Y%m%d-%H%M%S)-$agent-$RANDOM"
log="$RUNS_DIR/$run_id.log"
runs="$RUNS_DIR/runs.jsonl"
base="$(git -C "$worktree" rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo main)"
started=$(date +%s)

node "$HERE/runlog.mjs" "$runs" id="$run_id" agent="$agent" repo="$repo" \
  branch="$branch" worktree="$worktree" log="$log" status=running \
  task="$(head -c 160 "$prompt_file" | tr '\r\n' '  ')" started_at="$(date -Iseconds)"

export AGENT_NAME="$agent"
set +e
case "$agent" in
  claude) (cd "$worktree" && timeout "$TIMEOUT_SECONDS" claude -p "$prompt" --permission-mode acceptEdits \
             --allowedTools "$CLAUDE_ALLOWED_TOOLS" --disallowedTools "$CLAUDE_DENIED_TOOLS") ;;
  codex)  timeout "$TIMEOUT_SECONDS" codex exec -C "$worktree" -s workspace-write \
             ${CODEX_MODEL:+-m "$CODEX_MODEL"} "$prompt" ;;
  agy)    (cd "$worktree" && timeout "$TIMEOUT_SECONDS" agy --mode plan --disable-slash-commands \
             --print-timeout "${TIMEOUT_SECONDS}s" --prompt="$prompt") ;;
  hermes) timeout "$TIMEOUT_SECONDS" hermes --in "$worktree" -z "$prompt" ;;
  noop)   printf '%s\n' "$prompt" ;;
esac > "$log" 2>&1
exit_code=$?
set -e

commits="$(git -C "$worktree" rev-list --count "$base..HEAD" 2>/dev/null || echo 0)"
status=done
[ "$exit_code" -eq 0 ] || status=failed
[ "$exit_code" -eq 124 ] && status=timed_out

node "$HERE/runlog.mjs" "$runs" id="$run_id" status="$status" \
  exit_code:="$exit_code" duration_s:="$(( $(date +%s) - started ))" \
  commits_ahead:="$commits" head="$(git -C "$worktree" rev-parse --short HEAD)" \
  finished_at="$(date -Iseconds)"

echo "$run_id $status (exit $exit_code) log: $log"
exit "$exit_code"
