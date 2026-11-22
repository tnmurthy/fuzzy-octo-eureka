// orchestration/agent-handoff.js - Multi-Host Agent Federation & Handoff Protocol
// Inspired by AI Team OS (CronusL-1141/AI-company) cross-host federation.
//
// When local models (Hermes on Ollama / Mac Studio) encounter test failures,
// reasoning boundaries, or explicit escalation points, this engine:
// 1. Packages a structured Handoff Packet (diff, diagnostics, stack traces, scratchpad).
// 2. Preserves the local attempt as a patch (.arunachala-handoff.patch) so frontier models
//    don't waste tokens re-implementing 80% working code from scratch.
// 3. Synthesizes an enriched Federation Handoff Briefing for the frontier agent (Claude).
// 4. Logs cross-host federation telemetry into the SQLite WAL ledger.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_HANDOFFS_DIR = path.resolve(__dirname, '../logs/handoffs');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/**
 * Inspects a git worktree to collect diffs, modified files, and diffstat.
 */
function inspectWorktree(worktreeDir) {
  try {
    const statusOut = execFileSync('git', ['-C', worktreeDir, 'status', '--porcelain'], { encoding: 'utf8' });
    const diffStat = execFileSync('git', ['-C', worktreeDir, 'diff', 'HEAD~1', '--stat'], { encoding: 'utf8' }).trim() ||
      execFileSync('git', ['-C', worktreeDir, 'diff', '--stat'], { encoding: 'utf8' }).trim();
    const diffFull = execFileSync('git', ['-C', worktreeDir, 'diff', 'HEAD~1'], { encoding: 'utf8' }) ||
      execFileSync('git', ['-C', worktreeDir, 'diff'], { encoding: 'utf8' });

    const files = statusOut
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);

    return { files, diffStat, diffFull };
  } catch (_) {
    return { files: [], diffStat: '(unable to compute git diff)', diffFull: '' };
  }
}

/**
 * Creates and persists a structured Federation Handoff Packet.
 */
function createHandoffPacket({
  runId,
  worktreeDir,
  sourceAgent = 'hermes',
  targetAgent = 'claude',
  reason = 'TESTS_FAILED',
  testCommand = '',
  testOutput = '',
  exitCode = 1,
  storageDir = DEFAULT_HANDOFFS_DIR
}) {
  if (!runId) throw new Error('runId is required for handoff packet');

  const handoffId = `hnd_${runId}_${Date.now()}`;
  const dir = ensureDir(storageDir);
  const { files, diffStat, diffFull } = worktreeDir ? inspectWorktree(worktreeDir) : { files: [], diffStat: '', diffFull: '' };

  // Write patch file into worktree if diff exists
  let patchRelPath = null;
  if (worktreeDir && diffFull) {
    const patchPath = path.join(worktreeDir, '.arunachala-handoff.patch');
    try {
      fs.writeFileSync(patchPath, diffFull, 'utf8');
      patchRelPath = '.arunachala-handoff.patch';
    } catch (_) {}
  }

  // Clip test output slice to keep prompt lean
  const cleanTestOut = String(testOutput || '').trim();
  const testLines = cleanTestOut.split('\n');
  const testSlice = testLines.slice(-30).join('\n').slice(0, 1500);

  const packet = {
    handoffId,
    runId,
    timestamp: new Date().toISOString(),
    source: { agent: sourceAgent, host: 'local-mac-studio', runtime: 'ollama' },
    target: { agent: targetAgent, host: 'frontier-api' },
    reason,
    diagnostics: {
      exitCode,
      testCommand,
      testOutputSlice: testSlice,
      filesModified: files,
      diffStat
    },
    patchFile: patchRelPath,
    status: 'ESCALATED'
  };

  const packetPath = path.join(dir, `${runId}.json`);
  fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2), 'utf8');

  return packet;
}

/**
 * Synthesizes an enriched prompt for the frontier agent.
 */
function buildHandoffPrompt(originalPrompt, packet) {
  if (!packet) return originalPrompt;

  const header = [
    '================================================================================',
    '🚨 [MULTI-HOST AGENT FEDERATION HANDOFF]',
    `From: ${packet.source?.agent || 'Local Agent'} (Ollama on Mac Studio)`,
    `To: ${packet.target?.agent || 'Frontier Agent'}`,
    `Escalation Reason: ${packet.reason} (exit code ${packet.diagnostics?.exitCode ?? 1})`,
    '================================================================================',
    '',
    '### Local Agent Attempt Summary & Diagnostics',
    packet.diagnostics?.diffStat ? `**Diff Summary:**\n\`\`\`\n${packet.diagnostics.diffStat}\n\`\`\`` : null,
    packet.patchFile ? `> A patch of the local agent's work was saved to \`${packet.patchFile}\` in the repository root for reference.` : null,
    packet.diagnostics?.testCommand ? `- **Verification Command:** \`${packet.diagnostics.testCommand}\`` : null,
    packet.diagnostics?.testOutputSlice ? `**Failure Output / Stack Trace:**\n\`\`\`\n${packet.diagnostics.testOutputSlice}\n\`\`\`` : null,
    '',
    '### Your Objective as Frontier Agent',
    'Build upon or fix the local agent\'s attempt. Ensure all verification tests pass cleanly before completing.',
    '',
    '--- Original Task ---',
    originalPrompt
  ].filter(Boolean).join('\n');

  return header;
}

/**
 * Resolves a handoff packet once frontier run completes.
 */
function resolveHandoff(runId, resolution = {}, storageDir = DEFAULT_HANDOFFS_DIR) {
  const filePath = path.join(storageDir, `${runId}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    const packet = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    packet.status = resolution.status || 'RESOLVED';
    packet.resolvedAt = new Date().toISOString();
    packet.resolution = resolution;
    fs.writeFileSync(filePath, JSON.stringify(packet, null, 2), 'utf8');
    return packet;
  } catch (_) {
    return null;
  }
}

// CLI handler for agent-dispatch.sh integration
if (require.main === module) {
  const [,, cmd, runId, worktree, promptFile, testCmd, exitCode, logFile] = process.argv;

  if (cmd === 'prepare' && runId && promptFile) {
    let testOutput = '';
    if (logFile && fs.existsSync(logFile)) {
      try { testOutput = fs.readFileSync(logFile, 'utf8'); } catch (_) {}
    }
    const rawPrompt = fs.readFileSync(promptFile, 'utf8');
    const packet = createHandoffPacket({
      runId,
      worktreeDir: worktree,
      reason: 'TESTS_FAILED',
      testCommand: testCmd || '',
      testOutput,
      exitCode: Number(exitCode) || 1
    });

    const handoffPrompt = buildHandoffPrompt(rawPrompt, packet);
    const handoffPromptFile = path.join(path.dirname(promptFile), `${path.basename(promptFile, path.extname(promptFile))}.handoff.txt`);
    fs.writeFileSync(handoffPromptFile, handoffPrompt, 'utf8');
    process.stdout.write(handoffPromptFile);
  } else if (cmd === 'resolve' && runId) {
    resolveHandoff(runId, { status: process.argv[4] || 'RESOLVED' });
  }
}

module.exports = {
  createHandoffPacket,
  buildHandoffPrompt,
  resolveHandoff,
  DEFAULT_HANDOFFS_DIR
};
