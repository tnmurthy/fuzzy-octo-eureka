// router.js - decides what to do with an operator's Buzz message.
//
// One TypeSafe System One request asks every judgment in parallel over the
// same state (route, persona, executor, repo, status topic, risk, clarity).
// The speculative answers (persona, executor, ...) are only consumed when the
// route makes them relevant. decide() is plain policy over those answers, so
// thresholds can change without re-asking the model.

const THRESHOLDS = {
  route: 0.6,     // below this, ask instead of guessing the intent
  persona: 0.5,   // below this, the PO answers
  repo: 0.6,      // below this, ask which repo
  risky: 0.3,     // above this, a run needs the operator's confirmation
  clear: 0.5,     // below this, an actionable request gets a follow-up question
};

const PERSONAS = {
  po: 'Arunachala Ramana, Product Owner: scope, priorities, plans, coordinating the team',
  tech: 'Tech Lead and Architect: code design, implementation approach, refactoring, architecture',
  qa: 'QA and Verification: tests, validation, pre-commit checks, whether something works',
  infra: 'DevOps and Infrastructure: Docker, Ollama, services, tunnels, runtime health',
  doc: 'Documentation: changelogs, project state, memory logs, writing things down',
};

const EXECUTORS = {
  claude: 'Claude Code: builds features and fixes in a repo, edits files and commits',
  codex: 'Codex: builds focused code changes in a repo',
  agy: 'Antigravity: reviews code and plans without changing files',
  hermes: 'Hermes: local model, small reasoning or scripting tasks, no cloud cost',
};

function buildRequest({ message, thread, repos, recentRuns }) {
  const repoCriteria = Object.fromEntries(repos.map(r => [r, `the ${r} repository`]));
  repoCriteria.none = 'no repository is named or clearly implied';

  return {
    state: {
      message,
      thread: thread.slice(-5),
      team: { personas: PERSONAS, executors: EXECUTORS },
      repos,
      recentRuns: recentRuns.slice(0, 5),
    },
    questions: {
      route: {
        type: 'choice',
        instructions: 'The operator sent `message` to their AI team (earlier messages are in `thread`). What does the operator want?',
        criteria: {
          status: 'to know the current state: whether services or agents are up, what ran, what is in progress or failed',
          ask_persona: 'advice, a plan, an explanation or an opinion from a team member, with nothing changed',
          dispatch: 'a coding agent to change, fix, review or test code in a repository',
          add_task: 'something recorded on the task board for later, not done now',
          none: 'nothing: acknowledgement, thanks or small talk',
        },
      },
      persona: {
        type: 'choice',
        instructions: 'If a team member in `team.personas` should answer `message`, which one is the best fit?',
        criteria: PERSONAS,
      },
      executor: {
        type: 'choice',
        instructions: 'If `message` asks for work in a repository, which coding agent in `team.executors` fits it best?',
        criteria: EXECUTORS,
      },
      repo: {
        type: 'choice',
        instructions: 'Which repository from `repos` does `message` (with `thread`) refer to?',
        criteria: repoCriteria,
      },
      status_topic: {
        type: 'choice',
        instructions: 'If `message` asks about current state, what is it asking about?',
        criteria: {
          services: 'whether services are up: Ollama, OpenClaw, Buzz, the tunnel',
          runs: 'agent runs: what ran, what failed, what is running now',
          everything: 'an overall summary or several of these at once',
        },
      },
      risky: {
        type: 'noul',
        instructions: 'Would carrying out `message` push, merge or deploy code, delete data or branches, change production, cloud, DNS or access settings, rotate credentials, or spend money?',
        criteria: { true: 'it would do at least one of those', false: 'it would do none of those' },
      },
      clear: {
        type: 'noul',
        instructions: 'Does `message` (with `thread`) say what outcome is wanted, so a capable teammate could start on it? Ordinary engineering details can be left for them to work out.',
        criteria: {
          true: 'the wanted outcome is stated, e.g. "fix the failing lint in bov" or "add a health check to the dashboard"',
          false: 'the outcome itself is missing or ambiguous, e.g. "sort out that thing" or "make it better"',
        },
      },
    },
  };
}

function decide(a) {
  const route = a.route;
  const needsConfirm = a.risky.noul > THRESHOLDS.risky;

  if (route.confidence < THRESHOLDS.route) {
    return { action: 'clarify', question: 'Do you want a status update, advice from the team, or work done in a repo?' };
  }
  switch (route.choice) {
    case 'none':
      return { action: 'ignore' };
    case 'status':
      return { action: 'status', topic: a.status_topic.choice };
    case 'ask_persona': {
      const persona = a.persona.confidence >= THRESHOLDS.persona ? a.persona.choice : 'po';
      return { action: 'persona', persona };
    }
    case 'dispatch':
    case 'add_task': {
      if (a.clear.noul < THRESHOLDS.clear) {
        return { action: 'clarify', question: 'Can you say exactly what should change and how we will know it is done?' };
      }
      if (route.choice === 'add_task') return { action: 'add_task', needsConfirm, enabled: false };
      if (a.repo.choice === 'none' || a.repo.confidence < THRESHOLDS.repo) {
        return { action: 'clarify', question: 'Which repo should this run in?' };
      }
      return { action: 'dispatch', executor: a.executor.choice, repo: a.repo.choice, needsConfirm, enabled: false };
    }
    default:
      return { action: 'clarify', question: 'I did not understand that - can you rephrase?' };
  }
}

module.exports = { buildRequest, decide, THRESHOLDS, PERSONAS, EXECUTORS };
