// load-env.js - per-person settings: .env next to the code, then the secrets
// file it names in SECRETS_ENV_FILE (e.g. C:\tt-ai-stack\04_internal\secrets\
// arunachala-team.env). Passwords stay in the secrets folder, never in the
// project folder. process.loadEnvFile never overwrites a variable already set,
// so .env wins over the secrets file for the same key. Problems are reported
// by path only - never a value.

const path = require('path');

function loadEnv(dir, log = console.error) {
  const envPath = process.env.DASHBOARD_ENV_FILE || path.join(dir, '.env');
  try { process.loadEnvFile(envPath); } catch { /* no .env: defaults */ }
  const secrets = process.env.SECRETS_ENV_FILE;
  if (!secrets) return;
  try {
    process.loadEnvFile(secrets);
  } catch (err) {
    log(`secrets file not loaded: ${secrets} (${err.code || 'unreadable'})`);
  }
}

module.exports = { loadEnv };
