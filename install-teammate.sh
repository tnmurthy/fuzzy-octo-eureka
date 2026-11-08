#!/usr/bin/env bash
# install-teammate.sh - Set up Arunachala on macOS / Linux:
# Prerequisites check, local models, configuration (.env), npm dependencies,
# PM2 background services, and the n8n dispatch workflow.
#
# Usage:
#   ./install-teammate.sh --dry-run
#   ./install-teammate.sh
#   ./install-teammate.sh --supabase-url https://<ref>.supabase.co --supabase-key sb_publishable_... --team-id <uuid> --buzz-channels <hex>
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"
BRIDGE="$ROOT/buzz-bridge"
ENV_FILE="$ROOT/.env"
BRIDGE_ENV_FILE="$BRIDGE/.env"
MODELS=("gemma3:4b" "qwen2.5-coder:3b" "nomic-embed-text")
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=12

DRY_RUN=false
SUPABASE_URL=""
SUPABASE_KEY=""
TEAM_ID=""
BUZZ_CHANNELS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|-d) DRY_RUN=true; shift ;;
    --supabase-url) SUPABASE_URL="$2"; shift 2 ;;
    --supabase-key) SUPABASE_KEY="$2"; shift 2 ;;
    --team-id) TEAM_ID="$2"; shift 2 ;;
    --buzz-channels) BUZZ_CHANNELS="$2"; shift 2 ;;
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

configure_bridge_env() {
  step "Buzz bridge settings (buzz-bridge/.env)"
  if [ "$DRY_RUN" = true ]; then
    [ -f "$BRIDGE_ENV_FILE" ] && say "buzz-bridge/.env exists" || say "would create buzz-bridge/.env"
    return
  fi

  if [ ! -f "$BRIDGE_ENV_FILE" ]; then
    cp "$BRIDGE/.env.example" "$BRIDGE_ENV_FILE"
    say "created buzz-bridge/.env from .env.example"
  fi

  local ops bname chans
  ops="$(ask "Your Buzz public key (64 hex characters)" "$(get_env_val "$BRIDGE_ENV_FILE" "BUZZ_OPERATORS")")"
  set_env_val "$BRIDGE_ENV_FILE" "BUZZ_OPERATORS" "$ops"

  bname="$(ask "Your bot's name, unique on the team" "$(get_env_val "$BRIDGE_ENV_FILE" "BUZZ_BOT_NAME")")"
  set_env_val "$BRIDGE_ENV_FILE" "BUZZ_BOT_NAME" "$bname"

  chans="${BUZZ_CHANNELS:-$(get_env_val "$BRIDGE_ENV_FILE" "BUZZ_BOT_CHANNELS")}"
  [ -z "$chans" ] && chans="$(ask "Buzz channel id(s) (comma-separated hex)" "")"
  set_env_val "$BRIDGE_ENV_FILE" "BUZZ_BOT_CHANNELS" "$chans"
}

# --- 4. Packages --------------------------------------------------------------
install_packages() {
  step "Dependencies (buzz-bridge npm packages)"
  if [ -d "$BRIDGE/node_modules/nostr-tools" ]; then
    say "packages already installed"
    return
  fi
  if [ "$DRY_RUN" = true ]; then
    say "would run npm ci in buzz-bridge"
    return
  fi
  (cd "$BRIDGE" && npm ci)
}

# --- 5. n8n Dispatch Workflow -------------------------------------------------
install_n8n() {
  step "n8n dispatch workflow"
  if ! command -v docker >/dev/null 2>&1; then
    say "skipped - Docker not installed"
    return
  fi

  local workflow="$ROOT/n8n/buzz-dispatch-workflow.json"
  local running
  running="$(docker ps --filter 'name=^n8n$' --format '{{.Names}}' 2>/dev/null || true)"

  if [ "$DRY_RUN" = true ]; then
    if [ -n "$running" ]; then
      say "n8n container running - would import buzz-dispatch workflow"
    else
      say "would start n8n container and import workflow"
    fi
    return
  fi

  if [ -z "$running" ]; then
    local exists
    exists="$(docker ps -a --filter 'name=^n8n$' --format '{{.Names}}' 2>/dev/null || true)"
    if [ -n "$exists" ]; then
      docker start n8n >/dev/null
    else
      docker run -d --name n8n \
        --restart unless-stopped \
        -p 127.0.0.1:5678:5678 \
        -v n8n_data:/home/node/.n8n \
        docker.n8n.io/n8nio/n8n:latest >/dev/null
    fi
    sleep 8
  fi

  docker cp "$workflow" n8n:/tmp/buzz-dispatch-workflow.json
  docker exec n8n n8n import:workflow --input=/tmp/buzz-dispatch-workflow.json || true
  say "Imported workflow to n8n (http://127.0.0.1:5678)"
}

# --- 6. Services --------------------------------------------------------------
start_services() {
  step "Services (PM2)"
  mkdir -p "$LOGS"

  if ! command -v pm2 >/dev/null 2>&1; then
    say "PM2 not found. You can run manually:"
    say "  node server.js &"
    say "  node buzz-bridge/bridge.js &"
    say "  node telemetry-daemon.js &"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    say "would start ArunachalaDashboard, ArunachalaBuzzBridge, ArunachalaTelemetry via pm2"
    return
  fi

  pm2 start "$ROOT/server.js" --name "ArunachalaDashboard" || true
  pm2 start "$ROOT/buzz-bridge/bridge.js" --name "ArunachalaBuzzBridge" || true
  pm2 start "$ROOT/telemetry-daemon.js" --name "ArunachalaTelemetry" || true
  pm2 save || true
  say "PM2 services started and saved"
}

# --- 7. Check -----------------------------------------------------------------
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
configure_bridge_env
install_packages
install_n8n
start_services
test_install

echo ""
echo "Setup finished. You can view the dashboard at http://127.0.0.1:8787"
