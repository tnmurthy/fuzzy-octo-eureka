// handler.js - turns one operator message into one reply (or none).
//
// TypeSafe/local router decides what kind of message it is; code does the
// rest. Status answers are built from dashboard data with no model call.
// Persona answers go to the local Ollama personas via the dashboard. A
// non-risky dispatch is handed to deps.dispatch.trigger (n8n, which runs
// orchestration/agent-dispatch.sh and reports back asynchronously via
// bridge.js's /notify listener). A risky dispatch is still only described -
// it needs the operator's explicit confirmation, which isn't built yet.

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
  return `I would hand this to ${d.executor} in ${d.repo}. It looks risky, so it will need your confirmation. Running risky agents from Buzz is not enabled yet.`;
}

/**
 * @param {{ typesafe: { systemOne: Function },
 *           dashboard: { telemetry: Function, runs: Function, chat: Function },
 *           dispatch?: { trigger: Function, registerPending: Function },
 *           repos: () => string[] }} deps
 */
function createHandler(deps) {
  return async function handle({ text, thread, log = () => {} }) {
    const trimmed = (text || '').trim();

    // Fast-path: /status [services|runs|everything]
    if (trimmed.startsWith('/status')) {
      const topic = trimmed.includes('runs') ? 'runs' : trimmed.includes('services') ? 'services' : 'everything';
      const [telemetry, runs] = await Promise.all([deps.dashboard.telemetry(), deps.dashboard.runs()]);
      return formatStatus(telemetry, runs, topic);
    }

    // Fast-path: /run <agent> <repo> <task...> or /dispatch <agent> <repo> <task...>
    if (trimmed.startsWith('/run ') || trimmed.startsWith('/dispatch ')) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 4) {
        const agent = parts[1];
        const repo = parts[2];
        const task = parts.slice(3).join(' ');
        if (!deps.dispatch) return `Dispatch not configured.`;
        try {
          const { runId } = await deps.dispatch.trigger({ agent, repo, task });
          deps.dispatch.registerPending(runId);
          return `Dispatched ${agent} in ${repo} (run ${runId}). I will reply here when it finishes.`;
        } catch (err) {
          return `Could not dispatch: ${err.message}`;
        }
      }
    }

    // Fast-path: /po <text>, /tech <text>, /qa <text>, /infra <text>, /doc <text>
    const personaMatch = trimmed.match(/^\/(po|tech|qa|infra|doc)\s+(.+)$/s);
    if (personaMatch) {
      const [, p, query] = personaMatch;
      return deps.dashboard.chat(p, query);
    }

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
      case 'dispatch': {
        if (decision.needsConfirm || !deps.dispatch) return describeDispatch(decision);
        try {
          const { runId } = await deps.dispatch.trigger({ agent: decision.executor, repo: decision.repo, task: text });
          deps.dispatch.registerPending(runId);
          return `Dispatched ${decision.executor} in ${decision.repo} (run ${runId}). I will reply here when it finishes.`;
        } catch (err) {
          return `Could not dispatch: ${err.message}`;
        }
      }
      case 'add_task':
        return 'I would add this to the task board. Adding tasks from Buzz is not enabled yet.';
      default:
        return null;
    }
  };
}

module.exports = { createHandler, formatStatus };
