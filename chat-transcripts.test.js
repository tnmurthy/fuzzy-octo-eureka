// chat-transcripts.test.js - Unit tests for persistent conversation transcripts

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  recordTranscript,
  getTranscripts,
  clearTranscripts,
  exportTranscriptsMarkdown
} = require('./chat-transcripts');

const TEST_FILE = path.join(__dirname, 'logs', 'test-chat-transcripts.jsonl');

test('chat-transcripts: records, retrieves, and filters conversation entries', () => {
  // Clean before test
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);

  const t1 = recordTranscript({
    agent: 'po',
    agentTitle: '🧭 Arunachala Ramana',
    user: 'sriad',
    message: 'Review sprint deliverables',
    reply: 'I reviewed the deliverables. All verified.'
  }, TEST_FILE);

  assert.ok(t1.id.startsWith('tr-'));
  assert.equal(t1.agent, 'po');
  assert.equal(t1.user, 'sriad');

  const t2 = recordTranscript({
    agent: 'marketing',
    agentTitle: '📢 Priya Nair',
    user: 'sriad',
    message: 'Build a plan for enrolling 30 users',
    reply: 'Here is the 3-stream enrollment strategy.'
  }, TEST_FILE);

  assert.equal(t2.agent, 'marketing');

  // Retrieve all
  const all = getTranscripts({}, TEST_FILE);
  assert.equal(all.length, 2);

  // Retrieve filtered by agent
  const poOnly = getTranscripts({ agent: 'po' }, TEST_FILE);
  assert.equal(poOnly.length, 1);
  assert.equal(poOnly[0].message, 'Review sprint deliverables');

  const mktOnly = getTranscripts({ agent: 'marketing' }, TEST_FILE);
  assert.equal(mktOnly.length, 1);
  assert.equal(mktOnly[0].message, 'Build a plan for enrolling 30 users');

  // Clean after test
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

test('chat-transcripts: exports readable markdown transcript', () => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);

  recordTranscript({
    agent: 'tech',
    agentTitle: '💻 Tech Lead',
    user: 'sriad',
    message: 'How should we architect auth tokens?',
    reply: 'Use HMAC-SHA256 session signatures with ReBAC validation.'
  }, TEST_FILE);

  const md = exportTranscriptsMarkdown({ agent: 'tech' }, TEST_FILE);
  assert.ok(md.includes('# 📜 Agent Chat Transcript History (TECH)'));
  assert.ok(md.includes('💻 Tech Lead'));
  assert.ok(md.includes('How should we architect auth tokens?'));
  assert.ok(md.includes('HMAC-SHA256 session signatures'));

  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

test('chat-transcripts: clears transcripts selectively by agent', () => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);

  recordTranscript({ agent: 'po', message: 'Task 1', reply: 'Reply 1' }, TEST_FILE);
  recordTranscript({ agent: 'sec', message: 'Task 2', reply: 'Reply 2' }, TEST_FILE);

  clearTranscripts({ agent: 'po' }, TEST_FILE);

  const remaining = getTranscripts({}, TEST_FILE);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].agent, 'sec');

  clearTranscripts({}, TEST_FILE);
  assert.equal(getTranscripts({}, TEST_FILE).length, 0);

  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});
