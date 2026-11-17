// team-manager.js - Orchestrates the Buzz AI Team locally on Apple Silicon Mac Studio.
// Handles activation, deactivation, status polling, and dispatch for drisyon-ai communities relay.
//
// The team is "active" when its bridge process is online under PM2. The
// process is defined in ecosystem.config.js; activation registers it from
// there when PM2 does not know it yet (fresh machine, wiped ~/.pm2), so a
// login never fails with "Process ... not found".

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const PM2_NAME = process.env.TEAM_BRIDGE_PM2_NAME || 'ArunachalaDrisyonBridge';
const ECOSYSTEM_FILE = path.join(__dirname, 'ecosystem.config.js');
const RELAY_URL = 'wss://drisyon-ai.communities.buzz.xyz';
const BUZZ_CLI = process.env.BUZZ_CLI || '/Applications/Buzz.app/Contents/MacOS/buzz';
const OPERATOR_HEX = 'bd11c441f791cd9c2f390f435986e9c7a66b6d8ba469e22470543e6424080e84';
const BOT_PUBKEY = '9dd7a860bee06c9b9034031e499837cb967f92101797551d1687f60610421fdd';
const PM2_TIMEOUT_MS = 20000;
const BUZZ_TIMEOUT_MS = 20000;

const CHANNELS = [
  { id: '04ad4d05-a062-5233-b605-4d69ace72555', name: 'general' },
  { id: '6a9f5064-50b5-49bb-b1e8-5ca828a4f29e', name: 'arunachala-dashboard' },
  { id: 'f8d05965-8b26-49f1-bd6c-c6130393ed55', name: 'paperclip-tt-company' },
  { id: 'fc960810-ab71-4491-ae0c-704ce497b3b0', name: 'buzz' },
  { id: 'c9d15b53-fc4f-5e38-82d8-8e7be401f9b0', name: 'welcome-everyone' },
  { id: '66317052-e038-4e4c-8aca-fb5f607aeec2', name: 'drisyon-operations-center' }
];

const CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PM2 lives beside whichever node runs this server (nvm installs both in one
// bin dir), so no node version is hard-coded. PM2_BIN overrides.
function resolvePm2Bin({ env = process.env, execPath = process.execPath, existsSync = fs.existsSync } = {}) {
  const candidates = [env.PM2_BIN, path.join(path.dirname(execPath), 'pm2')].filter(Boolean);
  return candidates.find((c) => existsSync(c)) || 'pm2';
}

/**
 * @param {{ execFileSync?: Function, env?: object, existsSync?: Function, execPath?: string }} [deps]
 */
function createTeamManager(deps = {}) {
  const execFileSync = deps.execFileSync || childProcess.execFileSync;
  const env = deps.env || process.env;
  const existsSync = deps.existsSync || fs.existsSync;
  const execPath = deps.execPath || process.execPath;
  // The bridge can only be (re)started if the ecosystem file still defines it.
  const ecosystemApps = deps.ecosystemApps || (() => {
    try { return require(ECOSYSTEM_FILE).apps.map((a) => a.name); } catch (_) { return []; }
  });

  let lastActivatedAt = Date.now();
  let lastActivatedBy = 'system';

  // pm2 is a node script (#!/usr/bin/env node): keep this node first on PATH.
  const pm2Env = () => Object.assign({}, env, {
    PATH: [path.dirname(execPath), env.PATH].filter(Boolean).join(path.delimiter),
  });

  function pm2(args) {
    return execFileSync(resolvePm2Bin({ env, execPath, existsSync }), args, {
      encoding: 'utf8',
      env: pm2Env(),
      timeout: PM2_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  function findBridge() {
    const list = JSON.parse(pm2(['jlist']));
    return list.find((p) => p.name === PM2_NAME) || null;
  }

  function getTeamStatus() {
    let processStatus;
    let pid = null;
    let uptime = null;
    let restarts = 0;

    try {
      const bridgeProc = findBridge();
      if (bridgeProc) {
        processStatus = bridgeProc.pm2_env?.status || 'stopped';
        pid = bridgeProc.pid;
        uptime = bridgeProc.pm2_env?.pm_uptime ? Math.floor((Date.now() - bridgeProc.pm2_env.pm_uptime) / 1000) : null;
        restarts = bridgeProc.pm2_env?.restart_time || 0;
      } else {
        processStatus = 'not_registered';
      }
    } catch (err) {
      processStatus = 'error: ' + err.message;
    }

    return {
      active: processStatus === 'online',
      processStatus,
      pid,
      uptimeSec: uptime,
      restarts,
      relayUrl: RELAY_URL,
      botName: 'arunachala',
      botPubkey: BOT_PUBKEY,
      operator: 'NM (' + OPERATOR_HEX.slice(0, 8) + '...)',
      channels: CHANNELS,
      localModels: ['gemma3:4b', 'qwen2.5-coder:3b'],
      lastActivatedAt,
      lastActivatedBy,
    };
  }

  function activateTeam(triggeredBy = 'User Login') {
    lastActivatedAt = Date.now();
    lastActivatedBy = triggeredBy;

    try {
      const status = getTeamStatus();
      if (status.active) {
        return { ok: true, status: 'already_active', details: status };
      }

      if (!ecosystemApps().includes(PM2_NAME)) {
        return {
          ok: false,
          status: 'disabled',
          error: `${PM2_NAME} is not defined in ecosystem.config.js (Buzz bridge retired; work arrives as GitHub issues)`,
        };
      }

      if (status.processStatus === 'not_registered') {
        // PM2 has never seen the bridge on this machine: register it from the
        // ecosystem file and persist, so it also survives a reboot.
        pm2(['start', ECOSYSTEM_FILE, '--only', PM2_NAME]);
        try { pm2(['save']); } catch (_) { /* running is what matters; save is best-effort */ }
      } else {
        pm2(['restart', PM2_NAME, '--update-env']);
      }

      return {
        ok: true,
        status: 'activated',
        message: `Buzz AI Team successfully activated locally on Mac Studio (${triggeredBy})`,
        details: getTeamStatus()
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function deactivateTeam() {
    try {
      pm2(['stop', PM2_NAME]);
      return { ok: true, status: 'deactivated', message: 'Buzz AI Team deactivated' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // The signing key comes from the environment (the secrets file named by
  // SECRETS_ENV_FILE) and reaches the CLI through its environment - never
  // argv, where any local user could read it from the process list. No shell:
  // message content is one argument, whatever characters it holds.
  function sendDirective(channelId, content) {
    const privateKey = env.BUZZ_DIRECTIVE_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('BUZZ_DIRECTIVE_PRIVATE_KEY is not set (put it in the secrets file named by SECRETS_ENV_FILE)');
    }
    if (typeof channelId !== 'string' || !CHANNEL_ID_RE.test(channelId)) {
      throw new Error('channelId must be a channel UUID');
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('content must be a non-empty string');
    }
    if (!existsSync(BUZZ_CLI)) {
      throw new Error('Buzz CLI binary not found at ' + BUZZ_CLI);
    }
    const out = execFileSync(BUZZ_CLI, ['messages', 'send', '--channel', channelId, '--content', content], {
      encoding: 'utf8',
      timeout: BUZZ_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, env, {
        BUZZ_RELAY_URL: RELAY_URL.replace(/^ws/, 'http'),
        BUZZ_PRIVATE_KEY: privateKey,
      }),
    });
    return JSON.parse(out);
  }

  return { getTeamStatus, activateTeam, deactivateTeam, sendDirective };
}

module.exports = Object.assign(createTeamManager(), {
  createTeamManager,
  resolvePm2Bin,
  CHANNELS,
  PM2_NAME,
});
