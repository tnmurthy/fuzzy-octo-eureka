// node --test orchestration/claude-usage.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'claude-usage.mjs');

function run(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-'));
  const json = path.join(dir, 'run.claude.json');
  if (content !== undefined) fs.writeFileSync(json, content);
  const ledger = path.join(dir, 'logs', 'ai-calls.jsonl');
  const res = spawnSync(process.execPath, [SCRIPT, json, ledger, 'run-1'], { encoding: 'utf8' });
  const lines = fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { res, lines };
}

const reply = {
  type: 'result', result: 'Added the test.', is_error: false, total_cost_usd: 0.4213, duration_ms: 61000, num_turns: 9,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 39000, cache_read_input_tokens: 150000, output_tokens: 4200 },
  modelUsage: { 'claude-sonnet-4-5-20250929': { costUSD: 0.4213 } },
};

test('records one ledger line with summed input tokens, cost and the run id', () => {
  const { res, lines } = run(JSON.stringify(reply));
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), 'Added the test.');
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.equal(l.provider, 'anthropic');
  assert.equal(l.model, 'claude-sonnet-4-5-20250929');
  assert.equal(l.purpose, 'dispatch');
  assert.equal(l.ok, true);
  assert.equal(l.input_tokens, 190200);
  assert.equal(l.output_tokens, 4200);
  assert.equal(l.cost_usd, 0.4213);
  assert.equal(l.ms, 61000);
  assert.equal(l.run_id, 'run-1');
  assert.match(l.id, /^[0-9a-f-]{36}$/);
});

test('an error result is recorded as not ok', () => {
  const { lines } = run(JSON.stringify({ ...reply, is_error: true, result: 'Max turns reached' }));
  assert.equal(lines[0].ok, false);
});

test('unreadable output: prints it raw, records ok:false, exits 0', () => {
  const { res, lines } = run('Error: not logged in');
  assert.equal(res.status, 0);
  assert.match(res.stdout, /not logged in/);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].model, 'unknown');
  assert.equal(lines[0].cost_usd, 0);
});

test('missing output file still records the attempt', () => {
  const { res, lines } = run(undefined);
  assert.equal(res.status, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].ok, false);
});
