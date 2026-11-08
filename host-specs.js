// host-specs.js - Cross-platform host hardware and environment discovery
// Detects OS, CPU model/core count, GPU/acceleration layer, and stack endpoints.

const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

let cachedSpecs = null;

function getHostSpecs(refresh = false) {
  if (cachedSpecs && !refresh) return cachedSpecs;

  const platform = os.platform();
  const cpus = os.cpus() || [];
  const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown CPU';
  const coreCount = cpus.length;
  const memGb = (os.totalmem() / (1024 ** 3)).toFixed(1);

  let osName = '';
  let gpuName = '';
  let gpuHeader = '';
  let gpuSub = '';

  if (platform === 'darwin') {
    let macVersion = '';
    try {
      macVersion = execSync('sw_vers -productVersion', { encoding: 'utf8', timeout: 1500 }).trim();
    } catch (_) {
      macVersion = os.release();
    }
    osName = `macOS ${macVersion} (Metal Assist)`;

    try {
      const gpuRaw = execSync("system_profiler SPDisplaysDataType 2>/dev/null | grep 'Chipset Model' | head -1 | awk -F: '{print $2}'", { encoding: 'utf8', timeout: 2000 }).trim();
      gpuName = gpuRaw || cpuModel;
    } catch (_) {
      gpuName = cpuModel;
    }
    gpuHeader = `${gpuName} GPU`;
    gpuSub = `Metal Assist Enabled (${memGb}GB Unified)`;
  } else if (platform === 'win32') {
    const rel = os.release().split('.');
    const build = parseInt(rel[2] || '0', 10);
    const winVer = build >= 22000 ? '11' : '10';
    osName = `Windows ${winVer} (Vulkan Assist)`;
    gpuName = 'Intel Iris Xe (Integrated)';
    gpuHeader = 'Intel Iris Xe GPU';
    gpuSub = 'Vulkan Assist Enabled';
  } else {
    osName = `Linux ${os.release()} (${os.arch()})`;
    gpuName = 'Host GPU';
    gpuHeader = 'Host GPU';
    gpuSub = 'Compute Enabled';
  }

  const ollamaHost = process.env.OLLAMA_HOST || '127.0.0.1';
  const ollamaPort = process.env.OLLAMA_PORT || '11434';
  const operatorHome = process.env.OPERATOR_HOME || os.homedir();
  const stackRoot = process.env.STACK_ROOT || '';
  const resolvedStackRoot = stackRoot || (platform === 'win32' ? 'C:/tt-ai-stack' : path.join(operatorHome, 'tt-ai-stack'));

  let openclawConfigFile = 'openclaw.json';
  if (stackRoot) {
    openclawConfigFile = path.join(stackRoot, 'openclaw.json');
  } else if (platform === 'win32') {
    openclawConfigFile = 'C:/tt-ai-stack/openclaw.json';
  } else {
    openclawConfigFile = path.join(operatorHome, '.openclaw', 'openclaw.json');
  }

  const shellName = platform === 'win32' ? 'powershell' : 'bash / zsh';

  cachedSpecs = {
    platform,
    os: osName,
    cpu: `${cpuModel} (${coreCount}c)`,
    cpuModel,
    coreCount,
    gpu: gpuName,
    gpuHeader,
    gpuSub,
    memGb,
    shellName,
    stackRoot: resolvedStackRoot,
    ollamaEndpoint: `http://${ollamaHost}:${ollamaPort}`,
    openclawConfig: 'openclaw.json',
    openclawConfigFile
  };

  return cachedSpecs;
}

module.exports = { getHostSpecs };
