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
      renderCapAdmin(b.admin, b.capSettings);
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
        body: JSON.stringify({ repo: $('repo').value, agent: $('agent').value, title: $('title').value, body: $('body').value, specialist: $('specialist').value }),
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

  // ---- specialists (agency-agents) ---------------------------------------
  let catalog = { specialists: [], divisions: {} };
  let catShown = 24;
  const bySlug = new Map();

  function describeSpecialist() {
    const s = bySlug.get($('specialist').value);
    $('specialist-desc').textContent = s ? `${s.emoji || ''} ${s.description}`.trim() : '';
  }

  function useSpecialist(slug) {
    $('specialist').value = slug;
    describeSpecialist();
    $('task-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $('title').focus();
  }

  function renderCatalog() {
    const q = $('catalog-q').value.trim().toLowerCase();
    const div = $('catalog-division').value;
    const list = catalog.specialists.filter((s) => (!div || s.division === div)
      && (!q || `${s.name} ${s.description} ${s.vibe} ${s.divisionLabel}`.toLowerCase().includes(q)));
    const box = $('catalog');
    box.replaceChildren();
    $('catalog-count').textContent = `${list.length} of ${catalog.specialists.length}`;
    for (const s of list.slice(0, catShown)) {
      const btn = el('button', { className: 'btn-sm', type: 'button', textContent: 'Use' });
      btn.addEventListener('click', () => useSpecialist(s.slug));
      const card = el('div', { className: 'spec', title: s.vibe || '' },
        el('div', { className: 'n', textContent: `${s.emoji || '•'} ${s.name}` }),
        el('div', { className: 'd', textContent: s.description }),
        el('div', { className: 'f' }, el('span', { className: 'muted', textContent: s.divisionLabel }), btn));
      const color = (catalog.divisions[s.division] || {}).color;
      if (color && /^#[0-9a-fA-F]{6}$/.test(color)) card.style.setProperty('--div-color', color);
      box.append(card);
    }
    if (!list.length) box.append(el('div', { className: 'empty', textContent: 'No specialist matches.' }));
    $('catalog-more').hidden = list.length <= catShown;
  }

  async function loadSpecialists() {
    try {
      const r = await fetch('/api/agents/specialists');
      const b = await r.json();
      if (!b.ok) return;
      catalog = b;
      b.specialists.forEach((s) => bySlug.set(s.slug, s));
      const groups = {};
      for (const s of b.specialists) (groups[s.divisionLabel] = groups[s.divisionLabel] || []).push(s);
      const sel = $('specialist');
      for (const [label, items] of Object.entries(groups)) {
        const og = el('optgroup', { label });
        items.forEach((s) => og.append(el('option', { value: s.slug, textContent: `${s.emoji || ''} ${s.name}`.trim() })));
        sel.append(og);
      }
      const divSel = $('catalog-division');
      Object.entries(b.divisions || {}).sort((x, y) => x[1].label.localeCompare(y[1].label))
        .forEach(([k, v]) => divSel.append(el('option', { value: k, textContent: v.label })));
      $('catalog-source').textContent = b.commit
        ? `From The Agency (agency-agents, MIT), pinned at ${b.commit.slice(0, 7)}. Pick one and its expertise is added to the agent's instructions.`
        : '';
      renderCatalog();
    } catch (_) { /* catalog is optional */ }
  }
  $('specialist').addEventListener('change', describeSpecialist);
  $('catalog-q').addEventListener('input', () => { catShown = 24; renderCatalog(); });
  $('catalog-division').addEventListener('change', () => { catShown = 24; renderCatalog(); });
  $('catalog-more').addEventListener('click', () => { catShown += 24; renderCatalog(); });

  loadSpecialists();
  refresh();
  setInterval(refresh, 5000);
})();
