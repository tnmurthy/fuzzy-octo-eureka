const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runProbe } = require('../scripts/ollama-probe');

let exitCalledWith = null;
const originalExit = process.exit;
// Mock process.exit to prevent the test runner from terminating
process.exit = (code) => {
  exitCalledWith = code;
};

test('successful probe', async () => {
  const logFile = path.join(process.cwd(), 'test-logs', 'ok.jsonl');
  const mockProbe = async () => ({ ok: true, ms: 100 });
  const now = new Date();
  
  await runProbe({
    probe: mockProbe,
    model: 'hermes',
    logFile,
    now
  });

  assert.strictEqual(exitCalledWith, 0, 'Should exit with 0');
  
  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.ok(logContent.includes('"ok":true'), 'Log should contain ok:true');
  assert.ok(logContent.includes('"model":"hermes"'), 'Log should contain model:hermes');
  
  // Cleanup
  if (fs.existsSync(path.dirname(logFile))) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  // We don't delete files here to avoid issues with concurrent tests if any, 
  // but we should probably clean up.
});

test('failed probe', async () => {
  const logFile = path.join(process.cwd(), 'test-logs', 'fail.jsonl');
  const mockProbe = async () => ({ ok: false, ms: 0, error: 'stuck' });
  const now = new Date();

  await runProbe({
    probe: mockProbe,
    model: 'hermes',
    logFile,
    now
  });

  assert.strictEqual(exitCalledWith, 1, 'Should exit with 1');

  const logContent = fs.readFileSync(logFile, 'utf8');
  assert.ok(logContent.includes('"ok":false'), 'Log should contain ok:false');
  assert.ok(logContent.includes('"error":"stuck"'), 'Log should contain error:stuck');
});

// Restore original exit
process.exit = originalExit;
