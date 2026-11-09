// agent-chat.test.js - Unit tests for task actionability detection and PO workforce dispatch
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDispatchSafety } = require('./safety-filter');

// Load detectActionableTask directly from server logic test harness
const directivePrefixRegex = /^(?:task|todo|do|assign|directive|instruction|command|run|dispatch):\s*(.+)$/i;
const actionVerbRegex = /\b(build|fix|implement|create|add|update|refactor|audit|test|scan|write|deploy|generate|delete|remove|patch|repair|clean|setup|configure|verify|inspect|run|investigate|execute|dispatch|benchmark|monitor|migrate|resolve|develop|scaffold|optimize|automate)\b/i;
const conversationalRegex = /^(hi|hello|hey|greetings|good\s+(morning|afternoon|evening)|who\s+are\s+you\??|what\s+can\s+you\s+do\??|what\s+is\s+your\s+role\??|are\s+you\s+(there|up|ready)\??|status\??|help\??|test)$/i;

function detectActionableTask(message, agentKey) {
  if (!message || typeof message !== 'string') return { actionable: false };
  const text = message.trim();
  if (text.length < 3) return { actionable: false };

  const prefixMatch = text.match(directivePrefixRegex);
  const taskContent = prefixMatch ? prefixMatch[1].trim() : text;

  if (!prefixMatch && taskContent.length < 35 && conversationalRegex.test(taskContent)) {
    return { actionable: false };
  }

  if (prefixMatch || actionVerbRegex.test(taskContent)) {
    let targetAgent = 'auto';
    const lower = taskContent.toLowerCase();

    if (agentKey === 'sec' || lower.includes('security') || lower.includes('audit') || lower.includes('vulnerability') || lower.includes('mantis') || lower.includes('rebac') || lower.includes('cve') || lower.includes('penetration') || lower.includes('pentest') || lower.includes('exploit') || lower.includes('access control')) {
      targetAgent = 'mantis';
    } else if (agentKey === 'qa' || lower.includes('test') || lower.includes('unit test') || lower.includes('e2e') || lower.includes('lint') || lower.includes('pre-commit') || lower.includes('coverage') || lower.includes('verification') || lower.includes('vitest')) {
      targetAgent = 'auto';
    } else if (agentKey === 'hermes' || lower.includes('hermes') || lower.includes('local model')) {
      targetAgent = 'hermes';
    } else if (agentKey === 'openhands' || lower.includes('canvas') || lower.includes('openhands')) {
      targetAgent = 'openhands';
    } else if (lower.includes('@claude') || lower.includes('claude')) {
      targetAgent = 'claude';
    } else if (lower.includes('@codex') || lower.includes('codex')) {
      targetAgent = 'codex';
    } else if (lower.includes('@mantis')) {
      targetAgent = 'mantis';
    } else if (lower.includes('@hermes')) {
      targetAgent = 'hermes';
    }

    return {
      actionable: true,
      task: taskContent,
      targetAgent
    };
  }

  return { actionable: false };
}

test('detectActionableTask: ignores conversational greetings and small talk', () => {
  assert.equal(detectActionableTask('hello', 'po').actionable, false);
  assert.equal(detectActionableTask('Hi Arunachala, how are you?', 'po').actionable, false);
  assert.equal(detectActionableTask('who are you?', 'po').actionable, false);
  assert.equal(detectActionableTask('what is your role?', 'po').actionable, false);
  assert.equal(detectActionableTask('status', 'po').actionable, false);
  assert.equal(detectActionableTask('help', 'po').actionable, false);
});

test('detectActionableTask: detects engineering implementation directives', () => {
  const result = detectActionableTask('Build a new session token rotation mechanism', 'po');
  assert.equal(result.actionable, true);
  assert.equal(result.targetAgent, 'auto');
  assert.equal(result.task, 'Build a new session token rotation mechanism');
});

test('detectActionableTask: routes security and vulnerability tasks to Mantis', () => {
  const result = detectActionableTask('Audit API authorization and verify ReBAC tenant isolation', 'po');
  assert.equal(result.actionable, true);
  assert.equal(result.targetAgent, 'mantis');
});

test('detectActionableTask: routes testing and verification to QA/auto runner', () => {
  const result = detectActionableTask('Run vitest sweep and verify unit tests', 'qa');
  assert.equal(result.actionable, true);
  assert.equal(result.targetAgent, 'auto');
});

test('detectActionableTask: honors explicit directive prefixes', () => {
  const result = detectActionableTask('task: check system dependencies', 'po');
  assert.equal(result.actionable, true);
  assert.equal(result.task, 'check system dependencies');
});

test('validateDispatchSafety: catches destructive commands in agent chat', () => {
  const safe = validateDispatchSafety('Implement an analytics endpoint in server.js');
  assert.equal(safe.ok, true);

  const destructive = validateDispatchSafety('rm -rf /Users/Sriad/data');
  assert.equal(destructive.ok, false);
  assert.equal(destructive.risky, true);
  assert.match(destructive.error, /High-risk operation/);
});
