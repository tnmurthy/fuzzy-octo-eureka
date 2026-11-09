const test = require('node:test');
const assert = require('node:assert/strict');
const ReBACEngine = require('./rebac-engine');

function setupTestReBAC() {
  const rebac = new ReBACEngine();
  rebac.addNode('user:sriad', 'User', { name: 'Sriad' });
  rebac.addNode('user:drisyon', 'User', { name: 'Drisyon AI' });
  rebac.addNode('user:guest', 'User', { name: 'Untrusted Guest' });
  rebac.addNode('team:opscore', 'Team', { name: 'Ops Core Team' });
  rebac.addNode('role:admin', 'Role', { action: '*' });
  rebac.addNode('perm:ping', 'Permission', { action: 'ping:execute' });
  rebac.addNode('perm:dispatch', 'Permission', { action: 'dispatch:run' });
  rebac.addNode('perm:chat', 'Permission', { action: 'chat:interact' });
  rebac.addNode('perm:memory_store', 'Permission', { action: 'memory:store' });
  rebac.addNode('perm:memory_read', 'Permission', { action: 'memory:read' });
  rebac.addNode('resource:ollama_cluster', 'Resource', { name: 'Ollama Cluster' });
  rebac.addNode('resource:agent_runner', 'Resource', { name: 'Agent Runner' });
  rebac.addNode('resource:telemetry_feed', 'Resource', { name: 'Telemetry Feed' });
  rebac.addNode('resource:memory_engine', 'Resource', { name: 'Memory Engine' });

  rebac.addEdge('user:sriad', 'MEMBER_OF', 'team:opscore');
  rebac.addEdge('user:drisyon', 'MEMBER_OF', 'team:opscore');
  rebac.addEdge('team:opscore', 'GRANTED', 'role:admin');
  rebac.addEdge('role:admin', 'INCLUDES', 'perm:ping');
  rebac.addEdge('role:admin', 'INCLUDES', 'perm:dispatch');
  rebac.addEdge('role:admin', 'INCLUDES', 'perm:chat');
  rebac.addEdge('role:admin', 'INCLUDES', 'perm:memory_store');
  rebac.addEdge('role:admin', 'INCLUDES', 'perm:memory_read');
  rebac.addEdge('perm:ping', 'APPLIES_TO', 'resource:ollama_cluster');
  rebac.addEdge('perm:chat', 'APPLIES_TO', 'resource:ollama_cluster');
  rebac.addEdge('perm:dispatch', 'APPLIES_TO', 'resource:agent_runner');
  rebac.addEdge('perm:memory_store', 'APPLIES_TO', 'resource:memory_engine');
  rebac.addEdge('perm:memory_read', 'APPLIES_TO', 'resource:memory_engine');
  rebac.addEdge('team:opscore', 'OWNER_OF', 'resource:telemetry_feed');

  return rebac;
}

test('rebac-api: authorizes sriad and drisyon for all operations', () => {
  const rebac = setupTestReBAC();
  const operations = [
    { action: 'ping:execute', resource: 'resource:ollama_cluster' },
    { action: 'chat:interact', resource: 'resource:ollama_cluster' },
    { action: 'dispatch:run', resource: 'resource:agent_runner' },
    { action: 'memory:store', resource: 'resource:memory_engine' },
    { action: 'memory:read', resource: 'resource:memory_engine' }
  ];

  for (const user of ['user:sriad', 'user:drisyon']) {
    for (const op of operations) {
      const verdict = rebac.canAccess(user, op.action, op.resource);
      assert.equal(verdict.authorized, true, `${user} should have access to ${op.action} on ${op.resource}`);
      assert.ok(verdict.path.length > 0, 'Path should be recorded');
    }
  }
});

test('rebac-api: denies unassigned users', () => {
  const rebac = setupTestReBAC();
  const operations = [
    { action: 'chat:interact', resource: 'resource:ollama_cluster' },
    { action: 'dispatch:run', resource: 'resource:agent_runner' },
    { action: 'memory:store', resource: 'resource:memory_engine' },
    { action: 'memory:read', resource: 'resource:memory_engine' }
  ];

  for (const op of operations) {
    const verdict = rebac.canAccess('user:guest', op.action, op.resource);
    assert.equal(verdict.authorized, false, `user:guest should NOT have access to ${op.action} on ${op.resource}`);
    assert.equal(verdict.path.length, 0);
  }
});

test('rebac-api: denies non-existent permissions and resources', () => {
  const rebac = setupTestReBAC();
  const verdict = rebac.canAccess('user:sriad', 'superadmin:nuke', 'resource:unknown');
  assert.equal(verdict.authorized, false);
});
