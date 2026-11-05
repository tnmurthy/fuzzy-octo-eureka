// scripts/import-tasks.js - one-off copy of 04_internal/TASKS.md onto the
// team's shared board (arunachala_tasks), signed in as you (.env).
//
//   node scripts/import-tasks.js            # show what would be imported
//   node scripts/import-tasks.js --apply    # import it
//
// Safe to re-run: a title already on the board is skipped.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('../load-env').loadEnv(ROOT);
const { parseTasksMd } = require('../tasks-md');
const { createTeamStore } = require('../team-store');
const { validateNewTask } = require('../team-store/tasks');

async function main() {
  const apply = process.argv.includes('--apply');
  const file = process.env.TASKS_FILE || path.resolve(ROOT, '../../../04_internal/TASKS.md');
  const cols = parseTasksMd(fs.readFileSync(file, 'utf8'));
  const wanted = [
    ...cols.backlog.map((t) => ({ title: t.task, project: t.project, status: 'backlog', link: /^https?:\/\//.test(t.issue) ? t.issue : undefined })),
    ...cols.in_progress.map((t) => ({ title: t.task, project: t.project, status: 'in_progress' })),
    ...cols.done.map((t) => ({ title: t.task, status: 'done' })),
  ];
  const store = createTeamStore(process.env, { readRuns: () => ({ runs: [] }), runsFile: '', stateFile: '' });
  if (!store) throw new Error('team-store is off: set SUPABASE_* and TEAM_ID in .env');

  const board = (await store.teamTasks()).columns;
  const existing = new Set([...board.backlog, ...board.in_progress, ...board.done].map((t) => t.task));
  let added = 0;
  for (const input of wanted) {
    const v = validateNewTask(input);
    if (!v.ok) { console.log(`skip (${v.error}): ${input.title}`); continue; }
    if (existing.has(v.task.title)) { console.log(`skip (already on board): ${v.task.title}`); continue; }
    console.log(`${apply ? 'add' : 'would add'} [${v.task.status}] ${v.task.title}`);
    if (apply) { await store.createTask(v.task); added += 1; }
  }
  console.log(apply ? `${added} task(s) imported.` : 'Dry run - re-run with --apply to import.');
}

main().catch((err) => { console.error(`import failed: ${err.message}`); process.exit(1); });
