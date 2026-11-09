// tasks.js - the team's shared task board (arunachala_tasks): input checks
// for new tasks and moves, supporting both the 6-stage autonomous agent pipeline
// and legacy 3-column backwards compatibility.

const STATUSES = new Set([
  'backlog', 'in_progress', 'done',
  'intake', 'planning', 'in_execution', 'verification', 'human_review'
]);
const MAX_TITLE = 300;

const validateStatus = (s) => STATUSES.has(s);

function validateNewTask(input) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'task body must be a JSON object' };
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > MAX_TITLE) return { ok: false, error: `title is required, at most ${MAX_TITLE} characters` };
  const status = input.status || 'backlog';
  if (!validateStatus(status)) return { ok: false, error: 'status must be backlog, in_progress or done' };
  const project = typeof input.project === 'string' && input.project.trim() ? input.project.trim().slice(0, 80) : null;
  let link = null;
  if (input.link) {
    if (typeof input.link !== 'string' || !/^https?:\/\//i.test(input.link)) return { ok: false, error: 'link must be an http(s) URL' };
    link = input.link.slice(0, 500);
  }
  const task = { title, project, status, link };
  if (input.owner && typeof input.owner === 'string') task.owner = input.owner.trim().slice(0, 50);
  if (input.decision && typeof input.decision === 'string') task.decision = input.decision.trim().slice(0, 30);
  return { ok: true, task };
}

// ownerNames: task id -> display name of who it is assigned to (or created it).
function toColumns(rows, ownerNames = {}) {
  const columns = {
    intake: [],
    planning: [],
    in_execution: [],
    verification: [],
    human_review: [],
    done: [],
    backlog: [],
    in_progress: []
  };
  for (const r of rows) {
    if (r.status === 'in_progress' || r.status === 'in_execution') {
      const item = { id: r.id, task: r.title, project: r.project || 'General', owner: ownerNames[r.id] || 'Team' };
      columns.in_progress.push(item);
      columns.in_execution.push(item);
    } else if (r.status === 'done') {
      const item = { id: r.id, task: r.title, completed: 'Completed' };
      columns.done.push(item);
    } else if (r.status === 'planning') {
      columns.planning.push({ id: r.id, task: r.title, project: r.project || 'General', owner: ownerNames[r.id] || 'Team' });
    } else if (r.status === 'verification') {
      columns.verification.push({ id: r.id, task: r.title, project: r.project || 'General', owner: ownerNames[r.id] || 'Team' });
    } else if (r.status === 'human_review') {
      columns.human_review.push({ id: r.id, task: r.title, project: r.project || 'General', owner: ownerNames[r.id] || 'Team' });
    } else {
      const item = { id: r.id, task: r.title, project: r.project || 'General', issue: r.link || '' };
      columns.backlog.push(item);
      columns.intake.push(item);
    }
  }
  return columns;
}

module.exports = { toColumns, validateNewTask, validateStatus, STATUSES };
