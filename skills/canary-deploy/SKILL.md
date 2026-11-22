---
name: canary-deploy
description: Safe process restarts, PM2 lifecycle management, and zero-downtime rollbacks.
triggers: [deploy, release, canary, rollback, pm2, restart, healthcheck]
file_patterns: ["*ecosystem*.js", "*server*.js", "*.sh"]
---

# Canary & Safe Deployment Principles

## Core Invariants
1. Validate health check endpoints (e.g. GET /api/auth/status or /health) before completing deployment.
2. Use graceful reloads (`pm2 reload <app>`) rather than sudden SIGKILL (`kill -9`).
3. Keep automated rollback triggers if health check fails within 30 seconds of rollout.
4. Maintain clean state checkpoints and verify port bindings before declaring success.
