// agents-workspace.js - the top of the Agents page: your role, your repos
// (add a local folder or clone from git), starter tasks for the role, and
// submitting a task either as "Run now" (any repo, own branch + worktree) or
// as a GitHub issue (repos the issue poller watches: PR + agent review).
// Text from repos, GitHub and agents goes in via textContent only.
(function () {
  'use strict';

  const { el, $, refresh, openLog, setSpecialist, setRole } = window.AgentsPage;

  // ---- roles ---------------------------------------------------------------
  // Each role brings its specialists and starter tasks: something to do even
  // before you have written a task.
  const ROLES = [
    {
      id: 'developer', icon: '👩‍💻', label: 'Developer',
      desc: 'Build features, fix bugs & refactor',
      specialists: ['engineering-senior-developer', 'engineering-ai-engineer', 'engineering-backend-architect', 'engineering-frontend-developer', 'engineering-code-reviewer'],
      starters: [
        { title: 'Explain this codebase: architecture, entry points and how to run it', body: 'Write the answer to docs/ONBOARDING.md. Do not change code.', specialist: 'engineering-codebase-onboarding-engineer', agent: 'claude' },
        { title: 'Find and fix the top 3 bugs or risky spots, with a test for each', specialist: 'engineering-senior-developer', agent: 'claude' },
        { title: 'Add input validation and clear error handling to the API routes', specialist: 'engineering-backend-architect', agent: 'claude' },
        { title: 'Split the largest file into smaller modules without changing behaviour', body: 'Keep every existing test passing; no new features.', specialist: 'engineering-minimal-change-engineer', agent: 'claude' },
      ],
    },
    {
      id: 'tester', icon: '🧪', label: 'QA / Tester',
      desc: 'Verify edge cases & write tests',
      specialists: ['testing-test-automation-engineer', 'testing-api-tester', 'testing-accessibility-auditor', 'testing-performance-benchmarker', 'testing-reality-checker'],
      starters: [
        { title: 'Write unit tests for the least-tested module and report the coverage change', specialist: 'testing-test-automation-engineer', agent: 'claude' },
        { title: 'Write API tests for every endpoint: happy path, bad input, auth', specialist: 'testing-api-tester', agent: 'claude' },
        { title: 'Find flaky or slow tests and fix or document them', specialist: 'testing-test-results-analyzer', agent: 'claude' },
        { title: 'Audit the UI for accessibility (WCAG 2.2 AA) and fix what is quick', specialist: 'testing-accessibility-auditor', agent: 'claude' },
      ],
    },
    {
      id: 'pm', icon: '🧭', label: 'Product Manager',
      desc: 'Roadmaps, PRDs & backlog prioritization',
      specialists: ['product-manager', 'product-sprint-prioritizer', 'product-feedback-synthesizer', 'engineering-technical-writer'],
      starters: [
        { title: 'Write a one-page PRD for the next feature, from the README and open TODOs', body: 'Save it as docs/PRD-next.md.', specialist: 'product-manager', agent: 'hermes' },
        { title: 'Turn the TODO and FIXME comments into a prioritised backlog', body: 'Save it as docs/BACKLOG.md with effort and impact for each item.', specialist: 'product-sprint-prioritizer', agent: 'hermes' },
        { title: 'Rewrite the README for a first-time user: what it is, setup, first task', specialist: 'engineering-technical-writer', agent: 'hermes' },
      ],
    },
    {
      id: 'designer', icon: '🎨', label: 'UI/UX Designer',
      desc: 'Design reviews, mobile UI & accessibility',
      specialists: ['design-ux-architect', 'design-ui-designer', 'design-ux-researcher', 'testing-accessibility-auditor'],
      starters: [
        { title: 'Review the UI for consistency: spacing, colours, type; list fixes and apply the quick ones', specialist: 'design-ui-designer', agent: 'claude' },
        { title: 'Make the main pages work well on a phone (320-414 px wide)', specialist: 'design-ux-architect', agent: 'claude' },
        { title: 'Write a UX review of the main user flow with the top 5 friction points', body: 'Save it as docs/UX-REVIEW.md. Do not change code.', specialist: 'design-ux-researcher', agent: 'hermes' },
      ],
    },
    {
      id: 'devops', icon: '🛠️', label: 'DevOps / SRE',
      desc: 'CI/CD workflows, health checks & runbooks',
      specialists: ['engineering-devops-automator', 'engineering-sre', 'engineering-incident-response-commander'],
      starters: [
        { title: 'Add a CI workflow that installs, lints and runs the tests on every PR', specialist: 'engineering-devops-automator', agent: 'claude' },
        { title: 'Add health checks and structured logs to the services', specialist: 'engineering-sre', agent: 'claude' },
        { title: 'Write a runbook: how to deploy, roll back and debug this project', body: 'Save it as docs/RUNBOOK.md.', specialist: 'engineering-sre', agent: 'hermes' },
      ],
    },
    {
      id: 'security', icon: '🛡️', label: 'Security Auditor',
      desc: 'OWASP audits & secret vulnerability scans',
      specialists: ['security-appsec-engineer', 'security-architect', 'security-penetration-tester', 'engineering-code-reviewer'],
      starters: [
        { title: 'Audit the code for OWASP Top 10 issues and fix the critical ones', specialist: 'security-appsec-engineer', agent: 'claude' },
        { title: 'Find hardcoded secrets and move them to environment variables', specialist: 'security-appsec-engineer', agent: 'claude' },
        { title: 'Threat-model the app: assets, entry points, top risks and mitigations', body: 'Save it as docs/THREAT-MODEL.md. Do not change code.', specialist: 'security-architect', agent: 'hermes' },
      ],
    },
  ];

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  };
  let role = ROLES.find((r) => r.id === store.get('agents.role')) || ROLES[0];

  function renderRoles() {
    const container = $('roles');
    if (!container) return;
    container.replaceChildren(...ROLES.map((r) => {
      const top = el('div', { className: 'role-btn-top' }, `${r.icon} ${r.label}`);
      const desc = el('div', { className: 'role-btn-desc' }, r.desc || '');
      const b = el('button', { className: 'role-btn role', type: 'button' }, top, desc);
      b.setAttribute('aria-pressed', String(r.id === role.id));
      b.addEventListener('click', () => {
        role = r;
        store.set('agents.role', r.id);
        renderRoles();
        renderStarters();
        setRole(r);
      });
      return b;
    }));
  }

  function renderStarters() {
    const container = $('starters');
    if (!container) return;
    container.replaceChildren(...role.starters.map((s) => {
      const b = el('button', { className: 'starter', type: 'button', textContent: s.title });
      b.addEventListener('click', () => {
        $('title').value = s.title;
        $('body').value = s.body || '';
        $('agent').value = s.agent || 'claude';
        setSpecialist(s.specialist || '');
        $('title').dispatchEvent(new Event('input')); // refresh suggestions
        $('title').focus();
      });
      return b;
    }));
  }

  // ---- repos ---------------------------------------------------------------
  let repos = [];
  let current = store.get('agents.repo');

  function selected() { return repos.find((r) => r.name === current) || null; }

  function renderRepos() {
    const box = $('repo-list');
    if (!box) return;
    box.replaceChildren();
    for (const r of repos) {
      const tags = [];
      if (!r.exists) {
        tags.push(el('span', { className: 'tag missing' }, 'missing folder'));
      } else {
        tags.push(el('span', { className: 'tag gh' }, '● Ready'));
      }
      if (r.watched) {
        tags.push(el('span', { className: 'tag gh' }, 'GitHub PR review'));
      } else if (r.github) {
        tags.push(el('span', { className: 'tag gh' }, 'GitHub'));
      }
      tags.push(el('span', { className: `tag ${r.source === 'git' ? 'git' : ''}` },
        r.source === 'git' ? 'cloned' : r.source === 'local' ? 'local' : 'workspace'));

      const row = el('div', { className: 'repo', tabIndex: 0, role: 'radio' },
        el('div', { className: 'main' },
          el('div', { className: 'nm' }, r.name, ...tags),
          el('div', { className: 'pth', title: r.path, textContent: r.path })
        )
      );
      row.setAttribute('aria-checked', String(r.name === current));
      const pick = () => {
        if (!r.exists) return;
        current = r.name;
        store.set('agents.repo', r.name);
        renderRepos();
        renderMode();
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });

      if (canAdd && r.source !== 'builtin') {
        const rm = el('button', { className: 'btn-sm danger', type: 'button', textContent: 'Remove', title: 'Unregister (files stay on disk)' });
        rm.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`Remove ${r.name} from the list? Its files stay on disk.`)) return;
          await post('/api/agents/repos/remove', { name: r.name });
          loadRepos();
        });
        row.append(rm);
      }
      box.append(row);
    }
    if (!repos.length) box.append(el('div', { className: 'empty', textContent: 'No projects registered yet.' }));
  }

  // Recommend something when you have only the built-in repos.
  function renderReco(suggestions) {
    const reco = $('repo-reco');
    if (!reco) return;
    const own = repos.filter((r) => r.source !== 'builtin');
    if (own.length) { reco.hidden = true; return; }
    reco.replaceChildren(el('b', { textContent: 'Quick Start: ' }),
      'Select this workspace (already chosen), ',
      canAdd ? 'or add another project' : 'or ask an admin to add your project',
      suggestions.length ? ' (found on this Mac):' : '.');
    if (canAdd && suggestions.length) {
      const chips = el('div', { className: 'suggest' }, ...suggestions.slice(0, 6).map((s) => {
        const c = el('button', { className: 'chip', type: 'button', textContent: `+ ${s.path}` });
        c.addEventListener('click', () => addRepo({ type: 'local', path: s.path }));
        return c;
      }));
      reco.append(chips);
    }
    reco.hidden = false;
  }

  function renderFound(suggestions) {
    const box = $('found');
    if (!box) return;
    box.replaceChildren(el('span', { className: 'muted', textContent: 'Found on this Mac:' }), ...suggestions.slice(0, 10).map((s) => {
      const c = el('button', { className: 'chip', type: 'button', textContent: s.path });
      c.addEventListener('click', () => { $('local-path').value = s.path; });
      return c;
    }));
    box.hidden = !suggestions.length;
  }

  let canAdd = false;
  async function loadRepos() {
    try {
      const b = await (await fetch('/api/agents/repos')).json();
      repos = (b.repos || []).filter((r) => r.exists || r.source !== 'builtin');
      canAdd = Boolean(b.canAdd);
      if (!selected() || !selected().exists) current = (repos.find((r) => r.exists && r.watched) || repos.find((r) => r.exists) || {}).name || null;
      if ($('add-repo')) $('add-repo').hidden = !canAdd;
      renderRepos();
      renderReco(b.suggestions || []);
      renderFound(b.suggestions || []);
      renderMode();
    } catch (_) {
      const rl = $('repo-list');
      if (rl) rl.replaceChildren(el('div', { className: 'empty', textContent: 'Could not load repositories.' }));
    }
  }

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || !b.ok) throw new Error(b.error || `HTTP ${r.status}`);
    return b;
  }

  async function addRepo(payload) {
    const msg = $('repo-msg');
    $('add-repo').open = true;
    msg.className = 'msg';
    msg.textContent = payload.type === 'git' ? 'Cloning… (large repos can take a minute)' : 'Adding…';
    document.querySelectorAll('#add-repo button[type=submit]').forEach((b) => { b.disabled = true; });
    try {
      const b = await post('/api/agents/repos', payload);
      msg.className = 'msg ok';
      msg.textContent = b.already ? `${b.repo.name} is already in your list; selected it.` : `Added ${b.repo.name} (${b.repo.path}).`;
      current = b.repo.name;
      store.set('agents.repo', current);
      $('local-path').value = '';
      $('git-url').value = '';
      await loadRepos();
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message;
    } finally {
      document.querySelectorAll('#add-repo button[type=submit]').forEach((b) => { b.disabled = false; });
    }
  }

  document.querySelectorAll('#add-repo .tab').forEach((t) => t.addEventListener('click', () => {
    document.querySelectorAll('#add-repo .tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    $('add-local').hidden = t.dataset.tab !== 'local';
    $('add-git').hidden = t.dataset.tab !== 'git';
  }));
  $('add-local').addEventListener('submit', (e) => { e.preventDefault(); addRepo({ type: 'local', path: $('local-path').value }); });
  $('add-git').addEventListener('submit', (e) => { e.preventDefault(); addRepo({ type: 'git', url: $('git-url').value }); });

  // ---- how to run ----------------------------------------------------------
  const modeValue = () => (document.querySelector('input[name=mode]:checked') || {}).value || 'run';

  function renderMode() {
    const r = selected();
    const issueOk = Boolean(r && r.watched);
    const issueInput = document.querySelector('input[name=mode][value=issue]');
    if (issueInput) issueInput.disabled = !issueOk;
    if ($('mode-issue')) $('mode-issue').classList.toggle('disabled', !issueOk);
    if ($('mode-issue-note')) {
      $('mode-issue-note').textContent = issueOk
        ? 'Opens an issue; the agent opens a PR and a reviewer checks it.'
        : r && r.github ? 'Needs this repo in POLLER_REPOS (the issue poller watches it).' : 'Needs a GitHub repo watched by the issue poller.';
    }
    if (!issueOk && issueInput && issueInput.checked) {
      const runRadio = document.querySelector('input[name=mode][value=run]');
      if (runRadio) runRadio.checked = true;
    }
    const run = modeValue() === 'run';
    const isFriendly = document.body.classList.contains('mode-friendly');
    $('submit').textContent = run ? (isFriendly ? '🚀 Start Working on This' : 'Run now') : 'Open issue';
    $('submit-note').textContent = r
      ? `Target: ${r.name} ${run ? '· safe draft sandbox' : '· opens GitHub issue'}`
      : 'pick a project first';
  }
  document.querySelectorAll('input[name=mode]').forEach((i) => i.addEventListener('change', renderMode));

  // Re-render mode text when user switches experience mode
  const btnFriendly = $('btn-mode-friendly');
  const btnPro = $('btn-mode-pro');
  if (btnFriendly) btnFriendly.addEventListener('click', () => setTimeout(renderMode, 50));
  if (btnPro) btnPro.addEventListener('click', () => setTimeout(renderMode, 50));

  // ---- submit --------------------------------------------------------------
  $('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = selected();
    const msg = $('msg');
    if (!r) { msg.className = 'msg err'; msg.textContent = 'Please pick a project first.'; return; }
    const btn = $('submit');
    btn.disabled = true;
    msg.className = 'msg';
    const payload = { agent: $('agent').value, title: $('title').value, body: $('body').value, specialist: $('specialist').value };
    try {
      if (modeValue() === 'issue') {
        msg.textContent = 'Opening GitHub issue…';
        const b = await post('/api/agents/task', { ...payload, repo: r.github });
        msg.className = 'msg ok';
        msg.replaceChildren('Queued as ', el('a', { href: b.url, target: '_blank', rel: 'noopener', textContent: `issue #${b.number}` }), '. Your agent will begin within a minute.');
      } else {
        msg.textContent = 'Starting agent in safe draft sandbox…';
        const b = await post('/api/agents/run', { ...payload, repo: r.name });
        msg.className = 'msg ok';
        const watch = el('button', { className: 'btn-sm', style: 'margin-left:8px;', type: 'button', textContent: '👁️ Watch Live Progress' });
        watch.addEventListener('click', () => openLog(b.runId));
        msg.replaceChildren(`Started work on ${r.name} (draft branch: ${b.branch}). `, watch);
      }
      $('title').value = '';
      $('body').value = '';
      $('suggest').hidden = true;
      refresh();
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  renderRoles();
  renderStarters();
  setRole(role);
  loadRepos();
})();
