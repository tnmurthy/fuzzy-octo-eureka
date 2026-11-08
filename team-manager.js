// team-manager.js - Orchestrates the Buzz AI Team locally on Apple Silicon Mac Studio.
// Handles activation, deactivation, status polling, and dispatch for drisyon-ai communities relay.

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PM2_NAME = 'ArunachalaDrisyonBridge';
const RELAY_URL = 'wss://drisyon-ai.communities.buzz.xyz';
const BUZZ_CLI = '/Applications/Buzz.app/Contents/MacOS/buzz';
const OPERATOR_HEX = 'bd11c441f791cd9c2f390f435986e9c7a66b6d8ba469e22470543e6424080e84';
const BOT_PUBKEY = '9dd7a860bee06c9b9034031e499837cb967f92101797551d1687f60610421fdd';

const CHANNELS = [
  { id: '04ad4d05-a062-5233-b605-4d69ace72555', name: 'general' },
  { id: '6a9f5064-50b5-49bb-b1e8-5ca828a4f29e', name: 'arunachala-dashboard' },
  { id: 'f8d05965-8b26-49f1-bd6c-c6130393ed55', name: 'paperclip-tt-company' },
  { id: 'fc960810-ab71-4491-ae0c-704ce497b3b0', name: 'buzz' },
  { id: 'c9d15b53-fc4f-5e38-82d8-8e7be401f9b0', name: 'welcome-everyone' },
  { id: '66317052-e038-4e4c-8aca-fb5f607aeec2', name: 'drisyon-operations-center' }
];

let lastActivatedAt = Date.now();
let lastActivatedBy = 'system';

function getPm2Bin() {
  const custom = path.join(process.env.HOME || '/Users/Sriad', '.nvm/versions/node/v26.13.0/bin/pm2');
  if (fs.existsSync(custom)) return custom;
  return 'pm2';
}

function getTeamStatus() {
  const pm2 = getPm2Bin();
  let processStatus = 'unknown';
  let pid = null;
  let uptime = null;
  let restarts = 0;

  try {
    const jsonStr = execSync(`${pm2} jlist`, { encoding: 'utf8', env: process.env });
    const list = JSON.parse(jsonStr);
    const bridgeProc = list.find(p => p.name === PM2_NAME);
    if (bridgeProc) {
      processStatus = bridgeProc.pm2_env?.status || 'stopped';
      pid = bridgeProc.pid;
      uptime = bridgeProc.pm2_env?.pm_uptime ? Math.floor((Date.now() - bridgeProc.pm2_env.pm_uptime) / 1000) : null;
      restarts = bridgeProc.pm2_env?.restart_time || 0;
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
  const pm2 = getPm2Bin();
  lastActivatedAt = Date.now();
  lastActivatedBy = triggeredBy;

  try {
    // Check if process exists and is online
    const status = getTeamStatus();
    if (status.active) {
      return { ok: true, status: 'already_active', details: status };
    }

    // Start or restart via PM2
    execSync(`${pm2} restart ${PM2_NAME} --update-env`, {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        PATH: `${path.join(process.env.HOME || '/Users/Sriad', '.nvm/versions/node/v26.13.0/bin')}:${process.env.PATH}`
      })
    });

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
  const pm2 = getPm2Bin();
  try {
    execSync(`${pm2} stop ${PM2_NAME}`, { encoding: 'utf8', env: process.env });
    return { ok: true, status: 'deactivated', message: 'Buzz AI Team deactivated' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sendDirective(channelId, content) {
  const nsecKey = 'nsec1hq653n7ugw9kc4a6g8k09matw6yfzat24suv6cypanu4lcz5kakswz6pc9';
  if (!fs.existsSync(BUZZ_CLI)) {
    throw new Error('Buzz CLI binary not found at ' + BUZZ_CLI);
  }
  const cmd = `${BUZZ_CLI} --relay https://drisyon-ai.communities.buzz.xyz --private-key ${nsecKey} messages send --channel ${channelId} --content ${JSON.stringify(content)}`;
  const out = execSync(cmd, { encoding: 'utf8', env: process.env });
  return JSON.parse(out);
}

module.exports = {
  getTeamStatus,
  activateTeam,
  deactivateTeam,
  sendDirective,
  CHANNELS,
};
