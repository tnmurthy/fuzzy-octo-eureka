// memory-engine.js - Drisyon Unified Brain & Multi-Tenant Memory Engine
// Part of tt-ai-stack & Drisyon Operations Center.
// Implements 4-tier cognitive memory model:
// Tier 1: Working Memory (Ephemeral conversation & tool state)
// Tier 2: Episodic & Semantic Memory (Partitioned by Tenant with ReBAC boundaries)
// Tier 3: Procedural Invariants (DEC-001, DEC-002, DEC-003, DEC-005)
// Tier 4: Operator Alignment Memory (Ingested human-to-team dispatches)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class DrisyonMemoryEngine {
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(__dirname, 'drisyon-memory.json');
    this.workingMemory = new Map();
    this.episodicMemory = [];
    this.proceduralInvariants = [];
    this.operatorAlignments = [];

    this._initializeProceduralMemory();
    this.loadFromDisk();
  }

  _initializeProceduralMemory() {
    this.proceduralInvariants = [
      {
        id: 'DEC-001',
        title: 'Client-Owned Infrastructure & Zero Production Credentials',
        rule: 'DRISYON produces release bundles and IaC. Client CI executes them. DRISYON holds NO client production credentials at any tier. Staging uses synthetic data only.',
        enforcement: 'STRICT_BLOCK',
        scope: 'ALL_TENANTS'
      },
      {
        id: 'DEC-002',
        title: 'Run Step Idempotency Keyed on Trigger',
        rule: 'run_step idempotency is keyed on (project_id, run_id, actor, intent, trigger_ref). Trigger naming identifies cause (<source>:<id>).',
        enforcement: 'STRICT_BLOCK',
        scope: 'ENGINE'
      },
      {
        id: 'DEC-003',
        title: 'Parked is a Health Condition, Never a State',
        rule: 'project.state and project.health are orthogonal. Parking is a health change with state held constant.',
        enforcement: 'SCHEMA_CONSTRAINT',
        scope: 'STATE_MACHINE'
      },
      {
        id: 'DEC-005',
        title: 'Invariant I-8: Evidence Over Assertion for Gates',
        rule: 'Gate verdict PASSED requires non-empty evidence_refs array. Zero-evidence pass auto-fails.',
        enforcement: 'GATE_EVALUATION',
        scope: 'GATES'
      }
    ];
  }

  _computeVector(text) {
    const clean = (text || '').toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ');
    const tokens = clean.split(/\s+/).filter(t => t.length > 2);
    const freq = {};
    for (const t of tokens) {
      freq[t] = (freq[t] || 0) + 1;
    }
    return freq;
  }

  _cosineSimilarity(vecA, vecB) {
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (const [term, weight] of Object.entries(vecA)) {
      normA += weight * weight;
      if (vecB[term]) {
        dot += weight * vecB[term];
      }
    }
    for (const weight of Object.values(vecB)) {
      normB += weight * weight;
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  storeMemory(record) {
    const {
      tenantId = 'tenant:drisyon_core',
      projectId = 'global',
      category = 'context',
      title,
      content,
      tags = [],
      metadata = {}
    } = record;

    const memoryId = 'mem_' + crypto.randomBytes(6).toString('hex');
    const entry = {
      id: memoryId,
      tenantId,
      projectId,
      category,
      title: title || 'Untitled Knowledge',
      content,
      vector: this._computeVector(content + ' ' + (title || '') + ' ' + tags.join(' ')),
      tags,
      metadata,
      createdAt: new Date().toISOString()
    };

    this.episodicMemory.unshift(entry);
    this.saveToDisk();
    return entry;
  }

  ingestOperatorDispatch(dispatch) {
    const alignmentRecord = {
      id: 'align_' + (dispatch.id || Date.now()),
      sender: dispatch.sender || 'Operator',
      target: dispatch.target || 'Team',
      tenantId: dispatch.tenant || 'tenant:drisyon_core',
      directive: dispatch.content,
      priority: dispatch.priority || 'NORMAL',
      timestamp: dispatch.timestamp || new Date().toISOString(),
      vector: this._computeVector(dispatch.content)
    };

    this.operatorAlignments.unshift(alignmentRecord);

    this.storeMemory({
      tenantId: alignmentRecord.tenantId,
      projectId: 'all',
      category: 'operator_directive',
      title: `Directive from ${alignmentRecord.sender}`,
      content: dispatch.content,
      tags: ['dispatch', 'human_in_loop', alignmentRecord.priority],
      metadata: { originalDispatchId: dispatch.id }
    });

    return alignmentRecord;
  }

  search(query, options = {}) {
    const {
      tenantId = 'tenant:drisyon_core',
      projectId = null,
      category = null,
      topK = 5,
      threshold = 0.05
    } = options;

    const queryVec = this._computeVector(query);
    const results = [];

    for (const mem of this.episodicMemory) {
      // ReBAC / Multi-tenancy check: non-core tenants only see their own memories
      if (tenantId !== 'tenant:drisyon_core' && mem.tenantId !== tenantId) {
        continue;
      }

      if (projectId && mem.projectId !== 'all' && mem.projectId !== 'global' && mem.projectId !== projectId) {
        continue;
      }

      if (category && mem.category !== category) {
        continue;
      }

      const score = this._cosineSimilarity(queryVec, mem.vector);
      if (score >= threshold) {
        results.push({
          id: mem.id,
          score: Math.round(score * 100) / 100,
          tenantId: mem.tenantId,
          projectId: mem.projectId,
          category: mem.category,
          title: mem.title,
          content: mem.content,
          metadata: mem.metadata,
          createdAt: mem.createdAt
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  saveToDisk() {
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        episodicCount: this.episodicMemory.length,
        alignmentsCount: this.operatorAlignments.length,
        episodicMemory: this.episodicMemory.slice(0, 1000),
        operatorAlignments: this.operatorAlignments.slice(0, 200)
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      console.error('[MEMORY ENGINE] Disk save failed:', err.message);
    }
  }

  loadFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const data = JSON.parse(raw);
        this.episodicMemory = data.episodicMemory || [];
        this.operatorAlignments = data.operatorAlignments || [];
        console.log(`[MEMORY ENGINE] Loaded ${this.episodicMemory.length} memories from disk.`);
      }
    } catch (err) {
      console.warn('[MEMORY ENGINE] Disk load empty or new:', err.message);
    }
  }
}

module.exports = DrisyonMemoryEngine;
