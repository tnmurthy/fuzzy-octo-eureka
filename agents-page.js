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
      if ($('log-follow').checked) pre.scrollTop = pre.scrollHeight;
      if (b.status && b.status !== 'running') stopLogTimer();
    } catch (_) { /* next tick */ }
  }
  function stopLogTimer() { if (logTimer) clearInterval(logTimer); logTimer = null; }
  function openLog(id) {
    logId = id;
    $('log-id').textContent = id;
    $('log').textContent = 'Loading…';
    $('log-card').classList.add('open');
    stopLogTimer();
    loadLog();
    logTimer = setInterval(loadLog, 2000);
    $('log-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('log-close').addEventListener('click', () => { stopLogTimer(); logId = null; $('log-card').classList.remove('open'); });

  // ---- render -----------------------------------------------------------
  function renderCap(cap) {
    if (!cap) return;
    const pct = cap.cap > 0 ? Math.min(100, (cap.used / cap.cap) * 100) : 100;
    $('cap-fill').style.width = `${pct}%`;
    $('cap-text').textContent = cap.cap > 0 ? `${cap.used} / ${cap.cap}` : 'off';
    $('cap').classList.toggle('warn', pct >= 75 && pct < 100);
    $('cap').classList.toggle('full', pct >= 100);
  }

  function renderRunning(runs) {
    const box = $('running');
    box.replaceChildren();
    if (!runs.length) { box.append(el('div', { className: 'empty', textContent: 'Nothing running. Queue a task and it starts within a minute.' })); return; }
    const now = Date.now();
    for (const r of runs) {
      const meta = el('div', { className: 'muted' },
        el('span', { className: 'pulse' }),
        `${r.agent} · ${ago(now - Date.parse(r.started_at))} `);
      const ln = linkNode(r.link);
      if (ln) meta.append('· ', ln);
      const what = el('div', { className: 'what' }, meta, el('div', { className: 'task', title: r.task, textContent: r.task }));
      const btn = r.hasLog ? el('button', { className: 'btn-sm', type: 'button', textContent: 'Watch live' }) : null;
      if (btn) btn.addEventListener('click', () => openLog(r.id));
      box.append(el('div', { className: 'run' }, what, btn));
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
      const col = el('div', { className: 'card col' }, el('h3', {}, c.title, el('span', { className: 'count', textContent: String(items.length) })));
      if (!items.length) col.append(el('div', { className: 'empty', textContent: c.key === 'review' ? 'No PRs waiting.' : 'Empty.' }));
      for (const i of items) {
        const a = el('a', { className: 'issue', href: i.url, target: '_blank', rel: 'noopener' },
          el('div', { textContent: i.title }),
          el('div', { className: 'meta', textContent: `#${i.number}${i.agent ? ` · ${i.agent}` : ''} · ${i.repo.split('/')[1]}` }));
        a.style.setProperty('--accent', c.accent);
        col.append(a);
      }
      board.append(col);
    }
  }

  function renderRecent(runs) {
    const tb = $('recent');
    tb.replaceChildren();
    if (!runs.length) { tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'empty', textContent: 'No runs yet.' }))); return; }
    for (const r of runs) {
      const st = r.status === 'done' ? 'st-done' : r.status === 'failed' ? 'st-failed' : 'st-other';
      const btn = r.hasLog ? el('button', { className: 'btn-sm', type: 'button', textContent: 'Log' }) : '';
      if (btn) btn.addEventListener('click', () => openLog(r.id));
      tb.append(el('tr', {},
        el('td', { className: st, textContent: r.status }),
        el('td', { textContent: r.agent }),
        el('td', { className: 'mono', textContent: Number.isFinite(r.duration_s) ? ago(r.duration_s * 1000) : '-' }),
        el('td', { textContent: r.commits_ahead ? String(r.commits_ahead) : '-' }),
        el('td', {}, linkNode(r.link) || '-'),
        el('td', { className: 'task', title: r.task, textContent: r.task }),
        el('td', {}, btn)));
    }
  }

  let reposFilled = false;
  function fillRepos(repos) {
    if (reposFilled || !repos || !repos.length) return;
    $('repo').replaceChildren(...repos.map((r) => el('option', { value: r, textContent: r })));
    reposFilled = true;
  }

  async function refresh() {
    try {
      const r = await fetch('/api/agents/overview');
      if (r.status === 401) { location.href = '/login?redirect=/agents'; return; }
      const b = await r.json();
      fillRepos(b.repos);
      renderCap(b.cap);
      renderRunning(b.running || []);
      renderBoard(b.queue);
      renderRecent(b.recent || []);
    } catch (_) {
      $('queue-note').textContent = 'Dashboard unreachable; retrying…';
    }
  }

  // ---- submit -----------------------------------------------------------
  $('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('msg');
    const btn = $('submit');
    btn.disabled = true;
    msg.className = 'msg';
    msg.textContent = 'Opening issue…';
    try {
      const r = await fetch('/api/agents/task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: $('repo').value, agent: $('agent').value, title: $('title').value, body: $('body').value }),
      });
      const b = await r.json();
      if (!r.ok || !b.ok) throw new Error(b.error || `HTTP ${r.status}`);
      msg.className = 'msg ok';
      msg.replaceChildren('Queued as ', el('a', { href: b.url, target: '_blank', rel: 'noopener', textContent: `issue #${b.number}` }), '. An agent starts within a minute.');
      $('title').value = '';
      $('body').value = '';
      refresh();
    } catch (err) {
      msg.className = 'msg err';
      msg.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  refresh();
  setInterval(refresh, 5000);
})();
