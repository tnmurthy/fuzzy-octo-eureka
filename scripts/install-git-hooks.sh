#!/usr/bin/env bash
# scripts/install-git-hooks.sh - Installs automated reload hooks for git
# Ensures that subsequent sprint merges automatically reload PM2 services.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_DIR="${REPO_ROOT}/.git/hooks"

if [ ! -d "${HOOKS_DIR}" ]; then
  echo "Error: .git/hooks directory not found at ${HOOKS_DIR}"
  exit 1
fi

POST_MERGE_HOOK="${HOOKS_DIR}/post-merge"

cat << 'EOF' > "${POST_MERGE_HOOK}"
#!/usr/bin/env bash
# .git/hooks/post-merge - Auto-reloads Arunachala & Drisyon dashboards in PM2

echo "🔄 [Auto-Reload] Changes merged to working copy."
if command -v pm2 >/dev/null 2>&1; then
  echo "🚀 [Auto-Reload] Reloading ArunachalaDashboard & DrisyonDashboard under PM2..."
  pm2 reload ArunachalaDashboard DrisyonDashboard --update-env 2>/dev/null || {
    echo "⚠️ PM2 reload failed or services not running. Try 'pm2 start ecosystem.config.js'."
  }
else
  echo "ℹ️ PM2 is not installed globally or not in PATH; skipping process reload."
fi
EOF

chmod +x "${POST_MERGE_HOOK}"
echo "✅ Installed .git/hooks/post-merge successfully."
