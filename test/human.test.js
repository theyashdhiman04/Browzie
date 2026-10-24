// Unit tests for the human input model (pure functions, no browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyForChar } from '../extension/lib/keys.js';
import { makeRng, planMove, planClick, planTyping, planCombo, planWheel, aimPoint, snapper, movementTime, PACES } from '../extension/lib/human.js';

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('movement ends exactly on the target, starts near the origin, time only moves forward', () => {
  const r = makeRng(1);
  for (let i = 0; i < 300; i++) {
    const from = { x: r() * 1400, y: r() * 800 };
    const to = { x: r() * 1400, y: r() * 800 };
    const path = planMove(from, to, { rng: r, width: 10 + r() * 80 });
    if (Math.hypot(to.x - from.x, to.y - from.y) < 0.5) continue;
    const last = path[path.length - 1];
    assert.equal(last.x, to.x);
    assert.equal(last.y, to.y);
    for (let k = 1; k < path.length; k++) assert.ok(path[k].t >= path[k - 1].t);
    const firstStep = Math.hypot(path[0].x - from.x, path[0].y - from.y);
    assert.ok(firstStep < Math.max(30, 0.2 * Math.hypot(to.x - from.x, to.y - from.y)), `first step ${firstStep}`);
  }
});

test("movement time follows Fitts' law: farther and smaller targets take longer", () => {
  const P = PACES.human;
  const avg = (D, W) => {
    const r = makeRng(7);
    let s = 0;
    for (let i = 0; i < 400; i++) s += movementTime(D, W, P, r);
    return s / 400;
  };
  assert.ok(avg(800, 20) > avg(200, 20) + 100);
  assert.ok(avg(400, 10) > avg(400, 80) + 100);
  const t = avg(500, 40);
  assert.ok(t > 350 && t < 900, `500 px to a 40 px target: ${t.toFixed(0)} ms`);
});

test('velocity peaks before the midpoint of the movement (asymmetric bell)', () => {
  const r = makeRng(3);
  const peaks = [];
  for (let i = 0; i < 200; i++) {
    const path = planMove({ x: 0, y: 0 }, { x: 600, y: 0 }, { rng: r, width: 30 });
    let best = 0;
    let at = 0;
    for (let k = 1; k < path.length; k++) {
      const v = Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y) / Math.max(1, path[k].t - path[k - 1].t);
      if (v > best) (best = v), (at = path[k].t / path[path.length - 1].t);
    }
    peaks.push(at);
  }
  const m = median(peaks);
  assert.ok(m > 0.2 && m < 0.5, `median peak at ${m.toFixed(2)} of the movement`);
});

test('paths are curved and sampled at mouse-like intervals', () => {
  const r = makeRng(11);
  let curved = 0;
  const gaps = [];
  for (let i = 0; i < 200; i++) {
    const path = planMove({ x: 100, y: 500 }, { x: 900, y: 200 }, { rng: r, width: 40 });
    const dev = Math.max(...path.map((p) => Math.abs((900 - 100) * (500 - p.y) - (100 - p.x) * (200 - 500)) / Math.hypot(800, 300)));
    if (dev > 2) curved++;
    for (let k = 1; k < path.length; k++) gaps.push(path[k].t - path[k - 1].t);
  }
  assert.ok(curved > 150, `${curved}/200 paths visibly curved`);
  const g = median(gaps);
  assert.ok(g >= 7 && g <= 17, `median sample gap ${g.toFixed(1)} ms`);
});

test('aim points stay inside the inner part of the target and vary', () => {
  const r = makeRng(5);
  const box = { left: 100, top: 200, width: 160, height: 40 };
  const pts = Array.from({ length: 500 }, () => aimPoint(box, r));
  for (const p of pts) {
    assert.ok(p.x >= 100 + 32 - 1e-9 && p.x <= 260 - 32 + 1e-9);
    assert.ok(p.y >= 208 - 1e-9 && p.y <= 232 + 1e-9);
  }
  assert.ok(new Set(pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)).size > 400);
});

test('clicks: a resting pause, then the button held for tens of milliseconds', () => {
  const r = makeRng(9);
  for (let i = 0; i < 300; i++) {
    const [c] = planClick({ rng: r });
    assert.ok(c.down >= 35 && c.down <= 420);
    assert.ok(c.up - c.down >= 48 - 1e-6 && c.up - c.down <= 190 + 1e-6);
  }
  const dbl = planClick({ rng: r, count: 2 });
  assert.equal(dbl.length, 2);
  assert.equal(dbl[1].clickCount, 2);
  assert.ok(dbl[1].down - dbl[0].up >= 70 - 1e-6 && dbl[1].down - dbl[0].up <= 190 + 1e-6);
});

test('typing: every key goes down then up, Shift wraps capitals, rhythm is human', () => {
  const r = makeRng(13);
  const text = 'Hello World, THIS is 42!';
  const ev = planTyping(text, { rng: r });
  const chars = ev.filter((e) => e.ch);
  assert.equal(chars.filter((e) => e.type === 'down').map((e) => e.ch).join(''), text);
  // the k-th press of a character pairs with its k-th release (rollover can interleave them)
  for (const ch of new Set(text)) {
    const ds = chars.filter((e) => e.ch === ch && e.type === 'down');
    const us = chars.filter((e) => e.ch === ch && e.type === 'up');
    assert.equal(ds.length, us.length);
    ds.forEach((d, k) => assert.ok(us[k].t - d.t >= 42 - 1e-6 && us[k].t - d.t <= 170 + 1e-6, `hold of ${ch}`));
  }
  // Shift is held whenever a shifted character goes down
  let shift = false;
  for (const e of ev) {
    if (e.key === 'Shift') shift = e.type === 'down';
    if (e.ch && e.type === 'down') assert.equal(shift, /[A-Z!]/.test(e.ch), `shift state for ${e.ch}`);
  }
  const downs = chars.filter((e) => e.type === 'down').map((e) => e.t);
  const iki = downs.slice(1).map((t, i) => t - downs[i]);
  const m = median(iki);
  assert.ok(m > 100 && m < 260, `median key interval ${m.toFixed(0)} ms`);
  // keys roll over: sometimes the next key goes down before the previous one is up
  const long = planTyping('the quick brown fox jumps over the lazy dog '.repeat(4), { rng: makeRng(2) });
  let overlap = 0;
  let held = 0;
  for (const e of long.filter((x) => x.ch)) {
    if (e.type === 'down') {
      if (held > 0) overlap++;
      held++;
    } else held--;
  }
  assert.ok(overlap > 0, 'some rollover');
});

test('a key is always released before it is pressed again (no impossible double presses)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const keyOf = (ch) => { const k = keyForChar(ch); return k ? { shift: !!k.shift, code: k.code } : null; };
    const ev = planTyping('Hello, all 11 bookkeepers! aaa 1!1!', { rng: makeRng(seed), keyOf });
    const down = new Set();
    const physical = (ch) => ({ '!': '1' }[ch] || ch.toLowerCase());
    for (const e of ev) {
      if (!e.ch) continue;
      const k = physical(e.ch);
      if (e.type === 'down') {
        assert.ok(!down.has(k), `seed ${seed}: ${k} pressed twice without a release`);
        down.add(k);
      } else down.delete(k);
    }
  }
});

test('characters without a key are committed as text', () => {
  const ev = planTyping('café', { rng: makeRng(4), keyOf: (ch) => (/[a-z]/.test(ch) ? { shift: false } : null) });
  assert.deepEqual(ev.filter((e) => e.type === 'insert').map((e) => e.text), ['é']);
});

// Replays a plan into a pretend text field: keys insert their character, Backspace deletes one.
function field(ev, check) {
  const out = [];
  for (const e of ev) {
    if (e.type === 'insert') out.push(e.text);
    else if (e.type === 'down' && e.ch) out.push(e.ch);
    else if (e.type === 'down' && e.key === 'Backspace') out.pop();
    else continue;
    if (check) check(e, out.join(''));
  }
  return out.join('');
}
const keyOfUs = (ch) => {
  const k = keyForChar(ch);
  return k ? { shift: !!k.shift, code: k.code } : null;
};
const CAPTION = 'Do chicken dinner, phir bhi BMIC ka ticket nahi! Final standings mein sirf ek point ka farak tha.\nAapke hisaab se kya zyada zaroori hai? Comment karo 👇 #bgmi #esports';

test('typos: a slipped finger is taken back with Backspace and the field ends up exactly right', () => {
  let slips = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const ev = planTyping(CAPTION, { rng: makeRng(seed), keyOf: keyOfUs, typos: 0.05 });
    const text = [...CAPTION];
    const final = field(ev, (e, now) => {
      // n and x say exactly what the field holds after every stroke that changes it
      assert.equal([...now].length, e.n + e.x, `seed ${seed}: field length after a stroke`);
      assert.equal([...now].slice(0, e.n).join(''), text.slice(0, e.n).join(''), `seed ${seed}: correct prefix`);
    });
    assert.equal(final, CAPTION, `seed ${seed}`);
    slips += ev.filter((e) => e.key === 'Backspace' && e.type === 'down').length;
    // a slip is a neighbouring letter, struck inside a word
    for (const e of ev.filter((x) => x.type === 'down' && x.ch && x.x === 1)) {
      assert.ok(/[a-z]/i.test(e.ch), `seed ${seed}: the slip is a letter`);
      assert.ok(/\p{L}/u.test(text[e.n - 1]) && /\p{L}/u.test(text[e.n + 1]), `seed ${seed}: inside a word`);
    }
  }
  assert.ok(slips > 20, `slips happened (${slips})`);
  // off by default
  assert.equal(planTyping(CAPTION, { rng: makeRng(1), keyOf: keyOfUs }).filter((e) => e.key === 'Backspace').length, 0);
});

test('typing pauses: longer before a new sentence and after a line break than inside a word', () => {
  const gaps = { word: [], sentence: [], line: [] };
  const text = 'One two three. Four five six.\nSeven eight nine. Ten eleven.\n';
  for (let seed = 1; seed <= 80; seed++) {
    const ev = planTyping(text.repeat(2), { rng: makeRng(seed), keyOf: keyOfUs }).filter((e) => e.type === 'down' && e.ch);
    for (let i = 2; i < ev.length; i++) {
      const g = ev[i].t - ev[i - 1].t;
      if (ev[i - 1].ch === ' ' && ev[i - 2].ch === '.') gaps.sentence.push(g);
      else if (ev[i - 1].ch === '\n') gaps.line.push(g);
      else if (/[a-z]/.test(ev[i].ch) && /[a-z]/.test(ev[i - 1].ch)) gaps.word.push(g);
    }
  }
  const w = median(gaps.word);
  assert.ok(median(gaps.sentence) > w + 200, `sentence ${median(gaps.sentence).toFixed(0)} vs word ${w.toFixed(0)} ms`);
  assert.ok(median(gaps.line) > w + 300, `line ${median(gaps.line).toFixed(0)} vs word ${w.toFixed(0)} ms`);
});

test('typing rhythm drifts over a long text instead of holding one speed', () => {
  const ev = planTyping('the quick brown fox jumps over the lazy dog '.repeat(12), { rng: makeRng(9), keyOf: keyOfUs }).filter((e) => e.type === 'down' && e.ch && /[a-z]/.test(e.ch));
  const window = 60;
  const speeds = [];
  for (let i = window; i < ev.length; i += window) speeds.push(median(ev.slice(i - window + 1, i + 1).map((e, k, a) => (k ? e.t - a[k - 1].t : 0)).slice(1)));
  const spread = Math.max(...speeds) / Math.min(...speeds);
  assert.ok(spread > 1.1 && spread < 2.2, `stretches of the text are typed at different speeds (max/min ${spread.toFixed(2)})`);
});

test('key combos press modifiers first and release them last', () => {
  const ev = planCombo(['Control', 'Shift'], { rng: makeRng(6) });
  assert.deepEqual(ev.map((e) => `${e.type}:${e.key}`), ['down:Control', 'down:Shift', 'down:*', 'up:*', 'up:Shift', 'up:Control']);
  for (let k = 1; k < ev.length; k++) assert.ok(ev[k].t > ev[k - 1].t);
});

test('wheel: whole notches in flicks, total distance as asked', () => {
  const r = makeRng(8);
  const plan = planWheel(1730, { rng: r });
  assert.equal(plan.length, 17);
  assert.ok(plan.every((w) => w.delta === 100));
  assert.equal(planWheel(-250, { rng: r }).length, 3);
  assert.ok(planWheel(-250, { rng: r }).every((w) => w.delta === -100));
  const gaps = plan.slice(1).map((w, i) => w.t - plan[i].t);
  assert.ok(gaps.some((g) => g > 110), 'pauses between flicks');
});

test('snapper puts points on the physical pixel grid of the screen', () => {
  // 125% display, viewport 143 DIP below the top of the screen (measured on this machine)
  const snap = snapper({ ox: 0, oy: 143, scale: 1.25, zoom: 1 });
  const r = makeRng(10);
  for (let i = 0; i < 200; i++) {
    const p = snap({ x: r() * 1500, y: r() * 800 });
    const sx = (0 + p.x) * 1.25;
    const sy = (143 + p.y) * 1.25;
    assert.ok(Math.abs(sx - Math.round(sx)) < 1e-9 && Math.abs(sy - Math.round(sy)) < 1e-9);
  }
  // the real mouse sample recorded on this machine: clientX 843.2 is on the grid, 380.3 is not
  assert.equal(snap({ x: 843.2, y: 174.6 }).x, 843.2);
  assert.notEqual(snap({ x: 380.3, y: 225 }).x, 380.3);
});
