// orchestration/agent-handoff.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createHandoffPacket,
  buildHandoffPrompt,
  resolveHandoff
} = require('./agent-handoff');

test('agent handoff engine creates structured packet and formats frontier prompt', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  const runId = 'run-federation-01';

  // 1. Create packet when local verification fails
  const packet = createHandoffPacket({
    runId,
    sourceAgent: 'hermes',
    targetAgent: 'claude',
    reason: 'TESTS_FAILED',
    testCommand: 'npm test -- auth.test.js',
    testOutput: 'AssertionError: expected status 200 but received 401 Unauthorized\n    at test/auth.js:45',
    exitCode: 1,
    storageDir: tmpDir
  });

  assert.equal(packet.runId, runId);
  assert.equal(packet.source.agent, 'hermes');
  assert.equal(packet.target.agent, 'claude');
  assert.equal(packet.reason, 'TESTS_FAILED');
  assert.equal(packet.status, 'ESCALATED');
  assert.match(packet.diagnostics.testOutputSlice, /AssertionError/);

  // 2. Synthesize prompt for Claude
  const rawPrompt = 'Implement JWT refresh token endpoint in auth.js';
  const handoffPrompt = buildHandoffPrompt(rawPrompt, packet);

  assert.match(handoffPrompt, /MULTI-HOST AGENT FEDERATION HANDOFF/);
  assert.match(handoffPrompt, /From: hermes \(Ollama on Mac Studio\)/);
  assert.match(handoffPrompt, /npm test -- auth\.test\.js/);
  assert.match(handoffPrompt, /AssertionError: expected status 200/);
  assert.match(handoffPrompt, /Implement JWT refresh token endpoint in auth\.js/);

  // 3. Resolve handoff once Claude finishes
  const resolved = resolveHandoff(runId, { status: 'RESOLVED', passedTests: true }, tmpDir);
  assert.equal(resolved.status, 'RESOLVED');
  assert.ok(resolved.resolvedAt);

  // 4. Test CLI prepare and resolve invocation
  const testPromptFile = path.join(tmpDir, 'task.prompt.txt');
  fs.writeFileSync(testPromptFile, 'Original task from poller');
  const cliScript = path.join(__dirname, 'agent-handoff.js');
  const { spawnSync } = require('child_process');

  const cliRes = spawnSync(process.execPath, [
    cliScript,
    'prepare',
    'run-cli-02',
    tmpDir,
    testPromptFile,
    'npm test',
    '1'
  ], { encoding: 'utf8' });

  assert.equal(cliRes.status, 0);
  const handoffFile = cliRes.stdout.trim();
  assert.ok(fs.existsSync(handoffFile), 'Handoff prompt file must be generated');
  const generatedPrompt = fs.readFileSync(handoffFile, 'utf8');
  assert.match(generatedPrompt, /MULTI-HOST AGENT FEDERATION HANDOFF/);
  assert.match(generatedPrompt, /Original task from poller/);

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
