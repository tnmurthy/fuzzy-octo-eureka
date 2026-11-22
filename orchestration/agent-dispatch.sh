#!/usr/bin/env bash
# Hands one task to one agent, in its own worktree, and records the run.
#
#   orchestration/agent-dispatch.sh <agent> <repo> <branch> <prompt-file>
#
#   agent   claude | codex | agy | hermes | noop | auto
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
#
# `auto` tries the local agent first and escalates to claude only when it has
# to: LOCAL_AGENT (default hermes, a local model) works the task, then the
# repo's tests decide - the one-line command in <repo>/.arunachala-test, else
# `npm test` when package.json has a test script. Tests pass: done, no
# frontier tokens spent. Tests fail, the local agent fails, or the repo has no
# tests to check it with: the worktree is reset to where it started and claude
# takes over. The run's end line records escalated:=true|false.
set -euo pipefail

RUNS_DIR="${AGENT_RUNS_DIR:-$(cd "$(dirname "$0")/../../../.." && pwd)/04_internal/agent-runs}"
TIMEOUT_SECONDS="${AGENT_TIMEOUT:-3600}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Headless `claude -p` cannot ask for permission, so a builder run gets a
# narrow allow-list: edit files, git, the package and database tools, and the
# lock. Pushing is denied outright -- a dispatched agent commits, a person
# merges. Override with CLAUDE_ALLOWED_TOOLS for a different task shape.
# Defaults (when not started by the dashboard): the `auto` level from
# approval-levels.js, so this script never grants more than the dashboard does.
if [ -z "${CLAUDE_ALLOWED_TOOLS:-}" ] || [ -z "${CLAUDE_DENIED_TOOLS:-}" ]; then
  _auto_tools="$(node -e 'const t = require(process.argv[1]).toolsFor("auto", { scriptsDir: process.argv[2] }); console.log(t.allowed); console.log(t.denied);' \
    "$HERE/../approval-levels.js" "$HERE")" || { echo "cannot read approval-levels.js" >&2; exit 2; }
  CLAUDE_ALLOWED_TOOLS="${CLAUDE_ALLOWED_TOOLS:-$(printf '%s\n' "$_auto_tools" | sed -n 1p)}"
  CLAUDE_DENIED_TOOLS="${CLAUDE_DENIED_TOOLS:-$(printf '%s\n' "$_auto_tools" | sed -n 2p)}"
fi
# The dashboard sets these from the run's approval level (approval-levels.js).
CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-acceptEdits}"
# Model for dispatched claude runs: routine tasks do not need the account's
# default (often the most expensive) model.
CLAUDE_MODEL="${CLAUDE_MODEL:-sonnet}"
# A run that cannot finish in this many turns is stuck, not slow.
CLAUDE_MAX_TURNS="${CLAUDE_MAX_TURNS:-40}"
# Lean context: no MCP servers, no skills, no user settings - a dispatched run
# needs none of them. Measured here: 64k -> 39k tokens loaded before any work.
CLAUDE_LEAN="${CLAUDE_LEAN:-true}"
# The AI call ledger the dashboard syncs to the team; claude runs record their
# real tokens and cost in it (claude-usage.mjs).
AI_CALLS_FILE="${AI_CALLS_FILE:-$HERE/../logs/ai-calls.jsonl}"
# Lets a run pick a model the login can use; empty means the CLI's default.
CODEX_MODEL="${CODEX_MODEL:-}"

# Remote or local Ollama host (e.g. Mac Studio) for local agent execution
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1}"
export OLLAMA_PORT="${OLLAMA_PORT:-11434}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-http://$OLLAMA_HOST:$OLLAMA_PORT/v1}"
export OLLAMA_API_BASE="${OLLAMA_API_BASE:-http://$OLLAMA_HOST:$OLLAMA_PORT}"

# Hermes Desktop puts only hermes.cmd on PATH. Bash cannot find a .cmd by bare
# name, and cmd's %* cuts a multi-line prompt at the first newline, so use the
# venv's real hermes binary. HERMES_BIN overrides; the .venv copy is a fallback
# for older installs. Supports Windows, macOS, and Linux paths.
resolve_hermes() {
  local h_win="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/hermes-agent"
  local h_mac="$HOME/Library/Application Support/hermes/hermes-agent"
  local h_posix="$HOME/.hermes"
  local c
  for c in "${HERMES_BIN:-}" "$(command -v hermes 2>/dev/null || true)" \
           "$HERE/hermes-local.js" \
           "$h_win/venv/Scripts/hermes.exe" "$h_win/.venv/Scripts/hermes.exe" \
           "$h_mac/venv/bin/hermes" "$h_mac/.venv/bin/hermes" \
           "$h_posix/venv/bin/hermes" "$h_posix/.venv/bin/hermes"; do
    [ -n "$c" ] && [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  echo "hermes not found: set HERMES_BIN to Hermes executable" >&2
  return 1
}

# Cross-platform helpers for timeout and ISO-8601 timestamps (macOS BSD date/timeout compatibility)
run_timeout() {
  local limit="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$limit" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$limit" "$@"
  else
    "$@"
  fi
}

iso_date() {
  date -Iseconds 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -eq 4 ] || [ $# -eq 5 ] || usage

agent="$1"; repo="$(cd "$2" && pwd)"; branch="$3"; prompt_file="$4"
# Optional 5th arg: a caller-supplied run id, so a caller (server.js's
# /api/dispatch/run, and n8n/bridge.js polling for it) knows the id up
# front instead of having to scrape it from this script's stdout.
run_id_override="${5:-}"
case "$agent" in claude|codex|agy|hermes|noop|auto|mantis|openhands) ;; *) echo "unknown agent: $agent" >&2; usage ;; esac
[ -f "$prompt_file" ] || { echo "no prompt file: $prompt_file" >&2; exit 2; }
# This git build's -C does not accept a posix (/c/...) path - it needs the
# native C:\... form, or it fails with "cannot change to ...: No such file
# or directory" even though the directory exists. Every other git call in
# this script passes a plain positional path (cd's into it, or git itself
# resolved it), which works fine either way; only -C needs this.
native() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }
git -C "$(native "$repo")" rev-parse --git-dir >/dev/null
# Resolve before any worktree or run record exists, so a missing CLI fails fast.
LOCAL_AGENT="${LOCAL_AGENT:-hermes}"
LOCAL_TIMEOUT_SECONDS="${LOCAL_TIMEOUT:-900}"
TEST_TIMEOUT_SECONDS="${TEST_TIMEOUT:-900}"
{ [ "$agent" = hermes ] || { [ "$agent" = auto ] && [ "$LOCAL_AGENT" = hermes ]; }; } \
  && { HERMES="$(resolve_hermes)" || exit 2; }

# --- worktree -----------------------------------------------------------------
worktree="$(dirname "$repo")/$(basename "$repo")--${branch//\//-}"
if [ ! -d "$worktree" ]; then
  if git -C "$(native "$repo")" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$(native "$repo")" worktree add -q "$(native "$worktree")" "$branch"
  else
    git -C "$(native "$repo")" worktree add -q -b "$branch" "$(native "$worktree")"
  fi
  # A new worktree has only tracked files. The gitignored ones a run needs --
  # web/.env.local, say -- are listed one per line in the repo's
  # .worktreeinclude and copied from the main checkout. Without this the first
  # S9 run's e2e suite failed on a missing Supabase URL.
  if [ -f "$repo/.worktreeinclude" ]; then
    while IFS= read -r rel || [ -n "$rel" ]; do
      rel="${rel%$'\r'}"
      case "$rel" in ''|'#'*) continue ;; esac
      if [ -f "$repo/$rel" ] && [ ! -e "$worktree/$rel" ]; then
        mkdir -p "$(dirname "$worktree/$rel")"
        cp "$repo/$rel" "$worktree/$rel"
      fi
    done < "$repo/.worktreeinclude"
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
# Runs started from the Agents page (AGENT_CAN_ASK=1) may stop and ask the
# person one question; the page shows it as "Needs you" with a reply box,
# and the reply resumes this session (agents-api.js questionOf).
if [ "${AGENT_CAN_ASK:-}" = 1 ]; then
  prompt="$prompt"$'\n\n'"If you cannot continue without a decision only the person can make (a choice between approaches, missing access, unclear scope), do what you safely can, commit it, then end your final message with one line: QUESTION: <your question>. Ask at most one question, and only when it matters."
fi

# --- run ------------------------------------------------------------------------
mkdir -p "$RUNS_DIR"
run_id="${run_id_override:-$(date +%Y%m%d-%H%M%S)-$agent-$RANDOM}"
log="$RUNS_DIR/$run_id.log"
runs="$RUNS_DIR/runs.jsonl"
base="$(git -C "$(native "$worktree")" rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo main)"
started=$(date +%s)

# AGENT_TASK_TITLE (set by the dashboard) is the task alone, without the
# specialist guidance and memories appended to the prompt file.
node "$(native "$HERE/runlog.mjs")" "$runs" id="$run_id" agent="$agent" repo="$repo" \
  branch="$branch" worktree="$worktree" log="$log" status=running \
  task="$(if [ -n "${AGENT_TASK_TITLE:-}" ]; then printf '%s' "$AGENT_TASK_TITLE" | head -c 160; else head -c 160 "$prompt_file"; fi | tr '\r\n' '  ')" \
  ${AGENT_SPECIALIST:+"specialist=$AGENT_SPECIALIST"} ${AGENT_PARENT_RUN:+"parent=$AGENT_PARENT_RUN"} \
  ${AGENT_LEVEL:+"level=$AGENT_LEVEL"} started_at="$(iso_date)"

# Stop (Agents page -> run-control.js): the dashboard signals this script and
# every process under it. The trap lets the script outlive the signal and
# still write the end line, as status=stopped; the session id stream-log.js
# saved at start lets a follow-up resume where the agent was cut off.
pidfile="$RUNS_DIR/$run_id.pid"
echo "$$" > "$pidfile"
stopped=""
trap 'stopped=1' TERM

# A review reads the change from a file instead of running `git diff` (its
# level allows no shell). The file is excluded from git, so it never shows as
# a change on the PR branch.
if [[ "${AGENT_REVIEW_BASE:-}" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  git -C "$(native "$worktree")" diff "origin/$AGENT_REVIEW_BASE...HEAD" > "$worktree/.arunachala-review.diff" 2>/dev/null || true
  exclude="$(git -C "$(native "$worktree")" rev-parse --git-path info/exclude)"
  case "$exclude" in /*) ;; *) exclude="$worktree/$exclude" ;; esac
  mkdir -p "$(dirname "$exclude")"
  grep -qx '.arunachala-review.diff' "$exclude" 2>/dev/null || echo '.arunachala-review.diff' >> "$exclude"
fi

export AGENT_NAME="$agent"

# One agent, one attempt, in the worktree; output to stdout.
run_agent() {
  local who="$1" limit="$2"
  [ -n "$stopped" ] && return 143
  case "$who" in
    claude) run_claude "$limit" ;;
    codex)  run_timeout "$limit" codex exec -C "$worktree" -s workspace-write \
               ${CODEX_MODEL:+-m "$CODEX_MODEL"} "$prompt" ;;
    agy)    (cd "$worktree" && run_timeout "$limit" agy --mode plan --disable-slash-commands \
               --print-timeout "${limit}s" --prompt="$prompt") ;;
    mantis) run_mantis "$limit" ;;
    openhands) run_openhands "$limit" ;;
    hermes) run_hermes "$limit" ;;
    noop)   printf '%s\n' "$prompt" ;;
    *)      echo "unknown agent: $who"; return 2 ;;
  esac
}

run_openhands() {
  local limit="$1"
  echo "== Dispatching to OpenHands Sandbox (:8000) for $worktree"
  echo "$prompt" > "$worktree/.openhands_task" 2>/dev/null || true
  echo "Task assigned to OpenHands sandbox workspace. Canvas interface: http://127.0.0.1:8000/canvas/"
}

run_mantis() {
  local limit="$1"
  local mantis_dir="${MANTIS_HOME:-${STACK_ROOT:-$HOME/tt-ai-stack}/tools/mantis}"
  echo "== Running Google Mantis security analysis on $worktree"
  if [ -x "$mantis_dir/reference/run.sh" ] && [ -d "$mantis_dir/reference/.venv" ]; then
    run_timeout "$limit" "$mantis_dir/reference/run.sh" "$worktree"
  elif command -v agy >/dev/null 2>&1; then
    (cd "$worktree" && run_timeout "$limit" agy --mode plan --dangerously-skip-permissions \
       --print-timeout "${limit}s" \
       --prompt="Perform Google Mantis security review on this repository using skills from $mantis_dir/skills. Review threat model, authentication/authorization boundaries, and potential vulnerabilities: $prompt")
  else
    echo "Mantis skills loaded from $mantis_dir. Worktree: $worktree"
  fi
}

# claude streams its steps (--output-format stream-json); stream-log.js
# writes one readable line per step into the run log as they happen, so
# `tail -f <run-id>.log` shows the agent working, and saves the final result
# event to <run-id>.claude.json. claude-usage.mjs then records tokens and cost
# from that file and prints the readable result. The exit code is claude's.
run_claude() {
  local limit="$1" json="$RUNS_DIR/$run_id.claude.json" rc
  local lean=() resume=()
  [ "$CLAUDE_LEAN" = true ] && lean=(--strict-mcp-config --disable-slash-commands --setting-sources project,local)
  # A follow-up continues an earlier run's conversation (same worktree, so the
  # session's project folder matches). The dashboard validated the id.
  [[ "${AGENT_RESUME_SESSION:-}" =~ ^[0-9a-fA-F-]{36}$ ]] && resume=(--resume "$AGENT_RESUME_SESSION")
  # Approval cards (OMB-3): with a run token from the dashboard, anything the
  # level does not pre-allow goes to approval-mcp.js, which asks a person on
  # /agents and denies when nobody answers. Without a token nothing is asked
  # and such tools are simply refused, as before. The config holds the token,
  # so it is private to this user and removed when the run ends.
  local asks=() mcp_cfg="$RUNS_DIR/$run_id.mcp.json"
  if [ -n "${APPROVAL_TOKEN:-}" ]; then
    (umask 077; node -e 'const [f, h, ...e] = process.argv.slice(1); const env = Object.fromEntries(e.map((x) => [x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1)])); require("fs").writeFileSync(f, JSON.stringify({ mcpServers: { arunachala_approvals: { command: process.execPath, args: [h], env } } }));' \
      "$(native "$mcp_cfg")" "$(native "$HERE/approval-mcp.js")" \
      "APPROVAL_URL=${APPROVAL_URL:-http://127.0.0.1:8787}" "APPROVAL_RUN_ID=$run_id" "APPROVAL_TOKEN=$APPROVAL_TOKEN" \
      "APPROVAL_TIMEOUT_MS=${APPROVAL_TIMEOUT_MS:-600000}")
    asks=(--mcp-config "$mcp_cfg" --permission-prompt-tool mcp__arunachala_approvals__approve)
  fi
  (cd "$worktree" && run_timeout "$limit" claude -p "$prompt" --permission-mode "$CLAUDE_PERMISSION_MODE" \
     --allowedTools "$CLAUDE_ALLOWED_TOOLS" --disallowedTools "$CLAUDE_DENIED_TOOLS" \
     --model "$CLAUDE_MODEL" --max-turns "$CLAUDE_MAX_TURNS" --output-format stream-json --verbose "${lean[@]}" \
     ${resume[@]+"${resume[@]}"} ${asks[@]+"${asks[@]}"}) \
    | node "$(native "$HERE/stream-log.js")" "$(native "$json")"
  rc=${PIPESTATUS[0]}
  rm -f "$mcp_cfg"
  echo "== result"
  node "$(native "$HERE/claude-usage.mjs")" "$(native "$json")" "$(native "$AI_CALLS_FILE")" "$run_id"
  return "$rc"
}

# Hermes (local, Ollama) streams its steps the same way: stream-log.js writes
# the readable log and saves the normalised result (session id, answer) to
# <run-id>.hermes.json, so follow-ups, questions and the live step view work
# for local runs too. A follow-up resumes with --resume <local-...>.
# HERMES_MODEL overrides the model in ~/.hermes/config.yaml for these runs.
# The bundled hermes-local.js fallback has no chat/stream mode: plain call.
# Sandbox (default; AGENT_HERMES_SANDBOX=off to disable): the run uses its own
# HERMES_HOME (AGENT_HERMES_HOME, default ~/.hermes-agents) with the config in
# hermes-agent-config.yaml, so its commands and file edits happen in a Docker
# container that sees only the worktree, with tools limited to
# HERMES_TOOLSETS (terminal,file,todo: no web, browser, memory). There is no
# git inside, so the agent's changes are committed here on the host, hooks
# off, after checking the worktree's .git pointer was not tampered with.
# Docker (OrbStack) down: one `orb start` attempt, then the run fails rather
# than running unboxed.
hermes_sandbox_on() { [ "${AGENT_HERMES_SANDBOX:-on}" != off ]; }

ensure_docker() {
  docker info >/dev/null 2>&1 && return 0
  if command -v orb >/dev/null 2>&1; then
    echo "== sandbox: Docker is not running - starting OrbStack"
    orb start >/dev/null 2>&1 || true
    local i
    for i in $(seq 1 30); do docker info >/dev/null 2>&1 && return 0; sleep 2; done
  fi
  echo "== sandbox: Docker is not reachable, so the local agent was not started (start OrbStack, or set AGENT_HERMES_SANDBOX=off)"
  return 1
}

# Commit what the sandboxed agent changed, on the host. Returns 0 always;
# prints what it did.
commit_sandbox_changes() {
  local gitfile_before="$1" title msg
  if [ ! -f "$worktree/.git" ] || [ "$(cat "$worktree/.git" 2>/dev/null)" != "$gitfile_before" ]; then
    echo "== sandbox: the agent changed the worktree's .git pointer - restored it"
    rm -rf "$worktree/.git"
    printf '%s\n' "$gitfile_before" > "$worktree/.git"
  fi
  if [ -z "$(git -C "$(native "$worktree")" -c core.hooksPath=/dev/null status --porcelain 2>/dev/null)" ]; then
    echo "== sandbox: no file changes to commit"
    return 0
  fi
  title="$(if [ -n "${AGENT_TASK_TITLE:-}" ]; then printf '%s' "$AGENT_TASK_TITLE"; else head -c 72 "$prompt_file"; fi | tr '\r\n' '  ' | head -c 72)"
  msg="agent(hermes): ${title:-local agent changes}"
  # Committer: this machine's git identity; the agent's own when none is set.
  local ident=()
  git -C "$(native "$worktree")" config user.email >/dev/null 2>&1 \
    || ident=(-c user.name="Hermes local agent" -c user.email=hermes@localhost)
  git -C "$(native "$worktree")" -c core.hooksPath=/dev/null add -A \
    && git -C "$(native "$worktree")" -c core.hooksPath=/dev/null ${ident[@]+"${ident[@]}"} commit -q --no-verify \
         --author "Hermes local agent <hermes@localhost>" -m "$msg" -m "Run $run_id (sandboxed; committed by agent-dispatch.sh)" \
    && echo "== sandbox: committed the agent's changes ($(git -C "$(native "$worktree")" rev-parse --short HEAD))" \
    || echo "== sandbox: could not commit the agent's changes; they are left in the worktree"
  return 0
}

run_hermes() {
  local limit="$1" json="$RUNS_DIR/$run_id.hermes.json" rc resume=() model=() boxed=() run_prompt="$prompt" gitfile=""
  if [ "$(basename "$HERMES")" = hermes-local.js ]; then
    run_timeout "$limit" "$HERMES" --in "$worktree" -z "$prompt"
    return $?
  fi
  [[ "${AGENT_RESUME_SESSION:-}" =~ ^local-[0-9a-f]{16,128}$ ]] && resume=(--resume "$AGENT_RESUME_SESSION")
  [ -n "${HERMES_MODEL:-}" ] && model=(-m "$HERMES_MODEL")
  if hermes_sandbox_on; then
    ensure_docker || return 3
    local home="${AGENT_HERMES_HOME:-$HOME/.hermes-agents}"
    mkdir -p "$home" && cp "$HERE/hermes-agent-config.yaml" "$home/config.yaml" || return 3
    export HERMES_HOME="$home"
    boxed=(-t "${HERMES_TOOLSETS:-terminal,file,todo}")
    gitfile="$(cat "$worktree/.git" 2>/dev/null)"
    run_prompt="$prompt"$'\n\n'"Sandbox: you work inside a container. The repository is at /workspace (that is the directory named above). git is not available there: do not run git and do not try to commit. When you finish, your file changes are committed for you."
    echo "== sandbox: hermes in Docker, workspace only, tools ${HERMES_TOOLSETS:-terminal,file,todo}"
  fi
  (cd "$worktree" && run_timeout "$limit" "$HERMES" chat -q "$run_prompt" --oneshot --format stream-json --in "$worktree" \
      ${model[@]+"${model[@]}"} ${boxed[@]+"${boxed[@]}"} ${resume[@]+"${resume[@]}"} < /dev/null 2>&1) \
    | node "$(native "$HERE/stream-log.js")" "$(native "$json")" hermes
  rc=${PIPESTATUS[0]}
  if hermes_sandbox_on && [ -n "$gitfile" ]; then commit_sandbox_changes "$gitfile"; fi
  echo "== result"
  node -e 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(j.result || "(no answer)"); } catch (_) { console.log("(no result: the run ended early)"); }' "$(native "$json")"
  return "$rc"
}

# The repo's own check for `auto`: .arunachala-test, else an npm test script.
test_command() {
  if [ -f "$worktree/.arunachala-test" ]; then
    head -n 1 "$worktree/.arunachala-test" | tr -d '\r'
  elif [ -f "$worktree/package.json" ] && node -e "process.exit(require(process.argv[1]).scripts?.test ? 0 : 1)" \
         "$(native "$worktree/package.json")" 2>/dev/null; then
    echo "npm test"
  fi
}

# The repo's tests after a local attempt run code the local agent just wrote,
# so with the sandbox on they run in the same kind of container as the agent
# (image from hermes-agent-config.yaml, worktree only, no capabilities, host
# uid). AGENT_TEST_SANDBOX=off runs them on the host as before (e.g. tests
# that need host-only services such as a local database on 127.0.0.1).
# Afterwards the worktree's .git pointer is checked again: host git commands
# (reset, clean, rev-list) must never follow a pointer the tests rewrote.
sandbox_image() { sed -n 's/^  docker_image: *//p' "$HERE/hermes-agent-config.yaml" | head -1; }

run_repo_tests() {
  local tests="$1" rc gitfile name
  if ! hermes_sandbox_on || [ "${AGENT_TEST_SANDBOX:-on}" = off ]; then
    (cd "$worktree" && run_timeout "$TEST_TIMEOUT_SECONDS" bash -c "$tests")
    return $?
  fi
  ensure_docker || return 3
  gitfile="$(cat "$worktree/.git" 2>/dev/null)"
  name="arunachala-test-$run_id"
  echo "== auto: running the tests in the sandbox ($(sandbox_image))"
  run_timeout "$TEST_TIMEOUT_SECONDS" docker run --rm --init --name "$name" \
    --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
    --memory 8g --cpus 4 --pids-limit 1024 \
    --tmpfs /tmp:rw,size=512m --tmpfs /home/agent:rw,exec,size=1g -e HOME=/home/agent \
    -v "$worktree:/workspace" -w /workspace --label "arunachala-run=$run_id" \
    "$(sandbox_image)" bash -c "$tests"
  rc=$?
  docker rm -f "$name" >/dev/null 2>&1 || true   # timed out or stopped: do not leave it running
  if [ -n "$gitfile" ] && { [ ! -f "$worktree/.git" ] || [ "$(cat "$worktree/.git" 2>/dev/null)" != "$gitfile" ]; }; then
    echo "== auto: the tests changed the worktree's .git pointer - restored it"
    rm -rf "$worktree/.git"
    printf '%s\n' "$gitfile" > "$worktree/.git"
  fi
  return "$rc"
}

run_auto() {
  local start_sha tests rc
  start_sha="$(git -C "$(native "$worktree")" rev-parse HEAD)"
  tests="$(test_command)"
  escalated=true
  if [ -z "$tests" ]; then
    echo "== auto: no tests to check a local attempt with - going straight to claude"
  else
    echo "== auto: local attempt with $LOCAL_AGENT (tests: $tests)"
    run_agent "$LOCAL_AGENT" "$LOCAL_TIMEOUT_SECONDS"; rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "== auto: $LOCAL_AGENT finished - running tests"
      run_repo_tests "$tests"; rc=$?
      if [ "$rc" -eq 0 ]; then
        echo "== auto: tests pass - no escalation"
        escalated=false
        return 0
      fi
      echo "== auto: tests failed (exit $rc) - escalating to claude"
    else
      echo "== auto: $LOCAL_AGENT failed (exit $rc) - escalating to claude"
    fi
    # Stopped from the Agents page: do not escalate to a paid run.
    [ -n "$stopped" ] && { echo "== auto: stopped"; return 143; }

    # Multi-Host Agent Federation: Package handoff packet with diagnostics and patch
    if [ -f "$HERE/agent-handoff.js" ]; then
      echo "== auto: packaging multi-host federation handoff ($LOCAL_AGENT -> claude)"
      handoff_prompt_file="$(node "$HERE/agent-handoff.js" prepare "$run_id" "$(native "$worktree")" "$(native "$prompt_file")" "$tests" "$rc" "$log" 2>/dev/null || echo "")"
      if [ -n "$handoff_prompt_file" ] && [ -f "$handoff_prompt_file" ]; then
        prompt="$rules"$'\n'"$(cat "$handoff_prompt_file")"
      fi
    fi

    # Throw away the local attempt; gitignored files (.env copies) survive.
    git -C "$(native "$worktree")" reset -q --hard "$start_sha"
    git -C "$(native "$worktree")" clean -q -fd
  fi
  run_agent claude "$TIMEOUT_SECONDS"
  claude_rc=$?
  if [ -f "$HERE/agent-handoff.js" ]; then
    node "$HERE/agent-handoff.js" resolve "$run_id" "$([ "$claude_rc" -eq 0 ] && echo RESOLVED || echo FAILED)" 2>/dev/null || true
  fi
  return "$claude_rc"
}

escalated=""
set +e
if [ "$agent" = auto ]; then
  run_auto > "$log" 2>&1   # same shell, so escalated= stands
else
  run_agent "$agent" "$TIMEOUT_SECONDS" > "$log" 2>&1
fi
exit_code=$?
set -e

commits="$(git -C "$(native "$worktree")" rev-list --count "$base..HEAD" 2>/dev/null || echo 0)"
status=done
[ "$exit_code" -eq 0 ] || status=failed
[ "$exit_code" -eq 124 ] && status=timed_out
[ -n "$stopped" ] && status=stopped
rm -f "$pidfile"

node "$(native "$HERE/runlog.mjs")" "$runs" id="$run_id" status="$status" \
  exit_code:="$exit_code" duration_s:="$(( $(date +%s) - started ))" \
  commits_ahead:="$commits" head="$(git -C "$(native "$worktree")" rev-parse --short HEAD)" \
  finished_at="$(iso_date)" ${escalated:+escalated:="$escalated"}

echo "$run_id $status (exit $exit_code) log: $log"
exit "$exit_code"
