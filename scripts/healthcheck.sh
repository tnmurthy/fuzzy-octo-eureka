#!/usr/bin/env bash
# scripts/healthcheck.sh - Unified Infrastructure Health Probe
# Checks all 6 core ports, PM2 daemon processes, and local Ollama inference.
#
# Usage:
#   bash scripts/healthcheck.sh          # Human-readable terminal output
#   bash scripts/healthcheck.sh --json   # Structured JSON for monitoring/dashboards

set -u

JSON_MODE=false
if [ "${1:-}" = "--json" ]; then
  JSON_MODE=true
fi

# ANSI Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SERVICES=(
  "Arunachala Dashboard|http://127.0.0.1:8787/api/auth/status|8787|200,401"
  "Drisyon Portal|http://127.0.0.1:8788/api/auth/status|8788|200,401"
  "Canvas Gate (Lock)|http://127.0.0.1:3001/|3001|200,403"
  "OpenHands Canvas|http://127.0.0.1:3000/|3000|200"
  "Meilisearch Signals|http://127.0.0.1:7700/health|7700|200"
  "Ollama Inference|http://127.0.0.1:11434/api/tags|11434|200"
)

TOTAL=${#SERVICES[@]}
ONLINE_COUNT=0
JSON_ITEMS=()

if [ "$JSON_MODE" = false ]; then
  echo -e "${BOLD}${CYAN}🔍 Arunachala Infrastructure Health Probe${NC}"
  echo -e "${BLUE}========================================================================${NC}"
  printf "%-24s %-8s %-12s %-10s %s\n" "SERVICE" "PORT" "STATUS" "LATENCY" "DETAILS"
  echo -e "${BLUE}------------------------------------------------------------------------${NC}"
fi

for entry in "${SERVICES[@]}"; do
  IFS='|' read -r name url port expected_codes <<< "$entry"
  
  START_TIME=$(python3 -c "import time; print(int(time.time() * 1000))" 2>/dev/null || date +%s)
  
  # Probe HTTP endpoint with 2 second timeout
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "$url" 2>/dev/null)
  
  END_TIME=$(python3 -c "import time; print(int(time.time() * 1000))" 2>/dev/null || date +%s)
  LATENCY_MS=$((END_TIME - START_TIME))
  if [ "$LATENCY_MS" -lt 0 ]; then LATENCY_MS=0; fi

  STATUS="OFFLINE"
  COLOR="$RED"
  DETAILS="Connection refused"

  if [ -n "$HTTP_CODE" ] && [ "$HTTP_CODE" != "000" ]; then
    # Match expected HTTP codes
    IFS=',' read -ra CODES <<< "$expected_codes"
    IS_MATCH=false
    for c in "${CODES[@]}"; do
      if [ "$HTTP_CODE" = "$c" ]; then
        IS_MATCH=true
        break
      fi
    done

    if [ "$IS_MATCH" = true ]; then
      ONLINE_COUNT=$((ONLINE_COUNT + 1))
      if [ "$HTTP_CODE" = "403" ]; then
        STATUS="LOCKED"
        COLOR="$YELLOW"
        DETAILS="Access Gate active (403)"
      else
        STATUS="ONLINE"
        COLOR="$GREEN"
        DETAILS="HTTP ${HTTP_CODE} OK"
      fi
    else
      STATUS="DEGRADED"
      COLOR="$YELLOW"
      DETAILS="HTTP ${HTTP_CODE}"
    fi
  else
    HTTP_CODE="000"
  fi

  # Extra details for Ollama models
  if [ "$port" = "11434" ] && [ "$STATUS" = "ONLINE" ]; then
    MODELS_COUNT=$(curl -s --max-time 2 http://127.0.0.1:11434/api/tags 2>/dev/null | grep -o '"name":' | wc -l | tr -d ' ')
    DETAILS="${MODELS_COUNT} model(s) loaded"
  fi

  if [ "$JSON_MODE" = false ]; then
    printf "%-24s %-8s ${COLOR}%-12s${NC} %-10s %s\n" "$name" "$port" "$STATUS" "${LATENCY_MS}ms" "$DETAILS"
  else
    JSON_ITEMS+=("{\"name\":\"$name\",\"port\":$port,\"status\":\"$STATUS\",\"httpCode\":\"$HTTP_CODE\",\"latencyMs\":$LATENCY_MS,\"details\":\"$DETAILS\"}")
  fi
done

if [ "$JSON_MODE" = false ]; then
  echo -e "${BLUE}========================================================================${NC}"
  echo -e "${BOLD}Summary:${NC} ${ONLINE_COUNT}/${TOTAL} services responding."
  
  # PM2 Status Check
  echo ""
  echo -e "${BOLD}PM2 Supervision:${NC}"
  if command -v pm2 >/dev/null 2>&1; then
    pm2 status 2>/dev/null || echo -e "  ${YELLOW}PM2 daemon not currently running. Run 'pm2 start ecosystem.config.js'.${NC}"
  else
    echo -e "  ${YELLOW}PM2 command not in PATH.${NC}"
  fi
else
  # Output structured JSON
  IFS=','
  echo "{\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",\"online\":$ONLINE_COUNT,\"total\":$TOTAL,\"services\":[${JSON_ITEMS[*]}]}"
fi
