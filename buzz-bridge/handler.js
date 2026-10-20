// handler.js - turns one operator message into one reply (or none).
//
// TypeSafe decides what kind of message it is; code does the rest. Status
// answers are built from dashboard data with no model call. Persona answers
// go to the local Ollama personas via the dashboard. Dispatch is described
// but not executed until step 2 adds confirmation and the run hand-off.

const { buildRequest, decide } = require('./router');

const SERVICES = [['ollama', 'Ollama'], ['openclaw', 'OpenClaw'], ['buzz', 'Buzz relay']];
const MAX_RUNS_LISTED = 5;
const HINT = 'Hi! Try: "is everything up?", "what ran today?", or a question for the team like "should ollama run as a service?"';

const dayKey = (ms) => new Date(ms).toDateString();
const shortTime = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return 'time unknown';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

// "What ran today?" must not be answered with runs from weeks ago as if they
// were today's: show today's runs, or say there were none and show the latest.
function formatRuns(runs, nowMs) {
  if (!runs.length) return ['No agent runs recorded.'];
  const today = runs.filter(r => dayKey(Date.parse(r.started_at)) === dayKey(nowMs));
  const shown = (today.length ? today : runs).slice(0, MAX_RUNS_LISTED);
  const header = today.length ? 'Today:' : 'No agent runs today. Latest:';
  return [header, ...shown.map(r => `${r.agent} - ${r.status} - ${r.branch || '?'} (${shortTime(r.started_at)})`)];
}

function formatStatus(telemetry, runs, topic, nowMs = Date.now()) {
  const lines = [];
  if (topic === 'services' || topic === 'everything') {
    const svc = telemetry.services || {};
    for (const [key, label] of SERVICES) {
      const s = svc[key];
      const state = !s ? 'unknown' : s.online ? 'up' : 'DOWN';
      lines.push(`${label}: ${state}`);
    }
  }
  if (topic === 'runs' || topic === 'everything') lines.push(...formatRuns(runs, nowMs));
  if (telemetry.timestamp) lines.push(`(telemetry ${telemetry.timestamp})`);
  return lines.join('\n');
}

function describeDispatch(d) {
  const confirm = d.needsConfirm ? ' It looks risky, so it will need your confirmation.' : '';
  return `I would hand this to ${d.executor} in ${d.repo}.${confirm} Running agents from Buzz is not enabled yet.`;
}

/**
 * @param {{ typesafe: { systemOne: Function },
 *           dashboard: { telemetry: Function, runs: Function, chat: Function },
 *           repos: () => string[] }} deps
 */
function createHandler(deps) {
  return async function handle({ text, thread, log = () => {} }) {
    let decision;
    try {
      const runs = await deps.dashboard.runs();
      const req = buildRequest({ message: text, thread, repos: deps.repos(), recentRuns: runs });
      const res = await deps.typesafe.systemOne(req, { purpose: 'route' });
      decision = decide(res.answers);
    } catch (err) {
      log({ action: 'fallback-po', error: err.message });
      const reply = await deps.dashboard.chat('po', text);
      return `(routing unavailable: ${err.message})\n${reply}`;
    }
    log(decision);

    switch (decision.action) {
      case 'ignore':
        return HINT;
      case 'clarify':
        return decision.question;
      case 'status': {
        const [telemetry, runs] = await Promise.all([deps.dashboard.telemetry(), deps.dashboard.runs()]);
        return formatStatus(telemetry, runs, decision.topic);
      }
      case 'persona':
        return deps.dashboard.chat(decision.persona, text);
      case 'dispatch':
        return describeDispatch(decision);
      case 'add_task':
        return 'I would add this to the task board. Adding tasks from Buzz is not enabled yet.';
      default:
        return null;
    }
  };
}

module.exports = { createHandler, formatStatus };
