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

    const isSecurityAudit = (agentKey === 'sec') ||
      /\b(security\s+(audit|scan|review|assessment|probe|check|test)|vulnerability|mantis|rebac|cve|penetration|pentest|exploit|threat\s+model|access\s+control\s+audit)\b/i.test(taskContent);
    const isQA = (agentKey === 'qa') ||
      /\b(unit\s+test|e2e|integration\s+test|lint|pre-commit|test\s+suite|coverage|vitest|jest)\b/i.test(taskContent);
    const isAdvisory = /\b(plan|strategy|enroll|enrolling|marketing|campaign|pitch|outreach|proposal|deck|copy|advisory|gtm|funnel|pricing|sow)\b/i.test(taskContent) &&
      !/\b(code|script|api|endpoint|unit\s+test|refactor|function|database|schema|docker|bug|fix|pr|commit|repo)\b/i.test(taskContent);

    if (isAdvisory) {
      targetAgent = 'advisory';
    } else if (isSecurityAudit) {
      targetAgent = 'mantis';
    } else if (isQA) {
      targetAgent = 'auto';
    } else if (agentKey === 'hermes' || lower.includes('@hermes') || lower.includes('hermes runner')) {
      targetAgent = 'hermes';
    } else if (agentKey === 'openhands' || lower.includes('canvas') || lower.includes('openhands')) {
      targetAgent = 'openhands';
    } else if (lower.includes('@claude')) {
      targetAgent = 'claude';
    } else if (lower.includes('@codex')) {
      targetAgent = 'codex';
    } else if (lower.includes('@mantis')) {
      targetAgent = 'mantis';
    }

    return {
      actionable: true,
      task: taskContent,
      targetAgent,
      isAdvisory
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

test('detectActionableTask: classifies marketing/enrollment URLs as advisory tasks rather than Mantis/auto code scans', () => {
  const result = detectActionableTask('build a plan and help me in enrolling 30 users for this https://drisyon.com/cloud-security', 'po');
  assert.equal(result.actionable, true);
  assert.equal(result.isAdvisory, true);
  assert.equal(result.targetAgent, 'advisory');
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
