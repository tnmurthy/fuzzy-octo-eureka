// vector-cluster-engine.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  VectorClusterEngine,
  computeCosineSimilarity,
  normalizeVector,
  hashVectorize,
} = require('./vector-cluster-engine');
const { createLedgerDB } = require('./ledger-db');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vclust-')), 'test.db');

test('vector math: normalizeVector and computeCosineSimilarity', () => {
  const v1 = normalizeVector([3, 4]);
  assert.equal(Math.round(v1[0] * 10) / 10, 0.6);
  assert.equal(Math.round(v1[1] * 10) / 10, 0.8);

  const v2 = normalizeVector([3, 4]);
  const simIdentical = computeCosineSimilarity(v1, v2);
  assert.equal(Math.round(simIdentical * 100) / 100, 1.0);

  const vOrthogonal = normalizeVector([-4, 3]);
  const simOrthogonal = computeCosineSimilarity(v1, vOrthogonal);
  assert.equal(Math.round(simOrthogonal * 100) / 100, 0.0);
});

test('hashVectorize produces deterministic unit vectors', () => {
  const v1 = hashVectorize('cloud security and firewall', 64);
  const v2 = hashVectorize('cloud security and firewall', 64);
  assert.equal(v1.length, 64);
  assert.deepEqual(v1, v2);

  // Compute L2 norm
  let norm = 0;
  for (const x of v1) norm += x * x;
  assert.equal(Math.round(norm * 100) / 100, 1.0);
});

test('vector clustering: assigns related memories to same cluster and updates centroid', () => {
  const engine = new VectorClusterEngine({ similarityThreshold: 0.5, dim: 64 });

  const m1 = engine.addMemory({
    id: 'mem_1',
    tenantId: 'tenant:drisyon_core',
    title: 'Kubernetes Breach Defense',
    content: 'Container security, Falco runtime alerts, and pod isolation policies.',
    tags: ['k8s', 'security'],
  });
  assert.equal(m1.status, 'created');
  assert.ok(m1.clusterId);

  const m2 = engine.addMemory({
    id: 'mem_2',
    tenantId: 'tenant:drisyon_core',
    title: 'Container Runtime Security',
    content: 'Falco alerts, pod isolation policies, and Kubernetes container security.',
    tags: ['k8s', 'security'],
  });
  assert.equal(m2.status, 'merged');
  assert.equal(m2.clusterId, m1.clusterId);

  const clusters = engine.getClusters('tenant:drisyon_core');
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].memoryCount, 2);
});

test('vector clustering: enforces strict multi-tenant boundary isolation', () => {
  const engine = new VectorClusterEngine({ similarityThreshold: 0.3, dim: 64 });

  // Add identical content for two different tenants
  const m1 = engine.addMemory({
    id: 'mem_tenantA',
    tenantId: 'tenant:client_alpha',
    title: 'Proprietary Fintech Algorithm',
    content: 'Trading volume calculation and high-frequency risk modeling.',
  });

  const m2 = engine.addMemory({
    id: 'mem_tenantB',
    tenantId: 'tenant:client_beta',
    title: 'Proprietary Fintech Algorithm',
    content: 'Trading volume calculation and high-frequency risk modeling.',
  });

  // Despite identical content, they must form distinct clusters belonging to each tenant
  assert.notEqual(m1.clusterId, m2.clusterId);

  const alphaClusters = engine.getClusters('tenant:client_alpha');
  const betaClusters = engine.getClusters('tenant:client_beta');

  assert.equal(alphaClusters.length, 1);
  assert.equal(betaClusters.length, 1);
  assert.equal(alphaClusters[0].tenantId, 'tenant:client_alpha');
  assert.equal(betaClusters[0].tenantId, 'tenant:client_beta');

  // Search by client_alpha must NEVER return client_beta memories
  const searchAlpha = engine.search('high frequency trading risk', {
    tenantId: 'tenant:client_alpha',
    strictTenant: true,
  });

  assert.ok(searchAlpha.results.some((r) => r.id === 'mem_tenantA'));
  assert.ok(!searchAlpha.results.some((r) => r.id === 'mem_tenantB'));
});

test('vector clustering: hierarchical retrieval prunes clusters and ranks leaf memories', () => {
  const engine = new VectorClusterEngine({ similarityThreshold: 0.45, dim: 64 });

  // Cluster 1: Cloud security
  engine.addMemory({
    id: 'sec_1',
    tenantId: 'tenant:drisyon_core',
    title: 'Firewall Policy Review',
    content: 'Palo Alto and FortiGate next-gen firewall rules with ingress filtering.',
  });
  engine.addMemory({
    id: 'sec_2',
    tenantId: 'tenant:drisyon_core',
    title: 'Zero Trust Network Access',
    content: 'Zscaler and Okta authentication for cloud access security broker.',
  });

  // Cluster 2: Database and SQLite
  engine.addMemory({
    id: 'db_1',
    tenantId: 'tenant:drisyon_core',
    title: 'SQLite WAL Mode Tuning',
    content: 'Write-ahead logging, database concurrency, and PRAGMA synchronous normal.',
  });
  engine.addMemory({
    id: 'db_2',
    tenantId: 'tenant:drisyon_core',
    title: 'PostgreSQL Connection Pooling',
    content: 'PgBouncer connection limits, transaction pooling, and query latency.',
  });

  // Search for firewall security
  const secQuery = engine.search('FortiGate firewall ingress rules', {
    tenantId: 'tenant:drisyon_core',
    topK: 2,
  });

  assert.ok(secQuery.results.length > 0);
  assert.equal(secQuery.results[0].id, 'sec_1');
  assert.ok(
    secQuery.results[0].clusterLabel.includes('firewall') ||
      secQuery.results[0].clusterLabel.includes('rules') ||
      secQuery.results[0].clusterLabel.includes('palo')
  );

  // Database memories must not be the top match
  assert.notEqual(secQuery.results[0].id, 'db_1');
});

test('vector clustering: persists to SQLite WAL ledger and reloads', () => {
  const dbFile = tmp();
  const ledgerDB = createLedgerDB({ dbPath: dbFile });

  const engine1 = new VectorClusterEngine({
    ledgerDB,
    similarityThreshold: 0.5,
    dim: 64,
  });

  engine1.addMemory({
    id: 'mem_wal_1',
    tenantId: 'tenant:drisyon_core',
    title: 'Incident Antidote Mining',
    content: 'Closed loop git mining and continuous memory synthesis.',
  });

  const clusters1 = engine1.getClusters('tenant:drisyon_core');
  assert.equal(clusters1.length, 1);

  // Spin up a new engine pointing to the same ledger DB
  const engine2 = new VectorClusterEngine({
    ledgerDB,
    similarityThreshold: 0.5,
    dim: 64,
  });

  const clusters2 = engine2.getClusters('tenant:drisyon_core');
  assert.equal(clusters2.length, 1);
  assert.equal(clusters2[0].id, clusters1[0].id);

  ledgerDB.close();
});
