// chat-transcripts.js - Manages persistent conversation timelines and transcripts
// for all AI agent personas in Team Arunachala / Drisyon AI Mesh.

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');
const TRANSCRIPTS_FILE = path.join(LOGS_DIR, 'chat-transcripts.jsonl');

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function recordTranscript(entry, filePath = TRANSCRIPTS_FILE) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const record = {
      id: entry.id || `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: entry.timestamp || new Date().toISOString(),
      agent: entry.agent || 'po',
      agentTitle: entry.agentTitle || 'Arunachala Ramana',
      user: entry.user || 'operator',
      message: String(entry.message || '').trim(),
      reply: String(entry.reply || '').trim(),
      isAdvisory: Boolean(entry.isAdvisory),
      spawned: entry.spawned || null
    };

    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    return record;
  } catch (err) {
    console.error('Failed to append chat transcript:', err.message);
    return null;
  }
}

function getTranscripts({ agent, limit = 100 } = {}, filePath = TRANSCRIPTS_FILE) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const results = [];

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!agent || item.agent === agent) {
          results.push(item);
        }
      } catch (_) {}
    }

    if (limit && results.length > limit) {
      return results.slice(-limit);
    }
    return results;
  } catch (err) {
    console.error('Failed to read chat transcripts:', err.message);
    return [];
  }
}

function clearTranscripts({ agent } = {}, filePath = TRANSCRIPTS_FILE) {
  try {
    if (!fs.existsSync(filePath)) return true;
    if (!agent) {
      fs.writeFileSync(filePath, '', 'utf8');
      return true;
    }

    const all = getTranscripts({ limit: 0 }, filePath);
    const retained = all.filter(t => t.agent !== agent);
    const serialized = retained.map(r => JSON.stringify(r)).join('\n') + (retained.length ? '\n' : '');
    fs.writeFileSync(filePath, serialized, 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to clear chat transcripts:', err.message);
    return false;
  }
}

function exportTranscriptsMarkdown({ agent } = {}, filePath = TRANSCRIPTS_FILE) {
  const records = getTranscripts({ agent, limit: 0 }, filePath);
  if (!records.length) {
    return `# Chat Transcript History\n\nNo transcripts recorded yet.\n`;
  }

  const titleAgent = agent ? ` (${agent.toUpperCase()})` : '';
  let md = `# 📜 Agent Chat Transcript History${titleAgent}\n\n`;
  md += `*Generated: ${new Date().toUTCString()} · Total Messages: ${records.length}*\n\n---\n\n`;

  for (const r of records) {
    const timeStr = new Date(r.timestamp).toLocaleString();
    md += `### 💬 Session #${r.id} · ${timeStr}\n`;
    md += `**Persona:** ${r.agentTitle || r.agent} (\`${r.agent}\`)  \n`;
    md += `**Operator:** \`${r.user}\`  \n\n`;
    md += `#### 👤 User Prompt:\n> ${r.message.replace(/\n/g, '\n> ')}\n\n`;
    md += `#### 🤖 Agent Response:\n${r.reply}\n\n`;
    if (r.spawned && r.spawned.runId) {
      md += `*⚡ Dispatched Subagent:* \`${r.spawned.agent}\` (Run ID: \`${r.spawned.runId}\`, Branch: \`${r.spawned.branch}\`)\n\n`;
    }
    md += `---\n\n`;
  }

  return md;
}

module.exports = {
  TRANSCRIPTS_FILE,
  recordTranscript,
  getTranscripts,
  clearTranscripts,
  exportTranscriptsMarkdown
};
