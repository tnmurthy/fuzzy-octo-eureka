'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const k = require('./request-kinds');

test('keyword guesses on real requests from the run log', () => {
  const cases = [
    ['build a plan and help me in enrolling 30 users for this https://drisyon.com/cloud-security', 'document'],
    ['how can this repo (ruffle) help in my existing fuzzy-octo-eureka', 'answer'],
    ['Explain this codebase: architecture, entry points and how to run it', 'answer'],
    ['Turn the TODO and FIXME comments into a prioritised backlog', 'document'],
    ['add page number', 'change'],
    ['Read package.json and tell me the name of the test script command.', 'answer'],
    ['Find and fix the top 3 bugs or risky spots, with a test for each', 'change'],
    ['Split the largest file into smaller modules without changing behaviour', 'change'],
    ['Is the signup page slow?', 'answer'],
    ['', 'answer'],
  ];
  for (const [text, want] of cases) assert.equal(k.keywordKind(text), want, text);
});

test('a change starts as a plan; Go ahead makes it a change; follow-ups keep the kind', () => {
  assert.equal(k.resolveKind({ requested: 'change' }), 'plan');
  assert.equal(k.resolveKind({ requested: 'answer' }), 'answer');
  assert.equal(k.resolveKind({ requested: 'bogus' }), null);
  assert.equal(k.resolveKind({ requested: undefined }), null);
  assert.equal(k.resolveKind({ followUp: true, parentKind: 'plan' }), 'plan');
  assert.equal(k.resolveKind({ followUp: true, parentKind: 'answer', requested: 'change' }), 'answer', 'a follow-up cannot pick its own kind');
  assert.equal(k.resolveKind({ followUp: true, parentKind: null }), null);
  assert.equal(k.resolveKind({ followUp: true, parentKind: 'plan', approvePlan: true }), 'change');
});

test('read-only kinds and their guidance', () => {
  for (const kind of ['answer', 'document', 'plan']) {
    assert.equal(k.isReadOnlyKind(kind), true, kind);
    assert.match(k.kindBlock(kind), /do not change any files/i);
  }
  assert.equal(k.isReadOnlyKind('change'), false);
  assert.equal(k.isReadOnlyKind(null), false);
  assert.match(k.kindBlock('change'), /approved the plan/);
  assert.equal(k.kindBlock(null), '');
});

test('classifier uses the model when it answers, keywords when it fails or talks nonsense', async () => {
  const model = k.createKindClassifier({ ask: async () => 'document' });
  assert.deepEqual(await model('add page number'), { kind: 'document', source: 'model' });
  const down = k.createKindClassifier({ ask: async () => { throw new Error('down'); } });
  assert.deepEqual(await down('add page number'), { kind: 'change', source: 'keywords' });
  const odd = k.createKindClassifier({ ask: async () => 'banana' });
  assert.deepEqual(await odd('What is this?'), { kind: 'answer', source: 'keywords' });
  const none = k.createKindClassifier();
  assert.deepEqual(await none('write a report'), { kind: 'document', source: 'keywords' });
});
