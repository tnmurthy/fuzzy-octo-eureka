// skill-loader.js - Just-In-Time (JIT) Skill Loader & Discovery Engine
// Inspired by AI Team OS (CronusL-1141/AI-company) dynamic skill discovery.
//
// Solves context crowding by dynamically scanning available skills and
// loading ONLY the top-matching skill instructions just-in-time into the agent
// prompt, bounded by strict character/token quotas.

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SKILLS_DIR = path.resolve(__dirname, 'skills');

/**
 * Parses YAML frontmatter from a SKILL.md file.
 * Returns metadata object and body content.
 */
function parseSkillMd(content) {
  const text = String(content || '').trim();
  if (!text.startsWith('---')) {
    return { meta: {}, body: text };
  }

  const endIdx = text.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { meta: {}, body: text };
  }

  const frontmatter = text.slice(3, endIdx).trim();
  const body = text.slice(endIdx + 4).trim();

  const meta = {};
  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let val = line.slice(colonIdx + 1).trim();

    // Parse array if bracketed: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      meta[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }

  return { meta, body };
}

/**
 * Creates a Just-In-Time skill loader instance.
 */
function createSkillLoader({
  skillsDir = DEFAULT_SKILLS_DIR,
  maxSkills = 2,
  maxChars = 2500,
  perSkillChars = 1000
} = {}) {
  let cachedSkills = null;

  function loadAllSkills() {
    if (cachedSkills) return cachedSkills;

    const skills = [];
    if (!fs.existsSync(skillsDir)) {
      cachedSkills = skills;
      return skills;
    }

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const skillPath = path.join(skillsDir, ent.name, 'SKILL.md');
      if (fs.existsSync(skillPath)) {
        try {
          const raw = fs.readFileSync(skillPath, 'utf8');
          const { meta, body } = parseSkillMd(raw);
          skills.push({
            id: meta.name || ent.name,
            name: meta.name || ent.name,
            description: meta.description || '',
            triggers: Array.isArray(meta.triggers) ? meta.triggers : [],
            filePatterns: Array.isArray(meta.file_patterns) ? meta.file_patterns : [],
            body,
            dirPath: path.join(skillsDir, ent.name)
          });
        } catch (_) {
          // Skip corrupted skill files
        }
      }
    }

    cachedSkills = skills;
    return skills;
  }

  function clearCache() {
    cachedSkills = null;
  }

  /**
   * Matches available skills against a task description and touched file paths.
   */
  function matchSkills(taskText, files = [], options = {}) {
    const limit = options.maxSkills || maxSkills;
    const skills = loadAllSkills();
    const taskLower = String(taskText || '').toLowerCase();
    const fileList = Array.isArray(files) ? files : [];

    const scored = [];

    for (const skill of skills) {
      let score = 0;
      const matchedTriggers = [];
      const matchedFiles = [];

      // 1. Check triggers in task text
      for (const trigger of skill.triggers) {
        const trigLower = trigger.toLowerCase();
        // Regex word boundary match
        const regex = new RegExp(`\\b${trigLower}\\b`, 'i');
        if (regex.test(taskLower)) {
          score += 10;
          matchedTriggers.push(trigger);
        }
      }

      // 2. Check skill name and description token overlap
      const nameRegex = new RegExp(`\\b${skill.name.toLowerCase()}\\b`, 'i');
      if (nameRegex.test(taskLower)) {
        score += 15;
      }

      // 3. Check file pattern matches
      for (const pattern of skill.filePatterns) {
        const cleanPat = pattern.toLowerCase().replace(/\*/g, '.*');
        const patRegex = new RegExp(`^${cleanPat}$`, 'i');
        for (const file of fileList) {
          const base = path.basename(file).toLowerCase();
          if (patRegex.test(base) || patRegex.test(file.toLowerCase())) {
            score += 12;
            matchedFiles.push(file);
          }
        }
      }

      if (score > 0) {
        scored.push({
          skill,
          score,
          matchedTriggers,
          matchedFiles
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Formats matched skills into an injection block bounded by character quota.
   */
  function formatSkillPrompt(matchedResults, options = {}) {
    if (!Array.isArray(matchedResults) || !matchedResults.length) {
      return '';
    }

    const totalBudget = options.maxChars || maxChars;
    const skillBudget = options.perSkillChars || perSkillChars;

    let output = '\n\n---\nJust-In-Time Operational Skills (Auto-Discovered):\n';
    let currentLength = output.length;

    for (const item of matchedResults) {
      const s = item.skill;
      let bodyText = s.body.trim();
      if (bodyText.length > skillBudget) {
        bodyText = `${bodyText.slice(0, skillBudget - 1)}…\n[...skill guidance trimmed to preserve context budget]`;
      }

      const section = `\n### Skill: ${s.name}\n${bodyText}\n`;
      if (currentLength + section.length > totalBudget) {
        break;
      }

      output += section;
      currentLength += section.length;
    }

    return currentLength > output.length ? output : output;
  }

  return {
    loadAllSkills,
    matchSkills,
    formatSkillPrompt,
    clearCache,
    parseSkillMd
  };
}

module.exports = {
  createSkillLoader,
  parseSkillMd,
  DEFAULT_SKILLS_DIR
};
