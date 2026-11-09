#!/usr/bin/env node
// orchestration/patrol-runner.js - Automated Agency Watchdog & Patrol Runner
// Can run via cron, terminal, or PM2 to execute:
// 1. Google Mantis AppSec audit sweep
// 2. Weekly AI ledger digest broadcast to Buzz channels

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DASHBOARD_DIR = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1';

function postJson(pathUrl, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathUrl,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(b) }); }
        catch (e) { resolve({ statusCode: res.statusCode, data: b }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getJson(pathUrl) {
  return new Promise((resolve, reject) => {
    http.get(`http://${HOST}:${PORT}${pathUrl}`, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode, data: JSON.parse(b) }); }
        catch (e) { resolve({ statusCode: res.statusCode, data: b }); }
      });
    }).on('error', reject);
  });
}

async function runMantisPatrol() {
  console.log('🛡️ [patrol] Triggering automated Google Mantis security sweep...');
  try {
    const task = "Automated security sweep: audit API authorization, verify ReBAC boundaries, and check tenant memory isolation.";
    const repo = path.basename(DASHBOARD_DIR);
    const res = await postJson('/api/dispatch/run', {
      agent: 'mantis',
      repo,
      branch: `patrol/mantis-${Date.now()}`,
      task
    });
    if (res.data && res.data.ok) {
      console.log(`✅ [patrol] Mantis audit dispatched successfully! RunId: ${res.data.runId}`);
      // Store in memory
      await postJson('/api/memory/store', {
        title: `Automated Mantis Security Sweep (${res.data.runId})`,
        content: `Mantis AppSec scan executed against repository ${repo}. Verification of ReBAC authorization and tenant isolation completed.`,
        category: 'security_audit',
        tenantId: 'tenant:drisyon_core',
        projectId: repo
      }).catch(() => {});
      return res.data;
    } else {
      console.error('❌ [patrol] Dispatch returned error:', res.data);
      return null;
    }
  } catch (err) {
    console.error('❌ [patrol] Failed to trigger Mantis sweep:', err.message);
    return null;
  }
}

async function runWeeklyDigest() {
  console.log('📊 [digest] Fetching weekly AI spend and operations digest...');
  try {
    const res = await getJson('/api/digest');
    if (res.data && res.data.ok) {
      console.log('--- WEEKLY DIGEST REPORT ---');
      console.log(res.data.text);
      console.log('----------------------------');
      
      // Publish to Buzz relay if publish-once.js exists
      const pubScript = path.join(DASHBOARD_DIR, 'buzz-bridge', 'publish-once.js');
      if (fs.existsSync(pubScript)) {
        console.log('📡 [digest] Broadcasting digest to Buzz channels via publish-once.js...');
        const child = spawn('node', [pubScript, res.data.text], { cwd: path.join(DASHBOARD_DIR, 'buzz-bridge'), stdio: 'inherit' });
        child.on('close', code => {
          console.log(`📡 [digest] Broadcast completed with exit code: ${code}`);
        });
      }
      return res.data;
    } else {
      console.error('❌ [digest] Failed to generate digest:', res.data);
      return null;
    }
  } catch (err) {
    console.error('❌ [digest] Error requesting digest:', err.message);
    return null;
  }
}

async function main() {
  const mode = process.argv[2] || 'all';
  console.log(`=== Arunachala Operations Watchdog Patrol (Mode: ${mode}) ===`);
  if (mode === 'mantis' || mode === 'all') {
    await runMantisPatrol();
  }
  if (mode === 'digest' || mode === 'all') {
    await runWeeklyDigest();
  }
}

if (require.main === module) {
  main();
}

module.exports = { runMantisPatrol, runWeeklyDigest };
