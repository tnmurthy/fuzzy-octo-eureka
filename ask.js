// ask.js - the Ask page (/agents): ask a helper, follow your requests.
// Everything the agents write is shown with textContent, never innerHTML.
// APIs: GET /api/agents/mine, /api/agents/repos, /api/agents/thread,
// /api/agents/log; POST /api/agents/run, /api/agents/queue, /api/agents/stop,
// /api/agents/plan/approve, /api/agents/make-changes, /api/agents/milestone.
// Navigation: ask-nav.js; files changed: ask-files.js; "So far": ask-recap.js;
// formatted replies: ask-md.js; undo / discard / send for review: ask-draft.js.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const ago = (iso) => {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (!Number.isFinite(s)) return '';
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };
  const TONES = { 'needs-you': 'amber', working: 'blue', queued: 'muted', review: 'green', done: 'green', failed: 'red', stopped: 'muted' };

  async function api(url, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = '/login?redirect=/agents'; throw new Error('signed out'); }
    let b = null;
    try { b = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !b || b.ok === false) throw new Error((b && b.error) || `HTTP ${res.status}`);
    return b;
  }

  const state = { openId: null, me: null, mode: null, admin: false, threads: [] };

  // ---- the list: My requests ------------------------------------------------
  function renderThreads() {
    const box = $('threads');
    if (!state.threads.length) {
      box.replaceChildren(el('div', { className: 'ask-empty', textContent: 'No requests yet. Ask for something and it shows up here, with its progress.' }));
      return;
    }
    box.replaceChildren(...state.threads.map((t) => {
      const tone = TONES[t.stage.key] || 'muted';
      const b = el('button', { type: 'button', className: `ask-item${t.threadId === state.openThread ? ' active' : ''}` },
        el('div', { className: 'ask-item-title', textContent: shortTitle(t.title) || '(untitled)', title: t.title || '' }),
        el('div', { className: 'ask-item-meta' },
          el('span', { className: `ask-pill tone-${tone}`, textContent: t.stage.label }),
          el('span', { textContent: [t.repo, ago(t.updatedAt)].filter(Boolean).join(' · ') })));
      b.addEventListener('click', () => openThread(t.runId));
      return b;
    }));
  }

  function renderMode() {
    const note = $('mode-note');
    const expert = $('expert-opt');
    const send = $('new-send');
    send.disabled = false;
    expert.hidden = false;
    note.hidden = true;
    const changeChip = document.querySelector('.ask-kinds button[data-kind=change]');
    changeChip.disabled = !state.admin && (state.mode === 'readonly' || state.mode === 'off');
    changeChip.title = changeChip.disabled ? 'Changes are switched off for teammates right now' : '';
    if (changeChip.disabled && kind === 'change') setKind('answer', false);
    if (state.admin) return;
    const say = (text) => { note.textContent = text; note.hidden = false; };
    if (state.mode === 'readonly') {
      expert.hidden = true;
      document.querySelector('input[name=helper][value=hermes]').checked = true;
      say('Right now requests get answers and documents only: the helper reads your project and replies, but does not change any files.');
    } else if (state.mode === 'claude') {
      expert.hidden = true;
      say('Right now every request goes to the expert helper. Risky steps wait for an admin to approve them.');
    } else if (state.mode === 'off') {
      expert.hidden = true;
      send.disabled = true;
      say('Helpers are switched off for now. Ask an admin to turn them back on.');
    }
  }

  async function loadMine() {
    try {
      const b = await api('/api/agents/mine');
      Object.assign(state, { me: b.me, mode: b.teammateMode, admin: b.admin, threads: b.threads || [] });
      $('ops-link').hidden = !b.admin;
      if (b.cap && b.cap.cap > 0) {
        $('budget').hidden = false;
        $('budget').textContent = `Expert runs today: ${b.cap.used} of ${b.cap.cap}`;
      }
      renderThreads();
      renderMode();
    } catch (err) {
      if (err.message !== 'signed out') $('threads').replaceChildren(el('div', { className: 'ask-empty', textContent: `Could not load your requests (${err.message}).` }));
    }
  }

  async function loadProjects() {
    try {
      const b = await api('/api/agents/repos');
      const sel = $('project');
      const repos = (b.repos || []).filter((r) => r.exists !== false);
      sel.replaceChildren(...repos.map((r) => el('option', { value: r.name, textContent: r.name })));
      let saved = null;
      try { saved = localStorage.getItem('ask.project'); } catch (_) { /* private mode */ }
      if (saved && repos.some((r) => r.name === saved)) sel.value = saved;
      const hint = () => { const r = repos.find((x) => x.name === sel.value); $('project-hint').textContent = r ? r.path : ''; };
      sel.addEventListener('change', () => { hint(); try { localStorage.setItem('ask.project', sel.value); } catch (_) { /* ignore */ } });
      hint();
    } catch (err) {
      $('project-hint').textContent = `Could not load projects (${err.message}).`;
    }
  }

  // ---- what kind of request (request-kinds.js on the server) ------------------
  const KIND_NOTES = {
    answer: 'The helper reads your project and replies in plain words. Nothing is changed. Free.',
    document: 'The helper writes the document in its reply, ready to copy or download. Nothing is changed. Free.',
    change: 'First you get a short plan (free). Nothing changes until you press Go ahead.',
  };
  const SEND_LABEL = { answer: 'Ask the helper →', document: 'Write the document →', change: 'Get a plan first →' };
  let kind = 'answer';
  let kindPinned = false;
  let kindTimer = null;
  function setKind(k, guessed) {
    kind = k;
    for (const b of document.querySelectorAll('.ask-kinds button')) b.setAttribute('aria-checked', String(b.dataset.kind === k));
    $('kind-note').textContent = KIND_NOTES[k] || '';
    $('kind-src').textContent = guessed ? '(my guess: tap to change)' : '';
    $('new-send').textContent = SEND_LABEL[k] || SEND_LABEL.answer;
  }
  for (const b of document.querySelectorAll('.ask-kinds button')) {
    b.addEventListener('click', () => { kindPinned = true; setKind(b.dataset.kind, false); });
  }
  $('request').addEventListener('input', () => {
    if (kindPinned) return;
    clearTimeout(kindTimer);
    const q = $('request').value.trim();
    if (q.length < 6) return;
    kindTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/agents/request-kind?q=${encodeURIComponent(q.slice(0, 600))}`);
        const change = document.querySelector('.ask-kinds button[data-kind=change]');
        if (!kindPinned && $('request').value.trim() === q && !(r.kind === 'change' && change.disabled)) setKind(r.kind, true);
      } catch (_) { /* keep the current kind */ }
    }, 700);
  });

  // ---- a new request ---------------------------------------------------------
  function showNew() {
    state.openId = null;
    state.openThread = null;
    $('view-thread').hidden = true;
    $('view-new').hidden = false;
    if (location.hash) history.replaceState(null, '', location.pathname);
    renderThreads();
    window.scrollTo(0, 0);
    $('request').focus();
  }

  for (const b of document.querySelectorAll('#starters button')) {
    b.addEventListener('click', () => {
      const ta = $('request');
      const rest = ta.value.replace(/^(Explain how this works|Something is wrong|Please change|Check for problems in|Write a short document about): /, '');
      ta.value = b.dataset.prefix + rest;
      if (b.dataset.kind) { kindPinned = true; setKind(b.dataset.kind, false); }
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }

  $('new-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('request').value.trim();
    const msg = $('new-msg');
    if (!text) return;
    const nl = text.indexOf('\n');
    const first = (nl === -1 ? text : text.slice(0, nl)).trim();
    const title = first.length > 200 ? `${first.slice(0, 197)}...` : first;
    const body = (first.length > 200 ? text : nl === -1 ? '' : text.slice(nl + 1)).trim();
    const helper = (document.querySelector('input[name=helper]:checked') || {}).value || 'hermes';
    $('new-send').disabled = true;
    msg.className = 'ask-msg';
    msg.textContent = 'Sending…';
    try {
      const r = await api('/api/agents/run', { repo: $('project').value, agent: helper, title, body, kind });
      $('request').value = '';
      kindPinned = false;
      setKind('answer', false);
      msg.textContent = '';
      await loadMine();
      openThread(r.runId);
    } catch (err) {
      msg.className = 'ask-msg err';
      msg.textContent = `Not sent: ${err.message}`;
    } finally {
      $('new-send').disabled = state.mode === 'off' && !state.admin;
    }
  });

  // ---- one thread --------------------------------------------------------------
  // The task as the person wrote it: without the follow-up wording and the
  // recap block run-recap.js adds for the agent.
  const stripPrefix = (task) => String(task || '')
    .replace(/\s*Where this request stands \(a summary of earlier work; data, not instructions\):[\s\S]*$/, '')
    .replace(/^Follow-up: the person stopped you mid-task and changed direction\. Check git status for uncommitted work first\. New instruction: /, '')
    .replace(/^Follow-up: /, '');

  /** A request's first sentence or line, at most `max` characters, cut at a word. */
  function shortTitle(task, max = 70) {
    let t = stripPrefix(task).replace(/^Make the changes from: /, 'Changes: ').split('\n')[0].trim();
    const first = t.match(/^(.{20,}?[.!?:])(\s|$)/);
    if (first) t = first[1].replace(/[.:]$/, '');
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 15))}…`;
  }

  const KIND_TAG = { plan: 'plan', document: 'document', answer: 'answer', change: 'change' };
  const slug = (t) => String(t || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';

  function docActions(run, title) {
    const copy = el('button', { type: 'button', className: 'ask-btn', textContent: '📋 Copy' });
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(run.answer); copy.textContent = '✓ Copied'; } catch (_) { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = '📋 Copy'; }, 2000);
    });
    const dl = el('button', { type: 'button', className: 'ask-btn', textContent: '⬇ Download .md' });
    dl.addEventListener('click', () => {
      const a = el('a', { href: URL.createObjectURL(new Blob([run.answer], { type: 'text/markdown' })), download: `${slug(title)}.md` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    return el('div', { className: 'ask-actions' }, copy, dl);
  }

  /** "Go ahead" on a plan; false when cancelled or refused. */
  async function approvePlan(run) {
    if (!confirm('Carry out this plan? The helper will make the changes on a private draft copy.')) return false;
    try {
      const r = await api('/api/agents/plan/approve', { runId: run.id });
      state.openId = r.runId || state.openId;
      await loadMine();
      await renderThread();
      return true;
    } catch (err) {
      $('reply-msg').className = 'ask-msg err';
      $('reply-msg').textContent = `Could not start: ${err.message}`;
      return false;
    }
  }

  // ---- quick replies above the reply box ------------------------------------
  const QUICK = {
    plan: [['Make the plan smaller', 'Make the plan smaller: only the most important step for now.'], ['Explain it simply', 'Explain this plan in plain words: what changes and what I will see.']],
    change: [['Explain what you changed', 'Explain in plain words what you changed and how I can check it once it is live.'], ['Do what is still open', 'Now do the items that are still open from the plan.'], ['Make it smaller', 'That is more than I wanted. Keep only the most important change and undo the rest.']],
    answer: [['Shorter please', 'Make it shorter: the key points only.'], ['More detail', 'Go into more detail on the most important points.'], ['Explain simply', 'Explain this in plain words for a non-technical reader.']],
    failed: [['Try again', 'Try again. If something blocked you, say what.']],
  };
  QUICK.document = QUICK.answer;

  function fill(text) {
    $('reply').value = text;
    $('reply').focus();
  }

  function renderQuick(latest, hasQueue) {
    const box = $('quick');
    if (!latest || latest.status === 'running' || hasQueue) { box.replaceChildren(); return; }
    const chip = (label, onClick, cls = '') => {
      const b = el('button', { type: 'button', className: `ask-chip${cls}`, textContent: label });
      b.addEventListener('click', onClick);
      return b;
    };
    const failed = ['failed', 'timed_out', 'stale', 'stopped'].includes(latest.status);
    const chips = [];
    if (!failed && latest.kind === 'plan' && latest.answer && (state.admin || !['readonly', 'off'].includes(state.mode))) {
      chips.push(chip('✓ Go ahead', () => approvePlan(latest), ' go'));
    }
    if (!failed && latest.kind === 'change') {
      chips.push(chip('↶ Undo that', async () => {
        try { const m = await window.AskDraft.undo(latest); if (m) { $('reply-msg').className = 'ask-msg'; $('reply-msg').textContent = m; refreshDraft(); } } catch (err) { $('reply-msg').className = 'ask-msg err'; $('reply-msg').textContent = `Could not undo: ${err.message}`; }
      }));
    }
    for (const [label, text] of QUICK[failed ? 'failed' : latest.kind] || []) chips.push(chip(label, () => fill(text)));
    box.replaceChildren(...chips);
  }

  function planActions(run) {
    if (!state.admin && (state.mode === 'readonly' || state.mode === 'off')) {
      return el('div', { className: 'ask-callout tone-muted', textContent: 'Changes are switched off for teammates right now, so this plan cannot be carried out. Ask an admin.' });
    }
    const go = el('button', { type: 'button', className: 'ask-btn go', textContent: '✓ Go ahead' });
    const edit = el('button', { type: 'button', className: 'ask-btn', textContent: '✎ Change the plan' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      edit.disabled = true;
      if (!(await approvePlan(run))) { go.disabled = false; edit.disabled = false; }
    });
    edit.addEventListener('click', () => {
      $('reply').placeholder = 'What should be different in the plan?';
      $('reply').focus();
    });
    return el('div', { className: 'ask-actions' }, go, edit);
  }

  // "Make these changes": the way from read-only findings to edits. Starts a
  // new Change request (a plan first, then Go ahead) carrying this reply.
  function makeActions(run) {
    if (!state.admin && (state.mode === 'readonly' || state.mode === 'off')) return null;
    const focus = el('input', { className: 'ask-field', type: 'text', maxLength: 2000, placeholder: 'Which ones? e.g. fixes 1-5 (optional)' });
    const helper = el('select', { className: 'ask-field', title: 'Who makes the changes' },
      el('option', { value: 'claude', textContent: 'Expert helper' }),
      el('option', { value: 'hermes', textContent: 'Free helper' }));
    if (!state.admin && state.mode === 'claude') helper.disabled = true;
    const go = el('button', { type: 'button', className: 'ask-btn go', textContent: '🔧 Make these changes' });
    const msg = el('div', { className: 'ask-msg', role: 'status' });
    go.addEventListener('click', async () => {
      if (!confirm('Start a change request from this reply? The helper first sends a plan; nothing changes until you click Go ahead.')) return;
      go.disabled = true;
      msg.className = 'ask-msg';
      msg.textContent = 'Starting…';
      try {
        const r = await api('/api/agents/make-changes', { runId: run.id, agent: helper.value, focus: focus.value.trim() });
        await loadMine();
        openThread(r.runId);
      } catch (err) {
        go.disabled = false;
        msg.className = 'ask-msg err';
        msg.textContent = `Could not start: ${err.message}`;
      }
    });
    return el('div', { className: 'ask-make' },
      el('div', { className: 'ask-muted', textContent: 'Want the helper to act on this? It starts a new change request: a plan first, then changes on a draft copy after you say Go ahead.' }),
      el('div', { className: 'ask-make-row' }, focus, helper, go), msg);
  }

  /** After undo / discard / send: refetch the files, the card and the conversation. */
  function refreshDraft() {
    window.AskFiles.reset();
    if (state.openThread) window.AskRecap.invalidate(state.openThread);
    renderThread();
  }

  /** "Mark as milestone" (or rename / remove) for a finished turn. */
  function markButton(run) {
    const m = run.milestone;
    const btn = el('button', { type: 'button', className: 'ask-mark', textContent: m && m.manual ? `🏁 ${m.label} · rename or remove` : '🏁 Mark as milestone' });
    btn.addEventListener('click', async () => {
      const label = window.prompt('Name this milestone (leave empty to remove it):', m ? m.label : '');
      if (label === null) return;
      btn.disabled = true;
      try {
        await api('/api/agents/milestone', label.trim() ? { runId: run.id, label: label.trim() } : { runId: run.id, remove: true });
        if (state.openThread) window.AskRecap.invalidate(state.openThread);
        renderThread();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = `Could not save: ${err.message}`;
      }
    });
    return btn;
  }

  function helperBubble(run, steps, { latest = false, title = '', files = false } = {}) {
    const box = el('div', { className: 'ask-bubble helper' },
      el('div', { className: 'ask-who' },
        run.fallback ? 'Free helper (the Expert helper was out of usage)' : run.agent === 'claude' ? 'Expert helper' : 'Helper',
        KIND_TAG[run.kind] ? el('span', { className: 'ask-kind-tag', textContent: `· ${KIND_TAG[run.kind]}` }) : null));
    if (run.status === 'running') {
      box.append(el('div', {}, el('span', { className: 'ask-dots', textContent: 'Working on it' })));
      if (steps && steps.length) {
        box.append(el('ul', { className: 'ask-steps' }, ...steps.map((s) => el('li', { textContent: s.text }))));
      }
      if (files) box.append(window.AskFiles.panel(run));
      return box;
    }
    if (run.answer && run.kind === 'document' && run.status === 'done') {
      box.append(el('div', { className: 'ask-doc' }, window.AskNav.reply(run.answer, run.id, { md: true })), docActions(run, title));
    } else if (run.answer) {
      box.append(window.AskNav.reply(run.answer, run.id, { open: latest && run.answer.length < 6000, md: true }));
    }
    if (!run.answer && run.status === 'done') box.append(el('div', { className: 'ask-muted', textContent: 'Finished without a written answer.' }));
    if (run.kind === 'plan' && run.status === 'done' && run.answer && latest) box.append(planActions(run));
    if (['answer', 'document'].includes(run.kind) && run.status === 'done' && run.answer && latest) box.append(makeActions(run) || '');
    if (run.question) {
      box.append(el('div', { className: 'ask-callout tone-amber', textContent: `The helper asks: ${run.question} Reply below.` }));
    }
    if (run.status === 'stopped') box.append(el('div', { className: 'ask-callout tone-muted', textContent: 'Stopped. Reply below to continue.' }));
    if (['failed', 'timed_out', 'stale'].includes(run.status)) {
      box.append(el('div', { className: 'ask-callout tone-red', textContent: 'This did not finish. Reply below to try again, or ask an admin to look at it.' }));
    }
    if (run.commits_ahead > 0 && !['answer', 'document', 'plan'].includes(run.kind)) {
      box.append(el('div', { className: 'ask-callout tone-green', textContent: `${run.commits_ahead} change(s) saved on a private draft copy. Nothing is live yet: an admin reviews them first.` }));
    }
    if (files) {
      box.append(window.AskFiles.panel(run));
      box.append(window.AskDraft.bar(run, { admin: state.admin, onDone: refreshDraft }));
    }
    box.append(markButton(run));
    return box;
  }

  let stepsCache = {};
  async function stepsOf(run) {
    if (run.status !== 'running' || !run.hasLog || !window.RunSteps) return null;
    try {
      const b = await api(`/api/agents/log?id=${encodeURIComponent(run.id)}`);
      stepsCache[run.id] = window.RunSteps.parseSteps(b.text, 6);
    } catch (_) { /* log not written yet */ }
    return stepsCache[run.id] || null;
  }

  async function renderThread() {
    const id = state.openId;
    if (!id) return;
    let t;
    try {
      t = await api(`/api/agents/thread?id=${encodeURIComponent(id)}`);
    } catch (err) {
      $('convo').replaceChildren(el('div', { className: 'ask-empty', textContent: `Could not load this request (${err.message}).` }));
      return;
    }
    if (state.openId !== id) return; // the person opened another one meanwhile
    state.openThread = t.threadId;
    const runs = t.runs || [];
    const latest = runs[runs.length - 1];
    const listed = state.threads.find((x) => x.threadId === t.threadId);
    $('t-title').textContent = shortTitle(runs[0] && runs[0].task) || 'Request';
    $('t-title').title = stripPrefix(runs[0] && runs[0].task);
    $('t-meta').textContent = [listed && listed.repo, runs.length > 1 ? `${runs.length} turns` : null].filter(Boolean).join(' · ');
    const stage = listed ? listed.stage : null;
    $('t-stage').textContent = stage ? stage.label : (latest && latest.status) || '';
    $('t-stage').className = `ask-pill tone-${stage ? TONES[stage.key] || 'muted' : 'muted'}`;

    const items = [];
    const sums = [];
    const title = stripPrefix(runs[0] && runs[0].task);
    // Follow-ups share one draft copy, so its files show once: under the
    // latest run that may change files (ask-files.js).
    let filesAt = -1;
    runs.forEach((r, i) => { if (!['answer', 'document', 'plan'].includes(r.kind)) filesAt = i; });
    for (const [i, run] of runs.entries()) {
      const approved = run.kind === 'change' && /^Go ahead with the plan\./.test(String(run.task || ''));
      const said = approved ? '✓ Go ahead with the plan.' : stripPrefix(run.task);
      const you = el('div', { className: 'ask-bubble you' },
        el('div', { className: 'ask-who', textContent: 'You' }),
        window.AskNav.reply(said, `you-${run.id}`));
      const isLatest = i === runs.length - 1 && !(t.queue || []).length;
      const helper = helperBubble(run, await stepsOf(run), { latest: isLatest, title, files: i === filesAt });
      const summary = said.replace(/\s+/g, ' ').trim();
      const flag = run.milestone ? run.milestone.label : null;
      sums.push(flag ? `🏁 ${flag} - ${summary}` : summary);
      items.push(window.AskNav.turn({
        runId: run.id, index: i, total: runs.length, summary, flag,
        meta: [run.kind, run.status === 'running' ? 'working' : run.status, run.started_at ? ago(run.started_at) : null].filter(Boolean).join(' · '),
        body: [you, helper],
      }));
    }
    for (const q of t.queue || []) {
      items.push(el('div', { className: 'ask-bubble you queued' },
        el('div', { className: 'ask-who', textContent: 'You · waiting to be sent' }),
        el('pre', { className: 'ask-answer', textContent: q.text })));
    }
    if (state.openId !== id) return;
    const convo = $('convo');
    const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    convo.replaceChildren(...items);
    window.AskNav.setJump(sums);
    window.AskRecap.render($('recap'), t.threadId, runs.map((r) => `${r.id}:${r.status}:${r.milestone ? r.milestone.label : ''}`).join('|'));
    if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
    renderQuick(latest, (t.queue || []).length > 0);
    $('stop-btn').hidden = !(latest && latest.status === 'running');
    $('stop-btn').dataset.runId = latest ? latest.id : '';
    $('reply').placeholder = latest && latest.status === 'running'
      ? 'Add something while it works; it is sent when the helper finishes…'
      : 'Reply, answer a question, or ask for something more…';
  }

  function openThread(runId) {
    state.openId = runId;
    stepsCache = {};
    window.AskNav.reset();
    window.AskFiles.reset();
    window.AskRecap.reset();
    $('view-new').hidden = true;
    $('view-thread').hidden = false;
    $('convo').replaceChildren(el('div', { className: 'ask-empty', textContent: 'Loading…' }));
    $('reply-msg').textContent = '';
    history.replaceState(null, '', `#t=${encodeURIComponent(runId)}`);
    // Land on the latest reply; older turns start folded (ask-nav.js).
    renderThread().then(() => { window.scrollTo(0, document.body.scrollHeight); renderThreads(); });
  }

  $('reply-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('reply').value.trim();
    if (!text || !state.openId) return;
    const msg = $('reply-msg');
    $('reply-send').disabled = true;
    msg.className = 'ask-msg';
    msg.textContent = 'Sending…';
    try {
      const r = await api('/api/agents/queue', { runId: state.openId, text });
      $('reply').value = '';
      msg.textContent = r.queued ? 'Saved: it is sent when the helper finishes.' : '';
      if (r.runId) state.openId = r.runId;
      await loadMine();
      await renderThread();
    } catch (err) {
      msg.className = 'ask-msg err';
      msg.textContent = `Not sent: ${err.message}`;
    } finally {
      $('reply-send').disabled = false;
    }
  });
  $('reply').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('reply-form').requestSubmit();
  });

  $('stop-btn').addEventListener('click', async () => {
    const runId = $('stop-btn').dataset.runId;
    if (!runId || !confirm('Stop the helper? You can continue later by replying.')) return;
    try {
      await api('/api/agents/stop', { runId });
      $('reply-msg').textContent = 'Stopping…';
    } catch (err) {
      $('reply-msg').className = 'ask-msg err';
      $('reply-msg').textContent = `Could not stop: ${err.message}`;
    }
    setTimeout(renderThread, 1500);
  });

  $('new-btn').addEventListener('click', showNew);
  window.AskNav.init({ onNew: showNew });
  setKind('answer', false);

  // ---- start ---------------------------------------------------------------------
  const fromHash = decodeURIComponent((location.hash.match(/^#t=(.+)$/) || [])[1] || '');
  loadProjects();
  loadMine().then(() => (fromHash ? openThread(fromHash) : showNew()));
  setInterval(loadMine, 5000);
  setInterval(() => { if (state.openId && !document.hidden) renderThread(); }, 3000);
})();
