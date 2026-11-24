// ask-draft.js - what you can do with a request's draft copy on the Ask page
// (ask.js): Undo last step, Discard draft, and (admins) Send for review,
// which pushes the branch after the secret scan and opens GitHub's pull
// request page. APIs: POST /api/agents/draft {runId, action},
// POST /api/agents/run/push-pr {runId}. The conversation re-renders every
// 3 s, so each run's last message is kept here.
(function () {
  'use strict';
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const notes = new Map(); // runId -> { text, err, link }

  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let b = null;
    try { b = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !b || b.ok === false) throw new Error((b && b.error) || `HTTP ${res.status}`);
    return b;
  }

  /** Undo the last saved step of the request `run` belongs to. Resolves to a message. */
  async function undo(run) {
    if (!confirm('Undo the helper\'s last saved step? It is reverted with a new step, so nothing is lost.')) return null;
    const r = await post('/api/agents/draft', { runId: run.id, action: 'undo' });
    return `Undone: ${r.undone}`;
  }

  async function discard(run) {
    if (!confirm('Discard this draft? The draft copy is removed. The work is kept on a "discarded" branch an admin can recover.')) return null;
    const r = await post('/api/agents/draft', { runId: run.id, action: 'discard' });
    return `Draft discarded (kept as ${r.kept}).`;
  }

  async function review(run) {
    if (!confirm('Send this draft for review? The branch is pushed to GitHub (after a secret check) and the pull request page opens.')) return null;
    const r = await post('/api/agents/run/push-pr', { runId: run.id });
    const link = /^https:\/\/github\.com\//.test(String(r.prUrl || '')) ? r.prUrl : null;
    if (link) window.open(link, '_blank', 'noopener');
    return { text: `Pushed ${r.branch}.`, link };
  }

  /**
   * The draft bar under the Files changed panel of a finished change.
   * @param {object} run  the request's latest changing run
   * @param {{admin: boolean, onDone: () => void}} o
   */
  function bar(run, { admin, onDone }) {
    const msg = el('div', { className: 'ask-msg' });
    const show = () => {
      const n = notes.get(run.id);
      msg.className = `ask-msg${n && n.err ? ' err' : ''}`;
      msg.replaceChildren(n ? n.text : '', n && n.link ? el('a', { href: n.link, target: '_blank', rel: 'noopener noreferrer', textContent: ' Open the pull request page ↗' }) : '');
    };
    const buttons = [];
    const act = (label, title, fn) => {
      const b = el('button', { type: 'button', className: 'ask-btn', textContent: label, title });
      b.addEventListener('click', async () => {
        buttons.forEach((x) => { x.disabled = true; });
        try {
          const out = await fn(run);
          if (out) notes.set(run.id, typeof out === 'string' ? { text: out } : out);
          if (out) onDone();
        } catch (err) {
          notes.set(run.id, { text: `Could not do that: ${err.message}`, err: true });
        }
        buttons.forEach((x) => { x.disabled = false; });
        show();
      });
      buttons.push(b);
      return b;
    };
    act('↶ Undo last step', 'Revert the helper\'s last saved step', undo);
    act('🗑 Discard draft', 'Throw this draft away', discard);
    if (admin) act('🚀 Send for review', 'Push the branch and open a pull request', review);
    show();
    return el('div', { className: 'ask-draft' }, el('div', { className: 'ask-make-row' }, ...buttons), msg);
  }

  window.AskDraft = { bar, undo };
})();
