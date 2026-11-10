// scripts/ingest-context.test.js - Unit tests for context ingestion tool
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  isTextFile,
  collectFiles,
  chunkMarkdown,
  chunkFile,
  ingestPath
} = require('./ingest-context');

test('isTextFile identifies text/code files and filters binaries', () => {
  assert.equal(isTextFile('README.md'), true);
  assert.equal(isTextFile('server.js'), true);
  assert.equal(isTextFile('main.py'), true);
  assert.equal(isTextFile('schema.sql'), true);
  assert.equal(isTextFile('binary.png'), false);
  assert.equal(isTextFile('archive.zip'), false);
  assert.equal(isTextFile('executable.exe'), false);
});

test('chunkMarkdown splits documents by markdown headings', () => {
  const md = `# Overview\nThis is the high level overview of the system.\n\n## Architecture\nThe system uses a local Ollama vector engine and PM2.\n\n## API Specification\nEndpoint /api/memory/store stores records.`;
  const chunks = chunkMarkdown('docs/ARCHITECTURE.md', md);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.some(c => c.title.includes('Overview') || c.title.includes('docs/ARCHITECTURE.md')));
  assert.ok(chunks.some(c => c.title.includes('Architecture') || c.title.includes('API Specification')));
});

test('chunkFile chunks large non-markdown files without loss', () => {
  const code = 'const a = 1;\n'.repeat(150); // ~2100 chars
  const chunks = chunkFile('app.js', code);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].title.includes('app.js'));
  assert.ok(chunks[0].content.includes('const a = 1;'));
});

test('ingestPath processes directory and supports dryRun mode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-test-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'DOC1.md'), '# Title 1\nSome documentation text.');
    fs.writeFileSync(path.join(tmpDir, 'service.js'), 'function start() { return true; }');
    fs.writeFileSync(path.join(tmpDir, 'ignored.png'), 'fake-binary');

    const result = ingestPath(tmpDir, {
      project: 'test-project',
      category: 'testing',
      dryRun: true
    });

    assert.equal(result.project, 'test-project');
    assert.equal(result.filesCount, 2); // ignored.png is skipped
    assert.equal(result.dryRun, true);
    assert.ok(result.chunksCount >= 2);
    assert.ok(result.records.every(r => r.projectId === 'test-project'));
    assert.ok(result.records.every(r => r.category === 'testing'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
