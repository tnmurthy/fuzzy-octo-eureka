// ask-files.js - "Files changed" panel on the Ask page (ask.js): what the
// helper changed on its draft copy, with each file's diff on click.
// APIs: GET /api/agents/changes?id=, /api/agents/changes/file?id=&path=.
// Diffs are shown with textContent only. The conversation re-renders every
// 3 s, so lists, diffs and open files are cached here by run id and the panel
// is rebuilt from the cache; a running run's list refreshes every 10 s.
(function () {
  'use strict';
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props || {});
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const REFRESH_MS = 10000;

  const lists = new Map();      // runId -> { at, status, data | error, loading }
  const diffs = new Map();      // runId|path -> { data | error, loading }
  const openFiles = new Set();  // runId|path
  const panels = new Map();     // runId -> element currently on the page

  async function get(url) {
    const res = await fetch(url);
    let b = null;
    try { b = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !b || b.ok === false) throw new Error((b && b.error) || `HTTP ${res.status}`);
    return b;
  }

  function redraw(run) {
    const old = panels.get(run.id);
    if (old && old.isConnected) old.replaceWith(panel(run));
  }

  function loadList(run) {
    const c = lists.get(run.id);
    const fresh = c && (c.status === run.status) && (run.status !== 'running' || Date.now() - c.at < REFRESH_MS);
    if ((c && c.loading) || fresh) return;
    lists.set(run.id, { ...(c || {}), loading: true });
    get(`/api/agents/changes?id=${encodeURIComponent(run.id)}`)
      .then((data) => lists.set(run.id, { at: Date.now(), status: run.status, data }))
      .catch((err) => lists.set(run.id, { at: Date.now(), status: run.status, error: err.message }))
      .finally(() => redraw(run));
  }

  function loadDiff(run, file) {
    const key = `${run.id}|${file}`;
    const c = diffs.get(key);
    if (c && (c.loading || (c.data && run.status !== 'running'))) return;
    diffs.set(key, { ...(c || {}), loading: true });
    get(`/api/agents/changes/file?id=${encodeURIComponent(run.id)}&path=${encodeURIComponent(file)}`)
      .then((data) => diffs.set(key, { data }))
      .catch((err) => diffs.set(key, { error: err.message }))
      .finally(() => redraw(run));
  }

  function diffView(run, f) {
    const key = `${run.id}|${f.path}`;
    if (f.secret) return el('div', { className: 'ask-diff-note', textContent: 'Looks like a secrets file, so its contents are not shown.' });
    if (f.binary) return el('div', { className: 'ask-diff-note', textContent: 'Binary file (an image or similar): no text to compare.' });
    const c = diffs.get(key);
    if (!c || c.loading) { loadDiff(run, f.path); if (!c || !c.data) return el('div', { className: 'ask-diff-note', textContent: 'Loading…' }); }
    if (c.error) return el('div', { className: 'ask-diff-note err', textContent: `Could not load: ${c.error}` });
    const pre = el('pre', { className: 'ask-diff' });
    for (const line of String(c.data.diff || '').split('\n')) {
      const cls = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
      pre.append(el('span', { className: `ask-diff-${cls}`, textContent: `${line}\n` }));
    }
    const box = el('div', {}, pre);
    if (c.data.truncated) box.append(el('div', { className: 'ask-diff-note', textContent: 'Long change: showing the first part only.' }));
    return box;
  }

  const STATUS = { new: 'new', deleted: 'deleted', renamed: 'renamed', modified: '' };

  /** The panel for `run`; empty when nothing changed (yet). */
  function panel(run) {
    loadList(run);
    const c = lists.get(run.id) || {};
    let node;
    if (c.error) {
      node = el('div', { className: 'ask-files muted', textContent: `Files changed: ${c.error}` });
    } else if (!c.data) {
      node = el('div', { className: 'ask-files muted', textContent: '📁 Looking for changed files…' });
    } else if (!c.data.files.length) {
      node = run.status === 'running'
        ? el('div', { className: 'ask-files muted', textContent: '📁 No files changed yet.' })
        : el('span', { hidden: true });
    } else {
      const d = c.data;
      const all = d.files.every((f) => openFiles.has(`${run.id}|${f.path}`));
      const toggleAll = el('button', { type: 'button', className: 'ask-clip-btn', textContent: all ? 'Collapse all diffs' : 'Expand all diffs' });
      toggleAll.addEventListener('click', () => {
        for (const f of d.files) { const k = `${run.id}|${f.path}`; if (all) openFiles.delete(k); else openFiles.add(k); }
        redraw(run);
      });
      const rows = d.files.map((f) => {
        const key = `${run.id}|${f.path}`;
        const isOpen = openFiles.has(key);
        const head = el('button', { type: 'button', className: 'ask-file-row', title: isOpen ? 'Hide the change' : 'Show the change' },
          el('span', { className: 'ask-turn-caret', textContent: isOpen ? '▾' : '▸' }),
          el('span', { className: 'ask-file-path', textContent: f.from ? `${f.from} → ${f.path}` : f.path }),
          STATUS[f.status] ? el('span', { className: `ask-file-tag ${f.status}`, textContent: STATUS[f.status] }) : null,
          f.saved ? null : el('span', { className: 'ask-file-tag unsaved', textContent: 'not saved yet', title: 'Edited but not committed on the draft branch yet' }),
          el('span', { className: 'ask-file-num' },
            f.binary ? 'binary' : el('span', {},
              el('span', { className: 'ask-diff-add', textContent: `+${f.added || 0}` }), ' ',
              el('span', { className: 'ask-diff-del', textContent: `−${f.removed || 0}` }))));
        head.setAttribute('aria-expanded', String(isOpen));
        head.addEventListener('click', () => { if (openFiles.has(key)) openFiles.delete(key); else openFiles.add(key); redraw(run); });
        return el('div', { className: 'ask-file' }, head, isOpen ? diffView(run, f) : null);
      });
      node = el('div', { className: 'ask-files' },
        el('div', { className: 'ask-files-head' },
          el('span', { textContent: `📁 Files changed (${d.files.length}${d.more ? `+${d.more}` : ''})` }),
          el('span', { className: 'ask-file-num' },
            el('span', { className: 'ask-diff-add', textContent: `+${d.totals.added}` }), ' ',
            el('span', { className: 'ask-diff-del', textContent: `−${d.totals.removed}` })),
          el('span', { className: 'ask-tool-gap' }), toggleAll),
        ...rows,
        d.commits.length ? el('div', { className: 'ask-muted ask-commits', textContent: `Saved steps (${d.commits.length}): ${d.commits.map((x) => x.subject).join(' · ')}` }) : null,
        el('div', { className: 'ask-muted', textContent: `Draft branch ${d.branch}. Nothing is live until it is reviewed and merged.` }));
    }
    panels.set(run.id, node);
    return node;
  }

  function reset() {
    lists.clear();
    diffs.clear();
    openFiles.clear();
    panels.clear();
  }

  window.AskFiles = { panel, reset };
})();
