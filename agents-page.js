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

  // "claude · 👁️ Code Reviewer" when a run worked as a specialist.
  function agentLabel(r) {
    if (!r.specialist) return r.agent;
    const s = bySlug.get(r.specialist);
    return `${r.agent} · ${s ? `${s.emoji || ''} ${s.name}`.trim() : r.specialist}`;
  }

  function renderRunning(runs) {
    const box = $('running');
    box.replaceChildren();
    if (!runs.length) { box.append(el('div', { className: 'empty', textContent: 'Nothing running. Pick a repo and give the agent a task above.' })); return; }
    const now = Date.now();
    for (const r of runs) {
      const meta = el('div', { className: 'muted' },
        el('span', { className: 'pulse' }),
        `${agentLabel(r)} · ${ago(now - Date.parse(r.started_at))} `);
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

  // ---- follow up: talk to a finished claude run -------------------------------
  let openFollowUp = null;     // run id whose follow-up box is open
  const drafts = {};           // run id -> unsent text (survives the 5 s refresh)

  function toggleFollowUp(r, tr) {
    openFollowUp = openFollowUp === r.id ? null : r.id;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('fu-row')) next.remove();
    if (openFollowUp) { tr.after(followUpRow(r)); const t = document.getElementById(`fu-${r.id}`); if (t) t.focus(); }
  }

  function followUpRow(r) {
    const ta = el('textarea', { className: 'f', id: `fu-${r.id}`, rows: 3, maxLength: 8000, placeholder: 'e.g. Also add tests for empty input, then rerun the suite.', value: drafts[r.id] || '' });
    ta.addEventListener('input', () => { drafts[r.id] = ta.value; });
    const send = el('button', { className: 'btn', type: 'button', textContent: 'Send to agent' });
    const note = el('span', { className: 'muted', textContent: `Resumes this run's Claude session on ${r.task ? 'the same branch' : 'its branch'}; counts as a paid run.` });
    const out = el('div', { className: 'msg' });
    send.addEventListener('click', async () => {
      send.disabled = true;
      out.className = 'msg';
      out.textContent = 'Sending…';
      try {
        const res = await fetch('/api/agents/followup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: r.id, message: ta.value }) });
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
    return el('tr', { className: 'fu-row' }, el('td', { colSpan: 7 },
      el('div', { className: 'fu' }, ta, el('div', { className: 'submit-row' }, send, note), out)));
  }

  function renderRecent(runs) {
    // Hold the list still while a follow-up is being written.
    if (openFollowUp && document.getElementById(`fu-${openFollowUp}`)) return;
    const tb = $('recent');
    tb.replaceChildren();
    if (!runs.length) { tb.append(el('tr', {}, el('td', { colSpan: 7, className: 'empty', textContent: 'No runs yet.' }))); return; }
    for (const r of runs) {
      const st = r.status === 'done' ? 'st-done' : r.status === 'failed' ? 'st-failed' : 'st-other';
      const actions = el('td', { className: 'actions' });
      if (r.hasLog) {
        const btn = el('button', { className: 'btn-sm', type: 'button', textContent: 'Log' });
        btn.addEventListener('click', () => openLog(r.id));
        actions.append(btn);
      }
      if (r.canFollowUp) {
        const fu = el('button', { className: 'btn-sm', type: 'button', textContent: 'Follow up', title: 'Send this agent a message; it continues where it left off' });
        fu.addEventListener('click', () => toggleFollowUp(r, tr));
        actions.append(fu);
      }
      const taskCell = el('td', { className: 'task', title: r.task },
        r.parent ? el('span', { className: 'muted', textContent: `↳ follow-up of ${r.parent.slice(-6)} · ` }) : null, r.task);
      const tr = el('tr', {},
        el('td', { className: st, textContent: r.status }),
        el('td', { textContent: agentLabel(r) }),
        el('td', { className: 'mono', textContent: Number.isFinite(r.duration_s) ? ago(r.duration_s * 1000) : '-' }),
        el('td', { textContent: r.commits_ahead ? String(r.commits_ahead) : '-' }),
        el('td', {}, linkNode(r.link) || '-'),
        taskCell,
        actions);
      tb.append(tr);
      if (openFollowUp === r.id) tb.append(followUpRow(r));
    }
  }

  async function refresh() {
    try {
      const r = await fetch('/api/agents/overview');
      if (r.status === 401) { location.href = '/login?redirect=/agents'; return; }
      const b = await r.json();
      renderCap(b.cap);
      renderCapAdmin(b.admin, b.capSettings);
      renderRunning(b.running || []);
      renderBoard(b.queue);
      renderRecent(b.recent || []);
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
      const btn = el('button', { className: 'btn-sm', type: 'button', textContent: 'Use' });
      btn.addEventListener('click', () => useSpecialist(s.slug));
      const why = [...(role.slugs.includes(s.slug) ? [`for ${role.label}`] : []), ...((recommended.get(s.slug) || {}).reasons || [])];
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
    sel.replaceChildren(el('option', { value: '', textContent: 'None: plain agent' }));
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
      // Recommendations (usage + memory). Optional: the catalog works without.
      try {
        const rr = await (await fetch('/api/agents/specialists/recommended')).json();
        (rr.ranked || []).forEach((x, pos) => recommended.set(x.slug, { ...x, pos }));
        const basis = (rr.signals || []).filter((x) => x.kind === 'memory').map((x) => x.label);
        const tasks = (rr.signals || []).filter((x) => x.kind === 'task').length;
        if (basis.length || tasks) $('catalog-basis').textContent = `Recommended from your memory (${basis.join(', ')})${tasks ? ` and ${tasks} recent tasks` : ''}, plus what you use.`;
      } catch (_) { /* fall back to catalog order */ }
      const groups = {};
      for (const s of b.specialists) (groups[s.divisionLabel] = groups[s.divisionLabel] || []).push(s);
      allGroups = groups;
      fillPicker();
        const og = el('optgroup', { label });
      const divSel = $('catalog-division');
      Object.entries(b.divisions || {}).sort((x, y) => x[1].label.localeCompare(y[1].label))
        .forEach(([k, v]) => divSel.append(el('option', { value: k, textContent: v.label })));
      $('catalog-source').textContent = b.commit
        ? `From The Agency (agency-agents, MIT), pinned at ${b.commit.slice(0, 7)}. Pick one and its expertise is added to the agent's instructions.`
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
      if (seq !== suggestSeq) return; // a newer request superseded this one
      const chips = (b.suggestions || []).map((s) => {
        const c = el('button', { className: 'chip', type: 'button', textContent: `${s.emoji || ''} ${s.name}`.trim(), title: s.divisionLabel });
        c.dataset.slug = s.slug;
        c.addEventListener('click', () => { $('specialist').value = $('specialist').value === s.slug ? '' : s.slug; describeSpecialist(); markChips(); });
        return c;
      });
      box.replaceChildren(el('span', { className: 'muted', textContent: 'Suggested specialists:' }), ...chips);
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

  // Shared with agents-workspace.js (repos, roles, task submit).
  window.AgentsPage = { refresh, openLog, setSpecialist, setRole, el, $ };

  loadSpecialists();
  refresh();
  setInterval(refresh, 5000);
})();
