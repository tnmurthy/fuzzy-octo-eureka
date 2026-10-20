// node --test buzz-bridge/router.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, decide, THRESHOLDS } = require('./router');

const ctx = {
  message: 'is ollama up?',
  thread: [],
  repos: ['arunachala-dashboard', 'bov'],
  recentRuns: [],
};

const choice = (value, confidence = 0.9) => ({ type: 'choice', choice: value, confidence });
const noul = (p) => ({ type: 'noul', noul: p });

function answers(over = {}) {
  return {
    route: choice('status'),
    persona: choice('po'),
    executor: choice('claude'),
    repo: choice('none'),
    status_topic: choice('services'),
    risky: noul(0.02),
    clear: noul(0.95),
    ...over,
  };
}

test('request carries state and every question in one call', () => {
  const req = buildRequest(ctx);
  assert.equal(req.state.message, 'is ollama up?');
  assert.deepEqual(Object.keys(req.questions).sort(),
    ['clear', 'executor', 'persona', 'repo', 'risky', 'route', 'status_topic']);
  assert.equal(req.questions.route.type, 'choice');
  assert.equal(req.questions.risky.type, 'noul');
});

test('repo options come from the real repo list, plus none', () => {
  const req = buildRequest(ctx);
  assert.deepEqual(Object.keys(req.questions.repo.criteria).sort(), ['arunachala-dashboard', 'bov', 'none']);
});

test('status route answers from data with the chosen topic', () => {
  assert.deepEqual(decide(answers()), { action: 'status', topic: 'services' });
});

test('persona route picks the persona', () => {
  const d = decide(answers({ route: choice('ask_persona'), persona: choice('tech') }));
  assert.deepEqual(d, { action: 'persona', persona: 'tech' });
});

test('an uncertain persona pick falls back to the PO', () => {
  const d = decide(answers({ route: choice('ask_persona'), persona: choice('qa', 0.3) }));
  assert.deepEqual(d, { action: 'persona', persona: 'po' });
});

test('low route confidence asks for clarification instead of guessing', () => {
  const d = decide(answers({ route: choice('dispatch', THRESHOLDS.route - 0.01) }));
  assert.equal(d.action, 'clarify');
});

test('small talk is ignored', () => {
  assert.deepEqual(decide(answers({ route: choice('none') })), { action: 'ignore' });
});

test('dispatch reports executor, repo and risk, and is not run in step 1', () => {
  const d = decide(answers({ route: choice('dispatch'), executor: choice('codex'), repo: choice('bov'), risky: noul(0.8) }));
  assert.deepEqual(d, { action: 'dispatch', executor: 'codex', repo: 'bov', needsConfirm: true, enabled: false });
});

test('dispatch without a known repo asks which repo', () => {
  const d = decide(answers({ route: choice('dispatch'), repo: choice('none') }));
  assert.equal(d.action, 'clarify');
  assert.match(d.question, /repo/i);
});

test('an unclear actionable request asks a question', () => {
  const d = decide(answers({ route: choice('dispatch'), repo: choice('bov'), clear: noul(0.2) }));
  assert.equal(d.action, 'clarify');
});

test('risk is judged even when it is not the deciding answer', () => {
  const d = decide(answers({ route: choice('add_task'), risky: noul(0.9) }));
  assert.equal(d.needsConfirm, true);
});
