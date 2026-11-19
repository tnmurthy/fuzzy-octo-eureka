// ecosystem.config.js - the whole stack as PM2 sees it, so a fresh machine (or
// a wiped ~/.pm2) is one command away from running:
//
//   pm2 start ecosystem.config.js && pm2 save
//
// Secrets are not here: each process reads its own .env file (load-env.js),
// named below by path only. Work arrives as GitHub issues (IssuePoller).

const path = require('path');

const ROOT = __dirname;

// Shared restart policy: back off instead of spinning on a crash loop, and
// recycle a process that leaks instead of letting it take the machine down.
const base = {
  cwd: ROOT,
  interpreter: 'node',
  autorestart: true,
  exp_backoff_restart_delay: 2000,
  max_memory_restart: '512M',
  kill_timeout: 5000,
  time: true,
};

module.exports = {
  apps: [
    {
      ...base,
      name: 'ArunachalaDashboard',
      script: path.join(ROOT, 'server.js'),
      env: { PORT: '8787' },
      // Agent runs are detached children of this server. PM2's default
      // treekill stopped them on every restart (issue #34's hermes run died
      // with exit 130 mid-task on 2026-11-17). Runs have their own timeouts.
      treekill: false,
    },
    {
      ...base,
      name: 'DrisyonDashboard',
      script: path.join(ROOT, 'server.js'),
      env: {
        PORT: '8788',
        DASHBOARD_ENV_FILE: path.join(ROOT, '.env.drisyon'),
      },
    },
    {
      ...base,
      name: 'ArunachalaTelemetry',
      script: path.join(ROOT, 'telemetry-daemon.js'),
    },
    {
      // GitHub issues labelled agent:ready -> agent runs -> PRs. Idles (and
      // says so once an hour) until GITHUB_TOKEN is in the secrets file.
      ...base,
      name: 'IssuePoller',
      script: path.join(ROOT, 'orchestration', 'issue-poller.js'),
      max_memory_restart: '256M',
      env: { DASHBOARD_URL: 'http://127.0.0.1:8787' },
    },
    {
      // canvas.mytestbed.tech -> tunnel -> here -> OpenHands on 127.0.0.1:3000.
      // Re-checks the Cloudflare Access JWT (app "OpenHands Canvas") on every
      // request and WebSocket; refuses to start without CANVAS_ACCESS_AUD.
      ...base,
      name: 'CanvasGate',
      script: path.join(ROOT, 'canvas-gate.js'),
      max_memory_restart: '256M',
      env: {
        CANVAS_GATE_PORT: '3001',
        OPENHANDS_PORT: '3000',
        CANVAS_ACCESS_AUD: '851ddaae37f988f3eaa3305496b6e9afd729e14b844630e2b9d318cd1f246d53',
      },
    },
    {
      name: 'CloudflareTunnel',
      script: '/Users/arunachala/.local/bin/cloudflared',
      args: 'tunnel --config /Users/arunachala/.cloudflared/config.yml run d23b354e-faee-451b-a23b-6df6bdec117f',
      autorestart: true,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '256M',
      time: true,
    },
  ],
};
