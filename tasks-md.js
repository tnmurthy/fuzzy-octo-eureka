// tasks-md.js - parses 04_internal/TASKS.md (markdown tables under
// ## In Progress / ## Backlog / ## Done) into the Task Board's columns.
// Moved out of server.js unchanged so the team import script can reuse it.

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
            task: parts[0],
            completed: parts[1] || 'Completed'
          });
        }
      }
    }
  }
  return columns;
}

module.exports = { parseTasksMd };
