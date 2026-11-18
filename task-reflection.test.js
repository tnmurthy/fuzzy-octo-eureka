// node --test task-reflection.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLogArtifacts, synthesizeReflection, recordRunReflection } = require('./task-reflection');

test('parseLogArtifacts extracts tools, chat messages, and test outcomes', () => {
  const sampleLog = `
Starting agent run
💬 I will implement a secure authentication middleware.
🔧 Write src/auth.js
🔧 Edit src/server.js
Running test suite:
✔ auth-flow passes all checks
tests passed in 12ms
  `;

  const artifacts = parseLogArtifacts(sampleLog);
  assert.deepEqual(artifacts.toolsUsed, ['Write', 'Edit']);
  assert.equal(artifacts.filesModified.includes('src/auth.js'), true);
  assert.equal(artifacts.filesModified.includes('src/server.js'), true);
  assert.equal(artifacts.testsPassed, true);
  assert.equal(artifacts.agentMessages[0], 'I will implement a secure authentication middleware.');
});

test('synthesizeReflection creates structured memory payload with tags and metadata', () => {
  const run = {
    id: 'run-12345',
    repo: '/path/to/my-service',
    task: 'Fix race condition in session checkout',
    status: 'done',
    agent: 'claude',
    branch: 'agent/run-12345',
    commits_ahead: 2
  };

  const logText = `
💬 Fixed race condition by wrapping checkout in mutex.
🔧 Edit src/checkout.js
✔ all 14 tests passed
  `;

  const reflection = synthesizeReflection({ run, logText });
  assert.equal(reflection.projectId, 'my-service');
  assert.match(reflection.title, /Learned from my-service/);
  assert.match(reflection.content, /src\/checkout\.js/);
  assert.equal(reflection.tags.includes('reflection'), true);
  assert.equal(reflection.tags.includes('my-service'), true);
  assert.equal(reflection.metadata.runId, 'run-12345');
});

test('recordRunReflection records reflection in memory engine without duplicates', () => {
  const stored = [];
  const fakeMemory = {
    episodicMemory: stored,
    storeMemory: (item) => {
      const entry = { id: 'mem-1', ...item };
      stored.push(entry);
      return entry;
    }
  };

  const run = {
    id: 'run-999',
    repo: 'payment-api',
    task: 'Add webhook retry backoff',
    status: 'done'
  };

  const res1 = recordRunReflection({ run, memory: fakeMemory, logText: '💬 Added exponential backoff' });
  assert.equal(res1.ok, true);
  assert.equal(res1.already, false);
  assert.equal(stored.length, 1);

  // Duplicate call with same runId
  const res2 = recordRunReflection({ run, memory: fakeMemory, logText: '💬 Added exponential backoff' });
  assert.equal(res2.ok, true);
  assert.equal(res2.already, true);
  assert.equal(stored.length, 1); // Not duplicated
});
