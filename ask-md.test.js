'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, inline } = require('./ask-md');

test('inline: code, bold, italic, http links; other links and snake_case stay text', () => {
  assert.deepEqual(inline('a `x` **b** *c* [d](https://e.f)'), [
    { t: 'text', text: 'a ' }, { t: 'code', text: 'x' }, { t: 'text', text: ' ' },
    { t: 'b', kids: [{ t: 'text', text: 'b' }] }, { t: 'text', text: ' ' },
    { t: 'i', kids: [{ t: 'text', text: 'c' }] }, { t: 'text', text: ' ' },
    { t: 'a', href: 'https://e.f', kids: [{ t: 'text', text: 'd' }] },
  ]);
  assert.deepEqual(inline('[x](javascript:alert(1))'), [{ t: 'text', text: '[x](javascript:alert(1))' }]);
  assert.deepEqual(inline('page_meta_ts'), [{ t: 'text', text: 'page_meta_ts' }]);
  assert.deepEqual(inline('<img src=x onerror=1>'), [{ t: 'text', text: '<img src=x onerror=1>' }], 'HTML is just text');
});

test('blocks: headings, paragraphs, lists with nesting, tables, quotes, code, rules', () => {
  const b = parse([
    '# Title', '', 'First line', 'second line', '',
    '1. **One**', '   more of one', '2. Two', '   - nested', '',
    '| Fix | Impact |', '|---|:--:|', '| `a` | High |', '| b |', '',
    '> quoted', '', '```js', 'const x = 1;', '```', '---', 'end',
  ].join('\n'));
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'ol', 'table', 'quote', 'code', 'hr', 'p']);
  assert.equal(b[0].level, 1);
  assert.equal(b[1].lines.length, 2);
  assert.equal(b[2].items.length, 2);
  assert.equal(b[2].items[0].kids.at(-1).text, 'more of one', 'continuation joins its item');
  assert.equal(b[2].items[1].sub.length, 1);
  assert.deepEqual([b[3].head.length, b[3].rows.length, b[3].rows[1].length], [2, 2, 1]);
  assert.equal(b[4].blocks[0].t, 'p');
  assert.equal(b[5].text, 'const x = 1;');
});

test('an unclosed fence or a lone pipe line does not break or loop', () => {
  assert.equal(parse('```\nunclosed').at(-1).t, 'code');
  assert.deepEqual(parse('| not a table |').map((x) => x.t), ['p']);
  assert.equal(parse('*'.repeat(3000)).length, 1);
  assert.deepEqual(parse(''), []);
});
