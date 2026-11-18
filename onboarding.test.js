// node --test onboarding.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const DrisyonMemoryEngine = require('./memory-engine');

test('onboarding.html exists and contains all required wizard steps', () => {
  const filePath = path.join(__dirname, 'onboarding.html');
  assert.equal(fs.existsSync(filePath), true, 'onboarding.html must exist');
  const html = fs.readFileSync(filePath, 'utf8');

  // Verify core wizard elements
  assert.match(html, /Operator Onboarding &amp; Knowledge Setup|Operator Onboarding & Knowledge Setup/);
  assert.match(html, /id="panel-step-1"/, 'Must contain Step 1: Persona & Mode panel');
  assert.match(html, /id="panel-step-2"/, 'Must contain Step 2: Target Project panel');
  assert.match(html, /id="panel-step-3"/, 'Must contain Step 3: Local Context & Memory panel');
  assert.match(html, /id="panel-step-4"/, 'Must contain Step 4: Launchpad panel');
  assert.match(html, /Safe Draft Sandbox Guarantee/, 'Must have safe sandbox assurance');
  assert.match(html, /Test Memory Recall/, 'Must have interactive memory recall tester');
});

test('onboarding.js exists, is syntactically valid, and defines roles and templates', () => {
  const filePath = path.join(__dirname, 'onboarding.js');
  assert.equal(fs.existsSync(filePath), true, 'onboarding.js must exist');
  const js = fs.readFileSync(filePath, 'utf8');

  assert.match(js, /ROLES\s*=\s*\[/);
  assert.match(js, /KNOWLEDGE_TEMPLATES\s*=\s*\{/);
  assert.match(js, /developer/);
  assert.match(js, /tester/);
  assert.match(js, /pm/);
  assert.match(js, /designer/);
  assert.match(js, /devops/);
  assert.match(js, /security/);
  assert.match(js, /\/api\/memory\/store/);
  assert.match(js, /\/api\/memory\/search/);
});

test('server.js contains static route mapping for /onboarding and /welcome', () => {
  const serverPath = path.join(__dirname, 'server.js');
  const serverSrc = fs.readFileSync(serverPath, 'utf8');
  assert.match(serverSrc, /urlPath === '\/onboarding' \|\| urlPath === '\/welcome'/);
});

test('memory engine stores and recalls onboarding institutional memory', () => {
  const tmpPath = path.join(os.tmpdir(), `drisyon-test-mem-${Date.now()}.json`);
  const mem = new DrisyonMemoryEngine({ storagePath: tmpPath });
  const entry = mem.storeMemory({
    tenantId: 'tenant:drisyon_core',
    projectId: 'test-project',
    category: 'tech_stack',
    title: 'Node.js & ReBAC Architecture Guidelines',
    content: 'All endpoints must verify relationship-based access control and preserve test isolation.',
    tags: ['onboarding', 'developer', 'architecture']
  });

  assert.ok(entry.id.startsWith('mem_'));
  assert.equal(entry.title, 'Node.js & ReBAC Architecture Guidelines');
  assert.equal(entry.category, 'tech_stack');
  assert.ok(Array.isArray(entry.tags));
  assert.ok(entry.tags.includes('onboarding'));

  // Test retrieval via memory engine search
  const results = mem.search('ReBAC architecture guidelines', { limit: 5 });
  assert.ok(Array.isArray(results));
  assert.ok(results.length > 0);
  assert.ok(results.some((r) => r.id === entry.id || r.title.includes('ReBAC')));
});

test('onboarding.html contains memory distribution scope selector', () => {
  const filePath = path.join(__dirname, 'onboarding.html');
  const html = fs.readFileSync(filePath, 'utf8');
  assert.match(html, /id="scope-global-checkbox"/);
  assert.match(html, /Share across all projects &amp; teams/);
  assert.match(html, /id="scope-hub"/);
  assert.match(html, /id="scope-spoke"/);
});

test('memory engine supports Hub and Spoke scoping and promotion', () => {
  const tmpPath = path.join(os.tmpdir(), `drisyon-hubspoke-${Date.now()}.json`);
  const mem = new DrisyonMemoryEngine({ storagePath: tmpPath });

  // 1. Store a Spoke memory (local to project 'client-app')
  const spokeMem = mem.storeMemory({
    tenantId: 'tenant:client_a',
    projectId: 'client-app',
    category: 'context',
    title: 'Client Database Schema',
    content: 'Client uses PostgreSQL with pgvector for spoke embeddings.',
    tags: ['spoke', 'database']
  });

  // 2. Store a Hub memory (global to all projects and tenants)
  const hubMem = mem.storeMemory({
    tenantId: 'global',
    projectId: 'global',
    category: 'guidelines',
    title: 'Global Engineering Invariant DEC-001',
    content: 'Zero production credentials held at any tier; all releases via client IaC.',
    tags: ['hub', 'invariant', 'security']
  });

  // 3. Search as client-app project
  const searchResults = mem.search('credentials database', { projectId: 'client-app' });
  assert.ok(searchResults.length >= 2, 'Should match both local spoke memory and global hub memory');

  const hubFound = searchResults.find(r => r.id === hubMem.id);
  const spokeFound = searchResults.find(r => r.id === spokeMem.id);
  assert.ok(hubFound, 'Global Hub memory should be accessible to spoke search');
  assert.equal(hubFound.scope, 'hub');
  assert.ok(spokeFound, 'Local Spoke memory should be accessible to spoke search');
  assert.equal(spokeFound.scope, 'spoke');

  // 4. Promote spoke memory to Hub
  const promotedHubMem = mem.storeMemory({
    tenantId: 'global',
    projectId: 'global',
    category: spokeMem.category,
    title: `[Hub] ${spokeMem.title}`,
    content: spokeMem.content,
    tags: [...spokeMem.tags, 'hub', 'promoted_to_hub']
  });
  assert.ok(promotedHubMem.id.startsWith('mem_'));
  assert.equal(promotedHubMem.projectId, 'global');

  // Verify other projects now see promoted memory
  const otherProjectSearch = mem.search('pgvector', { projectId: 'other-repo' });
  assert.ok(otherProjectSearch.some(r => r.id === promotedHubMem.id), 'Promoted memory must be visible across all projects via the Hub');
});
