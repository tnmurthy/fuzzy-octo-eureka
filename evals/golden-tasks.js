// golden-tasks.js - loads the golden eval tasks in evals/golden/<id>/.
//
// Each task folder holds:
//   task.json   id, name, difficulty, targetAgent, targetTurns, targetDurationMs,
//               testCommand, testTimeoutMs, prompt (what the agent is told)
//   fixture/    the starting code; becomes a fresh git repo for the run
//   grader/     hidden tests, copied over the agent's work only after it finishes
//   solution/   a reference answer; tests prove the grader fails fixture/ and
//               passes solution/, so a task cannot silently become unpassable
'use strict';

const fs = require('fs');
const path = require('path');

const GOLDEN_DIR = path.join(__dirname, 'golden');
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REQUIRED = ['id', 'name', 'prompt', 'testCommand'];

function validateTask(task, dirName) {
  for (const key of REQUIRED) {
    if (typeof task[key] !== 'string' || !task[key].trim()) {
      throw new Error(`golden task ${dirName}: "${key}" must be a non-empty string`);
    }
  }
  if (!ID_RE.test(task.id)) throw new Error(`golden task ${dirName}: bad id "${task.id}"`);
  if (task.id !== dirName) throw new Error(`golden task ${dirName}: id "${task.id}" must match its folder`);
}

function loadTask(dir) {
  const dirName = path.basename(dir);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
  validateTask(raw, dirName);
  for (const sub of ['fixture', 'grader']) {
    if (!fs.existsSync(path.join(dir, sub))) throw new Error(`golden task ${dirName}: missing ${sub}/`);
  }
  return Object.freeze({
    difficulty: 'medium',
    targetAgent: 'hermes',
    targetTurns: 4,
    targetDurationMs: 20000,
    testTimeoutMs: 120000,
    ...raw,
    dir,
    fixtureDir: path.join(dir, 'fixture'),
    graderDir: path.join(dir, 'grader'),
    solutionDir: path.join(dir, 'solution'),
  });
}

function loadGoldenTasks(root = GOLDEN_DIR) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'task.json')))
    .map((d) => loadTask(path.join(root, d.name)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

module.exports = { loadGoldenTasks, loadTask, validateTask, GOLDEN_DIR };
