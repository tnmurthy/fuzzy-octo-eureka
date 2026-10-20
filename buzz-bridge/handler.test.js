// node --test buzz-bridge/handler.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, formatStatus } = require('./handler');

const telemetry = {
  timestamp: '2026-10-20 16:00:00',
  services: {
    ollama: { online: true, latencyMs: 10 },
    openclaw: { online: false },
    buzz: { online: true, realMembers: 2 },
  },
};
const runs = [
  { agent: 'codex', status: 'failed', branch: 'fix/x', started_at: '2026-10-20T09:00:00Z' },
  { agent: 'claude', status: 'running', branch: 'feat/y', started_at: '2026-10-20T10:00:00Z' },
];

const choice = (value, confidence = 0.9) => ({ type: 'choice', choice: value, confidence });
const noul = (p) => ({ type: 'noul', noul: p });
const baseAnswers = {
  route: choice('status'), persona: choice('po'), executor: choice('claude'),
  repo: choice('none'), status_topic: choice('services'), risky: noul(0.01), clear: noul(0.9),
};

function setup({ answers = baseAnswers, typesafeError } = {}) {
  const chats = [];
  const deps = {
    typesafe: {
      systemOne: async () => {
        if (typesafeError) throw new Error(typesafeError);
        return { answers };
      },
    },
    dashboard: {
      telemetry: async () => telemetry,
      runs: async () => runs,
      chat: async (persona, message) => { chats.push({ persona, message }); return `[${persona}] reply`; },
    },
    repos: () => ['bov', 'arunachala-dashboard'],
  };
  return { handle: createHandler(deps), chats };
}

test('status: services summary comes from telemetry, not a model', async () => {
  const { handle, chats } = setup();
  const reply = await handle({ text: 'is everything up?', thread: [] });
  assert.match(reply, /Ollama: up/);
  assert.match(reply, /OpenClaw: DOWN/);
  assert.equal(chats.length, 0);
});

test('status: runs topic lists failed and running runs', async () => {
  const { handle } = setup({ answers: { ...baseAnswers, status_topic: choice('runs') } });
  const reply = await handle({ text: 'what ran today?', thread: [] });
  assert.match(reply, /codex.*failed/);
  assert.match(reply, /claude.*running/);
});

test('persona: forwards the message to the chosen persona', async () => {
  const { handle, chats } = setup({ answers: { ...baseAnswers, route: choice('ask_persona'), persona: choice('infra') } });
  const reply = await handle({ text: 'should ollama be a service?', thread: [] });
  assert.deepEqual(chats, [{ persona: 'infra', message: 'should ollama be a service?' }]);
  assert.match(reply, /\[infra\] reply/);
});

test('small talk gets a short hint instead of silence', async () => {
  const { handle, chats } = setup({ answers: { ...baseAnswers, route: choice('none') } });
  const reply = await handle({ text: 'hello', thread: [] });
  assert.match(reply, /is everything up/);
  assert.equal(chats.length, 0);
});

test('every decision is reported to the logger', async () => {
  const logged = [];
  const { handle } = setup();
  await handle({ text: 'is everything up?', thread: [], log: (d) => logged.push(d) });
  assert.deepEqual(logged, [{ action: 'status', topic: 'services' }]);
});

test('dispatch is described but not run yet, and flags confirmation', async () => {
  const { handle } = setup({ answers: { ...baseAnswers, route: choice('dispatch'), executor: choice('codex'), repo: choice('bov'), risky: noul(0.9) } });
  const reply = await handle({ text: 'fix the lint in bov and push', thread: [] });
  assert.match(reply, /codex/);
  assert.match(reply, /bov/);
  assert.match(reply, /confirm/i);
  assert.match(reply, /not enabled yet/i);
});

test('when TypeSafe is unavailable the PO answers instead of failing silently', async () => {
  const { handle, chats } = setup({ typesafeError: 'TypeSafe daily cap of 200 calls reached' });
  const reply = await handle({ text: 'what should we do next?', thread: [] });
  assert.equal(chats[0].persona, 'po');
  assert.match(reply, /routing unavailable/i);
});

test('runs: says plainly when nothing ran today, then lists the latest', () => {
  const old = [{ agent: 'claude', status: 'done', branch: 'b', started_at: '2026-10-01T22:41:26+05:30' }];
  const text = formatStatus({ services: {} }, old, 'runs', Date.parse('2026-10-20T12:00:00Z'));
  assert.match(text, /^No agent runs today\. Latest:/);
  assert.match(text, /claude - done - b \(1 Oct/);
});

test('runs: lists only today\'s runs when there are some', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const list = [
    { agent: 'codex', status: 'running', branch: 'x', started_at: '2026-10-20T09:00:00Z' },
    { agent: 'claude', status: 'done', branch: 'y', started_at: '2026-10-01T09:00:00Z' },
  ];
  const text = formatStatus({ services: {} }, list, 'runs', now);
  assert.match(text, /^Today:/);
  assert.match(text, /codex - running - x/);
  assert.doesNotMatch(text, /claude/);
});

test('formatStatus marks unknown services instead of guessing', () => {
  assert.match(formatStatus({ services: {} }, [], 'services'), /Ollama: unknown/);
});
