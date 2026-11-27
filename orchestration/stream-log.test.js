// node --test orchestration/stream-log.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatEvent, toolSummary } = require('./stream-log');

const NOW = new Date(2026, 10, 17, 9, 5, 7);

test('assistant text and tool calls become one timestamped line each', () => {
  const { lines } = formatEvent({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Reading the router\nfirst.' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'src/router.js' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ] },
  }, NOW);
  assert.deepEqual(lines, ['09:05:07 💬 Reading the router first.', '09:05:07 🔧 Read src/router.js', '09:05:07 🔧 Bash npm test']);
});

test('tool inputs are summarised, never dumped', () => {
  assert.equal(toolSummary('Write', { file_path: 'a.txt', content: 'SECRET' }), 'Write a.txt');
  assert.equal(toolSummary('TodoWrite', { todos: [] }), 'TodoWrite');
  assert.equal(toolSummary('Bash', { command: 'x'.repeat(500) }).length, 'Bash '.length + 160);
});

test('only failed tool results are logged', () => {
  const ok = formatEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: 'fine' }] } }, NOW);
  assert.deepEqual(ok.lines, []);
  const bad = formatEvent({ type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'Permission denied' }] }] } }, NOW);
  assert.deepEqual(bad.lines, ['09:05:07    ↳ error: Permission denied']);
});

test('the result event is returned for the cost ledger and summarised', () => {
  const event = { type: 'result', subtype: 'success', num_turns: 4, total_cost_usd: 0.0123, result: 'All done' };
  const out = formatEvent(event, NOW);
  assert.equal(out.result, event);
  assert.deepEqual(out.lines, ['09:05:07 == claude finished: success · 4 turns · $0.0123']);
});

test('init names the model; unknown events are ignored', () => {
  assert.deepEqual(formatEvent({ type: 'system', subtype: 'init', model: 'claude-sonnet-x' }, NOW).lines, ['09:05:07 == claude started (model claude-sonnet-x)']);
  assert.deepEqual(formatEvent({ type: 'stream_event' }, NOW).lines, []);
  assert.deepEqual(formatEvent(null, NOW).lines, []);
});

// ---- hermes stream-json (2026-11-22) ----------------------------------------
test('hermes events become the same log lines and a normalised result', () => {
  const at = new Date('2026-11-22T10:00:05');
  const f = (e) => formatEvent(e, at, 'hermes');
  assert.deepEqual(f({ type: 'system', subtype: 'init', model: '', session_id: '' }).lines, ['10:00:05 == hermes started']);
  assert.deepEqual(f({ type: 'tool_use', name: 'terminal', input: { command: 'npm test' } }).lines, ['10:00:05 🔧 terminal npm test']);
  assert.deepEqual(f({ type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } }).lines, ['10:00:05 🔧 read_file a.txt']);
  assert.deepEqual(f({ type: 'tool_result', is_error: false, output: 'ok' }).lines, []);
  assert.deepEqual(f({ type: 'tool_result', is_error: true, output: 'boom' }).lines, ['10:00:05    ↳ error: boom']);\n  assert.deepEqual(f({ type: 'tool_result', is_error: true, output: "line one\nDid you mean one of these permissions?\n  x" }).lines, ['10:00:05    ↳ error: line one Did you mean one of these permissions? x']);
  assert.deepEqual(f({ type: 'text', text: '\n\nhello' }).lines, ['10:00:05 💬 hello']);
  const r = f({ type: 'result', session_id: 'local-abc', exit_code: 0, text: 'done\nQUESTION: which?', tokens: { total: 1200 } });
  assert.deepEqual(r.lines, ['10:00:05 == hermes finished: success · 1200 tokens (local)']);
  assert.deepEqual([r.result.session_id, r.result.result, r.result.is_error, r.result.agent], ['local-abc', 'done\nQUESTION: which?', false, 'hermes']);
  assert.equal(f({ type: 'result', exit_code: 1, text: '' }).result.is_error, true);
});

test('hermes text fragments join into one line before the next step', () => {
  const { textJoiner } = require('./stream-log');
  const j = textJoiner();
  assert.deepEqual(j.push({ type: 'text', text: 'The test ' }), []);
  assert.deepEqual(j.push({ type: 'text', text: 'command is npm test.' }), []);
  assert.deepEqual(j.push({ type: 'tool_use', name: 'terminal' }), [{ type: 'text', text: 'The test command is npm test.' }, { type: 'tool_use', name: 'terminal' }]);
  assert.deepEqual(j.push({ type: 'text', text: '\n\n' }), []);
  assert.deepEqual(j.flush(), [], 'whitespace only is dropped');
  j.push({ type: 'text', text: 'tail' });
  assert.deepEqual(j.flush(), [{ type: 'text', text: 'tail' }]);
});

test('the script joins hermes text and saves the normalised result (end to end)', () => {
  const { spawnSync } = require('child_process');
  const fsx = require('fs');
  const osx = require('os');
  const pathx = require('path');
  const out = pathx.join(fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'slog-')), 'r.json');
  const input = [
    { type: 'system', subtype: 'init', model: '', session_id: '' },
    { type: 'text', text: 'I read ' }, { type: 'text', text: 'package.json.' },
    { type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } },
    { type: 'result', session_id: 'local-0123456789abcdef', exit_code: 0, text: 'QUESTION: which?' },
  ].map((e) => JSON.stringify(e)).join('\n');
  const r = spawnSync(process.execPath, [pathx.join(__dirname, 'stream-log.js'), out, 'hermes'], { input, encoding: 'utf8' });
  const lines = r.stdout.trim().split('\n').map((l) => l.slice(9));
  assert.deepEqual(lines, ['== hermes started', '💬 I read package.json.', '🔧 read_file a.txt', '== hermes finished: success']);
  const saved = JSON.parse(fsx.readFileSync(out, 'utf8'));
  assert.deepEqual([saved.session_id, saved.result], ['local-0123456789abcdef', 'QUESTION: which?']);
});
