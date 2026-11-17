// node --test dispatch-settings.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDispatchSettings, validateCap } = require('./dispatch-settings');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dset-')), 'nested', 'settings.json');
const NOW = () => new Date('2026-11-17T12:00:00Z');

test('validateCap accepts whole numbers 0..1000, including numeric strings', () => {
  assert.deepEqual(validateCap(0), { ok: true, value: 0 });
  assert.deepEqual(validateCap('50'), { ok: true, value: 50 });
  for (const bad of [-1, 1001, 2.5, '', ' ', 'ten', null, undefined, NaN, '1e3x']) {
    assert.equal(validateCap(bad).ok, false, `rejects ${JSON.stringify(bad)}`);
  }
});

test('without a settings file the .env cap applies', () => {
  const s = createDispatchSettings({ file: tmpFile(), envCap: 20 });
  assert.equal(s.cap(), 20);
  assert.deepEqual(s.describe(), { dailyPaidRuns: 20, source: 'env', envDefault: 20 });
});

test('an admin change applies at once, records who, and survives a restart', () => {
  const file = tmpFile();
  const s = createDispatchSettings({ file, envCap: 20, now: NOW });
  const r = s.setCap('50', 'sriad');
  assert.equal(r.ok, true);
  assert.equal(s.cap(), 50);
  assert.deepEqual(s.describe(), { dailyPaidRuns: 50, source: 'admin', updatedBy: 'sriad', updatedAt: '2026-11-17T12:00:00.000Z', envDefault: 20 });
  const again = createDispatchSettings({ file, envCap: 20 });
  assert.equal(again.cap(), 50);
});

test('a bad value changes nothing', () => {
  const file = tmpFile();
  const s = createDispatchSettings({ file, envCap: 20 });
  assert.equal(s.setCap(-5, 'x').ok, false);
  assert.equal(s.cap(), 20);
  assert.equal(fs.existsSync(file), false);
});

test('a corrupt settings file falls back to .env', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"dailyPaidRuns": "lots"');
  assert.equal(createDispatchSettings({ file, envCap: 20 }).cap(), 20);
});
