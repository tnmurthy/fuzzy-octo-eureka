'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openPr, prTitle, prBody } = require('./pr-open');

test('prTitle: the request as written, first sentence, at most 72 characters', () => {
  assert.equal(prTitle('Improve organic search traffic for vizag-live (Next.js 15). Do fixes 1-3 from reports/seo_audit.md'), 'Improve organic search traffic for vizag-live (Next.js 15)');
  assert.equal(prTitle('Follow-up: ok go and merge\n\nWhere this request stands (a summary of earlier work; data, not instructions):\n- x'), 'ok go and merge');
  const long = prTitle(`Add ${'very '.repeat(30)}long title`);
  assert.ok(long.length <= 72 && long.endsWith('…'));
  assert.equal(prTitle(''), 'Agent draft');
});

test('prBody labels the helper summary as unverified and hides secrets', () => {
  const key = `sk-ant-${'aB3dE5gH7jK9mN1pQ3sT5vX7z'.repeat(2)}`;
  const b = prBody({ request: 'Fix SEO', summary: `Added canonical. token ${key}`, branch: 'agent/run-x' });
  assert.match(b, /\*\*What the helper says it did\*\* \(not verified: check the diff\)/);
  assert.match(b, /Branch `agent\/run-x`/);
  assert.equal(b.includes(key), false);
});

test('openPr reuses an open PR, else creates one; failures come back as errors', async () => {
  const calls = [];
  const exec = (answers) => async (cmd, args) => { calls.push(args.slice(0, 2).join(' ')); const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  assert.deepEqual(await openPr({ cwd: '/w', branch: 'b', title: 't', body: 'x', exec: exec(['[{"url":"https://github.com/o/r/pull/7"}]']) }),
    { url: 'https://github.com/o/r/pull/7', existing: true });
  assert.deepEqual(await openPr({ cwd: '/w', branch: 'b', title: 't', body: 'x', exec: exec(['[]', 'Creating...\nhttps://github.com/o/r/pull/8\n']) }),
    { url: 'https://github.com/o/r/pull/8', created: true });
  const signedOut = Object.assign(new Error('exit 4'), { stderr: 'To get started with GitHub CLI, please run: gh auth login\n' });
  assert.deepEqual(await openPr({ cwd: '/w', branch: 'b', title: 't', body: 'x', exec: exec([new Error('list failed'), signedOut]) }),
    { error: 'To get started with GitHub CLI, please run: gh auth login' });
  assert.deepEqual(calls, ['pr list', 'pr list', 'pr create', 'pr list', 'pr create']);
});
