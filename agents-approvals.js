// agents-approvals.js - Allow/Deny cards on /agents (OMB-3).
//
// A running agent asks here when its approval level does not pre-allow an
// action; nobody answering means no (approvals.js). All text goes in via
// textContent, never innerHTML: commands and paths come from agents.
// Only admins get the list; for anyone else the box stays empty.
(function () {
  'use strict';

  const box = document.getElementById('approvals');
  if (!box) return;

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const left = (deadline) => {
    const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  };

  async function decide(id, decision, remember, msg) {
    msg.textContent = 'Sending…';
    try {
      const res = await fetch('/api/agents/approvals/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, decision, remember }),
      });
      const b = await res.json();
      if (!b.ok) { msg.textContent = b.error || 'Could not send'; return; }
      await refresh();
    } catch (_) {
      msg.textContent = 'Could not reach the dashboard';
    }
  }

  function card(r) {
    const msg = el('span', { className: 'approval-msg' });
    const btn = (label, decision, remember, cls) => el('button', {
      type: 'button', className: `btn-sm ${cls || ''}`, textContent: label,
      onclick: () => decide(r.id, decision, remember, msg),
    });
    return el('div', { className: 'approval-card', role: 'group', ariaLabel: `Approval for ${r.tool}` },
      el('div', { className: 'approval-head' },
        el('strong', { textContent: `${r.tool}` }),
        el('span', { className: 'approval-meta', textContent: ` · ${r.repo} · run ${r.runId} · level ${r.level} · denied in ${left(r.deadline)} if nobody answers` })),
      el('pre', { className: 'approval-input', textContent: r.summary }),
      el('div', { className: 'approval-actions' },
        btn('Allow once', 'allow', false, 'ok'),
        btn('Always allow this exact action', 'allow', true),
        btn('Deny', 'deny', false, 'danger'),
        msg));
  }

  async function refresh() {
    let b;
    try {
      const res = await fetch('/api/agents/approvals');
      if (res.status === 403) { box.replaceChildren(); return; }
      b = await res.json();
    } catch (_) { return; }
    if (!b || !b.ok) return;
    window.dispatchEvent(new CustomEvent('agents:approvals', { detail: b.pending }));
    if (!b.pending.length) { box.replaceChildren(); return; }
    box.replaceChildren(
      el('h3', { className: 'approvals-title', textContent: `Waiting for you (${b.pending.length})` }),
      ...b.pending.map(card));
  }

  refresh();
  setInterval(refresh, 3000);
})();
