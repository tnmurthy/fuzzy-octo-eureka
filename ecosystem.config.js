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
  ],
};
