// host-specs.test.js - Tests for cross-platform host specs detection
const test = require('node:test');
const assert = require('node:assert');
const { getHostSpecs } = require('./host-specs');

test('getHostSpecs returns complete host hardware profile', () => {
  const specs = getHostSpecs();
  assert.ok(specs, 'specs should be returned');
  assert.ok(specs.platform, 'platform must be defined');
  assert.ok(specs.os, 'os description must be defined');
  assert.ok(specs.cpu, 'cpu summary must be defined');
  assert.ok(specs.cpuModel, 'cpuModel must be defined');
  assert.ok(typeof specs.coreCount === 'number' && specs.coreCount > 0, 'coreCount must be > 0');
  assert.ok(specs.gpu, 'gpu name must be defined');
  assert.ok(specs.gpuHeader, 'gpuHeader must be defined');
  assert.ok(specs.gpuSub, 'gpuSub must be defined');
  assert.ok(specs.stackRoot, 'stackRoot must be defined');
  assert.ok(specs.shellName, 'shellName must be defined');
  assert.ok(specs.ollamaEndpoint.startsWith('http://'), 'ollamaEndpoint must be valid URL');
  assert.ok(specs.openclawConfig, 'openclawConfig must be defined');
  assert.ok(specs.openclawConfigFile, 'openclawConfigFile must be defined');
});

test('getHostSpecs caches result on repeated calls', () => {
  const first = getHostSpecs();
  const second = getHostSpecs();
  assert.strictEqual(first, second, 'consecutive calls should return the cached reference');
});

test('getHostSpecs supports forced refresh', () => {
  const first = getHostSpecs();
  const refreshed = getHostSpecs(true);
  assert.deepStrictEqual(first, refreshed, 'refreshed specs should match cached specs values');
});
