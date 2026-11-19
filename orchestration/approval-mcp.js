#!/usr/bin/env node
// approval-mcp.js - the run's permission helper (OMB-3).
//
// A tiny stdio MCP server that headless claude calls through
// --permission-prompt-tool mcp__arunachala_approvals__approve whenever its
// approval level (approval-levels.js) does not pre-allow a tool. It files the
// request with the dashboard, waits for a person's Allow/Deny on /agents, and
// answers claude:
//   {"behavior":"allow","updatedInput":<input>}  or  {"behavior":"deny","message":"..."}
// It fails closed: any error, an unreachable dashboard or the deadline means deny.
//
// Env (set by agent-dispatch.sh from the dashboard's dispatch):
//   APPROVAL_URL         http://127.0.0.1:8787
//   APPROVAL_RUN_ID      the run id
//   APPROVAL_TOKEN       the run's token (never logged)
//   APPROVAL_TIMEOUT_MS  how long to wait for a person (default 10 min)
//   APPROVAL_POLL_MS     how often to check (default 2000)

'use strict';

const readline = require('readline');

const BASE = process.env.APPROVAL_URL || 'http://127.0.0.1:8787';
const RUN_ID = process.env.APPROVAL_RUN_ID || '';
const TOKEN = process.env.APPROVAL_TOKEN || '';
const TIMEOUT_MS = Number(process.env.APPROVAL_TIMEOUT_MS) || 10 * 60 * 1000;
const POLL_MS = Number(process.env.APPROVAL_POLL_MS) || 2000;
const TOOL = 'approve';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deny = (message) => ({ behavior: 'deny', message });

async function decide(toolName, input) {
  if (!RUN_ID || !TOKEN) return deny('approvals are not set up for this run');
  const filed = await fetch(`${BASE}/api/agents/approvals/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: RUN_ID, token: TOKEN, tool: toolName, input }),
  }).then((r) => r.json());
  if (!filed.ok) return deny(`approval request refused: ${filed.error || 'unknown error'}`);
  let req = filed.request;
  const until = Date.now() + TIMEOUT_MS + 5000;
  while (req.status === 'pending' && Date.now() < until) {
    await sleep(POLL_MS);
    const s = await fetch(`${BASE}/api/agents/approvals/status?id=${encodeURIComponent(req.id)}&runId=${encodeURIComponent(RUN_ID)}`, {
      headers: { 'x-run-token': TOKEN },
    }).then((r) => r.json());
    if (!s.ok) return deny(`approval status unavailable: ${s.error || 'unknown error'}`);
    req = s.request;
  }
  if (req.status === 'allowed') return { behavior: 'allow', updatedInput: input };
  return deny(req.status === 'pending' ? 'nobody answered in time' : `a person said no (${req.reason || 'denied'})`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no answer
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'arunachala-approvals', version: '1.0.0' },
    } });
  }
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: [{
      name: TOOL,
      description: 'Ask a person on the Arunachala dashboard whether this tool call may run.',
      inputSchema: {
        type: 'object',
        properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
        required: ['tool_name', 'input'],
      },
    }] } });
  }
  if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    let answer;
    if (!params || params.name !== TOOL) answer = deny('unknown approval tool');
    else {
      try { answer = await decide(String(args.tool_name || ''), args.input || {}); }
      catch (err) { answer = deny(`approval helper failed: ${err.message}`); }
    }
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(answer) }] } });
  }
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }
  handle(msg).catch(() => {});
});
