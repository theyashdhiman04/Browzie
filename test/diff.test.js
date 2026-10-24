import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, compactDiff } from '../extension/lib/diff.js';
import { planTyping, PACES } from '../extension/lib/human.js';

test('compactDiff: a 90-option list that opened shows 30 options and says how many more', () => {
  const before = ['main', '  textbox "Game title" [e1]'];
  const after = [...before, '  listbox "Select time"', ...Array.from({ length: 90 }, (_, i) => `    option "${i}:00" [e${i + 10}]`)];
  const d = diffLines(before, after);
  const c = compactDiff(d.text);
  assert.match(c, /\+ \.\.\. 61 more added lines/);
  assert.ok(c.split('\n').length < 40);
});

test('compactDiff: removed runs keep 3 lines; the whole text stops at max', () => {
  const text = ['@@ in main', ...Array.from({ length: 20 }, (_, i) => `- old ${i}`), ...Array.from({ length: 20 }, (_, i) => `+ new ${'x'.repeat(200)} ${i}`)].join('\n');
  const c = compactDiff(text, { max: 1500 });
  assert.match(c, /- \.\.\. 17 more removed lines/);
  assert.ok(c.length < 1700, String(c.length));
  assert.match(c, /diff cut here/);
});

test('fast typing: long text in word chunks, Enter for line breaks, every character accounted for', () => {
  const text = 'One two three four five six seven eight nine ten eleven twelve\nthirteen fourteen 👇 fifteen';
  const keyOf = (c) => (c === '\n' ? { shift: false, code: 'Enter' } : /[a-z ]/i.test(c) ? { shift: false, code: c } : null);
  const ev = planTyping(text, { pace: PACES.fast, keyOf });
  const typed = ev.map((e) => (e.type === 'insert' ? e.text : e.type === 'down' ? e.ch : '')).join('');
  assert.equal(typed, text);
  assert.ok(ev.filter((e) => e.type === 'insert').length >= 3);
  assert.equal(ev[ev.length - 1].n, [...text].length);
  assert.ok(ev[ev.length - 1].t < 400, String(ev[ev.length - 1].t));
  // short text (a time, a spin button value) stays real keystrokes
  assert.ok(planTyping('11:12 PM', { pace: PACES.fast }).every((e) => e.type !== 'insert'));
  // the human pace is unchanged
  assert.ok(planTyping(text, { pace: PACES.human, keyOf }).every((e) => e.type !== 'insert' || /👇/u.test(e.text)));
});
