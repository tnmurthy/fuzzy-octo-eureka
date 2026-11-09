const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseTasksMd, resolveTasksFile, addLocalTask, moveLocalTask } = require('./tasks-md');

test('tasks-md: parses standard TASKS.md format', () => {
  const sample = `# Task Board
## In Progress
| ID | Task | Project | Owner |
|---|---|---|---|
| TASK-01 | Build feature | core | dev |

## Backlog
| ID | Task | Project | Issue |
|---|---|---|---|
| TASK-02 | Review logs | infra | #10 |

## Done
| Task | Completed |
|---|---|
| Initial release | 2026-11-01 |
`;

  const parsed = parseTasksMd(sample);
  assert.equal(parsed.in_progress.length, 1);
  assert.equal(parsed.in_progress[0].id, 'TASK-01');
  assert.equal(parsed.backlog.length, 1);
  assert.equal(parsed.backlog[0].id, 'TASK-02');
  assert.equal(parsed.done.length, 1);
  assert.equal(parsed.done[0].task, 'Initial release');
});

test('tasks-md: resolves repository TASKS.md when present', () => {
  const resolved = resolveTasksFile(__dirname);
  assert.ok(resolved.endsWith('TASKS.md'));
  assert.ok(fs.existsSync(resolved));
});

test('tasks-md: addLocalTask appends to backlog and moveLocalTask updates section', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));
  const tmpFile = path.join(tmpDir, 'TASKS.md');

  const initial = `# Task Board\n\n## In Progress\n\n| ID | Task | Project | Owner |\n|---|---|---|---|\n\n## Backlog\n\n| ID | Task | Project | Issue |\n|---|---|---|---|\n\n## Done\n\n| Task | Completed |\n|---|---|\n`;
  fs.writeFileSync(tmpFile, initial, 'utf8');

  // Add task to backlog
  const added = addLocalTask(tmpFile, { title: 'Test Task A', project: 'test-proj', status: 'backlog' });
  assert.ok(added.id.startsWith('TASK-'));
  assert.equal(added.task, 'Test Task A');

  let cols = parseTasksMd(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(cols.backlog.length, 1);
  assert.equal(cols.backlog[0].task, 'Test Task A');
  assert.equal(cols.in_progress.length, 0);

  // Move task to in_progress
  const moved = moveLocalTask(tmpFile, added.id, 'in_progress');
  assert.ok(moved);
  assert.equal(moved.status, 'in_progress');

  cols = parseTasksMd(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(cols.backlog.length, 0);
  assert.equal(cols.in_progress.length, 1);
  assert.equal(cols.in_progress[0].id, added.id);

  // Move task to done
  const finished = moveLocalTask(tmpFile, added.id, 'done');
  assert.ok(finished);
  assert.equal(finished.status, 'done');

  cols = parseTasksMd(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(cols.in_progress.length, 0);
  assert.equal(cols.done.length, 1);

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
