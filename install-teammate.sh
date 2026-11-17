#!/usr/bin/env bash
# install-teammate.sh - Set up Arunachala on macOS / Linux:
# Prerequisites check, local models, configuration (.env), npm dependencies,
# and PM2 background services (from ecosystem.config.js).
#
# Usage:
#   ./install-teammate.sh --dry-run
#   ./install-teammate.sh
#   ./install-teammate.sh --supabase-url https://<ref>.supabase.co --supabase-key sb_publishable_... --team-id <uuid>
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"
ENV_FILE="$ROOT/.env"
MODELS=("gemma3:4b" "qwen2.5-coder:3b" "nomic-embed-text")
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=12

DRY_RUN=false
SUPABASE_URL=""
SUPABASE_KEY=""
TEAM_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-d) DRY_RUN=true; shift ;;
    --supabase-url) SUPABASE_URL="$2"; shift 2 ;;
    --supabase-key) SUPABASE_KEY="$2"; shift 2 ;;
    --team-id) TEAM_ID="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

say() { echo "  $1"; }
step() { echo ""; echo "== $1"; }
problem() { echo "  MISSING: $1" >&2; PROBLEMS+=("$1"); }
PROBLEMS=()

get_env_val() {
  local file="$1" key="$2"
  [ -f "$file" ] && grep -E "^[[:space:]]*${key}=" "$file" | head -n 1 | cut -d'=' -f2- | tr -d '"' | tr -d "'" || true
}

set_env_val() {
  local file="$1" key="$2" val="$3"
  if [ ! -f "$file" ]; then
    echo "${key}=${val}" > "$file"
    return
  fi
  if grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" "$file"; then
    # Portable in-place replacement (works on BSD/macOS and GNU sed)
    local tmp="${file}.tmp.$$"
    awk -v k="$key" -v v="$val" '
      $0 ~ "^[[:space:]]*#?[[:space:]]*" k "=" { if (!done) { print k "=" v; done=1; next } }
      { print }
      END { if (!done) print k "=" v }
    ' "$file" > "$tmp" && mv "$tmp" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

ask() {
  local prompt="$1" current="$2"
  if [ -n "$current" ]; then
    printf '%s\n' "$current"
    return
  fi
  local ans=""
  while [ -z "$ans" ]; do
    read -r -p "  $prompt: " ans
    ans="$(echo "$ans" | tr -d '\r\n')"
  done
  printf '%s\n' "$ans"
}

# --- 1. Prerequisites ---------------------------------------------------------
test_prerequisites() {
  step "Prerequisites"

  if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node -v | tr -d 'v')"
    NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
    NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
    if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
      problem "Node.js $NODE_VER is too old - need >= 20.12.0 (brew install node@22)"
    else
      say "node $NODE_VER ok"
    fi
  else
    problem "Node.js 20.12+ (brew install node@22)"
  fi

  if command -v git >/dev/null 2>&1; then say "git ok"; else problem "git (brew install git)"; fi
  if command -v docker >/dev/null 2>&1; then say "docker ok"; else problem "Docker / OrbStack (brew install --cask orbstack)"; fi
  if command -v ollama >/dev/null 2>&1; then say "ollama ok"; else problem "Ollama (brew install ollama)"; fi

  if command -v pm2 >/dev/null 2>&1; then
    say "pm2 ok"
  else
    say "pm2 not found; recommended for auto-restarting services (npm install -g pm2)"
  fi

  if [ "$(uname)" = "Darwin" ]; then
    if command -v gtimeout >/dev/null 2>&1 || command -v timeout >/dev/null 2>&1; then
      say "coreutils/timeout ok"
    else
      say "Note: coreutils recommended on macOS for timeout management (brew install coreutils)"
    fi
  fi
}

# --- 2. Local Models ----------------------------------------------------------
install_models() {
  step "Local models (Ollama)"
  if ! command -v ollama >/dev/null 2>&1; then
    say "skipped - Ollama not found"
    return
  fi
  local have
  have="$(ollama list 2>/dev/null | tail -n +2 | awk '{print $1}')"
  for m in "${MODELS[@]}"; do
    if echo "$have" | grep -qE "^(${m}|${m}:latest)$"; then
      say "$m already present"
    elif [ "$DRY_RUN" = true ]; then
      say "would pull $m"
    else
      say "pulling $m ..."
      ollama pull "$m"
    fi
  done
}

# --- 3. Configuration ---------------------------------------------------------
configure_env() {
  step "Dashboard settings (.env)"
  if [ "$DRY_RUN" = true ]; then
    if [ -f "$ENV_FILE" ]; then
      say ".env exists"
    else
      say "would create .env from .env.example"
    fi
    return
  fi

  if [ ! -f "$ENV_FILE" ]; then
    cp "$ROOT/.env.example" "$ENV_FILE"
    say "created .env from .env.example"
  fi

  local name home url key team email pass
  name="$(ask "Your first name (shown in dashboard)" "$(get_env_val "$ENV_FILE" "OPERATOR_NAME")")"
  set_env_val "$ENV_FILE" "OPERATOR_NAME" "$name"

  home="$(get_env_val "$ENV_FILE" "OPERATOR_HOME")"
  [ -z "$home" ] && home="$HOME"
  set_env_val "$ENV_FILE" "OPERATOR_HOME" "$home"
  set_env_val "$ENV_FILE" "STACK_ROOT" "$(cd "$ROOT/../../.." 2>/dev/null && pwd || echo "$HOME/tt-ai-stack")"
  set_env_val "$ENV_FILE" "DISPATCH_BASH_BIN" "$(command -v bash)"

  say "Shared team context (from your admin). Leave blank to stay solo for now."
  url="${SUPABASE_URL:-$(get_env_val "$ENV_FILE" "SUPABASE_URL")}"
  if [ -z "$url" ]; then
    read -r -p "  Supabase URL (https://<ref>.supabase.co, or Enter to skip): " url
  fi

  if [ -n "$url" ]; then
    set_env_val "$ENV_FILE" "SUPABASE_URL" "$url"
    key="${SUPABASE_KEY:-$(get_env_val "$ENV_FILE" "SUPABASE_PUBLISHABLE_KEY")}"
    [ -z "$key" ] && key="$(ask "Supabase publishable key (sb_publishable_...)" "")"
    set_env_val "$ENV_FILE" "SUPABASE_PUBLISHABLE_KEY" "$key"

    team="${TEAM_ID:-$(get_env_val "$ENV_FILE" "TEAM_ID")}"
    [ -z "$team" ] && team="$(ask "Team ID (UUID from admin)" "")"
    set_env_val "$ENV_FILE" "TEAM_ID" "$team"

    email="$(ask "Your Supabase login email" "$(get_env_val "$ENV_FILE" "SUPABASE_EMAIL")")"
    set_env_val "$ENV_FILE" "SUPABASE_EMAIL" "$email"

    pass="$(get_env_val "$ENV_FILE" "SUPABASE_PASSWORD")"
    if [ -z "$pass" ]; then
      read -s -r -p "  Your Supabase password (hidden): " pass
      echo ""
      [ -n "$pass" ] && set_env_val "$ENV_FILE" "SUPABASE_PASSWORD" "$pass"
    fi
  else
    say "team sync left off (solo install)"
  fi
}

# --- 4. Services --------------------------------------------------------------
start_services() {
  step "Services (PM2)"
  mkdir -p "$LOGS"

  if ! command -v pm2 >/dev/null 2>&1; then
    say "PM2 not found. You can run manually:"
    say "  node server.js &"
    say "  node telemetry-daemon.js &"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    say "would start the services in ecosystem.config.js via pm2"
    return
  fi

  pm2 start "$ROOT/ecosystem.config.js" || true
  pm2 save || true
  say "PM2 services started and saved"
}

# --- 5. Check -----------------------------------------------------------------
test_install() {
  step "Verify installation"
  if [ "$DRY_RUN" = true ]; then
    say "would probe http://127.0.0.1:8787/api/config"
    return
  fi

  sleep 3
  if command -v curl >/dev/null 2>&1; then
    if curl -s -f "http://127.0.0.1:8787/api/config" >/dev/null 2>&1; then
      say "Dashboard is responding at http://127.0.0.1:8787"
    else
      say "Dashboard did not respond on 8787 yet (check logs/ or pm2 logs)"
    fi
  fi
}

# --- Main ---------------------------------------------------------------------
echo "=== Arunachala Installer (macOS / Linux) ==="
[ "$DRY_RUN" = true ] && echo "DRY RUN MODE: No changes will be made."

test_prerequisites
if [ ${#PROBLEMS[@]} -gt 0 ] && [ "$DRY_RUN" = false ]; then
  echo ""
  echo "Please fix the missing prerequisites above and re-run."
  exit 1
fi

install_models
configure_env
start_services
test_install

echo ""
echo "Setup finished. You can view the dashboard at http://127.0.0.1:8787"
