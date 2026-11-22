// task-reflection.js - Autonomous Post-Task Reflection & Memory Synthesis Engine
// Part of the Drisyon Cognitive Architecture & Arunachala Operations Center.
//
// When an agent run finishes (coding, architecture analysis, bug fixing), this engine:
// 1. Parses the execution log and tool interactions (edits, writes, test verdicts).
// 2. Synthesizes 1-2 generalized architectural or operational lessons learned.
// 3. Commits the structured reflection into episodic memory (drisyon-memory.json)
//    under category: 'codebase_learning' and projectId: <repo>.
//
// Next time any agent works on that repository, dispatch-context.js automatically
// retrieves these lessons and injects them into the agent's prompt so mistakes
// are never repeated and architectural knowledge compounds over time.

const fs = require('fs');
const path = require('path');

/**
 * Extracts key findings, tools used, modified files, and test results from raw run log text.
 * @param {string} logText
 * @returns {object}
 */
function parseLogArtifacts(logText) {
  const text = String(logText || '');
  const lines = text.split(/\r?\n/);

  const agentMessages = [];
  const filesModified = new Set();
  const toolsUsed = new Set();
  let testsPassed = false;
  let testDetails = '';
  let architectureSummary = '';

  let inArchSection = false;
  const archLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Capture explicit chat messages from agent
    const chatMatch = line.match(/💬\s*(.+)$/);
    if (chatMatch) {
      agentMessages.push(chatMatch[1]);
    }

    // Capture tool invocations
    const toolMatch = line.match(/🔧\s*([A-Za-z0-9_-]+)\s*(.*)$/);
    if (toolMatch) {
      const toolName = toolMatch[1];
      toolsUsed.add(toolName);
      const arg = toolMatch[2] || '';
      const pathMatch = arg.match(/([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]{1,10})/);
      if (pathMatch && !pathMatch[1].startsWith('http')) {
        filesModified.add(pathMatch[1]);
      }
    }

    // Capture git diff file modifications
    const gitDiffMatch = line.match(/^diff --git a\/(.+?) b\/(.+?)$/);
    if (gitDiffMatch) {
      filesModified.add(gitDiffMatch[2]);
    }

    // Capture test results
    if (/(?:✔|passed|passing|tests passed|test session starts|pytest.*passed)/i.test(line)) {
      testsPassed = true;
      if (!testDetails && line.length < 120) {
        testDetails = line;
      }
    }

    // Capture architecture sections from analysis runs
    if (/^###?\s*(?:🏗️\s*)?(?:Architectural Overview|Architecture|System Design|Key Findings)/i.test(line)) {
      inArchSection = true;
    } else if (inArchSection && /^###?\s*/.test(line) && !/Architectural|Topology/i.test(line)) {
      inArchSection = false;
    }

    if (inArchSection && archLines.length < 25) {
      archLines.push(line);
    }
  }

  if (archLines.length > 0) {
    architectureSummary = archLines.join('\n').trim();
  }

  return {
    agentMessages,
    filesModified: Array.from(filesModified),
    toolsUsed: Array.from(toolsUsed),
    testsPassed,
    testDetails,
    architectureSummary
  };
}

/**
 * Extracts a reusable operational antidote from execution failure logs.
 * @param {object} params
 * @param {object} params.run - Run object from runs.jsonl
 * @param {string} params.logText - Execution log text
 * @param {object} [params.artifacts] - Parsed log artifacts
 * @returns {object|null} Antidote record { pattern, symptom, antidote, scope } or null
 */
function extractAntidoteFromFailure({ run = {}, logText = '', artifacts = null }) {
  const text = String(logText || '');
  const repoName = run.repo ? path.basename(run.repo) : 'unknown-repo';
  const arts = artifacts || parseLogArtifacts(text);

  // Pattern 1: PM2 / EADDRINUSE port binding conflicts
  if (/EADDRINUSE.*(?:8787|8788|3000|3001|7700)|address already in use/i.test(text)) {
    return {
      pattern: 'Port Conflict / PM2 Supervision Collision',
      symptom: 'EADDRINUSE port already in use on dashboard or service port',
      antidote: 'Services are supervised by PM2. Do not bind directly or kill PIDs with kill -9. Use "pm2 restart <service>" or check running daemons.',
      scope: [repoName, 'server.js', 'ecosystem.config.js']
    };
  }

  // Pattern 2: Git Index Lock Contention
  if (/(?:index\.lock.*File exists|Unable to create.*\.git\/index\.lock)/i.test(text)) {
    return {
      pattern: 'Git Index Lock Contention',
      symptom: 'fatal: Unable to create .git/index.lock: File exists',
      antidote: 'Another git process is holding index.lock or a previous run crashed. Verify no active git process exists before removing .git/index.lock.',
      scope: [repoName, 'git', 'orchestration']
    };
  }

  // Pattern 3: Missing Module / Dependency
  const modMatch = text.match(/(?:Cannot find module ['"]([^'"]+)['"]|MODULE_NOT_FOUND.*['"]([^'"]+)['"])/i);
  if (modMatch) {
    const modName = modMatch[1] || modMatch[2] || 'unknown';
    return {
      pattern: `Missing Dependency: ${modName}`,
      symptom: `Cannot find module '${modName}'`,
      antidote: `Ensure dependencies are installed in worktree/container. Check package.json and run 'npm install' or check import path relative resolution.`,
      scope: [repoName, 'package.json', modName]
    };
  }

  // Pattern 4: Syntax Error / Uncaught Exception
  const syntaxMatch = text.match(/(?:SyntaxError:\s*([^\r\n]+)|TypeError:\s*([^\r\n]+))/i);
  if (syntaxMatch && (run.status === 'failed' || !arts.testsPassed)) {
    const errText = (syntaxMatch[1] || syntaxMatch[2] || '').slice(0, 100);
    return {
      pattern: 'Code Syntax or Type Regression',
      symptom: errText,
      antidote: `Static analysis detected runtime breakage: "${errText}". Always run targeted unit tests (node --test) before marking work done.`,
      scope: [repoName, ...arts.filesModified.slice(0, 3)]
    };
  }

  // Pattern 5: Generic test failure with details
  if (!arts.testsPassed && arts.testDetails) {
    return {
      pattern: 'Automated Test Failure',
      symptom: arts.testDetails.slice(0, 120),
      antidote: `Verify test expectations and mocks against: ${arts.testDetails.slice(0, 100)}. Do not push without passing tests.`,
      scope: [repoName, ...arts.filesModified.slice(0, 3)]
    };
  }

  return null;
}

/**
 * Synthesizes a structured reflection record ready for memory-engine insertion.
 * @param {object} params
 * @param {object} params.run - Run object from runs.jsonl
 * @param {string} params.logText - Execution log
 * @param {string} [params.diffText] - Git diff (optional)
 * @returns {object} Reflection payload { title, content, category, projectId, tags, metadata, antidote? }
 */
function synthesizeReflection({ run, logText = '', diffText = '' }) {
  const artifacts = parseLogArtifacts(logText);
  const repoName = run.repo ? path.basename(run.repo) : 'unknown-repo';
  const taskText = String(run.task || 'Autonomous execution').trim();
  const cleanTask = taskText.replace(/^GitHub issue [^:]+:\s*/, '').replace(/^Follow-up:\s*/, '');

  let synthesisContent = '';

  if (artifacts.architectureSummary) {
    // Architectural or onboarding study run
    synthesisContent = `Architecture & Overview for ${repoName}: ${artifacts.architectureSummary.slice(0, 500)}`;
  } else if (artifacts.filesModified.length > 0) {
    // Code implementation or modification run
    const filesList = artifacts.filesModified.slice(0, 6).join(', ');
    const outcome = artifacts.testsPassed ? 'Verified with passing tests.' : 'Changes implemented in safe worktree.';
    synthesisContent = `Task "${cleanTask}" modified: [${filesList}]. ${outcome}`;
    if (artifacts.agentMessages.length > 0) {
      synthesisContent += ` Summary: ${artifacts.agentMessages[0].slice(0, 250)}`;
    }
  } else if (artifacts.agentMessages.length > 0) {
    // Analysis or advisory run
    synthesisContent = `Findings for "${cleanTask}": ${artifacts.agentMessages.join(' ').slice(0, 400)}`;
  } else {
    // Fallback minimal synthesis
    const statusText = run.status === 'done' ? 'completed successfully' : `finished with status '${run.status}'`;
    synthesisContent = `Agent ${run.agent || 'assistant'} ${statusText} for task: "${cleanTask}". Branch: ${run.branch || 'main'}.`;
  }

  const shortTitle = cleanTask.length > 60 ? `${cleanTask.slice(0, 57)}...` : cleanTask;

  // Extract failure antidote if the run failed or tests broke
  let antidote = null;
  if (run.status === 'failed' || !artifacts.testsPassed || run.status === 'timed_out') {
    antidote = extractAntidoteFromFailure({ run, logText, artifacts });
  }

  return {
    title: `Learned from ${repoName}: ${shortTitle}`,
    content: synthesisContent.trim(),
    category: 'codebase_learning',
    projectId: repoName,
    tags: [
      'reflection',
      'auto_learned',
      repoName,
      run.agent || 'agent',
      run.status === 'done' ? 'success' : 'failure'
    ],
    metadata: {
      runId: run.id,
      branch: run.branch || null,
      commitsAhead: run.commits_ahead || 0,
      filesCount: artifacts.filesModified.length,
      testsPassed: artifacts.testsPassed
    },
    antidote: antidote || undefined
  };
}

/**
 * Reflects on a run and persists the knowledge directly into DrisyonMemoryEngine.
 * @param {object} params
 * @param {object} params.run
 * @param {object} params.memory - DrisyonMemoryEngine instance
 * @param {string} [params.logText]
 * @returns {object} { ok: boolean, memoryEntry: object, reflection: object }
 */
function recordRunReflection({ run, memory, logText = null }) {
  if (!run || !run.id) {
    return { ok: false, error: 'invalid run object' };
  }

  let text = logText;
  if (text === null && run.log) {
    try {
      if (fs.existsSync(run.log)) {
        text = fs.readFileSync(run.log, 'utf8');
      }
    } catch (_) {}
  }

  const reflection = synthesizeReflection({ run, logText: text || '' });

  let memoryEntry = null;
  if (memory && typeof memory.storeMemory === 'function') {
    // Check if reflection already recorded for this run ID to prevent duplicate synthesis
    const existing = (memory.episodicMemory || []).find(
      (m) => m.metadata && m.metadata.runId === run.id
    );

    if (existing) {
      return { ok: true, already: true, memoryEntry: existing, reflection };
    }

    memoryEntry = memory.storeMemory({
      ...reflection,
      tenantId: 'global' // Hub/global scope accessible by all agents working on this repo
    });

    // Also persist into Antidotes registry if an antidote was extracted
    if (reflection.antidote && typeof memory.storeAntidote === 'function') {
      memory.storeAntidote(reflection.antidote);
    }
  }

  return { ok: true, already: false, memoryEntry, reflection };
}

module.exports = {
  parseLogArtifacts,
  extractAntidoteFromFailure,
  synthesizeReflection,
  recordRunReflection
};
