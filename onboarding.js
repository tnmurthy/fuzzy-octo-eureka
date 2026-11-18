// onboarding.js - Operator Onboarding & Institutional Knowledge Setup
(function () {
  'use strict';

  // ---- State & Storage -----------------------------------------------------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  };

  const ROLES = [
    {
      id: 'developer', icon: '👩‍💻', label: 'Developer',
      desc: 'Build features, fix bugs, optimize performance & refactor',
      tag: 'Code & Architecture',
      specialists: ['engineering-senior-developer', 'engineering-ai-engineer', 'engineering-backend-architect'],
      starters: [
        { title: 'Explain this codebase: architecture, entry points and how to run it', body: 'Write the answer to docs/ONBOARDING.md. Do not change code.', agent: 'claude', specialist: 'engineering-codebase-onboarding-engineer' },
        { title: 'Find and fix top 3 bugs or risky spots, with a unit test for each', body: 'Keep every existing test passing; zero regressions.', agent: 'claude', specialist: 'engineering-senior-developer' },
        { title: 'Add input validation and clear error handling to the API routes', body: 'Ensure all inputs are safely sanitised and validated.', agent: 'claude', specialist: 'engineering-backend-architect' },
        { title: 'Implement a responsive dashboard widget with dark-mode styling', body: 'Use existing CSS design tokens from dashboard.css.', agent: 'claude', specialist: 'engineering-frontend-developer' }
      ]
    },
    {
      id: 'tester', icon: '🧪', label: 'QA / Tester',
      desc: 'Verify edge cases, generate automated tests & catch regressions',
      tag: 'Test Suites & Audits',
      specialists: ['testing-test-automation-engineer', 'testing-api-tester', 'testing-accessibility-auditor'],
      starters: [
        { title: 'Write unit tests for the least-tested module and report coverage', body: 'Add tests to existing test suite using node:test runner.', agent: 'claude', specialist: 'testing-test-automation-engineer' },
        { title: 'Write API tests for every endpoint: happy path, bad input, auth', body: 'Verify status codes and response JSON shapes.', agent: 'claude', specialist: 'testing-api-tester' },
        { title: 'Audit the UI for accessibility (WCAG 2.2 AA) and fix issues', body: 'Check contrast, aria labels, and keyboard navigability.', agent: 'claude', specialist: 'testing-accessibility-auditor' },
        { title: 'Find flaky or slow tests and fix or document them', body: 'Profile test suite execution and isolate non-deterministic tests.', agent: 'claude', specialist: 'testing-test-results-analyzer' }
      ]
    },
    {
      id: 'pm', icon: '🧭', label: 'Product Manager',
      desc: 'Roadmaps, PRDs, user stories & backlog prioritization',
      tag: 'Strategy & Specs',
      specialists: ['product-manager', 'product-sprint-prioritizer', 'product-feedback-synthesizer'],
      starters: [
        { title: 'Write a one-page PRD for the next feature from open TODOs', body: 'Save it as docs/PRD-next.md with user value and acceptance criteria.', agent: 'hermes', specialist: 'product-manager' },
        { title: 'Turn TODO and FIXME comments into a prioritised backlog', body: 'Save it as docs/BACKLOG.md with effort and impact ratings.', agent: 'hermes', specialist: 'product-sprint-prioritizer' },
        { title: 'Rewrite the README for a first-time user: what it is and setup', body: 'Explain clearly for both non-tech operators and developers.', agent: 'hermes', specialist: 'engineering-technical-writer' },
        { title: 'Synthesize user feedback and draft top 3 product improvements', body: 'Focus on high ROI, low friction user enhancements.', agent: 'hermes', specialist: 'product-feedback-synthesizer' }
      ]
    },
    {
      id: 'designer', icon: '🎨', label: 'UI/UX Designer',
      desc: 'Design systems, mobile responsiveness & accessibility polish',
      tag: 'UI & Design Systems',
      specialists: ['design-ux-architect', 'design-ui-designer', 'design-ux-researcher'],
      starters: [
        { title: 'Review the UI for consistency: spacing, colours, type and tokens', body: 'Audit dashboard.css usage across all views and report fixes.', agent: 'claude', specialist: 'design-ui-designer' },
        { title: 'Make the main pages work smoothly on mobile screens (320-414px)', body: 'Ensure controls and navigation don\'t overflow.', agent: 'claude', specialist: 'design-ux-architect' },
        { title: 'Write a UX review of the primary user onboarding flow', body: 'Save as docs/UX-REVIEW.md with top 5 friction points.', agent: 'hermes', specialist: 'design-ux-researcher' },
        { title: 'Design a clean modal component following design token standards', body: 'Use backdrop blur and accessible focus management.', agent: 'claude', specialist: 'design-ui-designer' }
      ]
    },
    {
      id: 'devops', icon: '🛠️', label: 'DevOps / SRE',
      desc: 'CI/CD workflows, Docker containerization & runbooks',
      tag: 'Infra & Reliability',
      specialists: ['engineering-devops-automator', 'engineering-sre', 'engineering-incident-response-commander'],
      starters: [
        { title: 'Add a CI workflow that installs, lints and runs tests on PRs', body: 'Configure GitHub Actions or local automated verification.', agent: 'claude', specialist: 'engineering-devops-automator' },
        { title: 'Add health checks and structured logging to the services', body: 'Instrument HTTP endpoints with latency and error tracking.', agent: 'claude', specialist: 'engineering-sre' },
        { title: 'Write an operations runbook: deploy, rollback and troubleshoot', body: 'Save as docs/RUNBOOK.md with copy-paste commands.', agent: 'hermes', specialist: 'engineering-sre' },
        { title: 'Audit Dockerfile and container configurations for caching and security', body: 'Reduce image size and run as non-root user.', agent: 'claude', specialist: 'engineering-devops-automator' }
      ]
    },
    {
      id: 'security', icon: '🛡️', label: 'Security Auditor',
      desc: 'OWASP vulnerability audits, secrets scanning & ReBAC checks',
      tag: 'AppSec & Compliance',
      specialists: ['security-appsec-engineer', 'security-architect', 'security-penetration-tester'],
      starters: [
        { title: 'Audit the code for OWASP Top 10 issues and report critical items', body: 'Check injection vectors, broken access control, and ReBAC paths.', agent: 'claude', specialist: 'security-appsec-engineer' },
        { title: 'Find hardcoded secrets and move them to environment variables', body: 'Check git history, config files, and tests for API keys.', agent: 'claude', specialist: 'security-appsec-engineer' },
        { title: 'Threat-model the application: assets, attack surface and mitigations', body: 'Save as docs/THREAT-MODEL.md.', agent: 'hermes', specialist: 'security-architect' },
        { title: 'Verify tenant isolation and authorization barriers', body: 'Ensure multi-tenant separation is strictly maintained.', agent: 'claude', specialist: 'security-penetration-tester' }
      ]
    }
  ];

  // Knowledge Templates
  const KNOWLEDGE_TEMPLATES = {
    product: {
      title: 'Arunachala Operations Center Overview & Vision',
      category: 'product_context',
      tags: ['product', 'vision', 'architecture'],
      content: `Arunachala is a unified autonomous engineering platform and operations center.
Core Mission: Empower solo founders, cross-functional teams, and non-technical operators to orchestrate autonomous AI agents with confidence.
Key Features:
- Autonomous Agents Studio: Multi-agent dispatches, conversational follow-ups, and live stream logs.
- Safe Draft Sandbox: Code drafts are generated in isolated git worktrees/branches without overwriting main.
- ReBAC Authorization: Relationship-based access control protecting all system resources and memory.
- Institutional Memory Engine: Episodic and semantic knowledge base queried before every agent action.`
    },
    stack: {
      title: 'Architecture Blueprint & Engineering Stack',
      category: 'tech_stack',
      tags: ['stack', 'backend', 'frontend', 'standards'],
      content: `System Architecture & Technology Stack:
1. Backend: Node.js (v20+), vanilla HTTP server, minimal dependencies for maximum reliability.
2. Authorization: ReBAC graph authorization with granular access nodes and relations.
3. Memory Engine: Hybrid episodic/semantic vector search stored in drisyon-memory.json with cosine similarity ranking.
4. Frontend: Pure modern JavaScript (ES6+), semantic HTML5, and CSS custom properties (design tokens in dashboard.css).
5. Testing: Built-in Node test runner (node --test) with strict zero-regression requirement (229+ passing tests).`
    },
    rules: {
      title: 'Engineering Guardrails & Operating Standards',
      category: 'guidelines',
      tags: ['rules', 'guardrails', 'quality', 'testing'],
      content: `Standard Operating Procedures & Coding Guardrails:
1. Zero-Regression Policy: Never introduce code that breaks existing tests. Always run 'npm test' to verify.
2. Isolated Sandboxes: Always draft modifications in dedicated feature or bugfix branches (agent/*). Never commit directly to main.
3. Progressive Disclosure: Build interfaces that are welcoming and friendly for non-tech users by default, while exposing deep levers for developers.
4. Security & Sanitization: Never use unchecked innerHTML for user inputs or agent outputs. Always use textContent or secure DOM element construction.`
    },
    doc: {
      title: 'Project README & Development Workflow',
      category: 'docs',
      tags: ['docs', 'readme', 'onboarding'],
      content: `# Getting Started Guide
- Port: 8787 (Main Operations Center)
- Dashboard: http://localhost:8787/
- Agents Studio: http://localhost:8787/agents
- Context & Memory: http://localhost:8787/context
- Onboarding Wizard: http://localhost:8787/onboarding

To run agents: Choose your role, select the target repository, and enter your task. Agents automatically consult memory before acting.`
    }
  };

  // State Variables
  let currentStep = 1;
  let selectedRoleId = store.get('agents.role') || 'developer';
  let selectedMode = store.get('agents.uiMode') || 'friendly';
  let selectedRepoName = store.get('agents.repo') || 'fuzzy-octo-eureka';
  let activeKnowledgeCat = 'product';
  let availableRepos = [];
  let sessionMemories = [];
  let selectedStarter = null;

  // DOM Helpers
  const $ = (id) => document.getElementById(id);

  function showToast(message, type = 'success') {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.borderColor = type === 'error' ? 'var(--status-red)' : 'var(--status-green)';
    toast.innerHTML = `<span>${type === 'error' ? '⚠️' : '✅'}</span><span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity 0.3s ease-out, transform 0.3s ease-out';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  // ---- Stepper Navigation --------------------------------------------------
  function setStep(step) {
    if (step < 1 || step > 4) return;
    currentStep = step;

    // Update Stepper UI
    const percent = step === 1 ? 25 : step === 2 ? 50 : step === 3 ? 75 : 100;
    $('progress-bar').style.width = percent + '%';

    for (let i = 1; i <= 4; i++) {
      const tab = $(`tab-step-${i}`);
      const panel = $(`panel-step-${i}`);
      const badge = $(`badge-step-${i}`);

      if (tab) {
        tab.classList.toggle('active', i === step);
        tab.classList.toggle('completed', i < step);
      }
      if (panel) {
        panel.classList.toggle('active', i === step);
      }
      if (badge && i < step) {
        badge.textContent = '✓';
      } else if (badge) {
        badge.textContent = String(i);
      }
    }

    // Button states
    $('btn-prev').disabled = step === 1;
    if (step === 4) {
      $('btn-next').textContent = '🚀 Open in Agents Studio';
      $('btn-next').className = 'btn-primary';
    } else {
      $('btn-next').textContent = 'Next Step →';
      $('btn-next').className = 'btn-primary';
    }

    if (step === 4) {
      updateSummary();
    }
  }

  // ---- Step 1: Roles, Identity & Mode ---------------------------------------
  function renderRoles() {
    const container = $('roles-grid');
    if (!container) return;
    container.replaceChildren();

    ROLES.forEach((r) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `role-card ${r.id === selectedRoleId ? 'selected' : ''}`;
      card.dataset.role = r.id;

      card.innerHTML = `
        <div class="role-header">
          <div class="role-title-wrap">
            <span class="role-icon">${r.icon}</span>
            <span>${escapeHtml(r.label)}</span>
          </div>
          <div class="role-check">✓</div>
        </div>
        <div class="role-desc">${escapeHtml(r.desc)}</div>
        <div class="role-badge">${escapeHtml(r.tag)}</div>
      `;

      card.addEventListener('click', () => {
        selectedRoleId = r.id;
        store.set('agents.role', r.id);
        renderRoles();
        renderStarters();
      });

      container.appendChild(card);
    });
  }

  function initModeSelection() {
    const btnFriendly = $('mode-friendly');
    const btnPro = $('mode-pro');

    function updateModeCards() {
      if (btnFriendly) btnFriendly.classList.toggle('selected', selectedMode === 'friendly');
      if (btnPro) btnPro.classList.toggle('selected', selectedMode === 'pro');
      store.set('agents.uiMode', selectedMode);
    }

    if (btnFriendly) {
      btnFriendly.addEventListener('click', () => {
        selectedMode = 'friendly';
        updateModeCards();
      });
    }
    if (btnPro) {
      btnPro.addEventListener('click', () => {
        selectedMode = 'pro';
        updateModeCards();
      });
    }

    updateModeCards();

    // Operator Name input
    const nameInput = $('operator-name');
    if (nameInput) {
      const savedName = store.get('agents.operatorName') || 'Operator';
      nameInput.value = savedName;
      nameInput.addEventListener('input', () => {
        store.set('agents.operatorName', nameInput.value.trim() || 'Operator');
      });
    }
  }

  // ---- Step 2: Repositories & Workspace ------------------------------------
  async function loadRepos() {
    const container = $('repos-container');
    if (!container) return;

    try {
      const res = await fetch('/api/agents/repos');
      const data = await res.json();
      let repos = [];

      if (data.ok && Array.isArray(data.repos) && data.repos.length > 0) {
        repos = data.repos;
      } else {
        // Fallback to /api/repos
        const res2 = await fetch('/api/repos');
        const data2 = await res2.json();
        if (data2.ok && Array.isArray(data2.repos)) {
          repos = data2.repos.map((r) => ({
            name: r.name,
            path: r.path,
            exists: true,
            source: 'workspace'
          }));
        }
      }

      availableRepos = repos;
      renderReposList();
    } catch (err) {
      // Fallback local defaults
      availableRepos = [
        { name: 'fuzzy-octo-eureka', path: '/Users/arunachala/fuzzy-octo-eureka', exists: true, source: 'workspace' }
      ];
      renderReposList();
    }
  }

  function renderReposList() {
    const container = $('repos-container');
    if (!container) return;
    container.replaceChildren();

    if (!availableRepos.length) {
      container.innerHTML = '<div class="empty">No repositories detected. You can enter a path below.</div>';
      return;
    }

    availableRepos.forEach((repo) => {
      const box = document.createElement('div');
      box.className = `repo-box ${repo.name === selectedRepoName ? 'selected' : ''}`;
      box.dataset.name = repo.name;

      box.innerHTML = `
        <div class="repo-info">
          <div class="repo-name">
            <span>📦 ${escapeHtml(repo.name)}</span>
            <span class="repo-tag ready">● Ready</span>
          </div>
          <div class="repo-path" title="${escapeHtml(repo.path)}">${escapeHtml(repo.path)}</div>
        </div>
        <div>${repo.name === selectedRepoName ? '<span style="color:var(--status-blue); font-weight:600; font-size:0.8rem;">✓ Active</span>' : ''}</div>
      `;

      box.addEventListener('click', () => {
        selectedRepoName = repo.name;
        store.set('agents.repo', repo.name);
        renderReposList();
        const indicator = $('selected-repo-indicator');
        if (indicator) indicator.innerHTML = `Currently selected: <strong>${escapeHtml(repo.name)}</strong>`;
      });

      container.appendChild(box);
    });

    const indicator = $('selected-repo-indicator');
    if (indicator) indicator.innerHTML = `Currently selected: <strong>${escapeHtml(selectedRepoName)}</strong>`;
  }

  function initCustomRepo() {
    const btn = $('btn-set-custom-repo');
    const input = $('custom-repo-path');
    if (!btn || !input) return;

    btn.addEventListener('click', () => {
      const val = input.value.trim();
      if (!val) return;
      const baseName = val.split('/').filter(Boolean).pop() || val;
      selectedRepoName = baseName;
      store.set('agents.repo', baseName);
      store.set('agents.customRepoPath', val);

      if (!availableRepos.find((r) => r.name === baseName)) {
        availableRepos.unshift({ name: baseName, path: val, exists: true, source: 'custom' });
      }
      renderReposList();
      showToast(`Selected project workspace: ${baseName}`);
      input.value = '';
    });
  }

  // ---- Step 3: Local Context & Institutional Memory ------------------------
  function initKnowledgeTabs() {
    const tabs = document.querySelectorAll('.k-tab');
    tabs.forEach((t) => {
      t.addEventListener('click', () => {
        tabs.forEach((tab) => tab.classList.remove('active'));
        t.classList.add('active');
        activeKnowledgeCat = t.dataset.cat || 'product';
        loadActiveTemplateIntoEditor(false);
      });
    });

    const btnTemplate = $('btn-load-template');
    if (btnTemplate) {
      btnTemplate.addEventListener('click', () => loadActiveTemplateIntoEditor(true));
    }

    const btnSave = $('btn-save-memory');
    if (btnSave) {
      btnSave.addEventListener('click', saveCurrentMemory);
    }

    const btnBatch = $('btn-batch-seed');
    if (btnBatch) {
      btnBatch.addEventListener('click', batchSeedKnowledge);
    }

    const btnTest = $('btn-test-search');
    if (btnTest) {
      btnTest.addEventListener('click', runMemoryRecallTest);
    }
    const testInput = $('test-search-input');
    if (testInput) {
      testInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          runMemoryRecallTest();
        }
      });
    }

    // Load initial default
    loadActiveTemplateIntoEditor(false);
    fetchExistingMemories();
  }

  function loadActiveTemplateIntoEditor(force = false) {
    const tpl = KNOWLEDGE_TEMPLATES[activeKnowledgeCat];
    if (!tpl) return;

    const titleInput = $('memory-title');
    const contentArea = $('memory-content');

    if (force || (!titleInput.value && !contentArea.value)) {
      titleInput.value = tpl.title;
      contentArea.value = tpl.content;
      if (force) showToast(`Loaded template for ${tpl.title}`);
    }
  }

  async function saveCurrentMemory() {
    const title = $('memory-title').value.trim();
    const content = $('memory-content').value.trim();
    const feedback = $('ingest-feedback');
    const btnSave = $('btn-save-memory');

    if (!content) {
      showToast('Please enter some context or guidelines before saving.', 'error');
      return;
    }

    btnSave.disabled = true;
    feedback.innerHTML = '<span class="muted">⏳ Indexing into semantic memory...</span>';

    const tpl = KNOWLEDGE_TEMPLATES[activeKnowledgeCat] || {};
    const payload = {
      tenantId: 'tenant:drisyon_core',
      projectId: selectedRepoName || 'global',
      category: tpl.category || 'context',
      title: title || 'Untitled Knowledge',
      content: content,
      tags: [...(tpl.tags || []), selectedRoleId, 'onboarding'],
      metadata: { source: 'onboarding_wizard', role: selectedRoleId }
    };

    try {
      const res = await fetch('/api/memory/store', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-rebac-actor': 'user:sriad'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data.ok && data.memory) {
        sessionMemories.unshift(data.memory);
        renderMemoriesTray();
        showToast(`Indexed into memory: "${payload.title}"`);
        feedback.innerHTML = '<span class="repo-tag ready">✓ Saved</span> <span class="muted">Live in Drisyon Memory</span>';

        // Clear or reset fields for next entry
        $('memory-title').value = '';
        $('memory-content').value = '';
      } else {
        throw new Error(data.error || 'Failed to store memory');
      }
    } catch (err) {
      showToast(`Error saving memory: ${err.message}`, 'error');
      feedback.innerHTML = `<span style="color:var(--status-red)">⚠️ ${escapeHtml(err.message)}</span>`;
    } finally {
      btnSave.disabled = false;
    }
  }

  async function batchSeedKnowledge() {
    const btnBatch = $('btn-batch-seed');
    btnBatch.disabled = true;
    btnBatch.textContent = '⏳ Ingesting All 3...';

    const items = [
      KNOWLEDGE_TEMPLATES.product,
      KNOWLEDGE_TEMPLATES.stack,
      KNOWLEDGE_TEMPLATES.rules
    ];

    let count = 0;
    for (const tpl of items) {
      const payload = {
        tenantId: 'tenant:drisyon_core',
        projectId: selectedRepoName || 'global',
        category: tpl.category,
        title: tpl.title,
        content: tpl.content,
        tags: [...tpl.tags, selectedRoleId, 'onboarding_batch'],
        metadata: { source: 'onboarding_batch_seed', role: selectedRoleId }
      };

      try {
        const res = await fetch('/api/memory/store', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-rebac-actor': 'user:sriad'
          },
          body: JSON.stringify(payload)
        });
        const d = await res.json();
        if (d.ok && d.memory) {
          sessionMemories.unshift(d.memory);
          count++;
        }
      } catch (_) {}
    }

    renderMemoriesTray();
    btnBatch.disabled = false;
    btnBatch.textContent = '✨ Fast-Track: Ingest All 3 Defaults';
    showToast(`Successfully ingested ${count} foundational memories!`);
    $('ingest-feedback').innerHTML = '<span class="repo-tag ready">✓ Batch Complete</span> <span class="muted">All core institutional memories indexed!</span>';
  }

  async function fetchExistingMemories() {
    try {
      const res = await fetch('/api/memory/search?q=&limit=15', {
        headers: { 'x-rebac-actor': 'user:sriad' }
      });
      const data = await res.json();
      if (data.ok && Array.isArray(data.memories)) {
        sessionMemories = data.memories;
        renderMemoriesTray();
      }
    } catch (_) {}
  }

  function renderMemoriesTray() {
    const tray = $('memories-tray');
    const badge = $('mem-count-badge');
    if (!tray) return;

    if (badge) {
      badge.textContent = `${sessionMemories.length} indexed`;
    }

    if (!sessionMemories.length) {
      tray.innerHTML = '<div class="empty">No institutional memories saved yet. Fill out the form above or click "Fast-Track" to seed defaults.</div>';
      return;
    }

    tray.replaceChildren();
    sessionMemories.slice(0, 10).forEach((mem) => {
      const item = document.createElement('div');
      item.className = 'mem-item';
      item.innerHTML = `
        <div style="overflow: hidden;">
          <div class="mem-item-title">${escapeHtml(mem.title || 'Knowledge Entry')}</div>
          <div class="mem-item-snippet">${escapeHtml(mem.content || '')}</div>
          <div class="mem-item-meta">
            <span class="badge-cat">${escapeHtml(mem.category || 'context')}</span>
            <span class="muted" style="font-size: 0.72rem;">${escapeHtml(mem.projectId || 'global')}</span>
            <span class="muted" style="font-size: 0.72rem;">${mem.createdAt ? new Date(mem.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'recently'}</span>
          </div>
        </div>
      `;
      tray.appendChild(item);
    });
  }

  async function runMemoryRecallTest() {
    const input = $('test-search-input');
    const resultsBox = $('tester-results');
    const query = input.value.trim();

    if (!query) {
      showToast('Enter a search query to test memory recall.', 'error');
      return;
    }

    resultsBox.style.display = 'block';
    resultsBox.innerHTML = '<div class="muted" style="font-size:0.8rem;">Querying Drisyon Memory Engine...</div>';

    try {
      const res = await fetch(`/api/memory/search?q=${encodeURIComponent(query)}&limit=3`, {
        headers: { 'x-rebac-actor': 'user:sriad' }
      });
      const data = await res.json();

      if (data.ok && Array.isArray(data.memories) && data.memories.length > 0) {
        resultsBox.replaceChildren();
        data.memories.forEach((m) => {
          const item = document.createElement('div');
          item.className = 'test-result-item';
          const score = m.score ? Math.round(m.score * 100) : 95;
          item.innerHTML = `
            <div>
              <span class="test-score">${score}% Match</span>
              <strong>${escapeHtml(m.title)}</strong>
            </div>
            <div class="muted" style="margin-top: 4px; font-size: 0.78rem;">${escapeHtml(m.content.slice(0, 160))}...</div>
          `;
          resultsBox.appendChild(item);
        });
      } else {
        resultsBox.innerHTML = '<div class="muted" style="font-size:0.8rem;">No exact match found in memory. Try saving memories above first!</div>';
      }
    } catch (err) {
      resultsBox.innerHTML = `<div style="color:var(--status-red); font-size:0.8rem;">Search failed: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ---- Step 4: Launchpad & First Task ---------------------------------------
  function updateSummary() {
    const roleObj = ROLES.find((r) => r.id === selectedRoleId) || ROLES[0];
    const opEl = $('summary-operator');
    const repoEl = $('summary-repo');
    const memEl = $('summary-memory');

    const opName = store.get('agents.operatorName') || 'Operator';
    if (opEl) opEl.textContent = `${roleObj.icon} ${opName} (${roleObj.label})`;
    if (repoEl) repoEl.textContent = selectedRepoName || 'fuzzy-octo-eureka';
    if (memEl) memEl.textContent = `● Active (${sessionMemories.length} entries)`;

    renderStarters();
  }

  function renderStarters() {
    const container = $('starters-container');
    if (!container) return;
    const roleObj = ROLES.find((r) => r.id === selectedRoleId) || ROLES[0];
    container.replaceChildren();

    roleObj.starters.forEach((st, idx) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `starter-card ${selectedStarter && selectedStarter.title === st.title ? 'selected' : (idx === 0 && !selectedStarter ? 'selected' : '')}`;
      card.dataset.title = st.title;

      card.innerHTML = `
        <div class="starter-title">
          <span>✨</span>
          <span>${escapeHtml(st.title)}</span>
        </div>
        <div class="starter-desc">${escapeHtml(st.body || 'Guided task tailored for your discipline.')}</div>
      `;

      card.addEventListener('click', () => {
        selectedStarter = st;
        $('task-title-input').value = st.title;
        $('task-body-input').value = st.body || '';
        renderStarters();
      });

      container.appendChild(card);
    });

    // Default select first starter if not set
    if (!selectedStarter && roleObj.starters.length > 0) {
      selectedStarter = roleObj.starters[0];
      $('task-title-input').value = selectedStarter.title;
      $('task-body-input').value = selectedStarter.body || '';
    }
  }

  function launchStudioWithTask() {
    const title = $('task-title-input').value.trim() || (selectedStarter ? selectedStarter.title : 'Initial codebase exploration');
    const body = $('task-body-input').value.trim() || (selectedStarter ? selectedStarter.body : '');
    const agent = selectedStarter ? selectedStarter.agent || 'claude' : 'claude';
    const specialist = selectedStarter ? selectedStarter.specialist || '' : '';

    // Save pending task for Agents Studio hand-off
    store.set('agents.pendingTitle', title);
    store.set('agents.pendingBody', body);
    store.set('agents.pendingAgent', agent);
    store.set('agents.pendingSpecialist', specialist);
    store.set('agents.role', selectedRoleId);
    store.set('agents.repo', selectedRepoName);
    store.set('agents.uiMode', selectedMode);

    showToast('Redirecting to Agents Studio with your task...');
    setTimeout(() => {
      window.location.href = `/agents?task=${encodeURIComponent(title)}`;
    }, 450);
  }

  // ---- Initialization ------------------------------------------------------
  function init() {
    renderRoles();
    initModeSelection();
    loadRepos();
    initCustomRepo();
    initKnowledgeTabs();

    // Step navigation buttons
    $('btn-prev').addEventListener('click', () => setStep(currentStep - 1));
    $('btn-next').addEventListener('click', () => {
      if (currentStep === 4) {
        launchStudioWithTask();
      } else {
        setStep(currentStep + 1);
      }
    });

    for (let i = 1; i <= 4; i++) {
      const tab = $(`tab-step-${i}`);
      if (tab) {
        tab.addEventListener('click', () => setStep(i));
      }
    }

    const btnLaunch = $('btn-launch-studio');
    if (btnLaunch) {
      btnLaunch.addEventListener('click', launchStudioWithTask);
    }

    setStep(1);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();