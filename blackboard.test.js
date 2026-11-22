// blackboard.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBlackboard } = require('./blackboard');

test('blackboard posts facts, caches them, and notifies subscribers', () => {
  const blackboard = createBlackboard();
  const received = [];

  const unsubscribe = blackboard.subscribe((fact) => {
    received.push(fact);
  });

  const f1 = blackboard.postFact({
    title: 'API Schema Update',
    content: 'POST /api/v2/tokens now requires client_assertion parameter.',
    author: 'agent:hermes',
    scope: 'repo-core',
    tags: ['api', 'breaking-change']
  });

  assert.equal(f1.title, 'API Schema Update');
  assert.equal(received.length, 1);
  assert.equal(received[0].id, f1.id);
  assert.equal(received[0].author, 'agent:hermes');

  // Verify retrieval
  const recent = blackboard.getRecentFacts({ scope: 'repo-core' });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].id, f1.id);

  // Unsubscribe stops notifications
  unsubscribe();
  blackboard.postFact({
    title: 'Second update',
    content: 'Nothing to see here.',
    author: 'agent:claude'
  });
  assert.equal(received.length, 1);
});

test('blackboard logs events to ledger and syncs to memory engine', () => {
  const mockLedger = {
    events: [],
    logEvent(evt) {
      this.events.push(evt);
    }
  };

  const mockMemory = {
    memories: [],
    storeMemory(record) {
      this.memories.push(record);
      return { id: 'mem_123', ...record };
    }
  };

  const blackboard = createBlackboard({
    ledgerDB: mockLedger,
    memoryEngine: mockMemory
  });

  blackboard.postFact({
    title: 'Port 8787 Conflict Resolution',
    content: 'Always use pm2 restart ArunachalaDashboard.',
    author: 'agent:systems',
    tags: ['antidote', 'devops']
  });

  // Verify ledger log
  assert.equal(mockLedger.events.length, 1);
  assert.equal(mockLedger.events[0].type, 'BLACKBOARD_FACT');
  assert.equal(mockLedger.events[0].payload.author, 'agent:systems');

  // Verify memory engine entry for Supabase sync
  assert.equal(mockMemory.memories.length, 1);
  assert.equal(mockMemory.memories[0].category, 'blackboard');
  assert.match(mockMemory.memories[0].title, /Port 8787 Conflict Resolution/);
  assert.ok(mockMemory.memories[0].tags.includes('blackboard'));
});

test('blackboard formats prompt injection bounded by character limits', () => {
  const blackboard = createBlackboard();

  blackboard.postFact({
    title: 'Database WAL Pragma',
    content: 'Always enable PRAGMA journal_mode = WAL upon connection.',
    author: 'systems-architect',
    scope: 'global'
  });

  blackboard.postFact({
    title: 'CSS Token Standard',
    content: 'Use var(--bg-card) for all dashboard panels.',
    author: 'frontend-lead',
    scope: 'cockpit'
  });

  const prompt = blackboard.formatBlackboardPrompt({ scope: 'cockpit', maxFacts: 5 });
  assert.match(prompt, /Cognitive Blackboard \(Live Cross-Agent Signals\):/);
  assert.match(prompt, /Database WAL Pragma/);
  assert.match(prompt, /CSS Token Standard/);
});
