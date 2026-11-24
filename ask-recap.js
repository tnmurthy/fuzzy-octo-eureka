// ask-recap.js - the "So far" card at the top of a conversation on the Ask
// page (ask.js): milestones, what was done, decisions, what is open, the next
// step and files changed. API: GET /api/agents/recap?id=. Built from the
// run log and git (exact) plus short notes a local model writes after each
// reply (they appear a little after the reply). textContent only. Cached by
// thread and refetched when a turn changes, or every 5 s while notes are
// still being written.
(function () {
  'use strict';
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const PENDING_MS = 5000;

  const cache = new Map();   // threadId -> { sig, at, data | error, loading }
  let closed = false;        // the person folded the card (kept while the page is open)
  let target = null;
  let shown = null;

  async function load(threadId, sig) {
    const c = cache.get(threadId) || {};
    cache.set(threadId, { ...c, sig, loading: true });
    try {
      const res = await fetch(`/api/agents/recap?id=${encodeURIComponent(threadId)}`);
      const b = await res.json().catch(() => null);
      if (!res.ok || !b || b.ok === false) throw new Error((b && b.error) || `HTTP ${res.status}`);
      cache.set(threadId, { sig, at: Date.now(), data: b });
    } catch (err) {
      cache.set(threadId, { sig, at: Date.now(), error: err.message });
    }
    if (shown === threadId) draw(threadId);
  }

  const row = (label, items) => (items && items.length
    ? el('div', { className: 'ask-recap-row' }, el('span', { className: 'ask-recap-k', textContent: label }), el('span', { textContent: items.join(' · ') }))
    : null);

  function draw(threadId) {
    if (!target) return;
    const c = cache.get(threadId) || {};
    const d = c.data;
    if (!d) { target.replaceChildren(); target.hidden = true; return; }
    const changed = d.changed ? [`${d.changed.files} file(s), +${d.changed.added} −${d.changed.removed}${d.changed.branch ? ` · branch ${d.changed.branch}` : ''}`] : null;
    const rows = [
      d.milestones.length ? el('div', { className: 'ask-recap-flags' }, ...d.milestones.map((m) => el('button', {
        type: 'button', className: `ask-flag${m.manual ? ' manual' : ''}`, textContent: `🏁 ${m.label}`, title: `Go to turn ${m.index + 1}`,
        onclick: () => { const s = document.getElementById(`turn-${m.index + 1}`); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
      }))) : null,
      row('Saved', d.saved),
      row('Helper says', d.reported),
      row('Changed', changed),
      row('Decisions', d.decisions),
      row('Open', d.open),
      row('Next', d.next ? [d.next] : null),
    ].filter(Boolean);
    if (!rows.length && !d.pending) { target.replaceChildren(); target.hidden = true; return; }
    const head = el('summary', { className: 'ask-recap-head' },
      el('span', { textContent: '📌 So far' }),
      el('span', { className: 'ask-muted', textContent: ` ${d.turns} turn${d.turns === 1 ? '' : 's'}${d.milestones.length ? `, ${d.milestones.length} milestone${d.milestones.length === 1 ? '' : 's'}` : ''}` }));
    const box = el('details', { className: 'ask-recap' }, head, ...rows,
      d.pending ? el('div', { className: 'ask-muted', textContent: 'Summarising the latest reply…' }) : null);
    box.open = !closed;
    box.addEventListener('toggle', () => { closed = !box.open; });
    target.replaceChildren(box);
    target.hidden = false;
  }

  /**
   * Show the card for `threadId` in `node`. `sig` changes whenever a turn
   * starts or finishes, which refetches it.
   */
  function render(node, threadId, sig) {
    target = node;
    shown = threadId;
    const c = cache.get(threadId);
    const stale = !c || c.sig !== sig || (c.data && c.data.pending && Date.now() - c.at > PENDING_MS);
    if (stale && !(c && c.loading)) load(threadId, sig);
    draw(threadId);
  }

  /** Forget a thread's card (after marking a milestone). */
  const invalidate = (threadId) => cache.delete(threadId);

  function reset() {
    shown = null;
    if (target) { target.replaceChildren(); target.hidden = true; }
  }

  window.AskRecap = { render, invalidate, reset };
})();
