// node --test run-control.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunControl, treeOf } = require('./run-control');

const procs = [
  { pid: 100, ppid: 1, args: 'bash /x/orchestration/agent-dispatch.sh claude /r agent/run-1 /p.txt run-1' },
  { pid: 101, ppid: 100, args: 'timeout 3600 claude -p ...' },
  { pid: 102, ppid: 101, args: 'claude -p ...' },
  { pid: 103, ppid: 100, args: 'node stream-log.js' },
  { pid: 200, ppid: 1, args: 'unrelated' },
];

const make = (over = {}) => {
  const killed = [];
  const ctl = createRunControl({
    runsDir: '/runs',
    loadRuns: () => [{ id: 'run-1', status: 'running' }, { id: 'run-2', status: 'done' }],
    listProcesses: () => procs,
    kill: (pid, sig) => killed.push([pid, sig]),
    readFile: () => '100\n',
    sleep: async () => {},
    ...over,
  });
  return { ctl, killed };
};

test('treeOf lists the root first, then descendants', () => {
  assert.deepEqual(treeOf(100, procs), [100, 101, 103, 102]);
});

test('stop signals the dispatch script first, then its whole tree', () => {
  const { ctl, killed } = make();
  const r = ctl.stop('run-1');
  assert.equal(r.ok, true);
  assert.deepEqual(killed.map((k) => k[0]), [100, 101, 103, 102]);
  assert.ok(killed.every((k) => k[1] === 'SIGTERM'));
});

test('stop refuses bad ids, finished runs and missing pid files', () => {
  assert.equal(make().ctl.stop('../x').status, 400);
  assert.equal(make().ctl.stop('nope').status, 404);
  assert.equal(make().ctl.stop('run-2').status, 409);
  assert.equal(make({ readFile: () => { throw new Error('ENOENT'); } }).ctl.stop('run-1').status, 409);
});

test('stop never signals a recycled pid', () => {
  const { ctl, killed } = make({ readFile: () => '200' });
  assert.equal(ctl.stop('run-1').ok, false);
  const other = make({ listProcesses: () => [{ pid: 100, ppid: 1, args: 'bash agent-dispatch.sh claude /r b /p run-9' }] });
  assert.equal(other.ctl.stop('run-1').ok, false);
  assert.equal(killed.length + other.killed.length, 0);
});

test('waitForEnd resolves once the run leaves running, or null on timeout', async () => {
  let calls = 0;
  const { ctl } = make({ loadRuns: () => [{ id: 'run-1', status: ++calls > 2 ? 'stopped' : 'running' }] });
  assert.equal((await ctl.waitForEnd('run-1', 5000, 10)).status, 'stopped');
  const stuck = make().ctl;
  assert.equal(await stuck.waitForEnd('run-1', 30, 10), null);
});
