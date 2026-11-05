// tasks.js - the team's shared task board (arunachala_tasks): input checks
// for new tasks and moves, and the column shape the dashboard's Task Board
// tile already reads from the TASKS.md parser.

const STATUSES = new Set(['backlog', 'in_progress', 'done']);
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
  return { ok: true, task: { title, project, status, link } };
}

// ownerNames: task id -> display name of who it is assigned to (or created it).
function toColumns(rows, ownerNames = {}) {
  const columns = { backlog: [], in_progress: [], done: [] };
  for (const r of rows) {
    if (r.status === 'in_progress') {
      columns.in_progress.push({ id: r.id, task: r.title, project: r.project || 'General', owner: ownerNames[r.id] || 'Team' });
    } else if (r.status === 'done') {
      columns.done.push({ id: r.id, task: r.title, completed: 'Completed' });
    } else {
      columns.backlog.push({ id: r.id, task: r.title, project: r.project || 'General', issue: r.link || '' });
    }
  }
  return columns;
}

module.exports = { toColumns, validateNewTask, validateStatus, STATUSES };
