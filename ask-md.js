// ask-md.js - shows a helper's Markdown reply as formatted text on the Ask
// page: headings, bold / italic / code, lists (one level of nesting), tables,
// quotes, code blocks, rules and http(s) links. Agent text is untrusted: the
// parser builds a small tree and the renderer creates every element itself
// with textContent, so no HTML from the reply ever reaches the page. Links
// other than http(s) stay plain text. parse() is pure (tested in node).
(function (root) {
  'use strict';

  const FENCE = /^\s*(```|~~~)/;
  const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  // Inline: `code`, **bold**, __bold__, *italic*, [text](http...). Underscore
  // italics are skipped (they break snake_case names).
  const INLINE = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/;

  function inline(text) {
    const out = [];
    let rest = String(text);
    let guard = 0;
    while (rest && guard++ < 500) {
      const m = rest.match(INLINE);
      if (!m) { out.push({ t: 'text', text: rest }); break; }
      if (m.index > 0) out.push({ t: 'text', text: rest.slice(0, m.index) });
      if (m[1] != null) out.push({ t: 'code', text: m[1] });
      else if (m[2] != null || m[3] != null) out.push({ t: 'b', kids: inline(m[2] != null ? m[2] : m[3]) });
      else if (m[4] != null) out.push({ t: 'i', kids: inline(m[4]) });
      else if (/^https?:\/\//i.test(m[6])) out.push({ t: 'a', href: m[6], kids: inline(m[5]) });
      else out.push({ t: 'text', text: m[0] });
      rest = rest.slice(m.index + m[0].length);
    }
    // Adjacent text pieces become one.
    return out.reduce((acc, n) => {
      const last = acc[acc.length - 1];
      if (n.t === 'text' && last && last.t === 'text') acc[acc.length - 1] = { t: 'text', text: last.text + n.text };
      else acc.push(n);
      return acc;
    }, []);
  }

  /** Markdown text -> list of blocks. */
  function parse(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    const flush = () => { if (para.length) { blocks.push({ t: 'p', lines: para.map(inline) }); para = []; } };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (FENCE.test(line)) {
        flush();
        const mark = line.trim().slice(0, 3);
        const body = [];
        for (i += 1; i < lines.length && !lines[i].trim().startsWith(mark); i += 1) body.push(lines[i]);
        blocks.push({ t: 'code', text: body.join('\n') });
        continue;
      }
      if (!line.trim()) { flush(); continue; }
      let m = line.match(HEADING);
      if (m) { flush(); blocks.push({ t: 'h', level: m[1].length, kids: inline(m[2]) }); continue; }
      if (RULE.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }
      if (isRow(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flush();
        const head = cells(line).map(inline);
        const rows = [];
        for (i += 2; i < lines.length && isRow(lines[i]); i += 1) rows.push(cells(lines[i]).map(inline));
        i -= 1;
        blocks.push({ t: 'table', head, rows });
        continue;
      }
      m = line.match(ITEM);
      if (m) {
        flush();
        const ordered = /\d/.test(m[2]);
        const items = [];
        for (; i < lines.length; i += 1) {
          const it = lines[i].match(ITEM);
          if (it) {
            const nested = it[1].replace(/\t/g, '  ').length >= 2 && items.length;
            const node = { kids: inline(it[3]), sub: [] };
            if (nested) items[items.length - 1].sub.push(node); else items.push(node);
          } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1].kids.push({ t: 'text', text: ' ' }, ...inline(lines[i].trim()));
          } else { i -= 1; break; }
        }
        blocks.push({ t: ordered ? 'ol' : 'ul', items });
        continue;
      }
      m = line.match(QUOTE);
      if (m) {
        flush();
        const body = [];
        for (; i < lines.length && QUOTE.test(lines[i]); i += 1) body.push(lines[i].match(QUOTE)[1]);
        i -= 1;
        blocks.push({ t: 'quote', blocks: parse(body.join('\n')) });
        continue;
      }
      para.push(line.trim());
    }
    flush();
    return blocks;
  }

  // ---- browser: blocks -> elements ----------------------------------------
  function inlineDom(nodes, parent) {
    for (const n of nodes) {
      if (n.t === 'text') parent.append(document.createTextNode(n.text));
      else if (n.t === 'code') { const c = document.createElement('code'); c.textContent = n.text; parent.append(c); }
      else {
        const tag = n.t === 'b' ? 'strong' : n.t === 'i' ? 'em' : 'a';
        const e = document.createElement(tag);
        if (tag === 'a') { e.href = n.href; e.target = '_blank'; e.rel = 'noopener noreferrer'; }
        inlineDom(n.kids, e);
        parent.append(e);
      }
    }
    return parent;
  }

  function listDom(tag, items) {
    const list = document.createElement(tag);
    for (const it of items) {
      const li = inlineDom(it.kids, document.createElement('li'));
      if (it.sub.length) li.append(listDom('ul', it.sub));
      list.append(li);
    }
    return list;
  }

  function blocksDom(blocks, parent) {
    for (const b of blocks) {
      let e;
      if (b.t === 'p') {
        e = document.createElement('p');
        b.lines.forEach((l, i) => { if (i) e.append(document.createElement('br')); inlineDom(l, e); });
      } else if (b.t === 'h') e = inlineDom(b.kids, document.createElement(`h${Math.min(6, b.level + 2)}`));
      else if (b.t === 'hr') e = document.createElement('hr');
      else if (b.t === 'code') { e = document.createElement('pre'); const c = document.createElement('code'); c.textContent = b.text; e.append(c); }
      else if (b.t === 'ul' || b.t === 'ol') e = listDom(b.t, b.items);
      else if (b.t === 'quote') e = blocksDom(b.blocks, document.createElement('blockquote'));
      else if (b.t === 'table') {
        e = document.createElement('div');
        e.className = 'ask-md-table';
        const table = document.createElement('table');
        const tr = document.createElement('tr');
        for (const c of b.head) tr.append(inlineDom(c, document.createElement('th')));
        const thead = document.createElement('thead');
        thead.append(tr);
        const tbody = document.createElement('tbody');
        for (const r of b.rows) {
          const row = document.createElement('tr');
          for (let k = 0; k < b.head.length; k += 1) row.append(inlineDom(r[k] || [], document.createElement('td')));
          tbody.append(row);
        }
        table.append(thead, tbody);
        e.append(table);
      }
      if (e) parent.append(e);
    }
    return parent;
  }

  /** A formatted element for `text`. */
  function render(text) {
    const box = document.createElement('div');
    box.className = 'ask-answer ask-md';
    return blocksDom(parse(text), box);
  }

  const api = { parse, inline, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.AskMd = api;
})(typeof window !== 'undefined' ? window : null);
