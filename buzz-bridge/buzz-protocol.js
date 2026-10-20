// buzz-protocol.js - pure Buzz (NIP-29 relay) message rules for the bridge.
//
// Facts from the Buzz repo (crates/buzz-core/src/kind.rs, buzz-sdk/builders.rs):
//   - channel messages are kind 9 with an ["h", channelId] tag;
//   - a mention is a ["p", hexPubkey] tag - the authoritative signal;
//   - threads use marker-only NIP-10: a direct reply to a root carries
//     ["e", root, "", "reply"]; a nested reply carries ["e", root, "", "root"]
//     and ["e", parent, "", "reply"]. Unmarked e tags are rejected.
// No dependencies, so CI runs these tests without installing nostr-tools.

const KIND_CHANNEL_MESSAGE = 9;
// Buzz desktop edit: an unmarked ["e", originalId] tag, mentions as
// ["mention", pubkey] (no p tags), so a #p subscription never sees it.
const KIND_EDIT = 40003;

const tagValue = (event, name, marker) =>
  (event.tags.find(t => t[0] === name && (marker === undefined || t[3] === marker)) || [])[1];

// Subscribe by channel and check the mention locally. Verified 2026-10-20:
// the relay returns #p-filtered kind 9 history but does not fan out new kind 9
// events live to a #p-only subscription; #h subscriptions get them live. Edits
// carry ["mention", pk], which the relay can't filter on anyway.
function channelFilter(channels, since) {
  return { kinds: [KIND_CHANNEL_MESSAGE, KIND_EDIT], '#h': channels, since };
}

function mentionsBot(event, botPubkey) {
  const mentionTag = event.kind === KIND_EDIT ? 'mention' : 'p';
  return event.tags.some(t => t[0] === mentionTag && t[1] === botPubkey);
}

function shouldHandle(event, { botPubkey, operators, startedAt }) {
  if (event.kind !== KIND_CHANNEL_MESSAGE && event.kind !== KIND_EDIT) return { ok: false, reason: 'not a channel message' };
  if (event.pubkey === botPubkey) return { ok: false, reason: 'own message' };
  if (event.created_at < startedAt) return { ok: false, reason: 'sent before the bridge started' };
  if (!tagValue(event, 'h')) return { ok: false, reason: 'no channel tag' };
  if (!mentionsBot(event, botPubkey)) return { ok: false, reason: 'bot not mentioned' };
  if (!operators.includes(event.pubkey)) return { ok: false, reason: 'sender is not an operator' };
  return { ok: true };
}

// The root of the thread `event` belongs to: its root marker, else the
// target of its reply marker (a direct reply to a root), else none.
function threadRoot(event) {
  return tagValue(event, 'e', 'root') || tagValue(event, 'e', 'reply') || null;
}

function replyTemplate(event, content, createdAt) {
  // An edit is answered under the message it edited (assumed top-level).
  const editedId = event.kind === KIND_EDIT ? tagValue(event, 'e') : null;
  const root = editedId ? null : threadRoot(event);
  const target = editedId || event.id;
  const thread = root
    ? [['e', root, '', 'root'], ['e', target, '', 'reply']]
    : [['e', target, '', 'reply']];
  return {
    kind: KIND_CHANNEL_MESSAGE,
    created_at: createdAt,
    content,
    tags: [['h', tagValue(event, 'h')], ...thread, ['p', event.pubkey]],
  };
}

function stripMentions(text, botName) {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`@${escaped}`, 'gi'), '')
    .replace(/nostr:npub1[0-9a-z]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { channelFilter, shouldHandle, replyTemplate, stripMentions, threadRoot, KIND_CHANNEL_MESSAGE, KIND_EDIT };
