// node --test buzz-bridge/buzz-protocol.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldHandle, replyTemplate, stripMentions, channelFilter } = require('./buzz-protocol');

const BOT = 'b'.repeat(64);
const OPERATOR = 'a'.repeat(64);
const STARTED = 1_800_000_000;

const msg = (over = {}) => ({
  id: 'e1'.padEnd(64, '0'), kind: 9, pubkey: OPERATOR, created_at: STARTED + 5,
  content: '@Team Bot is ollama up?',
  tags: [['h', 'chan-1'], ['p', BOT]],
  ...over,
});

const ctx = { botPubkey: BOT, operators: [OPERATOR], startedAt: STARTED };

test('subscribes to messages and edits by channel (the relay only fans out live events on #h)', () => {
  assert.deepEqual(channelFilter(['chan-1'], STARTED), { kinds: [9, 40003], '#h': ['chan-1'], since: STARTED });
});

test('handles a fresh operator message that mentions the bot', () => {
  assert.deepEqual(shouldHandle(msg(), ctx), { ok: true });
});

test('ignores messages from anyone but the operator', () => {
  const r = shouldHandle(msg({ pubkey: 'c'.repeat(64) }), ctx);
  assert.equal(r.ok, false);
  assert.match(r.reason, /operator/);
});

test('ignores its own messages, old messages, non-mentions and non-channel events', () => {
  assert.equal(shouldHandle(msg({ pubkey: BOT }), { ...ctx, operators: [OPERATOR, BOT] }).ok, false);
  assert.equal(shouldHandle(msg({ created_at: STARTED - 1 }), ctx).ok, false);
  assert.equal(shouldHandle(msg({ tags: [['h', 'chan-1']] }), ctx).ok, false);
  assert.equal(shouldHandle(msg({ tags: [['p', BOT]] }), ctx).ok, false);
  assert.equal(shouldHandle(msg({ kind: 7 }), ctx).ok, false);
});

test('a reply to a top-level message threads under it', () => {
  const t = replyTemplate(msg(), 'Ollama: up', STARTED + 10);
  assert.equal(t.kind, 9);
  assert.equal(t.content, 'Ollama: up');
  assert.deepEqual(t.tags, [['h', 'chan-1'], ['e', msg().id, '', 'reply'], ['p', OPERATOR]]);
  assert.equal(t.created_at, STARTED + 10);
});

test('a reply inside a thread keeps the thread root', () => {
  const inThread = msg({ tags: [['h', 'chan-1'], ['e', 'root1', '', 'root'], ['e', 'parent1', '', 'reply'], ['p', BOT]] });
  const t = replyTemplate(inThread, 'ok', STARTED + 10);
  assert.deepEqual(t.tags, [['h', 'chan-1'], ['e', 'root1', '', 'root'], ['e', inThread.id, '', 'reply'], ['p', OPERATOR]]);
});

test('a direct reply to a root (only a reply marker) uses that root', () => {
  const direct = msg({ tags: [['h', 'chan-1'], ['e', 'root1', '', 'reply'], ['p', BOT]] });
  const t = replyTemplate(direct, 'ok', STARTED + 10);
  assert.deepEqual(t.tags.slice(1, 3), [['e', 'root1', '', 'root'], ['e', direct.id, '', 'reply']]);
});

// Buzz desktop edits (kind 40003) point at the original with an unmarked e tag
// and carry mentions as ["mention", pubkey], not p tags.
const edit = (over = {}) => msg({
  kind: 40003, content: '@Team Bot is everything up?',
  tags: [['h', 'chan-1'], ['e', 'orig1'], ['mention', BOT], ['buzz:mention-snapshot']],
  ...over,
});

test('handles an operator edit that mentions the bot', () => {
  assert.deepEqual(shouldHandle(edit(), ctx), { ok: true });
});

test('ignores an edit that does not mention the bot', () => {
  const r = shouldHandle(edit({ tags: [['h', 'chan-1'], ['e', 'orig1']] }), ctx);
  assert.equal(r.ok, false);
});

test('a reply to an edit threads under the edited message', () => {
  const t = replyTemplate(edit(), 'ok', STARTED + 10);
  assert.deepEqual(t.tags, [['h', 'chan-1'], ['e', 'orig1', '', 'reply'], ['p', OPERATOR]]);
});

test('mention text is stripped before routing', () => {
  assert.equal(stripMentions('@Team Bot is ollama up?', 'Team Bot'), 'is ollama up?');
  assert.equal(stripMentions('nostr:npub1abcdef0123 what ran today', 'Team Bot'), 'what ran today');
});
