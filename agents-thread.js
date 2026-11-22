// agents-thread.js - one task as a conversation, in a drawer on /agents.
//
// Patterns from OpenClaw's chat composer (MIT; rewritten, no code copied):
// a task card above the input that never moves (state, working clock,
// question), the conversation (your messages, the agent's answers, live
// steps while it works), and a queue for messages written while the agent
// works - edit, reorder, drop, or "steer now" (stop and redirect).
// Data: GET /api/agents/thread, POST /api/agents/queue[/update|/steer].
// All text via textContent: tasks and answers come from people and agents.
(function () {
  'use strict';

  const TF = window.TaskFeed;
  const RS = window.RunSteps;
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const page = () => window.AgentsPage || {};
  const ago = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };
  const stripFollowUp = (t) => String(t || '').replace(/^Follow-up:\s*/, '').replace(/^the person stopped you mid-task and changed direction\..*?New instruction:\s*/s, '↪ ');

  async function postJson(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let b = {};
    try { b = await res.json(); } catch (_) {}
    if (!res.ok || !b.ok) throw new Error(b.error || `HTTP ${res.status}`);
    return b;
  }

  // ---- drawer skeleton (built once) -------------------------------------------
  const drawer = el('aside', { className: 'thread-drawer', id: 'thread-drawer', ariaLabel: 'Task conversation', role: 'dialog' });
  drawer.hidden = true;
  const titleEl = el('h2', { className: 'td-title' });
  const closeBtn = el('button', { type: 'button', className: 'btn-sm', textContent: 'Close ✕', ariaLabel: 'Close conversation' });
  const card = el('div', { className: 'td-card' });
  const convo = el('div', { className: 'td-convo', ariaLive: 'polite' });
  const queueBox = el('div', { className: 'td-queue' });
  const input = el('textarea', { className: 'f td-input', rows: 2, maxLength: 8000, ariaLabel: 'Message the agent' });
  const sendBtn = el('button', { type: 'button', className: 'btn-sm td-send' });
  const hint = el('div', { className: 'td-hint muted' });
  const msg = el('div', { className: 'td-msg' });
  drawer.append(
    el('div', { className: 'td-head' }, titleEl, closeBtn),
    card, convo, queueBox,
    el('div', { className: 'td-composer' }, input, el('div', { className: 'td-bar' }, hint, sendBtn), msg));
  document.body.append(drawer);

  let openId = null;
  let data = null;
  let timer = null;
  let editing = null; // queue item id being edited (hold re-renders)
  const logCache = new Map();

  function close() {
    drawer.hidden = true;
    openId = null;
    data = null;
    if (timer) clearInterval(timer);
    timer = null;
  }
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden && !editing) close(); });

  const latest = () => (data && data.runs.length ? data.runs[data.runs.length - 1] : null);
  const working = () => { const l = latest(); return Boolean(l && l.status === 'running'); };

  // ---- task card: one line that says where the task is ------------------------
  function renderCard() {
    const l = latest();
    if (!l) { card.replaceChildren(); return; }
    const st = TF ? TF.stageOf(l, []) : { label: l.status, tone: 'muted', next: '' };
    const kids = [el('span', { className: `mt-pill mt-tone-${st.tone}`, textContent: st.label })];
    if (l.status === 'running') kids.push(el('span', { className: 'td-clock mono', textContent: ago(Date.now() - Date.parse(l.started_at)) }));
    kids.push(el('span', { className: `td-next ${st.question ? 'mt-question' : 'muted'}`, textContent: st.next }));
    const actions = el('div', { className: 'td-card-actions' });
    if (l.hasLog) {
      const b = el('button', { type: 'button', className: 'btn-sm', textContent: l.status === 'running' ? 'Raw log' : 'Deliverable' });
      b.addEventListener('click', () => (l.status === 'running' ? page().openLog(l.id) : page().openDeliverable(l)));
      actions.append(b);
    }
    card.replaceChildren(el('div', { className: 'td-card-row' }, ...kids), actions);
  }

  // ---- conversation ---------------------------------------------------------------
  function bubble(who, text, cls) {
    return el('div', { className: `td-msg-row td-${who}${cls ? ` ${cls}` : ''}` },
      el('div', { className: 'td-who', textContent: who === 'you' ? 'You' : 'Agent' }),
      el('div', { className: 'td-bubble', textContent: text }));
  }

  function liveSteps(run) {
    const box = el('div', { className: 'live-steps td-steps' });
    const text = logCache.get(run.id);
    if (!RS || !text) { box.append(el('div', { className: 'muted', textContent: 'Starting up…' })); return box; }
    box.append(el('div', { className: 'live-sum muted', textContent: RS.summary(text) }));
    for (const st of RS.parseSteps(text, 10)) {
      box.append(el('div', { className: `live-step live-${st.kind}` },
        el('span', { className: 'live-t mono', textContent: st.t }), el('span', { className: 'live-ic', textContent: st.icon }), el('span', { className: 'live-x', textContent: st.text })));
    }
    return box;
  }

  function renderConvo() {
    const stick = convo.scrollHeight - convo.scrollTop - convo.clientHeight < 40;
    const rows = [];
    for (const r of data.runs) {
      rows.push(bubble('you', stripFollowUp(r.task)));
      if (r.status === 'running') {
        rows.push(el('div', { className: 'td-msg-row td-agent' }, el('div', { className: 'td-who', textContent: `Agent · ${r.agent} · working` }), liveSteps(r)));
      } else {
        const meta = [r.agent, r.status === 'done' ? null : r.status, r.commits_ahead ? `${r.commits_ahead} change(s)` : null].filter(Boolean).join(' · ');
        const b = bubble('agent', r.answer || (r.status === 'done' ? '(finished without a written answer)' : `(${r.status})`), r.status === 'failed' ? 'td-failed' : '');
        b.firstChild.textContent = `Agent · ${meta}`;
        rows.push(b);
        if (r.question) rows.push(el('div', { className: 'td-ask mt-question', textContent: `❓ ${r.question}` }));
      }
    }
    convo.replaceChildren(...rows);
    if (stick) convo.scrollTop = convo.scrollHeight;
  }

  // ---- queue --------------------------------------------------------------------------
  function renderQueue() {
    if (editing) return;
    const items = data.queue || [];
    if (!items.length) { queueBox.replaceChildren(); return; }
    const head = el('div', { className: 'td-queue-head' },
      el('strong', { textContent: `Queued (${items.length})` }),
      el('span', { className: 'muted', textContent: working() ? ' · sent one by one when the agent finishes' : ' · sending…' }));
    const rows = items.map((it, i) => {
      const act = el('div', { className: 'td-q-actions' });
      const btn = (label, title, fn, cls) => {
        const b = el('button', { type: 'button', className: `btn-sm ${cls || ''}`, textContent: label, title });
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await fn(); } catch (err) { msg.className = 'td-msg err'; msg.textContent = err.message; }
          await refresh();
        });
        act.append(b);
      };
      const upd = (body) => postJson('/api/agents/queue/update', { threadId: data.threadId, itemId: it.id, ...body });
      if (i > 0) btn('↑', 'Move up', () => upd({ move: 'up' }));
      if (i < items.length - 1) btn('↓', 'Move down', () => upd({ move: 'down' }));
      btn('Edit', 'Edit this message', async () => startEdit(it));
      if (working()) {
        btn('Steer now', 'Stop the agent and give it this message now', async () => {
          if (!window.confirm('Stop the agent now and give it this message? Committed work stays on its branch.')) return;
          msg.className = 'td-msg';
          msg.textContent = 'Stopping the agent and redirecting it… (up to 20 s)';
          await postJson('/api/agents/queue/steer', { threadId: data.threadId, itemId: it.id });
          msg.textContent = 'Redirected.';
        }, 'mt-primary');
      }
      btn('✕', 'Remove from the queue', () => upd({ remove: true }), 'mt-danger');
      return el('div', { className: `td-q-row${it.error ? ' td-q-err' : ''}` },
        el('span', { className: 'td-q-n mono', textContent: String(i + 1) }),
        el('div', { className: 'td-q-text' }, it.text, it.error ? el('div', { className: 'td-q-error', textContent: `Not sent: ${it.error}. Edit it to try again.` }) : null),
        act);
    });
    queueBox.replaceChildren(head, ...rows);
  }

  function startEdit(it) {
    editing = it.id;
    const ta = el('textarea', { className: 'f', rows: 3, maxLength: 8000, value: it.text });
    const save = el('button', { type: 'button', className: 'btn-sm mt-primary', textContent: 'Save' });
    const cancel = el('button', { type: 'button', className: 'btn-sm', textContent: 'Cancel' });
    const done = async (body) => {
      try { if (body) await postJson('/api/agents/queue/update', { threadId: data.threadId, itemId: it.id, ...body }); } catch (err) { msg.className = 'td-msg err'; msg.textContent = err.message; }
      editing = null;
      await refresh();
    };
    save.addEventListener('click', () => done({ text: ta.value }));
    cancel.addEventListener('click', () => done(null));
    queueBox.replaceChildren(el('div', { className: 'td-queue-head' }, el('strong', { textContent: 'Edit queued message' })), ta, el('div', { className: 'td-bar' }, save, cancel));
    ta.focus();
  }

  // ---- composer ----------------------------------------------------------------------
  function renderComposer() {
    const l = latest();
    const busy = working();
    const can = l && (busy || l.canFollowUp || (data.queue && data.queue.length));
    sendBtn.textContent = busy ? '⏳ Queue' : '↵ Send';
    input.placeholder = busy
      ? 'The agent is working. Write your next instruction; it is sent when the agent finishes (Enter to queue).'
      : (l && l.question ? 'Answer the agent… (Enter to send)' : 'Tell the agent what to do next… (Enter to send)');
    hint.textContent = busy
      ? 'Queued messages go out one by one, as follow-ups. Use "Steer now" to interrupt instead.'
      : (can ? 'Continues the same conversation on the same branch. Paid if the agent is Claude.' : 'This task cannot be continued (no saved session).');
    sendBtn.disabled = !can;
    input.disabled = !can;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    sendBtn.disabled = true;
    msg.className = 'td-msg';
    msg.textContent = working() ? 'Queuing…' : 'Sending…';
    try {
      const b = await postJson('/api/agents/queue', { runId: openId, text });
      input.value = '';
      msg.textContent = b.queued ? 'Queued. It goes out when the agent finishes.' : 'Sent. The agent is on it.';
      if (page().refresh) page().refresh();
    } catch (err) {
      msg.className = 'td-msg err';
      msg.textContent = err.message;
    }
    await refresh();
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // ---- data ---------------------------------------------------------------------------
  async function refresh() {
    if (!openId || document.hidden) return;
    try {
      const res = await fetch(`/api/agents/thread?id=${encodeURIComponent(openId)}`);
      const b = await res.json();
      if (!b.ok) throw new Error(b.error || `HTTP ${res.status}`);
      data = b;
      const run = latest();
      if (run && run.status === 'running') {
        const lr = await fetch(`/api/agents/log?id=${encodeURIComponent(run.id)}`).then((x) => x.json()).catch(() => null);
        if (lr && lr.ok) logCache.set(run.id, lr.text);
      }
      titleEl.textContent = TF ? TF.clip(stripFollowUp(data.runs[0].task), 90) : data.runs[0].task;
      renderCard();
      renderConvo();
      renderQueue();
      renderComposer();
    } catch (err) {
      msg.className = 'td-msg err';
      msg.textContent = `Could not load this task: ${err.message}`;
    }
  }

  function open(runId) {
    openId = runId;
    data = null;
    editing = null;
    msg.textContent = '';
    convo.replaceChildren(el('div', { className: 'muted', textContent: 'Loading…' }));
    queueBox.replaceChildren();
    drawer.hidden = false;
    refresh().then(() => { convo.scrollTop = convo.scrollHeight; input.focus(); });
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, 3000);
  }

  window.AgentsThread = { open, close };
})();
