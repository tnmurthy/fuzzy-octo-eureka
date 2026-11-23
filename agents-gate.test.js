'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { agentsBlocked, isAgentPath } = require('./agents-gate');

const blocked = (url, o = {}) =>
  agentsBlocked({ portalHasAccess: false, viaTunnel: true, url, ...o });

test('blocks every agent-starting path through the tunnel without Access', () => {
  for (const url of [
    '/agents',
    '/agents.html',
    '/agents/ops',
    '/api/agents/run',
    '/api/agents/overview?x=1',
    '/api/dispatch/run',
    '/api/team/dispatch',
    '/api/patrol/mantis',
    '/api/agent/chat',
  ]) {
    assert.strictEqual(blocked(url), true, url);
  }
});

test('leaves the rest of the portal alone', () => {
  for (const url of ['/', '/drisyon.html', '/api/invoicing/summary', '/login', '/agents-page.js', '/api/agent/transcripts']) {
    assert.strictEqual(blocked(url), false, url);
  }
});

test('allows agents from this Mac (no tunnel)', () => {
  assert.strictEqual(blocked('/api/agents/run', { viaTunnel: false }), false);
});

test('allows agents once the portal has its own Access app', () => {
  assert.strictEqual(blocked('/api/agents/run', { portalHasAccess: true }), false);
});

test('isAgentPath ignores query strings and lookalikes', () => {
  assert.strictEqual(isAgentPath('/agents?tab=1'), true);
  assert.strictEqual(isAgentPath('/agentsx'), false);
  assert.strictEqual(isAgentPath('/api/agentsx'), false);
});
