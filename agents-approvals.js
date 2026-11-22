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

  // "Always allow" rules: what agents may do without asking, per repo, with
  // Revoke (pattern from OpenClaw's standing grants; rewritten). Plus the
  // last decisions, so people can see what was allowed, denied or timed out.
  let standingOpen = false;
  function standing(always, recent) {
    const repos = Object.entries(always).filter(([, keys]) => keys.length);
    const total = repos.reduce((n, [, keys]) => n + keys.length, 0);
    if (!total && !recent.length) return null;
    const d = el('details', { className: 'standing' });
    d.open = standingOpen;
    d.addEventListener('toggle', () => { standingOpen = d.open; });
    d.append(el('summary', { textContent: `Always allowed (${total}) · recent decisions (${recent.length})` }));
    for (const [repo, keys] of repos) {
      d.append(el('div', { className: 'standing-repo', textContent: repo }));
      for (const key of keys) {
        const msg = el('span', { className: 'approval-msg' });
        const revoke = el('button', { type: 'button', className: 'btn-sm danger', textContent: 'Revoke' });
        revoke.addEventListener('click', async () => {
          if (!window.confirm(`Agents in ${repo} will have to ask again before:\n${key}`)) return;
          revoke.disabled = true;
          try {
            const res = await fetch('/api/agents/approvals/always/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, key }) });
            const r = await res.json();
            if (!r.ok) throw new Error(r.error || `HTTP ${res.status}`);
            await refresh();
          } catch (err) { msg.textContent = err.message; revoke.disabled = false; }
        });
        d.append(el('div', { className: 'standing-row' }, el('code', { textContent: key }), revoke, msg));
      }
    }
    if (recent.length) {
      d.append(el('div', { className: 'standing-repo', textContent: 'Recent decisions' }));
      for (const r of recent.slice(0, 10)) {
        const when = new Date(r.decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        d.append(el('div', { className: `standing-row standing-${r.status}` },
          el('span', { className: 'mono', textContent: when }),
          el('span', { textContent: `${r.status === 'allowed' ? '✓' : '✕'} ${r.tool} · ${r.repo}` }),
          el('span', { className: 'approval-meta', textContent: `${r.reason}${r.decidedBy && r.decidedBy !== 'timeout' ? ` (${r.decidedBy})` : ''}` })));
      }
    }
    return d;
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
    const waiting = b.pending.length
      ? [el('h3', { className: 'approvals-title', textContent: `Waiting for you (${b.pending.length})` }), ...b.pending.map(card)]
      : [];
    box.replaceChildren(...waiting, standing(b.alwaysAllow || {}, b.recent || []));
  }

  refresh();
  setInterval(refresh, 3000);
})();
