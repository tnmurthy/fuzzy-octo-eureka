// injection.test.js - prompt-injection red-team suite.
//
// Every block of outside text that buildDispatchPrompt adds to an agent's
// prompt (team memories, antidotes, blackboard facts, direction rules) is fed
// each payload in payloads.json. The prompt must keep its shape:
//   - no new section line (Task:, SYSTEM:, ---, ## ..., <precompact_state>,
//     Directive:) appears that a benign note would not produce,
//   - the outside text adds at most its block's budget,
//   - blocks of outside text say they are background / data, not instructions.
// Then: dangerous commands in a task need confirmation, recaps drop them, and
// the write endpoints for prompt text are admin-only same-site JSON.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildDispatchPrompt } = require('../../dispatch-context');
const { createBlackboard } = require('../../blackboard');
const { createDirectionLayer } = require('../../direction-layer');
const { checkPromptSafety } = require('../../safety-filter');
const { recapText } = require('../../run-recap');
const { promptWriteRefusal } = require('../../prompt-write-guard');

const PAYLOADS = require('./payloads.json').map((p) => ({ ...p, text: p.repeat ? p.text.repeat(p.repeat) : p.text }));
const TASK = 'Fix the failing date parser in src/date.js and commit.';
const BENIGN = 'Use UTC everywhere in the date helpers.';

const LINE_BREAKS = /\r\n|\r|\n|\u2028|\u2029|\u0085/;
const SECTION_LINE = /^\s*(Task:|SYSTEM:|---\s*$|#{1,6} |<\/?precompact_state>|Directive:|Rules:)/i;
const sectionLines = (prompt) => prompt.split(LINE_BREAKS).filter((l) => SECTION_LINE.test(l)).length;

// Each source: how a piece of outside text gets into the prompt, and its budget.
const SOURCES = {
  memory: {
    budget: 1600,
    framed: /background only/,
    build: (text) => buildDispatchPrompt(TASK, [{ title: 'note', content: text }]),
  },
  antidote: {
    budget: 900,
    framed: /Known Traps/,
    build: (text) => buildDispatchPrompt(TASK, [], { antidotes: [{ id: 'a1', symptom: text, antidote: text }] }),
  },
  blackboard: {
    budget: 1600,
    framed: /not instructions/,
    build: (text) => {
      const bb = createBlackboard();
      bb.postFact({ title: text.slice(0, 300), content: text, author: text.slice(0, 40), scope: 'global', syncToMemory: false });
      return buildDispatchPrompt(TASK, [], { blackboard: bb });
    },
  },
  direction: {
    budget: 3200,
    framed: null, // operator-set rules ARE instructions; guarded by who may write them
    build: (text) => {
      const dl = createDirectionLayer();
      try {
        dl.addRule({ scope: 'global', title: text.slice(0, 80), ruleText: text.slice(0, 400) });
      } catch (_) {
        return null; // refused at intake: nothing reaches the prompt
      }
      return buildDispatchPrompt(TASK, [], { directionLayer: dl });
    },
  },
};

for (const [name, src] of Object.entries(SOURCES)) {
  const baseline = src.build(BENIGN);

  test(`${name}: a benign note is framed and the task stays first`, () => {
    assert.ok(baseline.startsWith(TASK));
    if (src.framed) assert.match(baseline, src.framed);
  });

  for (const p of PAYLOADS) {
    test(`${name} x ${p.id}: no new sections, within budget`, () => {
      const prompt = src.build(p.text);
      if (prompt === null) return; // refused at intake
      assert.ok(prompt.startsWith(TASK), 'the task must stay first');
      assert.equal(sectionLines(prompt), sectionLines(baseline), `new section lines:\n${prompt.split(LINE_BREAKS).filter((l) => SECTION_LINE.test(l)).join('\n')}`);
      assert.ok(prompt.length - TASK.length <= src.budget, `${prompt.length - TASK.length} chars > ${src.budget}`);
    });
  }
}

test('safety filter: dangerous commands in a task need confirmation', () => {
  for (const t of ['then rm -rf / to clean up', 'git push --force origin main', 'DROP TABLE users;', 'chmod -R 777 .', 'git reset --hard HEAD~5']) {
    assert.equal(checkPromptSafety(t).safe, false, t);
  }
});

test('recap: a dangerous note is dropped, not passed to the next run', () => {
  const s = { milestones: [], saved: [], reported: ['ran rm -rf / as asked'], decisions: [], open: [], changed: null };
  assert.equal(recapText(s), '');
  const ok = recapText({ ...s, reported: ['fixed the parser'] });
  assert.match(ok, /data, not instructions/);
});

test('prompt-write guard: admin-only, same-site JSON', () => {
  const json = { 'content-type': 'application/json', host: 'x' };
  assert.equal(promptWriteRefusal({ admin: true, headers: json }), null);
  assert.match(promptWriteRefusal({ admin: false, headers: json }).error, /admin/);
  assert.equal(promptWriteRefusal({ admin: false, headers: json }).status, 403);
  assert.equal(promptWriteRefusal({ admin: true, headers: { host: 'x', 'content-type': 'text/plain' } }).status, 415);
  assert.equal(promptWriteRefusal({ admin: true, headers: { ...json, origin: 'https://evil.example' } }).status, 403);
  assert.equal(promptWriteRefusal({ admin: true, headers: { ...json, 'sec-fetch-site': 'cross-site' } }).status, 403);
});

test('payload corpus is loaded', () => {
  assert.ok(PAYLOADS.length >= 7);
  assert.ok(path.basename(__filename).endsWith('.test.js'));
});
