#!/usr/bin/env node
// orchestration/hermes-local.js - Local Ollama Hermes Agent Engine
// Emulates Hermes CLI: hermes --in <worktree> -z <prompt>

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let worktree = process.cwd();
let prompt = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--in' && args[i + 1]) {
    worktree = path.resolve(args[i + 1]);
    i++;
  } else if (args[i] === '-z' && args[i + 1]) {
    prompt = args[i + 1];
    i++;
  } else if (!prompt) {
    prompt = args[i];
  }
}

if (!prompt) {
  console.error("Usage: hermes-local [--in <worktree>] -z '<prompt>'");
  process.exit(1);
}

const MODEL = process.env.HERMES_MODEL || process.env.LOCAL_ROUTER_FALLBACK_MODEL || 'qwen2.5-coder:3b';
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = Number(process.env.OLLAMA_PORT) || 11434;

console.log(`[hermes-local] Target worktree: ${worktree}`);
console.log(`[hermes-local] Dispatching prompt to local Ollama (${MODEL})...`);

const payload = JSON.stringify({
  model: MODEL,
  messages: [
    {
      role: 'system',
      content: 'You are Hermes, a local AI coding agent running on Ollama. You inspect repositories, implement software fixes, verify security and architecture, and produce structured, actionable engineering outputs.'
    },
    {
      role: 'user',
      content: prompt
    }
  ],
  stream: false
});

const req = http.request({
  host: OLLAMA_HOST,
  port: OLLAMA_PORT,
  path: '/api/chat',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const parsed = JSON.parse(data);
      const reply = parsed.message?.content || data;
      const tokens = parsed.eval_count || 0;
      const durationSec = ((parsed.eval_duration || 0) / 1e9).toFixed(2);
      console.log(`[hermes-local] Execution complete (${tokens} tokens generated in ${durationSec}s):`);
      console.log('--------------------------------------------------');
      console.log(reply);
      console.log('--------------------------------------------------');
      try {
        fs.appendFileSync(
          path.join(worktree, '.hermes_log'),
          `\n[${new Date().toISOString()}] Hermes run (${MODEL}):\n${reply}\n`,
          'utf8'
        );
      } catch (_) {}
      process.exit(0);
    } catch (e) {
      console.error('[hermes-local] Error parsing response:', e.message);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error('[hermes-local] Network error contacting Ollama:', err.message);
  process.exit(1);
});

req.write(payload);
req.end();
