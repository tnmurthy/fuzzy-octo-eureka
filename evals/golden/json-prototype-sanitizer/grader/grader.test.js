'use strict';
// Hidden grader: copied in after the agent finishes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeParse, merge } = require('./safe-json');

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

test('keeps ordinary JSON as JSON.parse would', () => {
  const text = '{"a":1,"b":[1,{"c":"x"}],"d":null,"e":true,"f":"__proto__"}';
  assert.deepEqual(safeParse(text), JSON.parse(text));
  assert.equal(safeParse('[1,2]').length, 2);
  assert.equal(safeParse('"s"'), 's');
});

test('drops blocked keys at any depth, inside arrays too', () => {
  const o = safeParse('{"__proto__":{"x":1},"a":{"constructor":{"prototype":{"y":1}},"k":2},"l":[{"prototype":1,"m":3}]}');
  assert.equal(hasOwn(o, '__proto__'), false);
  assert.equal(hasOwn(o.a, 'constructor'), false);
  assert.equal(o.a.k, 2);
  assert.equal(hasOwn(o.l[0], 'prototype'), false);
  assert.equal(o.l[0].m, 3);
});

test('invalid JSON still throws SyntaxError', () => {
  assert.throws(() => safeParse('{bad'), SyntaxError);
});

test('merge never pollutes Object.prototype', () => {
  try {
    merge({}, JSON.parse('{"__proto__":{"polluted":"yes"}}'));
    merge({}, JSON.parse('{"constructor":{"prototype":{"polluted":"yes"}}}'));
    merge({}, safeParse('{"a":{"__proto__":{"polluted":"yes"}}}'));
    assert.equal({}.polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
  } finally {
    delete Object.prototype.polluted;
  }
});

test('merge still deep-merges plain objects', () => {
  assert.deepEqual(merge({ a: { b: 1 }, c: 1 }, { a: { d: 2 }, c: 3, e: [1] }), { a: { b: 1, d: 2 }, c: 3, e: [1] });
});
