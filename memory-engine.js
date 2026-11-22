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
const { VectorClusterEngine } = require('./vector-cluster-engine');

class DrisyonMemoryEngine {
  constructor(options = {}) {
    this.storagePath = options.storagePath || path.join(__dirname, 'drisyon-memory.json');
    this.workingMemory = new Map();
    this.episodicMemory = [];
    this.proceduralInvariants = [];
    this.operatorAlignments = [];
    this.antidotes = [];
    this.clusterEngine =
      options.clusterEngine ||
      new VectorClusterEngine({
        ledgerDB: options.ledgerDB || null,
        storagePath: this.storagePath
          ? this.storagePath.replace(/\.json$/, '-clusters.json')
          : null,
      });

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
        scope: 'ALL_TENANTS',
      },
      {
        id: 'DEC-002',
        title: 'Run Step Idempotency Keyed on Trigger',
        rule: 'run_step idempotency is keyed on (project_id, run_id, actor, intent, trigger_ref). Trigger naming identifies cause (<source>:<id>).',
        enforcement: 'STRICT_BLOCK',
        scope: 'ENGINE',
      },
      {
        id: 'DEC-003',
        title: 'Parked is a Health Condition, Never a State',
        rule: 'project.state and project.health are orthogonal. Parking is a health change with state held constant.',
        enforcement: 'SCHEMA_CONSTRAINT',
        scope: 'STATE_MACHINE',
      },
      {
        id: 'DEC-005',
        title: 'Invariant I-8: Evidence Over Assertion for Gates',
        rule: 'Gate verdict PASSED requires non-empty evidence_refs array. Zero-evidence pass auto-fails.',
        enforcement: 'GATE_EVALUATION',
        scope: 'GATES',
      },
    ];

    // Seed baseline operational failure antidotes
    this.antidotes = [
      {
        id: 'ANT-001',
        pattern: 'PM2 respawns killed PID / Port conflict',
        symptom: 'EADDRINUSE 8787 or daemon respawn loop',
        antidote:
          'Never kill daemons with kill -9. Supervised by PM2. Use pm2 restart ArunachalaDashboard or check pm2 list.',
        scope: ['server.js', 'ecosystem.config.js'],
        createdAt: '2026-11-22T08:00:00.000Z',
      },
      {
        id: 'ANT-002',
        pattern: 'Git index lock contention',
        symptom: 'fatal: Unable to create .git/index.lock: File exists',
        antidote:
          'Check for concurrent git process or stale lock. Remove .git/index.lock only if no git process is active.',
        scope: ['git', 'orchestration'],
        createdAt: '2026-11-22T08:00:00.000Z',
      },
    ];
  }

  _computeVector(text) {
    const clean = (text || '').toLowerCase().replace(/[^a-z0-9\s_-]/g, ' ');
    const tokens = clean.split(/\s+/).filter((t) => t.length > 2);
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
      metadata = {},
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
      createdAt: new Date().toISOString(),
    };

    this.episodicMemory.unshift(entry);
    if (this.clusterEngine) {
      try {
        this.clusterEngine.addMemory(entry);
      } catch (_) {}
    }
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
      vector: this._computeVector(dispatch.content),
    };

    this.operatorAlignments.unshift(alignmentRecord);

    this.storeMemory({
      tenantId: alignmentRecord.tenantId,
      projectId: 'all',
      category: 'operator_directive',
      title: `Directive from ${alignmentRecord.sender}`,
      content: dispatch.content,
      tags: ['dispatch', 'human_in_loop', alignmentRecord.priority],
      metadata: { originalDispatchId: dispatch.id },
    });

    return alignmentRecord;
  }

  search(query, options = {}) {
    return this.searchEntries(this.episodicMemory, query, options);
  }

  // Tenant / project / category rules shared by every search.
  // When STRICT_TENANT_ISOLATION=true, core tenant queries only see their own
  // and global entries. Non-core tenants always only see their own.
  filterEntries(entries, options = {}) {
    const { tenantId = 'tenant:drisyon_core', projectId = null, category = null } = options;
    const strict = process.env.STRICT_TENANT_ISOLATION === 'true';
    return entries.filter(
      (mem) =>
        (!strict && tenantId === 'tenant:drisyon_core'
          ? true
          : tenantId === '*' ||
            mem.tenantId === 'all' ||
            mem.tenantId === 'global' ||
            mem.tenantId === tenantId) &&
        (!projectId ||
          mem.projectId === 'all' ||
          mem.projectId === 'global' ||
          mem.projectId === projectId) &&
        (!category || mem.category === category)
    );
  }

  toResult(mem, score) {
    const isHub =
      mem.projectId === 'global' ||
      mem.projectId === 'all' ||
      mem.tenantId === 'global' ||
      (Array.isArray(mem.tags) && mem.tags.includes('hub')) ||
      mem.metadata?.scope === 'hub';
    return {
      id: mem.id,
      score: Math.round(score * 100) / 100,
      tenantId: mem.tenantId,
      projectId: mem.projectId,
      category: mem.category,
      title: mem.title,
      content: mem.content,
      tags: mem.tags || [],
      scope: isHub ? 'hub' : 'spoke',
      metadata: mem.metadata,
      createdAt: mem.createdAt,
    };
  }

  // Keyword ranking of any list of entries (local, or the team's from
  // Supabase, which carry no vector). Fallback for memory-search.js.
  searchEntries(entries, query, options = {}) {
    const { topK = 5, threshold = 0.05 } = options;
    const queryVec = this._computeVector(query);
    return this.filterEntries(entries, options)
      .map((mem) => {
        const vector =
          mem.vector ||
          this._computeVector(
            mem.content + ' ' + (mem.title || '') + ' ' + (mem.tags || []).join(' ')
          );
        return { mem, score: this._cosineSimilarity(queryVec, vector) };
      })
      .filter((r) => r.score >= threshold)
      .sort((x, y) => y.score - x.score)
      .slice(0, topK)
      .map((r) => this.toResult(r.mem, r.score));
  }

  // --- Failure Antidote & Self-Healing Registry ---
  storeAntidote(antidote) {
    if (!antidote || (!antidote.pattern && !antidote.symptom)) return null;
    const entry = {
      id: antidote.id || 'ANT-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      pattern: antidote.pattern || 'Generic Failure Pattern',
      symptom: antidote.symptom || '',
      antidote: antidote.antidote || '',
      scope: Array.isArray(antidote.scope) ? antidote.scope : [antidote.scope || 'general'],
      createdAt: antidote.createdAt || new Date().toISOString(),
    };
    const idx = this.antidotes.findIndex((a) => a.symptom === entry.symptom || a.id === entry.id);
    if (idx >= 0) {
      this.antidotes[idx] = entry;
    } else {
      this.antidotes.unshift(entry);
    }
    this.saveToDisk();
    return entry;
  }

  getAntidotes(options = {}) {
    const { scope = null } = options;
    if (!scope) return this.antidotes;
    return this.antidotes.filter((a) => a.scope.includes('all') || a.scope.includes(scope));
  }

  searchAntidotes(text, files = []) {
    const cleanText = String(text || '').toLowerCase();
    const filesList = Array.isArray(files) ? files.map((f) => String(f).toLowerCase()) : [];

    return this.antidotes.filter((ant) => {
      const matchSymptom =
        ant.symptom && cleanText.includes(ant.symptom.toLowerCase().slice(0, 30));
      const matchPattern =
        ant.pattern && cleanText.includes(ant.pattern.toLowerCase().slice(0, 30));
      const matchScope = ant.scope.some((s) => {
        const sl = s.toLowerCase();
        return sl === 'all' || cleanText.includes(sl) || filesList.some((f) => f.includes(sl));
      });
      return (
        matchSymptom ||
        matchPattern ||
        (matchScope &&
          (cleanText.includes('fail') ||
            cleanText.includes('error') ||
            cleanText.includes('bug') ||
            cleanText.includes('issue')))
      );
    });
  }

  // --- Tiered Context Model (L0 / L1 / L2 Zooming) ---
  getL0Index(options = {}) {
    const activeRules = this.proceduralInvariants.map((p) => `[${p.id}] ${p.title}`).slice(0, 3);
    const recentMemories = this.episodicMemory.slice(0, 4).map((m) => m.title);
    const topAntidotes = this.antidotes.slice(0, 2).map((a) => `[${a.id}] ${a.pattern}`);

    return {
      tier: 'L0',
      invariants: activeRules,
      recentTopics: recentMemories,
      activeAntidotes: topAntidotes,
      summary: `Invariants: ${activeRules.join(' · ')} | Topics: ${recentMemories.join(', ') || 'None'}`,
    };
  }

  getL1Rollup(domainOrCategory, options = {}) {
    const entries = this.filterEntries(this.episodicMemory, {
      category: domainOrCategory,
      ...options,
    });
    const rollups = entries.slice(0, 5).map((e) => ({
      id: e.id,
      title: e.title,
      summary: (e.content || '').slice(0, 160) + (e.content && e.content.length > 160 ? '…' : ''),
      tags: e.tags,
    }));
    return {
      tier: 'L1',
      domain: domainOrCategory,
      count: entries.length,
      entries: rollups,
    };
  }

  getL2Detail(memoryId) {
    const mem = this.episodicMemory.find((m) => m.id === memoryId);
    if (!mem) return null;
    return {
      tier: 'L2',
      ...mem,
    };
  }

  getTieredContext(options = {}) {
    const { domain = null, task = '', files = [] } = options;
    const l0 = this.getL0Index(options);
    const l1 = domain ? this.getL1Rollup(domain, options) : null;
    const matchedAntidotes = this.searchAntidotes(task, files);

    return {
      l0,
      l1,
      antidotes: matchedAntidotes,
    };
  }

  memoryZoom(queryOrId, options = {}) {
    if (!queryOrId) return this.getL0Index(options);
    const byId = this.getL2Detail(queryOrId);
    if (byId) return byId;
    return this.getL1Rollup(queryOrId, options);
  }

  saveToDisk() {
    try {
      const payload = {
        updatedAt: new Date().toISOString(),
        episodicCount: this.episodicMemory.length,
        alignmentsCount: this.operatorAlignments.length,
        antidotesCount: this.antidotes.length,
        episodicMemory: this.episodicMemory.slice(0, 1000),
        operatorAlignments: this.operatorAlignments.slice(0, 200),
        antidotes: this.antidotes.slice(0, 100),
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
        if (Array.isArray(data.antidotes) && data.antidotes.length > 0) {
          // Merge loaded antidotes with baseline invariants without duplicate IDs
          const existingIds = new Set(this.antidotes.map((a) => a.id));
          for (const a of data.antidotes) {
            if (!existingIds.has(a.id)) {
              this.antidotes.push(a);
              existingIds.add(a.id);
            }
          }
        }
        console.log(
          `[MEMORY ENGINE] Loaded ${this.episodicMemory.length} memories & ${this.antidotes.length} antidotes from disk.`
        );
        if (this.clusterEngine) {
          try {
            this.clusterEngine.rebuildIndex(this.episodicMemory);
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn('[MEMORY ENGINE] Disk load empty or new:', err.message);
    }
  }

  getClusters(tenantId = null) {
    return this.clusterEngine ? this.clusterEngine.getClusters(tenantId) : [];
  }

  clusterSearch(query, options = {}) {
    return this.clusterEngine
      ? this.clusterEngine.search(query, options)
      : { ranker: 'fallback', results: this.search(query, options) };
  }
}

module.exports = DrisyonMemoryEngine;
