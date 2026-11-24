// node --test followup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFollowUp, followUpStatus } = require('./followup');

const SID = '0f4c2a1e-8b7d-4c3a-9e2f-1a2b3c4d5e6f';
const HSID = 'local-5a7d968e3dfdcaaa4d7db099b81ab685a2816d47ea001f29d07c17d0edde1dcb';
const files = {
  '/runs/r1.claude.json': JSON.stringify({ session_id: SID }),
  '/runs/bad.claude.json': '{"session_id":"x"}',
  '/runs/h1.hermes.json': JSON.stringify({ session_id: HSID, result: 'ok' }),
};
const readFile = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
const run = (o) => ({ id: 'r1', agent: 'claude', status: 'done', branch: 'agent/run-1', repo: '/Users/me/app', log: '/runs/r1.log', ...o });
const resolveRepo = (name) => (name === 'app' ? '/Users/me/app' : null);

test('a finished claude run resolves to its repo, branch and session', () => {
  assert.deepEqual(resolveFollowUp({ runs: [run()], runId: 'r1', resolveRepo, readFile }), {
    ok: true, repo: 'app', repoPath: '/Users/me/app', branch: 'agent/run-1', session: SID, parent: 'r1', agent: 'claude',
  });
});

test('a finished hermes (local) run resumes its local session with hermes', () => {
  const h = run({ id: 'h1', agent: 'hermes', log: '/runs/h1.log' });
  assert.deepEqual(resolveFollowUp({ runs: [h], runId: 'h1', resolveRepo, readFile }), {
    ok: true, repo: 'app', repoPath: '/Users/me/app', branch: 'agent/run-1', session: HSID, parent: 'h1', agent: 'hermes',
  });
});

test('running, other agents, sessionless or unknown runs cannot be followed up', () => {
  assert.match(followUpStatus(run({ status: 'running' }), { readFile }).error, /still going/);
  assert.match(followUpStatus(run({ agent: 'codex' }), { readFile }).error, /only Claude and Hermes/);
  assert.match(followUpStatus(run({ agent: 'hermes', log: '/runs/none.log' }), { readFile }).error, /no session/, 'hermes run without a saved session');
  assert.match(followUpStatus(run({ log: '/runs/none.log' }), { readFile }).error, /no session/);
  assert.match(followUpStatus(run({ log: '/runs/bad.log' }), { readFile }).error, /no session/, 'malformed id rejected');
  assert.match(resolveFollowUp({ runs: [run()], runId: 'nope', resolveRepo, readFile }).error, /not found/);
  assert.match(resolveFollowUp({ runs: [run()], runId: '../x', resolveRepo, readFile }).error, /bad run id/);
});

test('the repo must still be known to the dashboard at the same path', () => {
  assert.match(resolveFollowUp({ runs: [run({ repo: '/tmp/app' })], runId: 'r1', resolveRepo, readFile }).error, /no longer registered/);
  assert.match(resolveFollowUp({ runs: [run({ repo: '/Users/me/gone' })], runId: 'r1', resolveRepo, readFile }).error, /no longer registered/);
});

test('switchedHelper: Expert or Free only; the recorded helper follows the switch', () => {
  const { switchedHelper } = require('./followup');
  assert.deepEqual(switchedHelper({ agent: 'claude', helper: 'claude', switchTo: 'hermes' }), { agent: 'hermes', helper: 'hermes' });
  assert.deepEqual(switchedHelper({ agent: 'hermes', helper: null, switchTo: 'claude' }), { agent: 'claude', helper: null });
  assert.deepEqual(switchedHelper({ agent: 'claude', helper: 'claude', switchTo: 'codex' }), { agent: 'claude', helper: 'claude' });
  assert.deepEqual(switchedHelper({ agent: 'claude', helper: 'claude' }), { agent: 'claude', helper: 'claude' });
});
