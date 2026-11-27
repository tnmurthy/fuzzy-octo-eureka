// cohort-candidates.js - CRUD for the cohort sales/enrollment funnel's
// candidates (docs/DRISYON_COHORT_01_ENROLLMENT_PLAYBOOK.md section 8).
// A different domain from the engineering task/Kanban board
// (team-store/tasks.js) - no shared code or schema.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STAGES = ['lead_inquiry', 'screen_scheduled', 'screen_passed', 'lab_provisioned'];
const MAX_FIELD = 200;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function createCohortCandidates({ file, now = Date.now }) {
  const state = readJson(file) || { candidates: [] };
  if (!Array.isArray(state.candidates)) state.candidates = [];

  function list() {
    return state.candidates;
  }

  function create({ name, contact, source, notes } = {}) {
    const n = typeof name === 'string' ? name.trim() : '';
    if (!n || n.length > MAX_FIELD) return { ok: false, error: `name is required, at most ${MAX_FIELD} characters` };
    const candidate = {
      id: 'cand_' + crypto.randomBytes(6).toString('hex'),
      name: n,
      contact: typeof contact === 'string' ? contact.trim().slice(0, MAX_FIELD) : '',
      source: typeof source === 'string' ? source.trim().slice(0, MAX_FIELD) : '',
      notes: typeof notes === 'string' ? notes.trim().slice(0, 2000) : '',
      stage: STAGES[0],
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    state.candidates.push(candidate);
    writeJsonAtomic(file, state);
    return { ok: true, candidate };
  }

  function updateStage(id, stage) {
    if (!STAGES.includes(stage)) return { ok: false, error: `stage must be one of: ${STAGES.join(', ')}` };
    const candidate = state.candidates.find((c) => c.id === id);
    if (!candidate) return { ok: false, error: 'no such candidate' };
    candidate.stage = stage;
    candidate.updatedAt = new Date(now()).toISOString();
    writeJsonAtomic(file, state);
    return { ok: true, candidate };
  }

  return { STAGES, list, create, updateStage };
}

module.exports = { createCohortCandidates, STAGES };
