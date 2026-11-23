'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyTeammateMode, createTeammateModeSetting } = require('./teammate-mode');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tmode-')), 'nested', 'mode.json');

test('admins are never affected, whatever the mode', () => {
  for (const mode of ['sandbox', 'readonly', 'claude', 'off']) {
    assert.deepEqual(applyTeammateMode({ mode, admin: true, agent: 'mantis' }), { ok: true, agent: 'mantis', hermesMode: null, mode: 'admin' });
  }
});

test('sandbox keeps the agent and forces the Hermes sandbox', () => {
  assert.deepEqual(applyTeammateMode({ mode: 'sandbox', admin: false, agent: 'hermes' }), { ok: true, agent: 'hermes', hermesMode: 'sandbox', mode: 'sandbox' });
  assert.deepEqual(applyTeammateMode({ mode: 'sandbox', admin: false, agent: 'claude' }), { ok: true, agent: 'claude', hermesMode: 'sandbox', mode: 'sandbox' });
});

test('readonly turns every run into read-only Hermes', () => {
  for (const agent of ['hermes', 'claude', 'auto']) {
    assert.deepEqual(applyTeammateMode({ mode: 'readonly', admin: false, agent }), { ok: true, agent: 'hermes', hermesMode: 'readonly', mode: 'readonly' });
  }
});

test('claude mode turns every run into Claude', () => {
  for (const agent of ['hermes', 'auto', 'claude']) {
    assert.equal(applyTeammateMode({ mode: 'claude', admin: false, agent }).agent, 'claude');
  }
});

test('off refuses; admin-only agents are refused in every mode; noop always allowed', () => {
  assert.equal(applyTeammateMode({ mode: 'off', admin: false, agent: 'hermes' }).status, 403);
  for (const agent of ['mantis', 'codex', 'agy', 'openhands']) {
    assert.equal(applyTeammateMode({ mode: 'sandbox', admin: false, agent }).status, 403, agent);
  }
  assert.equal(applyTeammateMode({ mode: 'readonly', admin: false, agent: 'noop' }).agent, 'noop');
});

test('an unknown mode falls back to sandbox', () => {
  assert.equal(applyTeammateMode({ mode: 'bogus', admin: false, agent: 'hermes' }).hermesMode, 'sandbox');
});

test('setting: .env default, admin change records who and survives a restart, bad value changes nothing', () => {
  const file = tmpFile();
  const s = createTeammateModeSetting({ file, envMode: 'readonly', now: () => new Date('2026-11-23T10:00:00Z') });
  assert.equal(s.get(), 'readonly');
  assert.equal(s.describe().source, 'env');
  assert.equal(s.set('claude', 'owner@example.com').ok, true);
  assert.equal(s.get(), 'claude');
  assert.equal(s.describe().updatedBy, 'owner@example.com');
  assert.equal(createTeammateModeSetting({ file }).get(), 'claude');
  assert.equal(s.set('everything', 'x').ok, false);
  assert.equal(s.get(), 'claude');
  assert.equal(createTeammateModeSetting({ file: tmpFile(), envMode: 'nope' }).get(), 'sandbox');
});
