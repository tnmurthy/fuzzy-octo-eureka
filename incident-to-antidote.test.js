// incident-to-antidote.test.js - Unit tests for Incident-to-Antidote Synthesizer
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  synthesizeAntidote,
  mineGitCommits,
  mineFailedRuns,
  registerAntidote,
  batchRegister,
  deriveScopes
} = require('./incident-to-antidote');

test('antidote synthesizer: parses conventional commit messages into structured antidotes', () => {
  const commitIncident = {
    commitSha: 'e9c2699664e8d5fa799f3bc9403ee2e134d0522c',
    message: 'fix(approvals): grant admin permissions to Access users and add approval cards to Cockpit',
    files: ['server.js', 'cockpit.html']
  };

  const antidote = synthesizeAntidote(commitIncident);
  assert.equal(antidote.id, 'ANT-E9C2699');
  assert.match(antidote.pattern, /^APPROVALS: grant admin permissions/);
  assert.match(antidote.symptom, /Regression addressed in commit:/);
  assert.match(antidote.antidote, /Ensure grant admin permissions/);
  assert.ok(antidote.scope.includes('auth'));
  assert.ok(antidote.scope.includes('server'));
  assert.ok(antidote.scope.includes('ui'));
  assert.equal(antidote.source, 'commit:e9c2699');
});

test('antidote synthesizer: extracts symptom and pattern from error logs', () => {
  const errorIncident = {
    title: 'Port collision on daemon restart',
    errorLog: 'Error: listen EADDRINUSE: address already in use :::8787\n    at Server.setupListenHandle [as _listen2] (node:net:1904:16)',
    files: ['server.js']
  };

  const antidote = synthesizeAntidote(errorIncident);
  assert.match(antidote.symptom, /EADDRINUSE/);
  assert.match(antidote.antidote, /Ensure/);
  assert.ok(antidote.scope.includes('server'));
});

test('antidote synthesizer: deriveScopes identifies appropriate domains', () => {
  assert.deepEqual(deriveScopes(['auth.js', 'token.js']), ['auth', 'security']);
  assert.ok(deriveScopes(['ledger.db', 'schema.sql']).includes('database'));
  assert.ok(deriveScopes(['cockpit.html']).includes('ui'));
  assert.ok(deriveScopes(['test/app.test.js']).includes('testing'));
  assert.deepEqual(deriveScopes([], 'clean'), ['general']);
});

test('antidote synthesizer: mineGitCommits discovers fix commits from git history', () => {
  // Its own throwaway repo: CI checks out one commit, so the real history
  // cannot be relied on to hold any particular fix.
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antidote-git-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'feat: first');
    fs.writeFileSync(path.join(dir, 'access-auth.js'), 'module.exports = 1;\n');
    git('add', '.');
    git('commit', '-q', '--no-verify', '-m', 'fix(approvals): grant admin permissions to Access users');

    const mined = mineGitCommits(dir, { limit: 10 });
    assert.ok(Array.isArray(mined));
    assert.equal(mined.length, 1, 'only the fix commit is mined');
    assert.match(mined[0].pattern, /APPROVALS/);
    assert.ok(mined[0].scope.includes('auth'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antidote synthesizer: mineGitCommits returns [] outside a git repo', () => {
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antidote-nogit-'));
  try {
    assert.deepEqual(mineGitCommits(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('antidote synthesizer: mineFailedRuns processes failed agent trajectories', () => {
  const mockRuns = [
    {
      id: 'run-fail-1',
      status: 'failed',
      exit_code: 1,
      repo: 'core-api',
      task: 'Update JWT signing key',
      error: 'AssertionError [ERR_ASSERTION]: expected 200 got 403',
      files: ['auth.js']
    },
    {
      id: 'run-pass-1',
      status: 'done',
      exit_code: 0,
      repo: 'core-api',
      task: 'Docs typo'
    }
  ];

  const mined = mineFailedRuns(mockRuns);
  assert.equal(mined.length, 1);
  assert.equal(mined[0].source, 'run:run-fail-1');
  assert.match(mined[0].symptom, /AssertionError/);
  assert.ok(mined[0].scope.includes('auth'));
});

test('antidote synthesizer: registers antidote into memory engine, ledger, and blackboard', () => {
  let storedMemory = null;
  const mockMemory = {
    storeAntidote(a) {
      storedMemory = a;
      return a;
    },
    getAntidotes() {
      return storedMemory ? [storedMemory] : [];
    }
  };

  let loggedEvent = null;
  const mockLedger = {
    logEvent(evt) {
      loggedEvent = evt;
    }
  };

  let postedFact = null;
  const mockBlackboard = {
    postFact(f) {
      postedFact = f;
      return f;
    }
  };

  const antidote = synthesizeAntidote({
    id: 'ANT-MOCK-1',
    pattern: 'Git Index Lock Concurrency',
    symptom: 'fatal: Unable to create index.lock: Operation not permitted',
    antidote: 'Check for running git processes before clearing stale index.lock',
    scope: ['git', 'ops']
  });

  const registered = registerAntidote(antidote, {
    memoryEngine: mockMemory,
    ledgerDB: mockLedger,
    blackboard: mockBlackboard
  });

  assert.equal(registered.id, 'ANT-MOCK-1');
  assert.equal(storedMemory.id, 'ANT-MOCK-1');
  assert.equal(loggedEvent.type, 'ANTIDOTE_REGISTERED');
  assert.match(postedFact.title, /Antidote Created/);
  assert.ok(postedFact.tags.includes('antidote'));

  // Test batchRegister deduplication
  const batchResult = batchRegister([
    antidote, // duplicate, should be skipped
    {
      id: 'ANT-NEW-2',
      pattern: 'Uncaught Promise Rejection',
      symptom: 'UnhandledPromiseRejection: connection refused',
      antidote: 'Wrap async network handlers in try/catch'
    }
  ], {
    memoryEngine: mockMemory,
    ledgerDB: mockLedger,
    blackboard: mockBlackboard
  });

  assert.equal(batchResult.added, 1);
  assert.equal(batchResult.registered[0].id, 'ANT-NEW-2');
});

test('antidote synthesizer: CLI execution outputs formatted and json candidates', () => {
  const scriptPath = path.join(__dirname, 'incident-to-antidote.js');

  const outJson = execFileSync(process.execPath, [
    scriptPath,
    'synthesize',
    'fix(rebac): map drisyon session actor before permission evaluation',
    '--json'
  ], { encoding: 'utf8' });

  const parsed = JSON.parse(outJson);
  assert.ok(parsed.id);
  assert.match(parsed.pattern, /REBAC/);
  assert.ok(parsed.scope.includes('auth'));
});
