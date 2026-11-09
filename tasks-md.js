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
  const columns = { backlog: [], in_progress: [], done: [] };
  let currentSection = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## In Progress')) {
      currentSection = 'in_progress';
    } else if (trimmed.startsWith('## Backlog')) {
      currentSection = 'backlog';
    } else if (trimmed.startsWith('## Done')) {
      currentSection = 'done';
    } else if (trimmed.startsWith('## ') || trimmed.startsWith('# ')) {
      currentSection = null;
    } else if (currentSection && trimmed.startsWith('|') && !trimmed.includes('---') && !trimmed.toLowerCase().includes('task |') && !trimmed.toLowerCase().includes('# | task')) {
      const parts = trimmed.split('|').map(s => s.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
      if (parts.length >= 1) {
        if (currentSection === 'in_progress') {
          columns.in_progress.push({
            id: parts[0] || '—',
            task: parts[1] || parts[0],
            project: parts[2] || 'docker-base',
            owner: parts[3] || 'Agent/CI'
          });
        } else if (currentSection === 'backlog') {
          columns.backlog.push({
            id: parts[0] || '—',
            task: parts[1] || parts[0],
            project: parts[2] || 'General',
            issue: parts[3] || ''
          });
        } else if (currentSection === 'done') {
          columns.done.push({
            id: parts[0] || '—',
            task: parts[0],
            completed: parts[1] || 'Completed'
          });
        }
      }
    }
  }
  return columns;
}

function addLocalTask(filePath, { title, project = 'General', owner = 'Operator', issue = '', status = 'backlog' }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tasks file not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const id = `TASK-${Date.now().toString().slice(-4)}`;
  const cleanTitle = String(title).replace(/\|/g, '-').trim();
  const cleanProj = String(project).replace(/\|/g, '-').trim();

  let targetSectionHeader = '## Backlog';
  let newRow = `| ${id} | ${cleanTitle} | ${cleanProj} | ${issue} |`;

  if (status === 'in_progress') {
    targetSectionHeader = '## In Progress';
    newRow = `| ${id} | ${cleanTitle} | ${cleanProj} | ${owner} |`;
  } else if (status === 'done') {
    targetSectionHeader = '## Done';
    newRow = `| ${cleanTitle} | ${new Date().toISOString().slice(0, 10)} |`;
  }

  const lines = content.split(/\r?\n/);
  const targetIdx = lines.findIndex(l => l.trim().toLowerCase() === targetSectionHeader.toLowerCase());
  if (targetIdx === -1) {
    throw new Error(`Section ${targetSectionHeader} not found in ${filePath}`);
  }

  // Find end of table in that section
  let insertIdx = targetIdx + 1;
  while (insertIdx < lines.length && (lines[insertIdx].trim().startsWith('|') || lines[insertIdx].trim() === '')) {
    insertIdx++;
  }

  lines.splice(insertIdx, 0, newRow);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { id, task: cleanTitle, project: cleanProj, status };
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
          foundRow = { id: parts[0], task: parts[1] || parts[0], project: parts[2] || 'General', owner: parts[3] || 'Operator' };
          foundIdx = i;
          break;
        }
      }
    }
  }

  if (foundIdx === -1 || !foundRow) {
    return null;
  }

  // Remove old row
  lines.splice(foundIdx, 1);

  // Determine destination
  let targetSectionHeader = '## Backlog';
  let newRow = `| ${foundRow.id} | ${foundRow.task} | ${foundRow.project} | |`;
  if (newStatus === 'in_progress') {
    targetSectionHeader = '## In Progress';
    newRow = `| ${foundRow.id} | ${foundRow.task} | ${foundRow.project} | ${foundRow.owner} |`;
  } else if (newStatus === 'done') {
    targetSectionHeader = '## Done';
    newRow = `| ${foundRow.task} | ${new Date().toISOString().slice(0, 10)} |`;
  }

  const targetIdx = lines.findIndex(l => l.trim().toLowerCase() === targetSectionHeader.toLowerCase());
  if (targetIdx === -1) {
    throw new Error(`Section ${targetSectionHeader} not found in ${filePath}`);
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
