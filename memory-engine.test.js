// memory-engine.test.js - Comprehensive testing of DrisyonMemoryEngine L0/L1/L2 and Antidotes
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DrisyonMemoryEngine = require('./memory-engine');

test('memory engine manages L0/L1/L2 tiered context and zooming', () => {
  const tmpPath = path.join(os.tmpdir(), `drisyon-tiered-${Date.now()}.json`);
  const engine = new DrisyonMemoryEngine({ storagePath: tmpPath });

  // Store memories in different categories
  engine.storeMemory({
    category: 'architecture',
    title: 'Microservices vs Monolith Boundary',
    content: 'All agent routing passes through server.js with PM2 supervision.',
    tags: ['arch', 'pm2']
  });

  engine.storeMemory({
    category: 'database',
    title: 'Supabase RLS Protocol',
    content: 'Client reads require JWT with tenant claim. Service role key never leaves server.',
    tags: ['db', 'security']
  });

  // 1. Test L0 Index (compact ~100 tokens summary)
  const l0 = engine.getL0Index();
  assert.equal(l0.tier, 'L0');
  assert.ok(l0.invariants.length > 0);
  assert.match(l0.summary, /Invariants:/);
  assert.ok(l0.summary.length < 500, 'L0 index must stay lean');

  // 2. Test L1 Rollup (domain specific)
  const l1 = engine.getL1Rollup('architecture');
  assert.equal(l1.tier, 'L1');
  assert.equal(l1.domain, 'architecture');
  assert.equal(l1.count, 1);
  assert.match(l1.entries[0].title, /Microservices vs Monolith/);

  // 3. Test L2 Detail (deep query by ID)
  const memId = l1.entries[0].id;
  const l2 = engine.getL2Detail(memId);
  assert.equal(l2.tier, 'L2');
  assert.equal(l2.id, memId);
  assert.match(l2.content, /PM2 supervision/);

  // 4. Test Memory Zoom MCP tool helper
  const zoomL0 = engine.memoryZoom();
  assert.equal(zoomL0.tier, 'L0');

  const zoomL1 = engine.memoryZoom('database');
  assert.equal(zoomL1.tier, 'L1');
  assert.equal(zoomL1.domain, 'database');

  const zoomL2 = engine.memoryZoom(memId);
  assert.equal(zoomL2.tier, 'L2');

  // Cleanup
  try { fs.unlinkSync(tmpPath); } catch (_) {}
});

test('memory engine stores, persists, and matches failure antidotes', () => {
  const tmpPath = path.join(os.tmpdir(), `drisyon-antidote-${Date.now()}.json`);
  const engine = new DrisyonMemoryEngine({ storagePath: tmpPath });

  // Seed baseline antidotes are loaded
  assert.ok(engine.antidotes.length >= 2);
  const baseline = engine.antidotes.find(a => a.id === 'ANT-001');
  assert.ok(baseline);
  assert.match(baseline.antidote, /Never kill daemons with kill -9/);

  // Store new custom antidote
  const newAnt = engine.storeAntidote({
    id: 'ANT-999',
    pattern: 'Node 22 fetch header parse error',
    symptom: 'UND_ERR_INVALID_ARG fetch header error',
    antidote: 'Sanitize newline characters from headers before fetch call.',
    scope: ['api', 'network']
  });

  assert.equal(newAnt.id, 'ANT-999');

  // Search matching antidote
  const matches = engine.searchAntidotes('Encountered UND_ERR_INVALID_ARG fetch header error on api dispatch');
  assert.ok(matches.length > 0);
  assert.equal(matches[0].id, 'ANT-999');

  // Reload engine from disk to verify persistence
  const reloaded = new DrisyonMemoryEngine({ storagePath: tmpPath });
  const reloadedAnt = reloaded.antidotes.find(a => a.id === 'ANT-999');
  assert.ok(reloadedAnt, 'Custom antidote must persist across restarts');

  // Cleanup
  try { fs.unlinkSync(tmpPath); } catch (_) {}
});
