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
