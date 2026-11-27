// node --test cohort-candidates.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCohortCandidates, STAGES } = require('./cohort-candidates');

function make() {
  const file = path.join(os.tmpdir(), `test-cc-${Math.random()}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return createCohortCandidates({ file });
}

test('create({ name: "Asha" }) returns ok: true with a candidate whose stage is "lead_inquiry" and whose id starts with cand_', () => {
  const { create } = make();
  const { ok, candidate } = create({ name: 'Asha' });
  assert.strictEqual(ok, true);
  assert.strictEqual(candidate.stage, 'lead_inquiry');
  assert.ok(candidate.id.startsWith('cand_'));
});

test('create({}) (no name) returns ok: false with an error about name being required', () => {
  const { create } = make();
  const { ok, error } = create({ });
  assert.strictEqual(ok, false);
  assert.ok(error.includes('name is required'));
});

test('list() after creating 2 candidates returns both', () => {
  const { create, list } = make();
  create({ name: 'Asha' });
  create({ name: 'Bob' });
  assert.strictEqual(list().length, 2);
});

test('updateStage(id, "screen_scheduled") on a real id returns ok: true and the candidate\'s new stage; list() afterward reflects the change', () => {
  const { create, updateStage, list } = make();
  const { candidate } = create({ name: 'Asha' });
  const { ok, candidate: updated } = updateStage(candidate.id, 'screen_scheduled');
  assert.strictEqual(ok, true);
  assert.strictEqual(updated.stage, 'screen_scheduled');
  assert.strictEqual(list().find(c => c.id === candidate.id).stage, 'screen_scheduled');
});

test('updateStage(id, "not-a-real-stage") returns ok: false with an error naming the valid stages', () => {
  const { create, updateStage } = make();
  const { candidate } = create({ name: 'Asha' });
  const { ok, error } = updateStage(candidate.id, 'invalid_stage');
  assert.strictEqual(ok, false);
  assert.ok(error.includes('stage must be one of:'));
  assert.ok(error.includes(STAGES.join(', ')));
});

test('updateStage(\"no-such-id\", \"screen_scheduled\") returns ok: false with a \"no such candidate\" error', () => {
  const { updateStage } = make();
  const { ok, error } = updateStage('no-such-id', 'screen_scheduled');
  assert.strictEqual(ok, false);
  assert.strictEqual(error, 'no such candidate');
});
