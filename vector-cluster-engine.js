// vector-cluster-engine.js - Persistent Multi-Tenant Vector Clustering Engine
//
// Implements DEC-017 / TASK-105:
//   - Online adaptive clustering with running centroid normalization
//   - Strict multi-tenant boundary isolation
//   - Hierarchical semantic retrieval (Centroid Pruning -> Leaf Document Ranking)
//   - SQLite WAL persistence and local disk fallback

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_DIM = 128;
const DEFAULT_SIMILARITY_THRESHOLD = 0.6;
const DEFAULT_CLUSTER_CANDIDATES = 4;

/** Compute dot product of two unit-normalized vectors (equivalent to cosine similarity). */
function computeCosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Normalize vector to unit length (L2 norm = 1.0). */
function normalizeVector(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm === 0) return vec.slice();
  return vec.map((val) => val / norm);
}

/** Deterministic hashed semantic projection for fast, sub-millisecond vectorization. */
function hashVectorize(text, dim = DEFAULT_DIM) {
  const vec = new Array(dim).fill(0);
  const clean = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ');
  const tokens = clean.split(/\s+/).filter((t) => t.length > 1);

  if (!tokens.length) return vec;

  for (const token of tokens) {
    const hash = crypto.createHash('md5').update(token).digest();
    // Use first 4 bytes for index, 5th byte for sign
    const idx = hash.readUInt32BE(0) % dim;
    const sign = hash.readInt8(4) >= 0 ? 1 : -1;
    vec[idx] += sign;
  }

  return normalizeVector(vec);
}

/** Extract descriptive label from token frequency of cluster members. */
function deriveClusterLabel(textTokens, fallback = 'General Context') {
  const counts = {};
  for (const t of textTokens) {
    if (t.length <= 3) continue;
    counts[t] = (counts[t] || 0) + 1;
  }
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w);
  return sorted.length ? sorted.join(' / ') : fallback;
}

class VectorClusterEngine {
  constructor({
    ledgerDB = null,
    storagePath = null,
    similarityThreshold = DEFAULT_SIMILARITY_THRESHOLD,
    dim = DEFAULT_DIM,
  } = {}) {
    this.ledgerDB = ledgerDB;
    this.storagePath = storagePath;
    this.similarityThreshold = similarityThreshold;
    this.dim = dim;

    // In-memory cluster store: clusterId -> cluster object
    this.clusters = new Map();
    // Memory index: memoryId -> { id, tenantId, vector, text, clusterId }
    this.memoryIndex = new Map();

    this.loadClusters();
  }

  loadClusters() {
    // 1. Try SQLite WAL ledger first
    if (this.ledgerDB && typeof this.ledgerDB.getClusters === 'function') {
      try {
        const rows = this.ledgerDB.getClusters();
        for (const row of rows) {
          this.clusters.set(row.id, {
            id: row.id,
            tenantId: row.tenantId,
            label: row.label,
            centroid: row.centroid,
            memoryCount: row.memoryCount,
            memoryIds: row.memoryIds,
            updatedAt: row.updatedAt,
          });
        }
        return;
      } catch (_) {}
    }

    // 2. Fallback to local storage JSON
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.clusters)) {
          for (const c of data.clusters) {
            this.clusters.set(c.id, c);
          }
        }
      } catch (_) {}
    }
  }

  saveClusters() {
    const list = Array.from(this.clusters.values());

    // 1. Sync to SQLite WAL ledger
    if (this.ledgerDB && typeof this.ledgerDB.saveCluster === 'function') {
      try {
        for (const c of list) {
          this.ledgerDB.saveCluster(c);
        }
      } catch (_) {}
    }

    // 2. Sync to file cache
    if (this.storagePath) {
      try {
        fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
        fs.writeFileSync(
          this.storagePath,
          JSON.stringify(
            {
              updatedAt: new Date().toISOString(),
              clusterCount: list.length,
              clusters: list,
            },
            null,
            2
          ),
          'utf8'
        );
      } catch (_) {}
    }
  }

  /**
   * Add a memory record to the cluster engine.
   * Finds the best matching cluster within the same tenant or creates a new one.
   */
  addMemory(record) {
    if (!record || !record.id) return null;

    const tenantId = record.tenantId || 'tenant:default';
    const text = `${record.title || ''} ${record.content || ''} ${(record.tags || []).join(' ')}`;
    const vector =
      record.vector && Array.isArray(record.vector) && record.vector.length === this.dim
        ? normalizeVector(record.vector)
        : hashVectorize(text, this.dim);

    // Index leaf memory
    this.memoryIndex.set(record.id, {
      id: record.id,
      tenantId,
      vector,
      title: record.title || '',
      content: record.content || '',
      tags: record.tags || [],
      metadata: record.metadata || {},
      clusterId: null,
    });

    // Find candidate clusters for this tenant
    const tenantClusters = Array.from(this.clusters.values()).filter(
      (c) => c.tenantId === tenantId
    );

    let bestCluster = null;
    let maxSim = -1;

    for (const cluster of tenantClusters) {
      const sim = computeCosineSimilarity(vector, cluster.centroid);
      if (sim > maxSim) {
        maxSim = sim;
        bestCluster = cluster;
      }
    }

    if (bestCluster && maxSim >= this.similarityThreshold) {
      // Merge into existing cluster and update centroid
      if (!bestCluster.memoryIds.includes(record.id)) {
        bestCluster.memoryIds.push(record.id);
        bestCluster.memoryCount = bestCluster.memoryIds.length;
      }

      // Online centroid update: normalize(C * N + v)
      const count = bestCluster.memoryCount;
      const updatedCentroid = new Array(this.dim).fill(0);
      for (let i = 0; i < this.dim; i++) {
        updatedCentroid[i] = bestCluster.centroid[i] * (count - 1) + vector[i];
      }
      bestCluster.centroid = normalizeVector(updatedCentroid);
      bestCluster.updatedAt = new Date().toISOString();

      // Refresh label with new keywords
      const tokens = text
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 3);
      bestCluster.label = deriveClusterLabel(tokens, bestCluster.label);

      this.memoryIndex.get(record.id).clusterId = bestCluster.id;
      this.saveClusters();
      return { clusterId: bestCluster.id, status: 'merged', similarity: maxSim };
    } else {
      // Create new cluster for this tenant
      const clusterId = `cluster_${tenantId.replace(/[^a-zA-Z0-9]/g, '_')}_${crypto.randomBytes(3).toString('hex')}`;
      const tokens = text
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 3);
      const label = deriveClusterLabel(tokens, record.title || 'Knowledge Cluster');

      const newCluster = {
        id: clusterId,
        tenantId,
        label,
        centroid: vector,
        memoryCount: 1,
        memoryIds: [record.id],
        updatedAt: new Date().toISOString(),
      };

      this.clusters.set(clusterId, newCluster);
      this.memoryIndex.get(record.id).clusterId = clusterId;
      this.saveClusters();
      return { clusterId, status: 'created', similarity: 1.0 };
    }
  }

  /**
   * Hierarchical semantic search:
   * 1. Query vector compared against cluster centroids for the given tenant
   * 2. Top candidate clusters pruned
   * 3. Individual leaf memories inside candidate clusters scored and ranked
   */
  search(query, options = {}) {
    const {
      tenantId = 'tenant:drisyon_core',
      topK = 5,
      clusterCandidates = DEFAULT_CLUSTER_CANDIDATES,
      minSimilarity = 0.15,
      strictTenant = true,
    } = options;

    if (!query || !String(query).trim())
      return { ranker: 'cluster-hierarchical', results: [], clustersInspected: 0 };

    const queryVec = hashVectorize(query, this.dim);

    // 1. Filter clusters matching tenant (or global/cross-tenant if strictTenant is false)
    const eligibleClusters = Array.from(this.clusters.values()).filter((c) => {
      if (strictTenant) {
        return c.tenantId === tenantId || c.tenantId === 'global';
      }
      return tenantId === '*' || c.tenantId === tenantId || c.tenantId === 'global';
    });

    if (!eligibleClusters.length) {
      return { ranker: 'cluster-hierarchical', results: [], clustersInspected: 0 };
    }

    // 2. Score cluster centroids against query
    const scoredClusters = eligibleClusters
      .map((c) => ({
        cluster: c,
        centroidSim: computeCosineSimilarity(queryVec, c.centroid),
      }))
      .sort((a, b) => b.centroidSim - a.centroidSim)
      .slice(0, clusterCandidates);

    // 3. Gather candidate memory IDs from top clusters
    const candidateMemories = [];
    const inspectedClusterDetails = [];

    for (const { cluster, centroidSim } of scoredClusters) {
      inspectedClusterDetails.push({
        id: cluster.id,
        label: cluster.label,
        tenantId: cluster.tenantId,
        centroidSim: Math.round(centroidSim * 100) / 100,
        memoryCount: cluster.memoryCount,
      });

      for (const memId of cluster.memoryIds) {
        const mem = this.memoryIndex.get(memId);
        if (mem) {
          candidateMemories.push({ mem, cluster });
        }
      }
    }

    // 4. Score individual leaf memories
    const results = candidateMemories
      .map(({ mem, cluster }) => {
        const score = computeCosineSimilarity(queryVec, mem.vector);
        return {
          id: mem.id,
          score: Math.round(score * 100) / 100,
          tenantId: mem.tenantId,
          title: mem.title,
          content: mem.content,
          tags: mem.tags,
          metadata: mem.metadata,
          clusterId: cluster.id,
          clusterLabel: cluster.label,
        };
      })
      .filter((r) => r.score >= minSimilarity)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return {
      ranker: 'cluster-hierarchical',
      query,
      results,
      clustersInspected: scoredClusters.length,
      candidateClusters: inspectedClusterDetails,
    };
  }

  /** Retrieve cluster catalog filtered optionally by tenant. */
  getClusters(tenantId = null) {
    let list = Array.from(this.clusters.values());
    if (tenantId && tenantId !== '*') {
      list = list.filter((c) => c.tenantId === tenantId || c.tenantId === 'global');
    }
    return list.map((c) => ({
      id: c.id,
      tenantId: c.tenantId,
      label: c.label,
      memoryCount: c.memoryCount,
      updatedAt: c.updatedAt,
    }));
  }

  /** Rebuild all clusters from an array of memory objects. */
  rebuildIndex(memories = []) {
    this.clusters.clear();
    this.memoryIndex.clear();
    let created = 0;
    let merged = 0;

    for (const mem of memories) {
      const res = this.addMemory(mem);
      if (res) {
        if (res.status === 'created') created++;
        else merged++;
      }
    }

    return {
      totalMemories: memories.length,
      clustersCreated: this.clusters.size,
      mergedCount: merged,
    };
  }
}

module.exports = {
  VectorClusterEngine,
  computeCosineSimilarity,
  normalizeVector,
  hashVectorize,
  DEFAULT_DIM,
  DEFAULT_SIMILARITY_THRESHOLD,
};
