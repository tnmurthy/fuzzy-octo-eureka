// node --test team-manager.test.js
//
// PM2 and the Buzz CLI are stubbed: these tests pin down what team-manager
// asks them to do, not what they do.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createTeamManager, resolvePm2Bin, PM2_NAME } = require('./team-manager');

const CHANNEL = '04ad4d05-a062-5233-b605-4d69ace72555';

function stubbed({ procs = [], env = { PATH: '/usr/bin' }, exists = () => true, bridgeDefined = true } = {}) {
  const calls = [];
  const state = { procs };
  const execFileSync = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    if (args[0] === 'jlist') return JSON.stringify(state.procs);
    if (args[0] === 'start' || args[0] === 'restart') {
      state.procs = [{ name: PM2_NAME, pid: 42, pm2_env: { status: 'online', pm_uptime: Date.now(), restart_time: 0 } }];
      return '';
    }
    if (args[0] === 'messages') return JSON.stringify({ id: 'evt1' });
    return '';
  };
  const tm = createTeamManager({
    execFileSync, env, existsSync: exists, execPath: '/opt/node/bin/node',
    ecosystemApps: () => (bridgeDefined ? [PM2_NAME] : []),
  });
  return { tm, calls };
}

test('pm2 is found beside the running node, with no node version hard-coded', () => {
  const bin = resolvePm2Bin({ env: {}, execPath: '/opt/node/bin/node', existsSync: (p) => p === '/opt/node/bin/pm2' });
  assert.equal(bin, '/opt/node/bin/pm2');
});

test('PM2_BIN wins, and a missing pm2 falls back to PATH lookup', () => {
  assert.equal(resolvePm2Bin({ env: { PM2_BIN: '/x/pm2' }, execPath: '/opt/node/bin/node', existsSync: () => true }), '/x/pm2');
  assert.equal(resolvePm2Bin({ env: {}, execPath: '/opt/node/bin/node', existsSync: () => false }), 'pm2');
});

test('a bridge PM2 has never seen reports not_registered, not an error', () => {
  const { tm } = stubbed({ procs: [] });
  const status = tm.getTeamStatus();
  assert.equal(status.active, false);
  assert.equal(status.processStatus, 'not_registered');
});

test('activating an unregistered bridge starts it from the ecosystem file and saves', () => {
  const { tm, calls } = stubbed({ procs: [] });
  const result = tm.activateTeam('test');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'activated');
  assert.equal(result.details.active, true);
  const start = calls.find((c) => c.args[0] === 'start');
  assert.deepEqual(start.args, ['start', path.join(__dirname, 'ecosystem.config.js'), '--only', PM2_NAME]);
  assert.ok(calls.some((c) => c.args[0] === 'save'));
  assert.ok(!calls.some((c) => c.args[0] === 'restart'));
});

test('activating a stopped bridge restarts it with the current env', () => {
  const { tm, calls } = stubbed({ procs: [{ name: PM2_NAME, pid: 0, pm2_env: { status: 'stopped' } }] });
  const result = tm.activateTeam('test');
  assert.equal(result.ok, true);
  assert.deepEqual(calls.find((c) => c.args[0] === 'restart').args, ['restart', PM2_NAME, '--update-env']);
});

test('a bridge retired from the ecosystem file reports disabled and starts nothing', () => {
  const { tm, calls } = stubbed({ procs: [], bridgeDefined: false });
  const result = tm.activateTeam('test');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'disabled');
  assert.ok(calls.every((c) => c.args[0] === 'jlist'));
});

test('activating an online bridge does nothing', () => {
  const { tm, calls } = stubbed({ procs: [{ name: PM2_NAME, pid: 7, pm2_env: { status: 'online' } }] });
  assert.equal(tm.activateTeam('test').status, 'already_active');
  assert.ok(calls.every((c) => c.args[0] === 'jlist'));
});

test('a pm2 failure comes back as ok:false, never a throw', () => {
  const tm = createTeamManager({
    execFileSync: () => { throw new Error('pm2 exploded'); },
    env: {}, existsSync: () => true, execPath: '/opt/node/bin/node',
  });
  assert.equal(tm.getTeamStatus().processStatus, 'error: pm2 exploded');
  const result = tm.deactivateTeam();
  assert.equal(result.ok, false);
});

test('a directive passes the key by environment and the content as one argument', () => {
  const { tm, calls } = stubbed({ env: { PATH: '/usr/bin', BUZZ_DIRECTIVE_PRIVATE_KEY: 'nsec1test' } });
  const content = 'ship it "now"; $(rm -rf /) `id`';
  assert.deepEqual(tm.sendDirective(CHANNEL, content), { id: 'evt1' });
  const call = calls.find((c) => c.args[0] === 'messages');
  assert.deepEqual(call.args, ['messages', 'send', '--channel', CHANNEL, '--content', content]);
  assert.equal(call.opts.env.BUZZ_PRIVATE_KEY, 'nsec1test');
  assert.equal(call.opts.env.BUZZ_RELAY_URL, 'https://drisyon-ai.communities.buzz.xyz');
  assert.ok(!call.args.join(' ').includes('nsec1test'));
});

test('a directive is refused without a key, with a bad channel, or with no content', () => {
  const noKey = stubbed({ env: {} }).tm;
  assert.throws(() => noKey.sendDirective(CHANNEL, 'hi'), /BUZZ_DIRECTIVE_PRIVATE_KEY is not set/);
  const { tm, calls } = stubbed({ env: { BUZZ_DIRECTIVE_PRIVATE_KEY: 'nsec1test' } });
  assert.throws(() => tm.sendDirective('x; rm -rf /', 'hi'), /channel UUID/);
  assert.throws(() => tm.sendDirective(CHANNEL, '   '), /non-empty/);
  assert.equal(calls.length, 0);
});
