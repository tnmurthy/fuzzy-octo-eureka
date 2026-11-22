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

  function row(t) {
    const r = t.run;
    const actions = el('div', { className: 'mt-actions' });
    const btn = (label, fn, cls) => {
      const b = el('button', { type: 'button', className: `btn-sm ${cls || ''}`, textContent: label });
      b.addEventListener('click', fn);
      actions.append(b);
    };
    if (t.issue) {
      actions.append(el('a', { className: 'btn-sm', href: t.issue.url, target: '_blank', rel: 'noopener', textContent: `Issue #${t.issue.number}` }));
    } else if (t.stage.key === 'needs-you') {
      btn('Answer now', () => openFor({ kind: 'approval' }), 'mt-primary');
    } else if (t.stage.key === 'working') {
      if (r.hasLog) btn('Watch', () => page().openLog(r.id));
    } else {
      if (r.hasLog) btn(t.stage.key === 'failed' ? 'See why' : 'See result', () => page().openDeliverable(r), 'mt-primary');
      if (r.canFollowUp) btn('Follow up', () => page().openFollowUp && page().openFollowUp(r));
    }
    return el('div', { className: `mt-row mt-${t.stage.key}` },
      el('span', { className: `mt-pill mt-tone-${t.stage.tone}`, textContent: t.stage.label }),
      el('div', { className: 'mt-main' },
        el('div', { className: 'mt-task', title: r.task || '' },
          r.parent ? el('span', { className: 'muted', textContent: '↳ follow-up: ' }) : null,
          TF.clip(r.task, 140)),
        el('div', { className: 'mt-next muted', textContent: t.stage.next })),
      actions);
  }

  function render() {
    const tasks = TF.myTasks(latest);
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
