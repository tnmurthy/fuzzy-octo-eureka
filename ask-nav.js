// ask-nav.js - getting around a long conversation on the Ask page (ask.js):
// collapsible turns (older ones folded), long replies clipped behind "Show all",
// a toolbar (New chat, Collapse all, Expand all, Top, Latest, Go to turn) and
// floating top / latest buttons. Fold state lives here, keyed by run id, so the
// conversation can re-render every few seconds without undoing what you opened.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  const OPEN_LATEST = 2;        // turns left open by default, counted from the end
  const CLIP_CHARS = 1800;      // replies longer than this are clipped

  let folded = new Map();       // runId -> true when folded
  let unclipped = new Set();    // reply keys shown in full

  function reset() {
    folded = new Map();
    unclipped = new Set();
  }

  const turns = () => [...document.querySelectorAll('#convo .ask-turn')];

  function setFold(section, fold) {
    folded.set(section.dataset.run, fold);
    section.classList.toggle('folded', fold);
    const btn = section.querySelector('.ask-turn-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', String(!fold));
      btn.title = fold ? 'Show this turn' : 'Fold this turn';
    }
  }

  /**
   * One turn: your message and the helper's reply, with a header that folds it.
   * @param {{runId: string, index: number, total: number, summary: string, meta: string, body: Node[], flag?: string|null}} o
   */
  function turn({ runId, index, total, summary, meta, body, flag = null }) {
    if (!folded.has(runId)) folded.set(runId, index < total - OPEN_LATEST);
    const fold = folded.get(runId);
    const btn = el('button', { type: 'button', className: 'ask-turn-toggle' },
      el('span', { className: 'ask-turn-caret', textContent: '▾' }),
      el('span', { className: 'ask-turn-n', textContent: `${index + 1}` }),
      flag ? el('span', { className: 'ask-turn-flag', textContent: `🏁 ${flag}`, title: 'Milestone' }) : null,
      el('span', { className: 'ask-turn-sum', textContent: summary }),
      el('span', { className: 'ask-turn-meta', textContent: meta }));
    const section = el('section', { className: `ask-turn${fold ? ' folded' : ''}`, id: `turn-${index + 1}` },
      btn, el('div', { className: 'ask-turn-body' }, ...body));
    section.dataset.run = runId;
    btn.setAttribute('aria-expanded', String(!fold));
    btn.title = fold ? 'Show this turn' : 'Fold this turn';
    btn.addEventListener('click', () => setFold(section, !section.classList.contains('folded')));
    return section;
  }

  /** A reply; long ones are clipped behind "Show all" unless `open`. `md`: format it (ask-md.js). */
  function reply(text, key, { open = false, md = false } = {}) {
    const pre = md && window.AskMd ? window.AskMd.render(text) : el('pre', { className: 'ask-answer', textContent: text });
    if (open || String(text).length <= CLIP_CHARS) return pre;
    const wrap = el('div', { className: `ask-clip${unclipped.has(key) ? ' open' : ''}` }, pre);
    const more = el('button', { type: 'button', className: 'ask-clip-btn' });
    const label = () => { more.textContent = wrap.classList.contains('open') ? 'Show less' : `Show all (${Math.ceil(String(text).length / 1000)}k characters)`; };
    label();
    more.addEventListener('click', () => {
      const isOpen = wrap.classList.toggle('open');
      if (isOpen) unclipped.add(key); else { unclipped.delete(key); wrap.scrollIntoView({ block: 'nearest' }); }
      label();
    });
    return el('div', {}, wrap, more);
  }

  /** Fill "Go to turn…" after each render. */
  function setJump(items) {
    const sel = $('nav-jump');
    if (!sel) return;
    sel.hidden = items.length < 3;
    const keep = sel.value;
    sel.replaceChildren(el('option', { value: '', textContent: 'Go to turn…' }),
      ...items.map((t, i) => el('option', { value: String(i + 1), textContent: `${i + 1}. ${t.slice(0, 60)}` })));
    sel.value = keep && Number(keep) <= items.length ? keep : '';
  }

  const toTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });
  const toLatest = () => {
    const all = turns();
    const last = all[all.length - 1];
    if (last && last.classList.contains('folded')) setFold(last, false);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  function init({ onNew }) {
    $('nav-new').addEventListener('click', onNew);
    $('nav-fold').addEventListener('click', () => {
      const all = turns();
      all.forEach((s, i) => setFold(s, i < all.length - 1));
    });
    $('nav-unfold').addEventListener('click', () => turns().forEach((s) => setFold(s, false)));
    $('nav-top').addEventListener('click', toTop);
    $('nav-latest').addEventListener('click', toLatest);
    $('float-top').addEventListener('click', toTop);
    $('float-latest').addEventListener('click', toLatest);
    $('nav-jump').addEventListener('change', (e) => {
      const s = $(`turn-${e.target.value}`);
      if (!s) return;
      setFold(s, false);
      s.scrollIntoView({ behavior: 'smooth', block: 'start' });
      e.target.value = '';
    });
    const floats = $('ask-floats');
    const onScroll = () => {
      const threadOpen = !$('view-thread').hidden;
      const y = window.scrollY;
      const fromBottom = document.body.scrollHeight - (window.innerHeight + y);
      $('float-top').hidden = !threadOpen || y < 400;
      $('float-latest').hidden = !threadOpen || fromBottom < 400;
      floats.hidden = $('float-top').hidden && $('float-latest').hidden;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    setInterval(onScroll, 1000);
    // Keyboard: Alt+N new chat, Alt+Up top, Alt+Down latest (not while typing).
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'n' || e.key === 'N' || e.code === 'KeyN') { e.preventDefault(); onNew(); }
      else if (e.key === 'ArrowUp' && !$('view-thread').hidden) { e.preventDefault(); toTop(); }
      else if (e.key === 'ArrowDown' && !$('view-thread').hidden) { e.preventDefault(); toLatest(); }
    });
  }

  window.AskNav = { init, reset, turn, reply, setJump };
})();
