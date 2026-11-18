// node --test agents-features.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { prUrlOf, readOrigin } = require('./repo-registry');

test('prUrlOf constructs compare and PR URLs accurately for GitHub and GitLab', () => {
  // GitHub HTTPS
  assert.equal(
    prUrlOf('https://github.com/my-org/my-project.git', 'agent/run-123'),
    'https://github.com/my-org/my-project/compare/agent%2Frun-123?expand=1'
  );

  // GitHub SSH
  assert.equal(
    prUrlOf('git@github.com:my-org/my-project.git', 'agent/feat-ui'),
    'https://github.com/my-org/my-project/compare/agent%2Ffeat-ui?expand=1'
  );

  // GitHub HTTPS without .git
  assert.equal(
    prUrlOf('https://github.com/my-org/my-project', 'agent/run-abc'),
    'https://github.com/my-org/my-project/compare/agent%2Frun-abc?expand=1'
  );

  // GitLab
  assert.equal(
    prUrlOf('https://gitlab.com/subgroup/repo.git', 'agent/run-xyz'),
    'https://gitlab.com/subgroup/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=agent%2Frun-xyz'
  );

  // Empty or invalid
  assert.equal(prUrlOf(null, 'agent/run-1'), null);
  assert.equal(prUrlOf('', 'agent/run-1'), null);
  assert.equal(prUrlOf('https://mygit.internal/repo.git', 'agent/run-1'), null);
});

test('file preview security: rejects directory traversal and sensitive config files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-sec-'));
  const safeFile = path.join(tmpDir, 'app.js');
  fs.writeFileSync(safeFile, 'console.log("hello world");\n');
  const envFile = path.join(tmpDir, '.env');
  fs.writeFileSync(envFile, 'SECRET=123\n');

  function checkAccess(repoPath, requestedFile) {
    const targetPath = path.resolve(repoPath, requestedFile);
    const rel = path.relative(repoPath, targetPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, status: 403, error: 'path traversal forbidden' };
    }
    const segments = rel.split(path.sep);
    if (segments.some(s => s.startsWith('.env') || s === '.git' || s === '.ssh' || s === 'id_rsa')) {
      return { ok: false, status: 403, error: 'access to sensitive files is restricted' };
    }
    if (!fs.existsSync(targetPath)) {
      return { ok: false, status: 404, error: 'file not found' };
    }
    return { ok: true, path: targetPath };
  }

  // Traversal attempts
  assert.equal(checkAccess(tmpDir, '../other/file').ok, false);
  assert.equal(checkAccess(tmpDir, '../../etc/passwd').ok, false);

  // Sensitive files
  assert.equal(checkAccess(tmpDir, '.env').ok, false);
  assert.equal(checkAccess(tmpDir, '.env.local').ok, false);

  // Safe file
  const ok = checkAccess(tmpDir, 'app.js');
  assert.equal(ok.ok, true);
  assert.equal(ok.path, safeFile);

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('file preview reader detects binary files vs text contents', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-reader-'));
  const textFile = path.join(tmpDir, 'sample.txt');
  fs.writeFileSync(textFile, 'Line 1\nLine 2\nLine 3\n');

  const binFile = path.join(tmpDir, 'test.bin');
  fs.writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

  function readFile(filePath) {
    const stat = fs.statSync(filePath);
    const MAX_PREVIEW_BYTES = 512 * 1024;
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES));
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);

    const isBinary = buffer.slice(0, 1024).includes(0);
    if (isBinary) {
      return { ok: true, isBinary: true, size: stat.size };
    }
    const text = buffer.toString('utf8');
    return {
      ok: true,
      isBinary: false,
      content: text,
      lines: text.split('\n').length,
      size: stat.size
    };
  }

  const textRes = readFile(textFile);
  assert.equal(textRes.isBinary, false);
  assert.equal(textRes.lines, 4); // 3 lines + trailing newline
  assert.match(textRes.content, /Line 1/);

  const binRes = readFile(binFile);
  assert.equal(binRes.isBinary, true);
  assert.equal(binRes.size, 6);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
