// tasks-md.js - parses and manages TASKS.md (markdown tables under
// ## In Progress / ## Backlog / ## Done) into the Task Board's columns.
// Supports both team-store Supabase fallback and standalone local operations.

const fs = require('fs');
const path = require('path');

function resolveTasksFile(baseDir = __dirname) {
  if (process.env.TASKS_FILE && fs.existsSync(process.env.TASKS_FILE)) {
    return process.env.TASKS_FILE;
  }
  const localRepoPath = path.join(baseDir, 'TASKS.md');
  if (fs.existsSync(localRepoPath)) {
    return localRepoPath;
  }
  const parentInternal = path.resolve(baseDir, '../../../04_internal/TASKS.md');
  if (fs.existsSync(parentInternal)) {
    return parentInternal;
  }
  return localRepoPath;
}

function parseTasksMd(data) {
  const lines = data.split(/\r?\n/);
  const columns = {
    intake: [],
    planning: [],
    in_execution: [],
    verification: [],
    human_review: [],
    done: [],
    // Legacy mirrors for backwards compatibility
    backlog: [],
    in_progress: []
  };
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('## 1.') || lower.startsWith('## intake') || lower.startsWith('## backlog')) {
      currentSection = 'intake';
    } else if (lower.startsWith('## 2.') || lower.startsWith('## scope') || lower.startsWith('## planning')) {
      currentSection = 'planning';
    } else if (lower.startsWith('## 3.') || lower.startsWith('## execution') || lower.startsWith('## in execution') || lower.startsWith('## in progress')) {
      currentSection = 'in_execution';
    } else if (lower.startsWith('## 4.') || lower.startsWith('## evals') || lower.startsWith('## verification') || lower.startsWith('## qa')) {
      currentSection = 'verification';
    } else if (lower.startsWith('## 5.') || lower.startsWith('## review') || lower.startsWith('## sovereign') || lower.startsWith('## human review')) {
      currentSection = 'human_review';
    } else if (lower.startsWith('## 6.') || lower.startsWith('## delivered') || lower.startsWith('## done')) {
      currentSection = 'done';
    } else if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      currentSection = null;
    } else if (currentSection && trimmed.startsWith('|') && !trimmed.includes('---') && !trimmed.toLowerCase().includes('task |') && !trimmed.toLowerCase().includes('# | task')) {
      const parts = trimmed.split('|').map(s => s.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (parts.length >= 1) {
        if (currentSection === 'done') {
          const item = {
            id: parts[0] || '—',
            task: parts[0],
            completed: parts[1] || 'Completed'
          };
          columns.done.push(item);
        } else if (currentSection === 'intake') {
          const item = {
            id: parts[0] || '—',
            task: parts[1] || parts[0],
            project: parts[2] || 'docker-base',
            issue: parts[3] || ''
          };
          columns.intake.push(item);
          columns.backlog.push(item);
        } else if (currentSection === 'in_execution') {
          const item = {
            id: parts[0] || '—',
            task: parts[1] || parts[0],
            project: parts[2] || 'docker-base',
            owner: parts[3] || 'Agent/CI'
          };
          columns.in_execution.push(item);
          columns.in_progress.push(item);
        } else {
          const item = {
            id: parts[0] || '—',
            task: parts[1] || parts[0],
            project: parts[2] || 'fuzzy-octo-eureka',
            owner: parts[3] || 'Operator',
            decision: parts[4] || (currentSection === 'human_review' ? 'sovereign' : 'copilot')
          };
          columns[currentSection].push(item);
        }
      }
    }
  }
  return columns;
}

const SECTION_HEADERS = {
  intake: '## 1. Intake & Triage',
  backlog: '## 1. Intake & Triage',
  planning: '## 2. Scope & FinOps Gate',
  in_execution: '## 3. Autonomous Execution',
  in_progress: '## 3. Autonomous Execution',
  verification: '## 4. Evals & AppSec Verification',
  human_review: '## 5. Sovereign HITL Review',
  done: '## 6. Delivered & Invoiced'
};

function findSectionIndex(lines, status) {
  const targetHeader = (SECTION_HEADERS[status] || '## 1. Intake & Triage').toLowerCase();
  let idx = lines.findIndex(l => l.trim().toLowerCase().startsWith(targetHeader.slice(0, 10)));
  if (idx !== -1) return idx;

  // Fallbacks for legacy/alternative naming
  if (status === 'intake' || status === 'backlog') {
    return lines.findIndex(l => l.trim().toLowerCase().startsWith('## backlog') || l.trim().toLowerCase().startsWith('## intake'));
  }
  if (status === 'in_execution' || status === 'in_progress') {
    return lines.findIndex(l => l.trim().toLowerCase().startsWith('## in progress') || l.trim().toLowerCase().startsWith('## execution'));
  }
  if (status === 'planning') {
    return lines.findIndex(l => l.trim().toLowerCase().startsWith('## planning') || l.trim().toLowerCase().startsWith('## scope'));
  }
  if (status === 'verification') {
    return lines.findIndex(l => l.trim().toLowerCase().startsWith('## verification') || l.trim().toLowerCase().startsWith('## evals'));
  }
  if (status === 'human_review') {
    return lines.findIndex(l => l.trim().toLowerCase().startsWith('## sovereign') || l.trim().toLowerCase().startsWith('## review'));
  }
  if (status === 'done') {
    return lines.findIndex(l => l.trim().toLowerCase().startsWith('## done') || l.trim().toLowerCase().startsWith('## delivered'));
  }
  return -1;
}

function addLocalTask(filePath, { title, project = 'General', owner = 'Operator', issue = '', status = 'intake', decision = 'autonomous' }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tasks file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const id = `TASK-${Date.now().toString().slice(-4)}`;
  const cleanTitle = String(title).replace(/\|/g, '-').trim();
  const cleanProj = String(project).replace(/\|/g, '-').trim();
  const cleanOwner = String(owner).replace(/\|/g, '-').trim();

  const lines = content.split(/\r?\n/);
  const targetIdx = findSectionIndex(lines, status);
  if (targetIdx === -1) {
    throw new Error(`Section for status ${status} not found in ${filePath}`);
  }

  let newRow = `| ${id} | ${cleanTitle} | ${cleanProj} | ${cleanOwner} | ${decision} |`;
  if (status === 'done') {
    newRow = `| ${cleanTitle} | ${new Date().toISOString().slice(0, 10)} |`;
  }

  let insertIdx = targetIdx + 1;
  while (insertIdx < lines.length && (lines[insertIdx].trim().startsWith('|') || lines[insertIdx].trim() === '')) {
    insertIdx++;
  }

  lines.splice(insertIdx, 0, newRow);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { id, task: cleanTitle, project: cleanProj, status, owner: cleanOwner, decision };
}

function moveLocalTask(filePath, taskId, newStatus) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tasks file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  let foundRow = null;
  let foundIdx = -1;
  const cleanTarget = String(taskId).toLowerCase().trim();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('|') && !trimmed.includes('---') && !trimmed.toLowerCase().includes('task |') && !trimmed.toLowerCase().includes('# | task')) {
      const parts = trimmed.split('|').map(s => s.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (parts.length >= 1) {
        const idMatch = parts[0].toLowerCase() === cleanTarget;
        const titleMatch = (parts[1] && parts[1].toLowerCase() === cleanTarget) || parts[0].toLowerCase() === cleanTarget;
        if (idMatch || titleMatch) {
          foundRow = {
            id: parts[0],
            task: parts[1] || parts[0],
            project: parts[2] || 'General',
            owner: parts[3] || 'Operator',
            decision: parts[4] || 'autonomous'
          };
          foundIdx = i;
          break;
        }
      }
    }
  }

  if (foundIdx === -1 || !foundRow) {
    return null;
  }

  lines.splice(foundIdx, 1);

  const targetIdx = findSectionIndex(lines, newStatus);
  if (targetIdx === -1) {
    throw new Error(`Section for status ${newStatus} not found in ${filePath}`);
  }

  let newRow = `| ${foundRow.id} | ${foundRow.task} | ${foundRow.project} | ${foundRow.owner} | ${foundRow.decision} |`;
  if (newStatus === 'done') {
    newRow = `| ${foundRow.task} | ${new Date().toISOString().slice(0, 10)} |`;
  }

  let insertIdx = targetIdx + 1;
  while (insertIdx < lines.length && (lines[insertIdx].trim().startsWith('|') || lines[insertIdx].trim() === '')) {
    insertIdx++;
  }

  lines.splice(insertIdx, 0, newRow);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { id: foundRow.id, task: foundRow.task, status: newStatus };
}

module.exports = { parseTasksMd, resolveTasksFile, addLocalTask, moveLocalTask };
