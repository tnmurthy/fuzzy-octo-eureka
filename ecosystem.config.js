// ecosystem.config.js - the whole stack as PM2 sees it, so a fresh machine (or
// a wiped ~/.pm2) is one command away from running:
//
//   pm2 start ecosystem.config.js && pm2 save
//
// Secrets are not here: each process reads its own .env file (load-env.js,
// bridge.js), named below by path only.
//
// The two dashboards and the two bridges are pairs. A bridge triggers runs on
// its own dashboard (DASHBOARD_URL), and that dashboard's agent-dispatch.sh
// reports back to its own bridge (BRIDGE_NOTIFY_PORT) - cross them and a
// finished run is announced to a bridge that never asked for it.

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
      env: { PORT: '8787', BRIDGE_NOTIFY_PORT: '3100' },
    },
    {
      ...base,
      name: 'DrisyonDashboard',
      script: path.join(ROOT, 'server.js'),
      env: {
        PORT: '8788',
        DASHBOARD_ENV_FILE: path.join(ROOT, '.env.drisyon'),
        BRIDGE_NOTIFY_PORT: '3101',
      },
    },
    {
      ...base,
      name: 'ArunachalaTelemetry',
      script: path.join(ROOT, 'telemetry-daemon.js'),
    },
    {
      ...base,
      name: 'ArunachalaBuzzBridge',
      script: path.join(ROOT, 'buzz-bridge', 'bridge.js'),
      env: { DASHBOARD_URL: 'http://127.0.0.1:8787' },
    },
    {
      ...base,
      name: 'ArunachalaDrisyonBridge',
      script: path.join(ROOT, 'buzz-bridge', 'bridge.js'),
      env: {
        BRIDGE_ENV_FILE: path.join(ROOT, 'buzz-bridge', '.env.drisyon'),
        DASHBOARD_URL: 'http://127.0.0.1:8788',
      },
    },
  ],
};
