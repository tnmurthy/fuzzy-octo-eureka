// node --test secret-scan.test.js
// Fake tokens are built at runtime so this file itself never looks like a leak.
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanDiff, scanRange, knownSecrets, describe, isServiceRoleJwt } = require('./secret-scan');

const diffOf = (file, ...added) => [
  `diff --git a/${file} b/${file}`, '--- a/' + file, `+++ b/${file}`, `@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`),
].join('\n');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload) => `eyJ${b64({ alg: 'HS256' }).slice(3)}.${b64(payload)}.${'s'.repeat(30)}`;

test('flags known token formats on added lines, with file and line', () => {
  const gh = 'gh' + 'p_' + 'k3Jd8QwL2mZx7Rt5Vn9Bp4Hc6Yf1Gs0Ue2Aq8Wo';
  const ant = 'sk-' + 'ant-' + 'api03-' + 'a9Kd2LmQ7xZpW4vB8nR1tY6uE3oI5sH0gJfCq';
  const aws = 'AK' + 'IA' + 'Z7Q3K9M2X5V8B4N6';
  const key = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
  const body = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW';
  const f = scanDiff(diffOf('src/config.js', 'const a = 1;', `const t = "${gh}";`, `ANTHROPIC=${ant}`, `aws=${aws}`, key, body));
  assert.deepEqual(f.map((x) => [x.file, x.line, x.rule]), [
    ['src/config.js', 2, 'GitHub token'], ['src/config.js', 3, 'Anthropic key'], ['src/config.js', 4, 'AWS access key'], ['src/config.js', 5, 'private key'],
  ]);
});

test('flags the actual secret values this machine holds, never printing them', () => {
  const known = knownSecrets({ GITHUB_TOKEN: 'not-a-pattern-but-real-123', SUPABASE_PASSWORD: 'hunter2-but-longer', DEBUG: 'true', SHORT_KEY: 'abc', HOME: '/Users/x' });
  assert.deepEqual(known.map((k) => k.name), ['GITHUB_TOKEN', 'SUPABASE_PASSWORD']);
  const f = scanDiff(diffOf('notes.md', 'token is not-a-pattern-but-real-123 ok'), known);
  assert.deepEqual(f, [{ file: 'notes.md', line: 1, rule: 'value of GITHUB_TOKEN' }]);
  assert.ok(!describe(f).includes('not-a-pattern'));
});

test('flags Supabase service_role JWTs but not anon/publishable ones', () => {
  assert.equal(isServiceRoleJwt(jwt({ role: 'service_role' })), true);
  assert.equal(isServiceRoleJwt(jwt({ role: 'anon' })), false);
  const f = scanDiff(diffOf('a.js', `k=${jwt({ role: 'service_role' })}`, `p=${jwt({ role: 'anon' })}`));
  assert.deepEqual(f.map((x) => x.line), [1]);
});

test('flags secret files by name, not examples or public keys', () => {
  const d = [diffOf('.env', 'A=1'), diffOf('deploy/id_rsa', 'x'), diffOf('.env.example', 'A='), diffOf('keys/id_ed25519.pub', 'ssh-ed25519 AAAA')].join('\n');
  assert.deepEqual(scanDiff(d).map((x) => x.file), ['.env', 'deploy/id_rsa']);
});

test('ignores removed lines, context and clean diffs', () => {
  const gh = 'gh' + 'p_' + 'Z'.repeat(40);
  const d = ['--- a/x.js', '+++ b/x.js', '@@ -3,1 +3,1 @@', `-old ${gh}`, '+const clean = true;'].join('\n');
  assert.deepEqual(scanDiff(d), []);
  assert.deepEqual(scanDiff(''), []);
});

test('scanRange diffs base...head, and falls back to unpushed commits', () => {
  const calls = [];
  const gh = 'gh' + 'o_' + 'Qw3Er5Ty7Ui9Op1As2Df4Gh6Jk8Lz0Xc3Vb5Nm';
  const git = (args) => { calls.push(args); if (args[0] === 'diff') throw new Error('unknown revision'); return diffOf('a.txt', gh); };
  const f = scanRange({ git, cwd: '/r', base: 'origin/main', head: 'agent/x', known: [] });
  assert.equal(f[0].rule, 'GitHub token');
  assert.deepEqual(calls[0].slice(-1), ['origin/main...agent/x']);
  assert.deepEqual(calls[1].slice(0, 2), ['log', '--no-color']);
});

test('describe caps the list', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ file: 'f', line: i + 1, rule: 'r' }));
  assert.match(describe(many), /and 2 more$/);
});

test('fixtures and docs do not block a push', () => {
  const fake = 'gh' + 'p_' + '123456789012345678901234567890123456';
  const doc = ['# Private key material', '-----BEGIN ' + 'RSA PRIVATE KEY-----', '-----BEGIN ' + 'EC PRIVATE KEY-----', 'see the docs'];
  assert.deepEqual(scanDiff(diffOf('a.test.js', `const token = "${fake}";`)), []);
  assert.deepEqual(scanDiff(diffOf('secops.md', ...doc)), []);
});
