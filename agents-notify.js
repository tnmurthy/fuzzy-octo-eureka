// agents-notify.js - "My tasks" strip and alerts on /agents.
//
// Listens to the polls the page already makes ('agents:overview' from
// agents-page.js, 'agents:approvals' from agents-approvals.js), so it adds no
// requests. Shows every task's stage in plain words at the top of the page and
// tells people when a task or follow-up finishes or an agent waits for
// Allow/Deny: in-page toast (always), chime + desktop notification (when
// alerts are on), and "(n)" in the tab title while the tab is in background.
// Tasks that finished while the page was closed are reported on the next
// visit (snapshot in localStorage). All text via textContent.
(function () {
  'use strict';

  const TF = window.TaskFeed;
  const box = document.getElementById('my-tasks');
  if (!TF || !box) return;

  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
  };
  const SNAP_KEY = 'agents.taskSnapshot';
  const alertsOn = () => { try { return localStorage.getItem('task_alerts_enabled') !== 'false'; } catch (_) { return true; } };
  const page = () => window.AgentsPage || {};

  const latest = { running: [], recent: [], approvals: [], queued: [] };
  let snap = null;        // set on the first overview
  let ready = false;
  let unseen = 0;
  const baseTitle = document.title;

  // ---- toasts + title badge ------------------------------------------------
  const toasts = el('div', { className: 'toast-stack', ariaLive: 'polite' });
  document.body.append(toasts);

  function toast(ev, onOpen) {
    const t = el('div', { className: `toast toast-${ev.kind}`, role: 'status' },
      el('strong', { textContent: ev.title }),
      el('div', { className: 'toast-body', textContent: ev.body }));
    const close = el('button', { type: 'button', className: 'toast-x', ariaLabel: 'Dismiss', textContent: '✕' });
    close.addEventListener('click', (e) => { e.stopPropagation(); t.remove(); });
    t.append(close);
    if (ev.approvalId) t.dataset.approval = ev.approvalId;
    t.addEventListener('click', () => { t.remove(); onOpen(); });
    toasts.append(t);
    // Approvals stay until handled; the rest fade after 15 s.
    if (ev.kind !== 'approval') setTimeout(() => t.remove(), 15000);
  }

  function bumpTitle() {
    if (!document.hidden) return;
    unseen += 1;
    document.title = `(${unseen}) ${baseTitle}`;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { unseen = 0; document.title = baseTitle; }
  });

  function openFor(ev) {
    window.focus();
    if (ev.kind === 'approval') {
      if (page().switchTab) page().switchTab('tab-btn-live');
      const a = document.getElementById('approvals');
      if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const r = latest.recent.find((x) => x.id === ev.runId);
    if (r && r.hasLog && page().openDeliverable) page().openDeliverable(r);
    else if (page().openLog) page().openLog(ev.runId);
  }

  function announce(events, away) {
    for (const ev of events) {
      const e = away ? { ...ev, title: `While you were away: ${ev.title.toLowerCase()}` } : ev;
      toast(e, () => openFor(ev));
      bumpTitle();
      if (!alertsOn()) continue;
      if (window.playCompletionChime) window.playCompletionChime(ev.kind !== 'failed');
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const n = new Notification(e.title, { body: e.body, tag: `${ev.kind}-${ev.approvalId || ev.runId}`, requireInteraction: ev.kind === 'approval' });
          n.onclick = () => { n.close(); openFor(ev); };
        } catch (_) {}
      }
    }
  }

  // ---- state -----------------------------------------------------------------
  function update() {
    if (!ready) return;
    const away = snap === null;
    const prev = away ? store.get(SNAP_KEY) : snap;
    // On a fresh visit only finished runs are "while you were away"; pending
    // approvals render in the page anyway, so do not pop them as news.
    const events = TF.diffEvents(prev, latest).filter((e) => !(away && e.kind === 'approval'));
    announce(events, away);
    snap = { running: TF.carryRunning(prev, latest), approvals: latest.approvals.map((a) => a.id) };
    store.set(SNAP_KEY, snap);
    // An approval answered (or timed out) is no longer news.
    const pending = new Set(snap.approvals);
    toasts.querySelectorAll('[data-approval]').forEach((t) => { if (!pending.has(t.dataset.approval)) t.remove(); });
    render();
  }

  // ---- "My tasks" strip ------------------------------------------------------
  function permissionHint() {
    if (!alertsOn() || !('Notification' in window) || Notification.permission === 'granted') return null;
    if (Notification.permission === 'denied') {
      return el('div', { className: 'mt-hint', textContent: 'Desktop alerts are blocked for this site in your browser settings. You will still see alerts on this page.' });
    }
    const b = el('button', { type: 'button', className: 'btn-sm', textContent: '🔔 Turn on desktop alerts' });
    b.addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch (_) {}
      render();
    });
    return el('div', { className: 'mt-hint' }, b, ' Get told when a task finishes or an agent needs your OK, even in another tab.');
  }

  // ---- talking to an agent: reply to its question, or change its course ------
  // One composer open at a time; drafts survive re-renders (every few s).
  let open = null;            // { runId, mode: 'reply' | 'redirect' }
  const drafts = {};
  let held = false;           // a render skipped while someone was typing

  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let b = {};
    try { b = await res.json(); } catch (_) {}
    if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
    return b;
  }

  function composer(r, mode) {
    const key = `${mode}:${r.id}`;
    const ta = el('textarea', {
      className: 'f mt-input', rows: 2, maxLength: 8000, value: drafts[key] || '',
      placeholder: mode === 'reply' ? 'Your answer… (Enter to send, Shift+Enter for a new line)' : 'What should the agent do instead? (Enter to send)',
    });
    ta.dataset.key = key;
    const msg = el('span', { className: 'mt-msg muted' });
    const bar = el('div', { className: 'mt-compose-bar' });
    const close = () => { open = null; delete drafts[key]; held = false; render(); };
    const busy = (on, text) => { bar.querySelectorAll('button').forEach((b) => { b.disabled = on; }); ta.disabled = on; msg.textContent = text || ''; };
    const done = (text) => {
      close();
      toast({ kind: 'done', title: text, body: TF.clip(r.task, 120) }, () => {});
      if (page().refresh) page().refresh();
    };
    const fail = (err) => { busy(false); msg.className = 'mt-msg err'; msg.textContent = err.message; };

    const send = async () => {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (mode === 'reply') {
        busy(true, 'Sending your answer…');
        try { await postJson('/api/agents/followup', { runId: r.id, message: text }); done('Answer sent; the agent is back on it'); } catch (e) { fail(e); }
      } else {
        busy(true, 'Stopping the agent, then restarting it with your instruction… (up to 20 s)');
        try { await postJson('/api/agents/redirect', { runId: r.id, message: text }); done('Agent redirected'); } catch (e) { fail(e); }
      }
    };
    ta.addEventListener('input', () => { drafts[key] = ta.value; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === 'Escape') close(); });
    ta.addEventListener('blur', () => { if (held) setTimeout(() => { if (!box.contains(document.activeElement)) render(); }, 150); });

    const mk = (label, fn, cls) => { const b = el('button', { type: 'button', className: `btn-sm ${cls || ''}`, textContent: label }); b.addEventListener('click', fn); bar.append(b); };
    mk(mode === 'reply' ? '↵ Send answer' : '↪ Stop & redirect', send, 'mt-primary');
    if (mode === 'redirect') {
      mk('■ Just stop', async () => {
        if (!window.confirm('Stop this agent now? Work it has committed stays on its branch; you can follow up later.')) return;
        busy(true, 'Stopping…');
        try { await postJson('/api/agents/stop', { runId: r.id }); done('Agent stopped'); } catch (e) { fail(e); }
      }, 'mt-danger');
    }
    mk('Cancel', close);
    bar.append(msg);
    if (mode === 'reply') {
      const chips = el('div', { className: 'mt-chips' }, ...['Yes, go ahead', 'No, keep it as it is', 'Your call; pick the simplest option'].map((c) => {
        const b = el('button', { type: 'button', className: 'chip', textContent: c });
        b.addEventListener('click', () => { ta.value = c; drafts[key] = c; ta.focus(); });
        return b;
      }));
      return el('div', { className: 'mt-compose' }, chips, ta, bar);
    }
    return el('div', { className: 'mt-compose' }, ta, bar);
  }

  function row(t) {
    const r = t.run;
    const actions = el('div', { className: 'mt-actions' });
    const btn = (label, fn, cls) => {
      const b = el('button', { type: 'button', className: `btn-sm ${cls || ''}`, textContent: label });
      b.addEventListener('click', fn);
      actions.append(b);
    };
    const toggle = (mode) => () => {
      open = open && open.runId === r.id && open.mode === mode ? null : { runId: r.id, mode };
      render();
      const ta = box.querySelector('.mt-input');
      if (ta) ta.focus();
    };
    if (t.issue) {
      actions.append(el('a', { className: 'btn-sm', href: t.issue.url, target: '_blank', rel: 'noopener', textContent: `Issue #${t.issue.number}` }));
    } else if (t.stage.question) {
      if (r.canFollowUp) btn('Reply', toggle('reply'), 'mt-primary');
      if (r.hasLog) btn('See result', () => page().openDeliverable(r));
    } else if (t.stage.key === 'needs-you') {
      btn('Answer now', () => openFor({ kind: 'approval' }), 'mt-primary');
    } else if (t.stage.key === 'working') {
      btn('Change course', toggle('redirect'));
      if (r.hasLog) btn('Watch', () => page().openLog(r.id));
    } else {
      if (r.hasLog) btn(t.stage.key === 'failed' ? 'See why' : 'See result', () => page().openDeliverable(r), 'mt-primary');
      if (r.canFollowUp) btn('Follow up', () => page().openFollowUp && page().openFollowUp(r));
    }
    const main = el('div', { className: 'mt-main' },
      el('div', { className: 'mt-task', title: r.task || '' },
        r.parent ? el('span', { className: 'muted', textContent: '↳ follow-up: ' }) : null,
        TF.clip(r.task, 140)),
      el('div', { className: `mt-next ${t.stage.question ? 'mt-question' : 'muted'}`, textContent: t.stage.next }));
    const rowEl = el('div', { className: `mt-row mt-${t.stage.key}` },
      el('span', { className: `mt-pill mt-tone-${t.stage.tone}`, textContent: t.stage.label }),
      main,
      actions);
    const fits = open && open.runId === r.id
      && ((open.mode === 'reply' && t.stage.question) || (open.mode === 'redirect' && t.stage.key === 'working'));
    if (fits) rowEl.append(composer(r, open.mode));
    return rowEl;
  }

  function render() {
    // Never rebuild under someone's fingers: wait until they leave the box.
    const typing = document.activeElement && document.activeElement.classList.contains('mt-input') && box.contains(document.activeElement);
    if (typing) { held = true; return; }
    held = false;
    const tasks = TF.myTasks(latest);
    if (open && !tasks.some((t) => t.run.id === open.runId)) open = null;
    const needs = tasks.filter((t) => t.stage.key === 'needs-you').length;
    const head = el('div', { className: 'mt-head' },
      el('h2', { className: 'card-title', textContent: 'My tasks' }),
      el('span', { className: 'muted', textContent: needs ? `${needs} waiting for you` : 'Last 24 hours · updates every 5 s' }));
    const list = tasks.length
      ? el('div', { className: 'mt-list' }, ...tasks.map(row))
      : el('div', { className: 'empty', textContent: 'No tasks yet. Describe what you need on the left and press Start; it will show up here with its status.' });
    box.replaceChildren(head, permissionHint(), list);
  }

  window.addEventListener('agents:overview', (e) => {
    const b = e.detail || {};
    latest.running = b.running || [];
    latest.recent = b.recent || [];
    latest.queued = (b.queue && b.queue.available && b.queue.columns && b.queue.columns.ready) || [];
    ready = true;
    update();
  });
  let approvalsSeen = false;
  window.addEventListener('agents:approvals', (e) => {
    latest.approvals = e.detail || [];
    // First answer is the baseline: requests already pending when the page
    // opened are on screen, not news.
    if (!approvalsSeen && snap) snap = { ...snap, approvals: latest.approvals.map((a) => a.id) };
    approvalsSeen = true;
    update();
  });
})();
