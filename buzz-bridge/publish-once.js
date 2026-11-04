// publish-once.js - one-shot utility: publish a single channel message as
// the bridge's existing bot identity, then exit. Reuses buzz-bridge/.env
// (BRIDGE_RELAY_URL, BUZZ_BOT_SECRET_KEY, BUZZ_BOT_CHANNELS). Does not touch
// the running ArunachalaBuzzBridge service or its own connection.
//
// Usage: node publish-once.js "<message text>" [channelId]
// If channelId is omitted, posts to every channel in BUZZ_BOT_CHANNELS.

const fs = require('fs');
const path = require('path');
const { getPublicKey, finalizeEvent } = require('nostr-tools/pure');
const { makeAuthEvent } = require('nostr-tools/nip42');
const { npubEncode } = require('nostr-tools/nip19');

const ENV_FILE = path.join(__dirname, '.env');
try { process.loadEnvFile(ENV_FILE); } catch { /* rely on process env */ }

const RELAY_URL = (process.env.BRIDGE_RELAY_URL || 'wss://buzz.mytestbed.tech').replace(/^http/, 'ws');
const hex = process.env.BUZZ_BOT_SECRET_KEY;
if (!hex || !/^[0-9a-f]{64}$/.test(hex)) {
  console.error('No BUZZ_BOT_SECRET_KEY in .env - start bridge.js once first so it generates one.');
  process.exit(1);
}
const SECRET = Uint8Array.from(Buffer.from(hex, 'hex'));
const BOT_PUBKEY = getPublicKey(SECRET);
const now = () => Math.floor(Date.now() / 1000);

const content = process.argv[2];
const targetChannel = process.argv[3];
if (!content) {
  console.error('Usage: node publish-once.js "<message>" [channelId]');
  process.exit(1);
}
const CHANNELS = targetChannel ? [targetChannel] : (process.env.BUZZ_BOT_CHANNELS || '').split(',').filter(Boolean);
if (!CHANNELS.length) {
  console.error('No channel to post to - set BUZZ_BOT_CHANNELS in .env or pass one as argv[2].');
  process.exit(1);
}

const ws = new WebSocket(RELAY_URL);
let authed = false;
let posted = 0;

const send = (msg) => ws.send(JSON.stringify(msg));
const publish = (template) => send(['EVENT', finalizeEvent(template, SECRET)]);

ws.addEventListener('open', () => console.log(`Connected to ${RELAY_URL} as ${npubEncode(BOT_PUBKEY)}`));

ws.addEventListener('message', ({ data }) => {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  const [type] = msg;

  if (type === 'AUTH') {
    send(['AUTH', finalizeEvent(makeAuthEvent(RELAY_URL, msg[1]), SECRET)]);
    return;
  }
  if (type === 'OK' && !authed) {
    if (!msg[2]) { console.error(`Relay refused login: ${msg[3]}`); return ws.close(); }
    authed = true;
    for (const ch of CHANNELS) {
      publish({ kind: 9, created_at: now(), content, tags: [['h', ch]] });
    }
    return;
  }
  if (type === 'OK' && authed) {
    posted += 1;
    console.log(`Posted to ${msg[1]}: ${msg[2] ? 'ok' : 'rejected - ' + msg[3]}`);
    if (posted >= CHANNELS.length) { ws.close(); process.exit(0); }
  }
});

ws.addEventListener('error', (e) => console.error('WS error:', e.message || e));
setTimeout(() => { console.error('Timed out waiting for relay ack.'); process.exit(1); }, 15000);
