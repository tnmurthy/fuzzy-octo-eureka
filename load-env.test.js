// node --test load-env.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Runs loadEnv in a fresh process (it writes to process.env) and reports the keys.
function run(files, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  const code = `require(${JSON.stringify(path.join(__dirname, 'load-env.js'))}).loadEnv(${JSON.stringify(dir)}, (m) => console.error(m));
    console.log(JSON.stringify({ A: process.env.A || null, P: process.env.SUPABASE_PASSWORD || null }))`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  return { out: JSON.parse(r.stdout.trim().split('\n').pop()), err: r.stderr, dir };
}

test('loads .env, then the secrets file it points to', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const secrets = path.join(dir, 'arunachala-team.env');
  fs.writeFileSync(secrets, 'SUPABASE_PASSWORD=s3cret\n');
  const { out } = run({ '.env': `A=1\nSECRETS_ENV_FILE=${secrets}\n` });
  assert.deepEqual(out, { A: '1', P: 's3cret' });
});

test('.env wins over the secrets file for the same key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-'));
  const secrets = path.join(dir, 's.env');
  fs.writeFileSync(secrets, 'A=from-secrets\n');
  assert.equal(run({ '.env': `A=from-env\nSECRETS_ENV_FILE=${secrets}\n` }).out.A, 'from-env');
});

test('a missing secrets file is reported by path, never by contents, and does not crash', () => {
  const missing = path.join(os.tmpdir(), 'arunachala-no-such-dir', 'missing.env');
  const r = run({ '.env': `A=1\nSECRETS_ENV_FILE=${missing}\n` });
  assert.equal(r.out.A, '1');
  assert.ok(r.err.includes(`secrets file not loaded: ${missing}`), r.err);
});

test('no .env and no secrets file: nothing loaded, no error', () => {
  const r = run({});
  assert.deepEqual(r.out, { A: null, P: null });
  assert.equal(r.err, '');
});
