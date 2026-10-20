// node --test buzz-bridge/typesafe-client.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTypeSafeClient } = require('./typesafe-client');

const tmpLedger = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-')), 'ledger.jsonl');
const okResponse = { model: 'jev-latest', answers: { route: { type: 'choice', choice: 'status', confidence: 0.9 } }, usage: { input_tokens: 100, output_tokens: 5 } };

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  fn.calls = calls;
  return fn;
}

const req = { state: { message: 'hi' }, questions: { route: { type: 'choice', instructions: 'x', criteria: { a: 'a' } } } };
const day = Date.parse('2026-10-20T10:00:00Z');

test('posts to /v1/systemone with bearer auth and model', async () => {
  const fetch = fakeFetch(200, okResponse);
  const c = createTypeSafeClient({ apiKey: 'k', fetch, ledgerFile: tmpLedger(), now: () => day });
  const res = await c.systemOne(req);
  assert.equal(res.answers.route.choice, 'status');
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.headers.Authorization, 'Bearer k');
  assert.equal(JSON.parse(init.body).model, 'jev-latest');
});

test('logs every billable call to the ledger', async () => {
  const ledgerFile = tmpLedger();
  const c = createTypeSafeClient({ apiKey: 'k', fetch: fakeFetch(200, okResponse), ledgerFile, now: () => day });
  await c.systemOne(req, { purpose: 'route' });
  const line = JSON.parse(fs.readFileSync(ledgerFile, 'utf8').trim());
  assert.equal(line.purpose, 'route');
  assert.equal(line.ok, true);
  assert.equal(line.input_tokens, 100);
});

test('refuses once the daily cap is reached, counting from the ledger', async () => {
  const ledgerFile = tmpLedger();
  const fetch = fakeFetch(200, okResponse);
  const c = createTypeSafeClient({ apiKey: 'k', fetch, ledgerFile, dailyCap: 2, now: () => day });
  await c.systemOne(req);
  await c.systemOne(req);
  await assert.rejects(c.systemOne(req), /daily cap/);
  assert.equal(fetch.calls.length, 2);
  // A new client (service restart) still sees today's count.
  const again = createTypeSafeClient({ apiKey: 'k', fetch, ledgerFile, dailyCap: 2, now: () => day });
  await assert.rejects(again.systemOne(req), /daily cap/);
});

test('the cap resets on a new day', async () => {
  const ledgerFile = tmpLedger();
  let clock = day;
  const c = createTypeSafeClient({ apiKey: 'k', fetch: fakeFetch(200, okResponse), ledgerFile, dailyCap: 1, now: () => clock });
  await c.systemOne(req);
  clock += 24 * 3600 * 1000;
  await c.systemOne(req);
});

test('fails clearly without an API key and makes no call', async () => {
  const fetch = fakeFetch(200, okResponse);
  const c = createTypeSafeClient({ apiKey: '', fetch, ledgerFile: tmpLedger() });
  await assert.rejects(c.systemOne(req), /TYPESAFE_API_KEY/);
  assert.equal(fetch.calls.length, 0);
});

test('an API error is thrown and still logged', async () => {
  const ledgerFile = tmpLedger();
  const c = createTypeSafeClient({ apiKey: 'k', fetch: fakeFetch(422, { detail: 'bad' }), ledgerFile, now: () => day });
  await assert.rejects(c.systemOne(req), /422/);
  assert.equal(JSON.parse(fs.readFileSync(ledgerFile, 'utf8').trim()).ok, false);
});
