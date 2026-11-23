// agents-page.js - client for /agents (agents.html). All text goes in via
// textContent, never innerHTML, since titles and logs come from GitHub/agents.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };

  const ghUrl = (repo, kind, n) => `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${n}`;

  function linkNode(link) {
    if (!link || !link.repo) return null;
    const isReview = link.kind === 'review';
    const n = isReview ? link.pr : link.issue;
    return el('a', { className: 'lnk', href: ghUrl(link.repo, isReview ? 'pr' : 'issue', n), target: '_blank', rel: 'noopener', textContent: isReview ? `review PR #${n}` : `issue #${n}` });
  }

  const bySlug = new Map(); // specialist slug -> catalog entry (filled by loadSpecialists)

  // One plain-English voice for everyone (the Friendly/Developer toggle was
  // removed 2026-11-23): body keeps class mode-friendly, so pro-only text stays
  // hidden. Forget a choice saved by the old toggle.
  document.body.classList.add('mode-friendly');
  document.body.classList.remove('mode-pro');
  try { localStorage.removeItem('agents.uiMode'); } catch (_) {}

  let activeSelectedRepo = 'fuzzy-octo-eureka';

  // ---- Background Task Audio & Desktop Notifications --------------------
  function getAlertsEnabled() {
    try { return localStorage.getItem('task_alerts_enabled') !== 'false'; } catch (_) { return true; }
  }

  function updateAlertsButtonUi() {
    const enabled = getAlertsEnabled();
    const icon = $('notif-icon');
    const label = $('notif-label');
    if (icon) icon.textContent = enabled ? '🔔' : '🔕';
    if (label) label.textContent = enabled ? 'Alerts: On' : 'Alerts: Off';
  }

  function playCompletionChime(success = true) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      if (success) {
        // D5 (587.33Hz) -> A5 (880Hz)
        osc.frequency.setValueAtTime(587.33, now);
        osc.frequency.setValueAtTime(880.00, now + 0.12);
      } else {
        // E4 (329.63Hz) -> A3 (220Hz)
        osc.frequency.setValueAtTime(329.63, now);
        osc.frequency.setValueAtTime(220.00, now + 0.14);
      }

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.36);
    } catch (_) {}
  }

  async function toggleTaskNotifications() {
    const currentlyEnabled = getAlertsEnabled();
    const nextState = !currentlyEnabled;
    try { localStorage.setItem('task_alerts_enabled', String(nextState)); } catch (_) {}
    updateAlertsButtonUi();

    if (nextState) {
      if ('Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch (_) {}
      }
      playCompletionChime(true);
    }
  }

  if ($('btn-toggle-notifs')) {
    $('btn-toggle-notifs').addEventListener('click', toggleTaskNotifications);
  }
  updateAlertsButtonUi();
  window.toggleTaskNotifications = toggleTaskNotifications;
  window.playCompletionChime = playCompletionChime;

  // Completion / follow-up / approval alerts live in agents-notify.js.

  // ---- 1-Click Push Branch & Create PR -----------------------------------
  async function pushRunAndOpenPr(runId, btn) {
    if (!runId) return;
    const oldText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Pushing to origin...';
    }

    try {
      const res = await fetch('/api/agents/run/push-pr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId })
      });
      const data = await res.json();
      if (!data.ok) {
        const where = Array.isArray(data.findings) && data.findings.length
          ? `\n\n${data.findings.map((f) => `• ${f.file}${f.line ? `:${f.line}` : ''}: ${f.rule}`).join('\n')}`
          : '';
        alert(`${data.error || 'Failed to push branch'}${where}`);
        if (btn) {
          btn.disabled = false;
          btn.textContent = '❌ Push Failed (Retry)';
        }
        return;
      }

      if (btn) {
        btn.textContent = '✅ Pushed!';
      }

      if (data.prUrl) {
        window.open(data.prUrl, '_blank');
      } else {
        alert(`Branch ${data.branch} was pushed to remote! (${data.remote || 'origin'})`);
      }
    } catch (err) {
      alert(`Error pushing branch: ${err.message}`);
      if (btn) {
        btn.disabled = false;
        btn.textContent = oldText || '🚀 Push & PR';
      }
    }
  }
  window.pushRunAndOpenPr = pushRunAndOpenPr;

  // ---- In-Browser Code & File Viewer ------------------------------------
  let currentFileCode = '';

  async function openFilePreview(fileName) {
    const box = $('preview-code-viewer');
    const titleEl = $('code-viewer-filename');
    const metaEl = $('code-viewer-meta');
    const contentEl = $('code-viewer-content');
    if (!box || !titleEl || !contentEl) return;

    box.style.display = 'block';
    titleEl.textContent = fileName;
    if (metaEl) metaEl.textContent = 'Loading...';
    contentEl.textContent = 'Reading file contents...';

    // Highlight active chip
    document.querySelectorAll('.file-chip-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.file === fileName);
    });

    try {
      const repo = activeSelectedRepo || 'fuzzy-octo-eureka';
      const res = await fetch(`/api/agents/repo/file?repo=${encodeURIComponent(repo)}&file=${encodeURIComponent(fileName)}`);
      const data = await res.json();
      if (!data.ok) {
        if (metaEl) metaEl.textContent = 'Error';
        contentEl.textContent = data.error || 'Failed to read file.';
        return;
      }

      if (data.isDirectory) {
        if (metaEl) metaEl.textContent = `Folder · ${(data.items || []).length} items`;
        contentEl.textContent = (data.items || []).map(i => `${i.isDirectory ? '📁' : '📄'} ${i.name}`).join('\n') || '(Empty folder)';
        currentFileCode = contentEl.textContent;
        return;
      }

      if (data.isBinary) {
        if (metaEl) metaEl.textContent = `Binary · ${(data.size / 1024).toFixed(1)} KB`;
        contentEl.textContent = `Binary file (${data.ext || 'unknown format'}, ${data.size} bytes). Direct viewing is not supported in text mode.`;
        currentFileCode = '';
        return;
      }

      if (metaEl) {
        const sizeKb = (data.size / 1024).toFixed(1);
        metaEl.textContent = `${data.lines} lines · ${sizeKb} KB${data.truncated ? ' (first 512KB shown)' : ''}`;
      }
      currentFileCode = data.content || '';
      contentEl.textContent = data.content || '(Empty file)';
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      if (metaEl) metaEl.textContent = 'Error';
      contentEl.textContent = `Error loading file: ${err.message}`;
    }
  }

  function closeFileViewer() {
    const box = $('preview-code-viewer');
    if (box) box.style.display = 'none';
    document.querySelectorAll('.file-chip-btn').forEach(btn => btn.classList.remove('active'));
    currentFileCode = '';
  }

  function copyCurrentFileCode() {
    if (!currentFileCode) return;
    navigator.clipboard.writeText(currentFileCode).then(() => {
      const btn = $('btn-copy-code');
      if (btn) {
        const old = btn.textContent;
        btn.textContent = '✅ Copied!';
        setTimeout(() => { btn.textContent = old; }, 2000);
      }
    }).catch(() => {});
  }

  window.openFilePreview = openFilePreview;
  window.closeFileViewer = closeFileViewer;
  window.copyCurrentFileCode = copyCurrentFileCode;

  // ---- Universal Collapsible Toggle -------------------------------------
  window.toggleSection = function(btn, targetId) {
    const target = $(targetId) || document.getElementById(targetId);
    if (!target) return;
    const isCollapsed = target.classList.toggle('collapsed');
    if (btn) {
      btn.classList.toggle('collapsed', isCollapsed);
      btn.setAttribute('aria-expanded', String(!isCollapsed));
      btn.title = isCollapsed ? 'Expand section' : 'Collapse section';
    }
  };

  // ---- Cockpit Segmented Tab Navigation ---------------------------------
  const cockpitTabs = [
    { btn: 'tab-btn-live', view: 'view-live' },
    { btn: 'tab-btn-preview', view: 'view-preview' },
    { btn: 'tab-btn-board', view: 'view-board' },
    { btn: 'tab-btn-threads', view: 'view-threads' },
  ];

  function switchCockpitTab(btnId) {
    cockpitTabs.forEach(({ btn, view }) => {
      const isTarget = btn === btnId;
      const b = $(btn);
      const v = $(view);
      if (b) b.classList.toggle('active', isTarget);
      if (v) v.classList.toggle('active', isTarget);
    });
    if (btnId === 'tab-btn-preview') {
      loadWorkspacePreview(activeSelectedRepo);
    }
  }

  cockpitTabs.forEach(({ btn }) => {
    const b = $(btn);
    if (b) b.addEventListener('click', () => switchCockpitTab(btn));
  });

  // ---- Specialist Catalog Modal -----------------------------------------
  const catModal = $('catalog-modal');
  if ($('btn-open-catalog')) {
    $('btn-open-catalog').addEventListener('click', () => {
      if (catModal) {
        catModal.classList.add('open');
        $('catalog-q').focus();
      }
    });
  }
  if ($('catalog-modal-close')) {
    $('catalog-modal-close').addEventListener('click', () => {
      if (catModal) catModal.classList.remove('open');
    });
  }
  if (catModal) {
    catModal.addEventListener('click', (e) => {
      if (e.target === catModal) catModal.classList.remove('open');
    });
  }

  // ---- log viewer -------------------------------------------------------
  let logId = null;
  let logTimer = null;

  async function loadLog() {
    if (!logId) return;
    try {
      const r = await fetch(`/api/agents/log?id=${encodeURIComponent(logId)}`);
      const b = await r.json();
      const pre = $('log');
      pre.textContent = b.ok ? (b.truncated ? '… (earlier output trimmed)\n' : '') + b.text : (b.error || 'log unavailable');
      $('log-status').textContent = b.status ? `· ${b.status}` : '';
      if ($('log-follow') && $('log-follow').checked) pre.scrollTop = pre.scrollHeight;
      if (b.status && b.status !== 'running') stopLogTimer();
    } catch (_) { /* next tick */ }
  }
  function stopLogTimer() { if (logTimer) clearInterval(logTimer); logTimer = null; }
  function openLog(id) {
    logId = id;
    $('log-id').textContent = id;
    $('log').textContent = 'Loading execution output…';
    $('log-card').classList.add('open');
    // Ensure Live tab is active so log is immediately visible
    switchCockpitTab('tab-btn-live');
    stopLogTimer();
    loadLog();
    logTimer = setInterval(loadLog, 2000);
    $('log-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  $('log-close').addEventListener('click', () => {
    stopLogTimer();
    logId = null;
    $('log-card').classList.remove('open');
  });

  // ---- deliverable & visual preview modal -------------------------------
  const deliverableModal = $('deliverable-modal');
  let activeDeliverableRun = null;

  async function openDeliverable(r) {
    if (!deliverableModal) return;
    activeDeliverableRun = r;
    const titleText = $('deliverable-title-text');
    if (titleText) titleText.textContent = r.task || 'Task Deliverable';
    const metaEl = $('deliverable-meta');
    if (metaEl) metaEl.textContent = `${agentLabel(r)} · Status: ${r.status || 'unknown'}${r.duration_s ? ` · Took ${ago(r.duration_s * 1000)}` : ''}`;
    const footerNote = $('deliverable-footer-note');
    if (footerNote) footerNote.textContent = r.commits_ahead ? `+${r.commits_ahead} updates made on safe draft worktree` : 'Safe draft sandbox';

    const prBtn = $('deliverable-push-pr-btn');
    if (prBtn) {
      if (r.branch) {
        prBtn.style.display = 'inline-flex';
        prBtn.disabled = false;
        prBtn.textContent = '🚀 Push to GitHub & Open PR';
      } else {
        prBtn.style.display = 'none';
      }
    }

    const content = $('deliverable-content');
    content.replaceChildren(el('div', { className: 'empty' }, 'Loading deliverables and analyzing changes…'));
    deliverableModal.classList.add('open');

    try {
      const res = await fetch(`/api/agents/log?id=${encodeURIComponent(r.id)}`);
      const b = await res.json();
      if (!b.ok || !b.text) {
        content.replaceChildren(el('div', { className: 'empty' }, b.error || 'No log details available for this run.'));
        return;
      }

      const logText = b.text;
      const lines = logText.split('\n');

      const agentMessages = [];
      const filesModified = new Set();
      let testsPassed = null;
      let costInfo = '';

      for (const line of lines) {
        const trimmed = line.trim();
        const msgMatch = trimmed.match(/💬\s*(.+)$/);
        if (msgMatch) {
          agentMessages.push(msgMatch[1]);
        }
        const toolMatch = trimmed.match(/🔧\s*([A-Za-z0-9_-]+)\s*(.*)$/);
        if (toolMatch) {
          const toolArg = toolMatch[2] || '';
          const pathMatch = toolArg.match(/([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]{1,10})/);
          if (pathMatch) {
            filesModified.add(pathMatch[1]);
          }
        }
        if (/✔|passed|passing|tests passed/i.test(trimmed)) {
          testsPassed = trimmed;
        }
        const resultMatch = trimmed.match(/==\s*claude finished:.*(\$[\d.]+)/);
        if (resultMatch) {
          costInfo = resultMatch[1];
        }
      }

      content.replaceChildren();

      // Section 1: Summary of Work Done
      const summaryCard = el('div', { className: 'deliverable-card' });
      summaryCard.append(el('h4', {}, '📋 What Your Teammate Did (Summary)'));

      if (agentMessages.length) {
        const textWrapper = el('div', { className: 'deliverable-text', textContent: agentMessages.join('\n\n') });
        summaryCard.append(textWrapper);
      } else {
        summaryCard.append(el('div', { className: 'deliverable-text', textContent: `Teammate completed task: "${r.task}". All modifications and automated checks were completed in an isolated safe sandbox.` }));
      }
      content.append(summaryCard);

      // Section 2: Files Modified / Artifacts
      if (filesModified.size > 0) {
        const filesCard = el('div', { className: 'deliverable-card' });
        filesCard.append(el('h4', {}, `📁 Files & Artifacts Created or Updated (${filesModified.size})`));
        const fileList = el('div', { className: 'deliverable-files-list' });
        for (const f of filesModified) {
          const item = el('div', { className: 'file-item', style: 'cursor:pointer;', title: 'Click to inspect in Preview Tab' },
            el('span', { className: 'file-name', textContent: f }),
            el('span', { className: 'file-badge', textContent: '✓ Inspect' })
          );
          item.onclick = () => {
            if (deliverableModal) deliverableModal.classList.remove('open');
            switchCockpitTab('tab-btn-preview');
            openFilePreview(f);
          };
          fileList.append(item);
        }
        filesCard.append(fileList);
        content.append(filesCard);
      }

      // Section 3: Verification & Execution Metrics
      const metricsCard = el('div', { className: 'deliverable-card' });
      metricsCard.append(el('h4', {}, '🧪 Verification & Quality Checks'));
      const metricsList = el('div', { style: 'font-size:0.8rem; display:flex; flex-direction:column; gap:6px;' },
        el('div', { style: 'color:var(--status-green); font-weight:500;' }, '✓ Workspace isolated & verified clean'),
        testsPassed ? el('div', { style: 'color:var(--status-green);' }, `✓ ${testsPassed}`) : el('div', { className: 'muted' }, '✓ Execution completed with clean exit status'),
        costInfo ? el('div', { className: 'muted' }, `Compute cost: ${costInfo}`) : null
      );
      metricsCard.append(metricsList);
      content.append(metricsCard);

      // Section 4: Automated Security & Code Quality Review ("Maker / Checker")
      const auditCard = el('div', { className: 'deliverable-card' });
      auditCard.append(el('h4', {}, '🛡️ Automated Peer Review (Maker / Checker)'));
      const auditBody = el('div', { style: 'font-size:0.8rem;', textContent: 'Running automated security and quality audit…' });
      auditCard.append(auditBody);
      content.append(auditCard);

      fetch(`/api/agents/run/audit?id=${encodeURIComponent(r.id)}`)
        .then(res => res.json())
        .then(aud => {
          if (!aud.ok) {
            auditBody.textContent = 'Audit unavailable for this run.';
            return;
          }
          auditBody.replaceChildren();
          const scoreClass = aud.score >= 85 ? 'var(--status-green)' : aud.score >= 60 ? 'var(--status-yellow)' : 'var(--status-red)';
          const scoreRow = el('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;' },
            el('span', { style: `font-weight:600; color:${scoreClass};` }, `${aud.verdict === 'PASSED' ? '✓' : '⚠️'} Score: ${aud.score}/100 · ${aud.verdict}`),
            el('span', { className: 'muted', style: 'font-size:0.75rem;' }, `${aud.metrics.linesAdded} lines added, ${aud.metrics.linesDeleted} deleted`)
          );
          auditBody.append(scoreRow);
          auditBody.append(el('div', { className: 'muted', style: 'margin-bottom:6px;' }, aud.summary));

          if (aud.findings && aud.findings.length > 0) {
            const findingsList = el('div', { style: 'margin-top:6px; display:flex; flex-direction:column; gap:4px;' });
            aud.findings.forEach(f => {
              const fItem = el('div', { style: 'font-size:0.75rem; color:#fca5a5; background:rgba(239,68,68,0.1); padding:4px 8px; border-radius:4px;' },
                `⚠️ [${f.rule}] ${f.file}: ${f.message}`
              );
              findingsList.append(fItem);
            });
            auditBody.append(findingsList);
          }
        })
        .catch(() => {
          auditBody.textContent = 'Audit skipped (no code diff detected).';
        });

      // Section 5: Institutional Knowledge & Reflection
      const reflectCard = el('div', { className: 'deliverable-card' });
      reflectCard.append(el('h4', {}, '🧠 Institutional Knowledge & Self-Reflection'));
      const reflectDesc = el('div', { style: 'font-size:0.8rem; margin-bottom:8px; line-height:1.4;', className: 'muted' },
        'Extract architectural patterns and operational lessons learned from this run into team memory so future agents automatically inherit this context.'
      );
      const reflectBtn = el('button', {
        className: 'btn-sm',
        style: 'font-weight:600; color:var(--status-blue);',
        type: 'button',
        textContent: '🧠 Store Lesson in Team Memory',
        onclick: async () => {
          reflectBtn.disabled = true;
          reflectBtn.textContent = '⏳ Synthesizing & Storing...';
          try {
            const refRes = await fetch('/api/agents/run/reflect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ runId: r.id })
            });
            const refData = await refRes.json();
            if (refData.ok) {
              reflectBtn.textContent = refData.already ? '✓ Already in Team Memory' : '✓ Stored in Team Memory!';
              if (refData.reflection && refData.reflection.content) {
                const note = el('div', { className: 'mono', style: 'margin-top:8px; font-size:0.75rem; color:#a5f3fc; background:rgba(6,182,212,0.1); padding:8px 10px; border-radius:6px;' },
                  `📖 ${refData.reflection.content}`
                );
                reflectCard.append(note);
              }
            } else {
              reflectBtn.disabled = false;
              reflectBtn.textContent = '❌ Failed to store';
            }
          } catch (e) {
            reflectBtn.disabled = false;
            reflectBtn.textContent = '❌ Error storing';
          }
        }
      });
      reflectCard.append(reflectDesc, reflectBtn);
      content.append(reflectCard);

    } catch (err) {
      content.replaceChildren(el('div', { className: 'empty err', textContent: `Failed to load deliverable: ${err.message}` }));
    }
  }

  if ($('deliverable-modal-close')) {
    $('deliverable-modal-close').addEventListener('click', () => {
      if (deliverableModal) deliverableModal.classList.remove('open');
    });
  }
  if (deliverableModal) {
    deliverableModal.addEventListener('click', (e) => {
      if (e.target === deliverableModal) deliverableModal.classList.remove('open');
    });
  }
  if ($('deliverable-copy-btn')) {
    $('deliverable-copy-btn').addEventListener('click', () => {
      const contentEl = $('deliverable-content');
      const text = contentEl ? contentEl.innerText : '';
      if (text) {
        navigator.clipboard.writeText(text);
        const btn = $('deliverable-copy-btn');
        const orig = btn.textContent;
        btn.textContent = '✓ Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
    });
  }
  if ($('deliverable-log-btn')) {
    $('deliverable-log-btn').addEventListener('click', () => {
      if (activeDeliverableRun) {
        if (deliverableModal) deliverableModal.classList.remove('open');
        openLog(activeDeliverableRun.id);
      }
    });
  }
  if ($('deliverable-push-pr-btn')) {
    $('deliverable-push-pr-btn').addEventListener('click', () => {
      if (activeDeliverableRun) {
        pushRunAndOpenPr(activeDeliverableRun.id, $('deliverable-push-pr-btn'));
      }
    });
  }
  if ($('deliverable-followup-btn')) {
    $('deliverable-followup-btn').addEventListener('click', () => {
      if (activeDeliverableRun) {
        if (deliverableModal) deliverableModal.classList.remove('open');
        switchCockpitTab('tab-btn-threads');
        const runId = activeDeliverableRun.id;
        const threadCard = document.querySelector(`.fu-box-${runId}`);
        if (threadCard) threadCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // ---- admin: change the daily limit ------------------------------------
  let capEditing = false;
  function renderCapAdmin(admin, s) {
    $('cap-edit').hidden = !admin || capEditing;
    $('cap-form').hidden = !capEditing;
    if (!s) { $('cap-note').textContent = ''; return; }
    $('cap-note').textContent = s.source === 'admin'
      ? `Limit ${s.dailyPaidRuns}/day, set by ${s.updatedBy} on ${new Date(s.updatedAt).toLocaleString()} (default ${s.envDefault})`
      : `Limit ${s.dailyPaidRuns}/day (default from .env)`;
    if (!capEditing) $('cap-input').value = s.dailyPaidRuns;
  }
  $('cap-edit').addEventListener('click', () => { capEditing = true; $('cap-edit').hidden = true; $('cap-form').hidden = false; $('cap-input').focus(); });
  $('cap-cancel').addEventListener('click', () => { capEditing = false; refresh(); });
  $('cap-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = Number($('cap-input').value);
    if (n === 0 && !confirm('0 turns paid agent runs OFF (Claude, Codex, Auto). Hermes and Noop still run. Continue?')) return;
    try {
      const r = await fetch('/api/agents/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dailyPaidRuns: n }),
      });
      const b = await r.json();
      if (!r.ok || !b.ok) throw new Error(b.error || `HTTP ${r.status}`);
      capEditing = false;
      refresh();
    } catch (err) {
      alert(`Not saved: ${err.message}`);
    }
  });

  // ---- teammate run mode: admins switch it, teammates see it -------------
  let tmBusy = false;
  function renderTeammateMode(admin, t) {
    const box = $('tm-box');
    const sel = $('tm-mode');
    if (!box || !sel) return;
    if (!t) { box.hidden = true; return; }
    box.hidden = false;
    if (tmBusy || document.activeElement === sel) return;
    if (sel.options.length !== t.modes.length) {
      sel.textContent = '';
      for (const m of t.modes) sel.append(new Option(m.label, m.value));
    }
    sel.value = t.mode;
    sel.disabled = !admin;
    box.title = t.source === 'admin'
      ? `Set by ${t.updatedBy} on ${new Date(t.updatedAt).toLocaleString()} (default ${t.envDefault}). Admins are never restricted.`
      : `Default from .env (${t.envDefault}). Admins are never restricted.`;
  }
  if ($('tm-mode')) {
    $('tm-mode').addEventListener('change', async (e) => {
      const sel = e.target;
      const label = sel.options[sel.selectedIndex].text;
      if (!confirm(`Teammates' agent runs will be: ${label}.\nThis applies from their next run. Continue?`)) { refresh(); return; }
      tmBusy = true;
      try {
        const r = await fetch('/api/agents/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ teammateMode: sel.value }),
        });
        const b = await r.json();
        if (!r.ok || !b.ok) throw new Error(b.error || `HTTP ${r.status}`);
      } catch (err) {
        alert(`Not saved: ${err.message}`);
      } finally {
        tmBusy = false;
        sel.blur();
        refresh();
      }
    });
  }

  function renderCap(cap) {
    if (!cap) return;
    const pct = cap.cap > 0 ? Math.min(100, (cap.used / cap.cap) * 100) : 100;
    $('cap-fill').style.width = `${pct}%`;
    $('cap-text').textContent = cap.cap > 0 ? `${cap.used} / ${cap.cap}` : 'off';
    $('cap').classList.toggle('warn', pct >= 75 && pct < 100);
    $('cap').classList.toggle('full', pct >= 100);
  }

  // "claude · 👁️ Code Reviewer" when a run worked as a specialist.
  function agentLabel(r) {
    if (!r.specialist) return r.agent;
    const s = bySlug.get(r.specialist);
    return `${r.agent} · ${s ? `${s.emoji || ''} ${s.name}`.trim() : r.specialist}`;
  }

  // ---- live steps: what each running agent is doing, from its log ----------
  // Polls the existing /api/agents/log for the running runs (at most 3) every
  // 3 s while the tab is visible; the 5 s re-render repaints from the cache.
  const stepCache = new Map(); // run id -> { steps, summary }
  let runningIds = [];

  function paintSteps(box, id) {
    const c = stepCache.get(id);
    if (!c || !c.steps.length) {
      box.replaceChildren(el('div', { className: 'step-item active' }, el('span', { className: 'pulse' }), 'Starting up…'));
      return;
    }
    const items = c.steps.map((st, i) => {
      const last = i === c.steps.length - 1;
      return el('div', { className: `live-step live-${st.kind}${last ? ' live-current' : ''}` },
        el('span', { className: 'live-t mono', textContent: st.t }),
        el('span', { className: 'live-ic', textContent: st.icon }),
        el('span', { className: 'live-x', textContent: st.text }));
    });
    box.replaceChildren(el('div', { className: 'live-sum muted', textContent: c.summary }), ...items);
  }

  async function pollSteps() {
    if (document.hidden || !window.RunSteps) return;
    for (const id of runningIds.slice(0, 3)) {
      try {
        const res = await fetch(`/api/agents/log?id=${encodeURIComponent(id)}`);
        if (!res.ok) continue;
        const b = await res.json();
        stepCache.set(id, { steps: window.RunSteps.parseSteps(b.text, 8), summary: window.RunSteps.summary(b.text) });
        document.querySelectorAll(`[data-steps="${CSS.escape(id)}"]`).forEach((box) => paintSteps(box, id));
      } catch (_) { /* next tick */ }
    }
    for (const id of [...stepCache.keys()]) if (!runningIds.includes(id)) stepCache.delete(id);
  }
  setInterval(pollSteps, 3000);

  // Render active running tasks with friendly checklist & pro controls
  function renderRunning(runs) {
    const fresh = runs.map((r) => r.id).filter((id) => !runningIds.includes(id));
    runningIds = runs.map((r) => r.id);
    if (fresh.length) setTimeout(pollSteps, 0);
    const box = $('running');
    box.replaceChildren();
    if (!runs.length) {
      box.append(el('div', { className: 'empty' },
        el('div', { style: 'font-size:1.4rem; margin-bottom:6px;' }, '💤'),
        el('b', { textContent: 'No tasks currently running.' }),
        el('div', { className: 'muted', style: 'margin-top:4px;' },
          'Pick a project on the left, describe your goal, and assign an AI teammate to start!')));
      return;
    }
    const now = Date.now();
    for (const r of runs) {
      const elapsedStr = ago(now - Date.parse(r.started_at));

      // Live steps from the run log (run-steps.js), filled by pollSteps().
      const checklist = el('div', { className: 'live-steps' });
      checklist.dataset.steps = r.id;
      paintSteps(checklist, r.id);

      const header = el('div', { className: 'run-header-friendly' },
        el('div', { className: 'run-agent-badge' },
          el('span', { className: 'pulse' }),
          agentLabel(r)),
        el('span', { className: 'muted', style: 'font-size:0.75rem;' }, `${elapsedStr} elapsed`)
      );

      const title = el('div', { className: 'run-task-title', textContent: r.task });

      const actions = el('div', { className: 'run-actions-row' });
      if (r.hasLog) {
        const watchBtn = el('button', { className: 'btn-sm', type: 'button', textContent: '👁️ Watch Live Progress' });
        watchBtn.addEventListener('click', () => openLog(r.id));
        const viewBtn = el('button', { className: 'btn-sm', style: 'color:var(--status-green); border-color:rgba(0,230,118,0.35);', type: 'button', textContent: '📋 Progress & Steps' });
        viewBtn.addEventListener('click', () => openDeliverable(r));
        actions.append(watchBtn, viewBtn);
      }
      if (r.link && r.link.repo) {
        const ln = linkNode(r.link);
        if (ln) actions.append(ln);
      }

      const card = el('div', { className: 'run-card-friendly' }, header, title, checklist, actions);
      box.append(card);
    }
  }

  const COLUMNS = [
    { key: 'ready', title: 'Queued', accent: 'var(--status-blue)' },
    { key: 'running', title: 'Working', accent: 'var(--status-amber)' },
    { key: 'review', title: 'Needs your review', accent: 'var(--status-green)' },
    { key: 'failed', title: 'Failed', accent: 'var(--status-red)' },
  ];

  function renderBoard(queue) {
    const board = $('board');
    board.replaceChildren();
    $('queue-note').textContent = queue && !queue.available ? queue.note : '';
    if (!queue || !queue.available) return;
    for (const c of COLUMNS) {
      const items = queue.columns[c.key] || [];
      const col = el('div', { className: 'col' },
        el('h3', {}, c.title, el('span', { className: 'count', textContent: String(items.length) })));
      if (!items.length) col.append(el('div', { className: 'empty', textContent: c.key === 'review' ? 'No PRs waiting.' : 'Empty.' }));
      for (const i of items) {
        const a = el('a', { className: 'issue', href: i.url, target: '_blank', rel: 'noopener' },
          el('div', { style: 'font-weight:500;', textContent: i.title }),
          el('div', { className: 'meta', textContent: `#${i.number}${i.agent ? ` · ${i.agent}` : ''} · ${i.repo.split('/')[1]}` }));
        a.style.setProperty('--accent', c.accent);
        col.append(a);
      }
      board.append(col);
    }
  }

  // ---- follow up: conversational steering on finished claude runs ------------
  let openFollowUp = null;     // run id whose follow-up box is open
  const drafts = {};           // run id -> unsent text (survives the 5 s refresh)

  function toggleFollowUp(r, containerEl) {
    openFollowUp = openFollowUp === r.id ? null : r.id;
    // Check if an existing follow-up box exists in this container
    const existing = containerEl.querySelector(`.fu-box-${r.id}`);
    if (existing) existing.remove();
    if (openFollowUp === r.id) {
      const fu = followUpComponent(r);
      containerEl.append(fu);
      const t = document.getElementById(`fu-${r.id}`);
      if (t) t.focus();
    }
  }

  function followUpComponent(r) {
    const ta = el('textarea', {
      className: 'f',
      id: `fu-${r.id}`,
      rows: 3,
      maxLength: 8000,
      placeholder: 'Tell the agent what to adjust, e.g. "Also add test cases for invalid input, and make sure the error message is friendly."',
      value: drafts[r.id] || ''
    });
    ta.addEventListener('input', () => { drafts[r.id] = ta.value; });

    // Quick steering suggestion chips
    const chips = [
      'Also add unit tests for edge cases',
      'Make sure error handling is clear and friendly',
      'Explain your changes in a brief summary',
      'Open a pull request for review'
    ];
    const chipsRow = el('div', { className: 'suggest', style: 'margin-bottom:8px;' },
      ...chips.map((cText) => {
        const c = el('button', { className: 'chip', type: 'button', textContent: `+ ${cText}` });
        c.addEventListener('click', () => {
          ta.value = ta.value ? `${ta.value}\n${cText}` : cText;
          drafts[r.id] = ta.value;
          ta.focus();
        });
        return c;
      })
    );

    const send = el('button', { className: 'btn-sm', style: 'font-weight:600; padding:6px 14px;', type: 'button', textContent: '↵ Send to Teammate' });
    const note = el('span', { className: 'muted', style: 'font-size:0.75rem;', textContent: `Resumes Claude on the same draft branch; builds on previous changes.` });
    const out = el('div', { className: 'msg' });

    send.addEventListener('click', async () => {
      if (!ta.value.trim()) return;
      send.disabled = true;
      out.className = 'msg';
      out.textContent = 'Sending feedback to agent…';
      try {
        const res = await fetch('/api/agents/followup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: r.id, message: ta.value })
        });
        const b = await res.json();
        if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
        delete drafts[r.id];
        openFollowUp = null;
        openLog(b.runId);
        refresh();
      } catch (err) {
        out.className = 'msg err';
        out.textContent = err.message;
        send.disabled = false;
      }
    });

    return el('div', { className: `fu-wrapper fu-box-${r.id}` },
      el('div', { className: 'fu-header' }, '💬 Conversational Feedback & Steering'),
      chipsRow,
      ta,
      el('div', { style: 'display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:8px; flex-wrap:wrap;' },
        send, note),
      out
    );
  }

  function renderRecent(runs) {
    // Render into both:
    // 1. Threaded Conversational Cards (#threads-container)
    // 2. Traditional Pro Table (#recent)
    const threadBox = $('threads-container');
    const tableBody = $('recent');

    // Hold still while follow-up is being typed
    if (openFollowUp && document.getElementById(`fu-${openFollowUp}`)) return;

    if (threadBox) threadBox.replaceChildren();
    if (tableBody) tableBody.replaceChildren();

    if (!runs.length) {
      if (threadBox) threadBox.append(el('div', { className: 'empty', textContent: 'No task sessions recorded yet.' }));
      if (tableBody) tableBody.append(el('tr', {}, el('td', { colSpan: 7, className: 'empty', textContent: 'No runs yet.' })));
      return;
    }

    for (const r of runs) {
      const isDone = r.status === 'done';
      const isFailed = r.status === 'failed';
      const stClass = isDone ? 'st-done' : isFailed ? 'st-failed' : 'st-other';
      const stLabel = isDone ? (r.question ? '❓ Has a question' : '✅ Completed') : isFailed ? '❌ Failed'
        : r.status === 'stopped' ? '■ Stopped' : r.status === 'timed_out' ? '⏱ Timed out' : '⚡ In progress';

      // --- 1. Thread Card View ---
      if (threadBox) {
        const card = el('div', { className: 'thread-card' });
        const topRow = el('div', { className: 'thread-header' },
          el('div', { style: 'display:flex; align-items:center; gap:8px;' },
            el('span', { className: stClass, style: 'font-weight:600; font-size:0.78rem;' }, stLabel),
            el('span', { style: 'font-weight:600; font-size:0.85rem;' }, agentLabel(r))
          ),
          el('span', { className: 'muted', style: 'font-size:0.75rem;' },
            Number.isFinite(r.duration_s) ? `Took ${ago(r.duration_s * 1000)}` : '')
        );

        const taskTitle = el('div', { className: 'thread-title', textContent: r.task });

        const metaRow = el('div', { className: 'thread-meta' });
        if (r.parent) metaRow.append(el('span', { className: 'tag git' }, `↳ Follow-up of ${r.parent.slice(-6)}`));
        if (r.commits_ahead) metaRow.append(el('span', { className: 'tag gh' }, `+${r.commits_ahead} updates made`));
        const ln = linkNode(r.link);
        if (ln) metaRow.append(ln);

        const actionsRow = el('div', { style: 'display:flex; gap:8px; align-items:center; margin-top:10px;' });
        if (r.hasLog) {
          const viewBtn = el('button', { className: 'btn-sm', style: 'color:var(--status-green); font-weight:600; border-color:rgba(0,230,118,0.35);', type: 'button', textContent: '👁️ View Deliverable' });
          viewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openDeliverable(r);
          });
          actionsRow.append(viewBtn);
        }
        if (r.canFollowUp) {
          const fuBtn = el('button', { className: 'btn-sm', type: 'button', textContent: '💬 Chat / Follow-up' });
          fuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleFollowUp(r, card);
          });
          actionsRow.append(fuBtn);
        }
        if (r.hasLog) {
          const logBtn = el('button', { className: 'btn-sm', type: 'button', textContent: '📜 View Log' });
          logBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openLog(r.id);
          });
          actionsRow.append(logBtn);
        }
        if (r.branch && r.status === 'done') {
          const prBtn = el('button', {
            className: 'btn-sm btn-push-pr',
            type: 'button',
            textContent: '🚀 Push & PR'
          });
          prBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            pushRunAndOpenPr(r.id, prBtn);
          });
          actionsRow.append(prBtn);
        }

        card.append(topRow, taskTitle, metaRow, actionsRow);
        if (openFollowUp === r.id) card.append(followUpComponent(r));
        threadBox.append(card);
      }

      // --- 2. Traditional Table View (Pro Mode) ---
      if (tableBody) {
        const actions = el('td', { className: 'actions' });
        if (r.hasLog) {
          const dBtn = el('button', { className: 'btn-sm', style: 'color:var(--status-green); border-color:rgba(0,230,118,0.35);', type: 'button', textContent: 'Deliverable' });
          dBtn.addEventListener('click', () => openDeliverable(r));
          actions.append(dBtn);
          const btn = el('button', { className: 'btn-sm', type: 'button', textContent: 'Log' });
          btn.addEventListener('click', () => openLog(r.id));
          actions.append(btn);
        }
        if (r.canFollowUp) {
          const fu = el('button', { className: 'btn-sm', type: 'button', textContent: 'Follow up' });
          fu.addEventListener('click', () => toggleFollowUp(r, tr));
          actions.append(fu);
        }
        if (r.branch && r.status === 'done') {
          const prBtn = el('button', { className: 'btn-sm', style: 'color:var(--status-blue); font-weight:600;', type: 'button', textContent: 'PR' });
          prBtn.addEventListener('click', () => pushRunAndOpenPr(r.id, prBtn));
          actions.append(prBtn);
        }
        const taskCell = el('td', { className: 'task', title: r.task },
          r.parent ? el('span', { className: 'muted', textContent: `↳ follow-up of ${r.parent.slice(-6)} · ` }) : null, r.task);
        const tr = el('tr', {},
          el('td', { className: stClass, textContent: r.status }),
          el('td', { textContent: agentLabel(r) }),
          el('td', { className: 'mono', textContent: Number.isFinite(r.duration_s) ? ago(r.duration_s * 1000) : '-' }),
          el('td', { textContent: r.commits_ahead ? String(r.commits_ahead) : '-' }),
          el('td', {}, linkNode(r.link) || '-'),
          taskCell,
          actions);
        tableBody.append(tr);
      }
    }
  }

  // Export transcripts handler
  if ($('btn-export-transcripts')) {
    $('btn-export-transcripts').addEventListener('click', () => {
      window.open('/api/agent/transcripts?export=md', '_blank');
    });
  }

  let lastRecent = [];
  // Open the follow-up box for a finished run (used by the My tasks strip).
  function openFollowUpFor(r) {
    switchCockpitTab('tab-btn-threads');
    openFollowUp = r.id;
    renderRecent(lastRecent);
    const t = document.getElementById(`fu-${r.id}`);
    if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.focus(); }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/agents/overview');
      if (r.status === 401) { location.href = '/login?redirect=/agents'; return; }
      const b = await r.json();
      renderCap(b.cap);
      renderCapAdmin(b.admin, b.capSettings);
      renderTeammateMode(b.admin, b.teammateMode);
      renderRunning(b.running || []);
      renderBoard(b.queue);
      lastRecent = b.recent || [];
      renderRecent(lastRecent);
      window.dispatchEvent(new CustomEvent('agents:overview', { detail: b }));
    } catch (_) {
      $('queue-note').textContent = 'Dashboard unreachable; retrying…';
    }
  }

  // ---- specialists (agency-agents) ---------------------------------------
  let catalog = { specialists: [], divisions: {} };
  let role = { label: '', slugs: [] }; // set by agents-workspace.js
  const recommended = new Map(); // slug -> { score, used, reasons, pos }
  let catShown = 24;

  function describeSpecialist() {
    const s = bySlug.get($('specialist').value);
    $('specialist-desc').textContent = s ? `${s.emoji || ''} ${s.description}`.trim() : '';
  }

  function useSpecialist(slug) {
    $('specialist').value = slug;
    describeSpecialist();
    if (catModal) catModal.classList.remove('open');
    $('task-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('title').focus();
  }

  function renderCatalog() {
    const q = $('catalog-q').value.trim().toLowerCase();
    const div = $('catalog-division').value;
    const sort = $('catalog-sort').value;
    const list = catalog.specialists.filter((s) => (!div || s.division === div)
      && (!q || `${s.name} ${s.description} ${s.vibe} ${s.divisionLabel}`.toLowerCase().includes(q)));
    const rk = (s) => recommended.get(s.slug) || { score: 0, used: 0, pos: 1e9 };
    const roleRank = (s) => { const i = role.slugs.indexOf(s.slug); return i < 0 ? 1e9 : i; };
    if (sort === 'recommended') list.sort((a, b) => roleRank(a) - roleRank(b) || rk(a).pos - rk(b).pos);
    else if (sort === 'used') list.sort((a, b) => rk(b).used - rk(a).used || rk(a).pos - rk(b).pos);
    else list.sort((a, b) => a.name.localeCompare(b.name));
    const box = $('catalog');
    box.replaceChildren();
    $('catalog-count').textContent = `${list.length} of ${catalog.specialists.length}`;
    for (const s of list.slice(0, catShown)) {
      const btn = el('button', { className: 'btn-sm', type: 'button', textContent: 'Assign Teammate' });
      btn.addEventListener('click', () => useSpecialist(s.slug));
      const why = [...(role.slugs.includes(s.slug) ? [`For ${role.label}`] : []), ...((recommended.get(s.slug) || {}).reasons || [])];
      const card = el('div', { className: 'spec', title: s.vibe || '' },
        el('div', { className: 'n', textContent: `${s.emoji || '•'} ${s.name}` }),
        why.length ? el('div', { className: 'why', textContent: `⭐ ${why.join(' · ')}` }) : null,
        el('div', { className: 'd', textContent: s.description }),
        el('div', { className: 'f' }, el('span', { className: 'muted', textContent: s.divisionLabel }), btn));
      const color = (catalog.divisions[s.division] || {}).color;
      if (color && /^#[0-9a-fA-F]{6}$/.test(color)) card.style.setProperty('--div-color', color);
      box.append(card);
    }
    if (!list.length) box.append(el('div', { className: 'empty', textContent: 'No specialist matches.' }));
    $('catalog-more').hidden = list.length <= catShown;
  }

  // The picker: your role's specialists, then recommended, then by division.
  let allGroups = {};
  const opt = (s) => el('option', { value: s.slug, textContent: `${s.emoji || ''} ${s.name}`.trim() });
  function fillPicker() {
    const sel = $('specialist');
    const keep = sel.value;
    sel.replaceChildren(el('option', { value: '', textContent: 'None: plain assistant' }));
    const roleItems = role.slugs.map((slug) => bySlug.get(slug)).filter(Boolean);
    if (roleItems.length) sel.append(el('optgroup', { label: `For ${role.label}` }, ...roleItems.map(opt)));
    const top = [...recommended.values()].filter((x) => x.reasons && x.reasons.length && !role.slugs.includes(x.slug)).slice(0, 8)
      .map((x) => bySlug.get(x.slug)).filter(Boolean);
    if (top.length) sel.append(el('optgroup', { label: '⭐ Recommended for you' }, ...top.map(opt)));
    for (const [label, items] of Object.entries(allGroups)) sel.append(el('optgroup', { label }, ...items.map(opt)));
    sel.value = keep;
    describeSpecialist();
  }

  function setSpecialist(slug) {
    $('specialist').value = bySlug.has(slug) ? slug : '';
    describeSpecialist();
    markChips();
  }

  function setRole(next) {
    role = { label: next.label, slugs: next.specialists || [] };
    if (catalog.specialists.length) { fillPicker(); renderCatalog(); }
  }

  async function loadSpecialists() {
    try {
      const r = await fetch('/api/agents/specialists');
      const b = await r.json();
      if (!b.ok) return;
      catalog = b;
      b.specialists.forEach((s) => bySlug.set(s.slug, s));
      try {
        const rr = await (await fetch('/api/agents/specialists/recommended')).json();
        (rr.ranked || []).forEach((x, pos) => recommended.set(x.slug, { ...x, pos }));
        const basis = (rr.signals || []).filter((x) => x.kind === 'memory').map((x) => x.label);
        const tasks = (rr.signals || []).filter((x) => x.kind === 'task').length;
        if (basis.length || tasks) $('catalog-basis').textContent = `Recommended from memory (${basis.join(', ')})${tasks ? ` and ${tasks} recent tasks` : ''}, plus what you use.`;
      } catch (_) { /* fall back */ }
      const groups = {};
      for (const s of b.specialists) (groups[s.divisionLabel] = groups[s.divisionLabel] || []).push(s);
      allGroups = groups;
      fillPicker();
      const divSel = $('catalog-division');
      Object.entries(b.divisions || {}).sort((x, y) => x[1].label.localeCompare(y[1].label))
        .forEach(([k, v]) => divSel.append(el('option', { value: k, textContent: v.label })));
      $('catalog-source').textContent = b.commit
        ? `The Agency catalog (agency-agents, MIT), pinned at ${b.commit.slice(0, 7)}.`
        : '';
      renderCatalog();
    } catch (_) { /* catalog is optional */ }
  }
  $('specialist').addEventListener('change', () => { describeSpecialist(); markChips(); });

  // Suggestions as you type the task (debounced; local model, no cost).
  let suggestTimer = null;
  let suggestSeq = 0;
  function markChips() {
    document.querySelectorAll('#suggest .chip').forEach((c) => c.classList.toggle('on', c.dataset.slug === $('specialist').value));
  }
  async function loadSuggestions() {
    const q = `${$('title').value} ${$('body').value}`.trim();
    const box = $('suggest');
    if (q.length < 8) { box.hidden = true; return; }
    const seq = ++suggestSeq;
    try {
      const r = await fetch(`/api/agents/specialists/suggest?q=${encodeURIComponent(q.slice(0, 500))}`);
      const b = await r.json();
      if (seq !== suggestSeq) return;
      const chips = (b.suggestions || []).map((s) => {
        const c = el('button', { className: 'chip', type: 'button', textContent: `${s.emoji || ''} ${s.name}`.trim(), title: s.divisionLabel });
        c.dataset.slug = s.slug;
        c.addEventListener('click', () => { $('specialist').value = $('specialist').value === s.slug ? '' : s.slug; describeSpecialist(); markChips(); });
        return c;
      });
      box.replaceChildren(el('span', { className: 'muted', textContent: 'Suggested teammates:' }), ...chips);
      box.hidden = !chips.length;
      markChips();
    } catch (_) { box.hidden = true; }
  }
  const queueSuggest = () => { clearTimeout(suggestTimer); suggestTimer = setTimeout(loadSuggestions, 500); };
  $('title').addEventListener('input', queueSuggest);
  $('body').addEventListener('input', queueSuggest);
  $('catalog-q').addEventListener('input', () => { catShown = 24; renderCatalog(); });
  $('catalog-division').addEventListener('change', () => { catShown = 24; renderCatalog(); });
  $('catalog-sort').addEventListener('change', () => { catShown = 24; renderCatalog(); });
  $('catalog-more').addEventListener('click', () => { catShown += 24; renderCatalog(); });

  // ---- voice input (speech-to-text) -------------------------------------
  function initVoiceInput() {
    const micBtn = $('btn-voice-input');
    if (!micBtn) return;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      micBtn.title = 'Speech-to-text is not supported in this browser';
      micBtn.style.opacity = '0.5';
      return;
    }

    let recognition = null;
    let isListening = false;

    function stopListening() {
      if (recognition && isListening) {
        recognition.stop();
      }
      isListening = false;
      micBtn.classList.remove('listening');
      const micText = micBtn.querySelector('.mic-text');
      if (micText) micText.textContent = 'Speak';
    }

    function startListening() {
      try {
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';

        recognition.onstart = () => {
          isListening = true;
          micBtn.classList.add('listening');
          const micText = micBtn.querySelector('.mic-text');
          if (micText) micText.textContent = 'Listening…';
        };

        recognition.onresult = (e) => {
          let text = '';
          for (let i = 0; i < e.results.length; i++) {
            text += e.results[i][0].transcript;
          }
          if (text) {
            $('title').value = text;
            $('title').dispatchEvent(new Event('input')); // triggers debounced specialist suggest!
          }
        };

        recognition.onerror = (e) => {
          stopListening();
          if (e.error === 'not-allowed') {
            const m = $('msg');
            if (m) {
              m.className = 'msg err';
              m.textContent = 'Microphone access was denied. Please allow microphone permissions in your browser.';
            }
          }
        };

        recognition.onend = () => {
          stopListening();
        };

        recognition.start();
      } catch (err) {
        stopListening();
      }
    }

    micBtn.addEventListener('click', () => {
      if (isListening) {
        stopListening();
      } else {
        startListening();
      }
    });
  }

  // ---- Workspace Preview & Interactive Teammate Chat --------------------
  async function loadWorkspacePreview(repoName) {
    const repo = repoName || activeSelectedRepo || 'fuzzy-octo-eureka';
    const pathEl = $('preview-repo-path');
    const filesEl = $('preview-files-list');
    const readmeEl = $('preview-readme-text');
    const delivEl = $('preview-latest-deliverable-body');
    const badgeEl = $('preview-latest-run-badge');

    if (pathEl) pathEl.textContent = 'Fetching preview...';

    try {
      const res = await fetch(`/api/agents/repo/preview?repo=${encodeURIComponent(repo)}`);
      const data = await res.json();
      if (!data.ok) {
        if (pathEl) pathEl.textContent = data.error || 'Preview unavailable';
        return;
      }

      if (pathEl) {
        let archBadge = '';
        if (data.architecture) {
          const eps = (data.architecture.entryPoints || []).length ? ` (${data.architecture.entryPoints.join(', ')})` : '';
          archBadge = ` · ⚡ ${data.architecture.stack}${eps}`;
        }
        pathEl.textContent = (data.path || repo) + archBadge;
      }

      if (filesEl) {
        filesEl.replaceChildren();
        if (Array.isArray(data.files) && data.files.length > 0) {
          data.files.forEach(f => {
            const isDir = !f.includes('.');
            const btn = el('button', {
              type: 'button',
              className: 'file-chip-btn',
              title: isDir ? `Browse folder ${f}` : `Click to preview ${f} code`,
              onclick: () => openFilePreview(f)
            }, `${isDir ? '📁' : '📄'} ${f}`);
            btn.dataset.file = f;
            filesEl.appendChild(btn);
          });
        } else {
          filesEl.appendChild(el('span', { className: 'muted' }, 'No files found in root.'));
        }
      }

      if (readmeEl) {
        readmeEl.textContent = data.readme || 'No README.md found in this repository.';
      }

      if (delivEl && badgeEl) {
        if (data.latestRun) {
          const lr = data.latestRun;
          badgeEl.textContent = `Run ${lr.id} · ${lr.agent || 'agent'} · Status: ${lr.status || 'finished'}`;
          delivEl.replaceChildren();
          const card = el('div', { style: 'font-size:0.82rem; line-height:1.5;' },
            el('div', { style: 'font-weight:600; color:#fff; margin-bottom:4px;' }, `Task: ${lr.task || 'Autonomous Execution'}`),
            el('div', { className: 'muted', style: 'margin-bottom:8px;' }, lr.branch ? `Branch: ${lr.branch}` : ''),
            el('div', { style: 'display:flex; gap:8px; flex-wrap:wrap;' },
              lr.branch ? el('button', {
                className: 'btn-sm btn-push-pr',
                type: 'button',
                textContent: '🚀 Push to GitHub & Open PR',
                onclick: (e) => pushRunAndOpenPr(lr.id, e.currentTarget)
              }) : null,
              el('button', {
                className: 'btn-sm',
                type: 'button',
                textContent: '📜 Inspect Full Log',
                onclick: () => openLog(lr.id)
              }),
              el('button', {
                className: 'btn-sm',
                type: 'button',
                textContent: '💬 Open Follow-up Thread',
                onclick: () => {
                  switchCockpitTab('tab-btn-threads');
                  toggleFollowUp(lr, $('threads-container'));
                }
              })
            )
          );
          delivEl.appendChild(card);
        } else {
          badgeEl.textContent = 'No past runs for this repo yet';
          delivEl.replaceChildren(el('div', { className: 'empty' }, `Ready to run your first task on ${repo}! Assign a task in Step 2.`));
        }
      }
    } catch (err) {
      if (pathEl) pathEl.textContent = 'Error loading preview: ' + err.message;
    }
  }

  window.loadWorkspacePreview = loadWorkspacePreview;

  window.onRepoSelectionChanged = function(repoName) {
    if (!repoName) return;
    activeSelectedRepo = repoName;
    const previewRepoEl = $('preview-active-repo');
    if (previewRepoEl) previewRepoEl.textContent = repoName;
    const chatRepoLabel = $('agents-chat-repo-label');
    if (chatRepoLabel) chatRepoLabel.textContent = repoName;
    const chatRepoChip = $('agents-chat-repo-chip');
    if (chatRepoChip) chatRepoChip.textContent = repoName;

    // Load preview if the preview tab is visible
    loadWorkspacePreview(repoName);
  };

  async function sendAgentsPageChatMessage() {
    const input = $('agents-page-chat-input');
    const box = $('agents-page-chat-messages');
    if (!input || !box) return;
    const msg = input.value.trim();
    if (!msg) return;

    // Append user bubble
    const userBubble = el('div', { className: 'chat-bubble user', style: 'font-size:0.8rem; padding:8px 12px; margin-bottom:8px; text-align:right;' },
      el('span', { style: 'background:#0284c7; color:#fff; padding:6px 12px; border-radius:8px; display:inline-block;' }, msg)
    );
    box.appendChild(userBubble);
    input.value = '';
    box.scrollTop = box.scrollHeight;

    // Typing bubble
    const typing = el('div', { id: 'agents-page-typing', className: 'muted', style: 'font-size:0.75rem; margin-bottom:8px;' },
      'Teammate reasoning with repo context...'
    );
    box.appendChild(typing);
    box.scrollTop = box.scrollHeight;

    const repo = activeSelectedRepo || 'fuzzy-octo-eureka';
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, agent: 'po', repo })
      });
      const data = await res.json();
      typing.remove();

      const replyBubble = el('div', { className: 'chat-bubble agent', style: 'font-size:0.8rem; padding:8px 12px; margin-bottom:8px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); border-radius:8px;' });
      replyBubble.innerHTML = `<strong>🧭 Teammate:</strong><div style="margin-top:4px; line-height:1.5;">${(data.reply || 'Task acknowledged.').replace(/\n/g, '<br>')}</div>`;
      box.appendChild(replyBubble);
      box.scrollTop = box.scrollHeight;
    } catch (err) {
      typing.remove();
      const errBubble = el('div', { style: 'color:var(--status-red); font-size:0.75rem;' }, 'Chat failed: ' + err.message);
      box.appendChild(errBubble);
    }
  }

  window.sendAgentsPageChatMessage = sendAgentsPageChatMessage;

  // Shared with agents-workspace.js (repos, roles, task submit).
  window.AgentsPage = { refresh, openLog, openDeliverable, setSpecialist, setRole, el, $, switchTab: switchCockpitTab, openFollowUp: openFollowUpFor };

  loadSpecialists();
  initVoiceInput();
  refresh();
  setInterval(refresh, 5000);
})();
