// context-page.js - client for /context (context.html). Memory text comes from
// teammates and agents, so everything goes in via textContent.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '-');
  const fmtNum = (n) => Number(n || 0).toLocaleString();

  const VIEWS = {
    mine: { test: (e) => e.mine, help: 'Memories you wrote: on this Mac, plus any you shared from another machine.' },
    shared: { test: (e) => e.shared, help: 'Memory every teammate can read. Yours is private (only you can read it), so it is not listed here.' },
    combined: { test: () => true, help: 'This Mac\'s memory and the team\'s together, each counted once.' },
  };
  const PAGE = 30;

  let data = null;
  let view = 'combined';
  let shown = PAGE;

  function renderMembers(members, teamStore) {
    const tb = $('members');
    tb.replaceChildren();
    if (!members.length) {
      tb.append(el('tr', {}, el('td', { colSpan: 8, className: 'empty', textContent: teamStore === 'on' ? 'No members found.' : 'Team sharing is off, so there is no member list. Add the Supabase settings to .env to turn it on.' })));
      return;
    }
    for (const m of members) {
      const name = el('td', {}, m.name, m.you ? el('span', { className: 'you', textContent: 'you' }) : null);
      tb.append(el('tr', {},
        name,
        el('td', { className: m.role === 'owner' ? 'role-owner' : '', textContent: m.role }),
        el('td', { className: 'num', textContent: fmtNum(m.memories) }),
        el('td', { className: 'num', textContent: fmtNum(m.runs) }),
        el('td', { textContent: m.lastRun ? fmtDate(m.lastRun) : '-' }),
        el('td', { className: 'num', textContent: fmtNum(m.aiCalls7d) }),
        el('td', { className: 'num', textContent: fmtNum(m.tokens7d) }),
        el('td', { textContent: fmtDate(m.joined) })));
    }
  }

  function badgeFor(e) {
    if (e.private) return el('span', { className: 'badge b-private', textContent: e.local ? '🔒 private · this Mac + Supabase' : '🔒 private · Supabase' });
    if (e.local && e.shared) return el('span', { className: 'badge b-synced', textContent: 'this Mac + shared with team' });
    if (e.local) return el('span', { className: 'badge b-local', textContent: 'this Mac only' });
    return el('span', { className: 'badge b-team', textContent: e.mine ? 'shared with team (other machine)' : 'shared by teammate' });
  }

  function filtered() {
    const q = $('q').value.trim().toLowerCase();
    const project = $('project').value;
    return data.memory.filter((e) => VIEWS[view].test(e)
      && (!project || e.project === project)
      && (!q || `${e.title} ${e.content} ${e.tags.join(' ')} ${e.author}`.toLowerCase().includes(q)));
  }

  function renderMemory() {
    const box = $('memory');
    box.replaceChildren();
    const list = filtered();
    $('tab-help').textContent = `${VIEWS[view].help} ${list.length} shown.`;
    if (!list.length) {
      box.append(el('div', { className: 'empty', textContent: 'Nothing matches.' }));
      $('more').hidden = true;
      return;
    }
    for (const e of list.slice(0, shown)) {
      const meta = el('div', { className: 'meta' },
        badgeFor(e),
        el('span', { className: 'badge', textContent: e.author }),
        el('span', { className: 'badge', textContent: e.project }),
        el('span', { className: 'badge', textContent: e.category }),
        ...e.tags.map((t) => el('span', { className: 'badge', textContent: `#${t}` })),
        el('span', { className: 'muted', textContent: fmtDate(e.createdAt) }));
      const card = el('div', { className: 'mem', tabIndex: 0, role: 'button', 'aria-expanded': 'false' },
        el('div', { className: 't', textContent: e.title }),
        el('div', { className: 'b', textContent: e.content }),
        meta);
      const toggle = () => card.setAttribute('aria-expanded', String(card.classList.toggle('open')));
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
      box.append(card);
    }
    $('more').hidden = list.length <= shown;
  }

  function renderAll() {
    const t = data.totals;
    $('t-members').textContent = data.teamStore === 'on' ? fmtNum(t.members) : '-';
    $('t-mine').textContent = fmtNum(t.mine);
    $('t-shared').textContent = data.teamStore === 'on' ? fmtNum(t.shared) : '-';
    $('t-private').textContent = data.teamStore === 'on' ? fmtNum(t.private) : '-';
    $('t-team').textContent = data.teamStore === 'on' ? fmtNum(t.fromTeammates) : '-';
    $('t-combined').textContent = fmtNum(t.combined);
    $('c-mine').textContent = t.mine;
    $('c-shared').textContent = t.shared;
    $('c-combined').textContent = t.combined;
    if (data.teamName) $('subtitle').textContent = `${data.teamName}: who is on the team and what the agents know.`;
    $('note').hidden = !data.note;
    $('note').textContent = data.note || '';

    const projects = [...new Set(data.memory.map((e) => e.project))].sort();
    const sel = $('project');
    const current = sel.value;
    sel.replaceChildren(el('option', { value: '', textContent: 'All projects' }), ...projects.map((p) => el('option', { value: p, textContent: p })));
    sel.value = projects.includes(current) ? current : '';

    renderMembers(data.members, data.teamStore);
    renderMemory();
  }

  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    shown = PAGE;
    document.querySelectorAll('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    if (data) renderMemory();
  }));
  $('q').addEventListener('input', () => { shown = PAGE; if (data) renderMemory(); });
  $('project').addEventListener('change', () => { shown = PAGE; if (data) renderMemory(); });
  $('more').addEventListener('click', () => { shown += PAGE; renderMemory(); });

  async function load() {
    try {
      const r = await fetch('/api/context/overview');
      if (r.status === 401) { location.href = '/login?redirect=/context'; return; }
      const b = await r.json();
      if (!b.ok) throw new Error(b.error || `HTTP ${r.status}`);
      data = b;
      renderAll();
    } catch (err) {
      $('note').hidden = false;
      $('note').textContent = `Could not load context: ${err.message}`;
    }
  }

  load();
  setInterval(load, 60000);
})();
