// node --test buzz-bridge/local-router-client.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalRouterClient } = require('./local-router-client');

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

function ollamaReply(content) {
  return { message: { role: 'assistant', content } };
}

const req = {
  state: { message: 'is everything up?' },
  questions: {
    route: { type: 'choice', instructions: 'x', criteria: { status: 'wants status', none: 'small talk' } },
    risky: { type: 'noul', instructions: 'y', criteria: { true: 't', false: 'f' } },
  },
};

test('posts to the local Ollama chat endpoint with the model and a JSON-only prompt', async () => {
  const fetch = fakeFetch(200, ollamaReply('{"route": "status", "risky": false}'));
  const c = createLocalRouterClient({ fetch, model: 'gemma3:4b' });
  const res = await c.systemOne(req);

  assert.equal(res.answers.route.choice, 'status');
  assert.equal(res.answers.risky.noul, 0.15);

  const { url, init } = fetch.calls[0];
  assert.equal(url, 'http://127.0.0.1:11434/api/chat');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'gemma3:4b');
  assert.equal(body.stream, false);
  assert.match(body.messages[1].content, /"route"/);
});

test('accepts plain string/boolean answers - what a small model actually emits', async () => {
  const fetch = fakeFetch(200, ollamaReply('{"route": "status", "risky": true}'));
  const c = createLocalRouterClient({ fetch });
  const res = await c.systemOne(req);
  assert.equal(res.answers.route.choice, 'status');
  assert.equal(res.answers.route.confidence, 0.75);
  assert.equal(res.answers.risky.noul, 0.85);
});

test('also accepts the fuller {choice, confidence} / {noul} object form', async () => {
  const fetch = fakeFetch(200, ollamaReply('{"route": {"choice": "status", "confidence": 0.9}, "risky": {"noul": 0.1}}'));
  const c = createLocalRouterClient({ fetch });
  const res = await c.systemOne(req);
  assert.equal(res.answers.route.confidence, 0.9);
  assert.equal(res.answers.risky.noul, 0.1);
});

test('clamps an out-of-range confidence or noul into [0, 1]', async () => {
  const fetch = fakeFetch(200, ollamaReply('{"route": {"choice": "status", "confidence": 5}, "risky": {"noul": -2}}'));
  const c = createLocalRouterClient({ fetch });
  const res = await c.systemOne(req);
  assert.equal(res.answers.route.confidence, 1);
  assert.equal(res.answers.risky.noul, 0);
});

test('tolerates markdown fences or prose around the JSON object', async () => {
  const fetch = fakeFetch(200, ollamaReply('Sure, here you go:\n```json\n{"route": "none", "risky": false}\n```'));
  const c = createLocalRouterClient({ fetch });
  const res = await c.systemOne(req);
  assert.equal(res.answers.route.choice, 'none');
});

test('rejects a choice the question did not list', async () => {
  const fetch = fakeFetch(200, ollamaReply('{"route": "launch_missiles", "risky": false}'));
  const c = createLocalRouterClient({ fetch });
  await assert.rejects(c.systemOne(req), /unlisted option/);
});

test('a non-route field with an unlisted choice degrades to a zero-confidence default instead of failing', async () => {
  const req2 = {
    state: {},
    questions: {
      ...req.questions,
      persona: { type: 'choice', instructions: 'z', criteria: { po: 'p', tech: 't' } },
    },
  };
  const fetch = fakeFetch(200, ollamaReply('{"route": "status", "risky": false, "persona": "infra"}'));
  const c = createLocalRouterClient({ fetch });
  const res = await c.systemOne(req2);
  assert.equal(res.answers.persona.choice, 'po');
  assert.equal(res.answers.persona.confidence, 0);
});

test('rejects a response missing a question', async () => {
  const fetch = fakeFetch(200, ollamaReply('{"route": "status"}'));
  const c = createLocalRouterClient({ fetch });
  await assert.rejects(c.systemOne(req), /did not answer "risky"/);
});

test('rejects output with no JSON object at all', async () => {
  const fetch = fakeFetch(200, ollamaReply('I am not sure how to answer that.'));
  const c = createLocalRouterClient({ fetch });
  await assert.rejects(c.systemOne(req), /no JSON object/);
});

test('surfaces an HTTP error from Ollama', async () => {
  const fetch = fakeFetch(500, { error: 'model not found' });
  const c = createLocalRouterClient({ fetch });
  await assert.rejects(c.systemOne(req), /local router HTTP 500/);
});

test('surfaces a network/connection failure (e.g. Ollama not running)', async () => {
  const fetch = async () => { throw new Error('ECONNREFUSED'); };
  const c = createLocalRouterClient({ fetch });
  await assert.rejects(c.systemOne(req), /local router request failed: ECONNREFUSED/);
});

test('reports each call to onCall with model, outcome and token usage', async () => {
  const seen = [];
  const fetch = fakeFetch(200, { ...ollamaReply('{"route": "status", "risky": false}'), prompt_eval_count: 300, eval_count: 12, total_duration: 4e9 });
  const c = createLocalRouterClient({ fetch, model: 'gemma3:4b', onCall: (e) => seen.push(e) });
  await c.systemOne(req);
  assert.deepEqual(seen, [{ provider: 'ollama', model: 'gemma3:4b', purpose: 'route', ok: true, input_tokens: 300, output_tokens: 12, ms: 4000 }]);
});

test('reports a failed call too, and an onCall error never breaks routing', async () => {
  const seen = [];
  const c = createLocalRouterClient({ fetch: fakeFetch(500, {}), onCall: (e) => seen.push(e) });
  await assert.rejects(c.systemOne(req), /HTTP 500/);
  assert.equal(seen[0].ok, false);
  const ok = createLocalRouterClient({ fetch: fakeFetch(200, ollamaReply('{"route": "status", "risky": false}')), onCall: () => { throw new Error('boom'); } });
  await ok.systemOne(req);
});
