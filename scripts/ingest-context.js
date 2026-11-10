// scripts/ingest-context.js - CLI & utility to ingest external codebases,
// local folders, documentation, and architecture specs into Drisyon Semantic Memory.
//
// Usage:
//   node scripts/ingest-context.js <path-to-folder-or-file> [options]
//
// Options:
//   --project <id>       Target project/repo ID (default: target folder name or 'global')
//   --category <name>    Memory category (default: 'codebase' or 'docs')
//   --tenant <id>        Tenant ID (default: 'tenant:drisyon_core')
//   --tags <tag1,tag2>   Comma-separated tags
//   --dry-run            Simulate and display what would be ingested without writing to disk
//   --max-size <bytes>   Max file size to parse (default: 300000 = 300KB)

const fs = require('fs');
const path = require('path');
const DrisyonMemoryEngine = require('../memory-engine');

const DEFAULT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.rst',
  '.json', '.yaml', '.yml', '.toml',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.sh', '.bash', '.zsh',
  '.sql', '.html', '.css'
]);

const IGNORED_NAMES = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', 'build',
  'coverage', '.next', '.nuxt', 'logs', 'package-lock.json',
  'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', '.env'
]);

const CHUNK_SIZE = 1200;
const MAX_FILE_SIZE = 300 * 1024; // 300 KB

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return DEFAULT_EXTENSIONS.has(ext);
}

function collectFiles(targetPath, options = {}) {
  const maxFileSize = options.maxFileSize || MAX_FILE_SIZE;
  const collected = [];

  function walk(current) {
    if (!fs.existsSync(current)) return;
    const stat = fs.statSync(current);

    if (stat.isFile()) {
      const base = path.basename(current);
      if (!IGNORED_NAMES.has(base) && isTextFile(current) && stat.size <= maxFileSize) {
        collected.push(current);
      }
      return;
    }

    if (stat.isDirectory()) {
      const base = path.basename(current);
      if (IGNORED_NAMES.has(base) || base.startsWith('.')) return;

      const entries = fs.readdirSync(current);
      for (const ent of entries) {
        walk(path.join(current, ent));
      }
    }
  }

  walk(targetPath);
  return collected;
}

function chunkMarkdown(relPath, content) {
  const lines = content.split('\n');
  const sections = [];
  let currentHeader = path.basename(relPath);
  let currentLines = [];

  for (const line of lines) {
    if (/^#{1,3}\s+(.+)$/.test(line)) {
      if (currentLines.join('\n').trim().length > 50) {
        sections.push({
          title: `${relPath} > ${currentHeader}`,
          content: currentLines.join('\n').trim()
        });
      }
      currentHeader = line.replace(/^#{1,3}\s+/, '').trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
      if (currentLines.join('\n').length >= CHUNK_SIZE) {
        sections.push({
          title: `${relPath} > ${currentHeader}`,
          content: currentLines.join('\n').trim()
        });
        currentLines = [];
      }
    }
  }

  if (currentLines.join('\n').trim().length > 30) {
    sections.push({
      title: `${relPath} > ${currentHeader}`,
      content: currentLines.join('\n').trim()
    });
  }

  return sections.length ? sections : [{
    title: relPath,
    content: content.slice(0, CHUNK_SIZE)
  }];
}

function chunkFile(relPath, content) {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') {
    return chunkMarkdown(relPath, content);
  }

  if (content.length <= CHUNK_SIZE) {
    return [{
      title: relPath,
      content
    }];
  }

  // Large code or config file: break into sequential chunks with small overlap
  const chunks = [];
  let start = 0;
  let part = 1;
  while (start < content.length) {
    const end = Math.min(start + CHUNK_SIZE, content.length);
    const chunkText = content.slice(start, end).trim();
    if (chunkText.length > 30) {
      chunks.push({
        title: `${relPath} (part ${part})`,
        content: chunkText
      });
      part++;
    }
    start += (CHUNK_SIZE - 100);
  }
  return chunks;
}

function ingestPath(targetPath, options = {}) {
  const absPath = path.resolve(targetPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Target path does not exist: ${absPath}`);
  }

  const stat = fs.statSync(absPath);
  const defaultProject = stat.isDirectory()
    ? path.basename(absPath)
    : path.basename(path.dirname(absPath));

  const project = options.project || defaultProject;
  const category = options.category || (stat.isFile() && absPath.endsWith('.md') ? 'documentation' : 'codebase');
  const tenant = options.tenant || 'tenant:drisyon_core';
  const customTags = Array.isArray(options.tags)
    ? options.tags
    : (options.tags ? String(options.tags).split(',').map(s => s.trim()) : []);

  const dryRun = Boolean(options.dryRun);
  const memoryEngine = options.memoryEngine || new DrisyonMemoryEngine();

  const files = collectFiles(absPath, options);
  const recordsToStore = [];

  for (const file of files) {
    const relPath = path.relative(stat.isDirectory() ? absPath : path.dirname(absPath), file);
    try {
      const content = fs.readFileSync(file, 'utf8');
      const chunks = chunkFile(relPath, content);
      for (const chunk of chunks) {
        recordsToStore.push({
          tenantId: tenant,
          projectId: project,
          category,
          title: chunk.title,
          content: chunk.content,
          tags: Array.from(new Set(['ingested', category, project, ...customTags])),
          metadata: {
            sourcePath: file,
            relativePath: relPath,
            sizeBytes: Buffer.byteLength(chunk.content, 'utf8')
          }
        });
      }
    } catch (err) {
      console.warn(`[INGEST] Warning: Failed to read ${file}: ${err.message}`);
    }
  }

  if (!dryRun) {
    for (const record of recordsToStore) {
      memoryEngine.storeMemory(record);
    }
    memoryEngine.saveToDisk();
  }

  return {
    targetPath: absPath,
    project,
    filesCount: files.length,
    chunksCount: recordsToStore.length,
    dryRun,
    records: recordsToStore
  };
}

// CLI handler
function runCli() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(`
Drisyon Semantic Memory Ingestion Tool
--------------------------------------
Ingests external codebases, local directories, architecture specs, and markdown docs
into Drisyon Semantic Memory so autonomous agents, runners, and chat personas can access them.

Usage:
  node scripts/ingest-context.js <folder-or-file> [options]

Options:
  --project <id>       Target project/repo ID (default: directory name)
  --category <name>    Category ('codebase', 'documentation', 'architecture', etc.)
  --tenant <id>        Tenant ID (default: 'tenant:drisyon_core')
  --tags <t1,t2>       Comma-separated tags (e.g. 'auth,backend,v2')
  --dry-run            Preview chunks and files without modifying drisyon-memory.json
  --max-size <bytes>   Max file size in bytes to index (default: 300000)

Examples:
  node scripts/ingest-context.js ../another-project --project another-project
  node scripts/ingest-context.js ./docs/DRISYON_COHORT_01_ENROLLMENT_PLAYBOOK.md --category playbook
  node scripts/ingest-context.js /Users/Sriad/my-app --dry-run
`);
    process.exit(0);
  }

  const targetPath = args[0];
  let project = null;
  let category = null;
  let tenant = 'tenant:drisyon_core';
  let tags = [];
  let dryRun = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) project = args[++i];
    else if (args[i] === '--category' && args[i + 1]) category = args[++i];
    else if (args[i] === '--tenant' && args[i + 1]) tenant = args[++i];
    else if (args[i] === '--tags' && args[i + 1]) tags = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--dry-run') dryRun = true;
  }

  try {
    const result = ingestPath(targetPath, { project, category, tenant, tags, dryRun });
    console.log(`\n✅ Ingestion complete:`);
    console.log(`- Target: ${result.targetPath}`);
    console.log(`- Project: ${result.project}`);
    console.log(`- Files processed: ${result.filesCount}`);
    console.log(`- Chunks created: ${result.chunksCount}`);
    console.log(`- Mode: ${dryRun ? 'DRY-RUN (no changes saved)' : 'SAVED to drisyon-memory.json'}\n`);

    if (result.chunksCount > 0) {
      console.log(`Sample of ingested entries:`);
      for (const r of result.records.slice(0, 3)) {
        console.log(`  * [${r.category}] ${r.title} (${r.content.length} chars)`);
      }
      if (result.records.length > 3) {
        console.log(`  ... and ${result.records.length - 3} more chunks.`);
      }
    }
  } catch (err) {
    console.error(`\n❌ Ingestion failed: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  runCli();
}

module.exports = {
  isTextFile,
  collectFiles,
  chunkMarkdown,
  chunkFile,
  ingestPath
};
