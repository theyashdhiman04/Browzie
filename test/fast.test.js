// The fast pace (the default since 2026-10-21) and the fixes from the 21 Oct posting day: chunked
// typing, one-line reports, auto-wait for late targets, wait_for enabled, the re-rendered-ref
// guard, evaluate's "script" aliases. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, fixtureServer, Mcp, refOf } from './harness.js';

let fx;
let b;
let m;
before(async () => {
  fx = await fixtureServer();
  b = await launch({ headless: true });
  m = new Mcp(b.host.pid, { BROWZIE_PACE: 'fast' });
  await m.init();
});
after(async () => {
  m && m.close();
  b && (await b.close());
  fx && fx.close();
});
const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r.text;
};
const CAPTION = 'Techno Gamerz ki awaaz ab BGMI ke andar! BGMI ne khud bola: Techno Gamerz Voice Pack is here.\n\n19 October ko video aaya, aur ye 20 October se live hai. 👇 Comment karo\n#BGMI #TechnoGamerz #BGMIUpdate';

test('fast: a 170-character caption with line breaks and an emoji goes in exactly, in about a second', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('fast.html') }));
  const t0 = Date.now();
  const r = ok(await m.call('type', { ref: refOf(s, /textbox "Caption"/), text: CAPTION, snapshot: 'none' }));
  const ms = Date.now() - t0;
  assert.equal(r.split('\n').length, 1, 'snapshot none: one line');
  assert.equal(await m.js("document.getElementById('cap').value"), CAPTION);
  assert.ok(ms < 4000, `took ${ms} ms`);
});

test('fast: a click is quick, and a text target that appears late is waited for', async () => {
  ok(await m.call('navigate', { url: fx.url('fast.html') }));
  const t0 = Date.now();
  ok(await m.call('click', { text: 'Show late', role: 'button', snapshot: 'none' }));
  const one = Date.now() - t0;
  assert.ok(one < 2500, `click took ${one} ms`);
  ok(await m.call('click', { text: 'Late button', role: 'button', snapshot: 'none' }));
  assert.equal(await m.js('window.__late'), 1);
});

test('wait_for enabled: returns once the disabled Next button becomes usable', async () => {
  ok(await m.call('navigate', { url: fx.url('fast.html') }));
  const early = await m.call('wait_for', { text: 'Next', role: 'button', enabled: true, timeout: 400, snapshot: 'none' });
  assert.equal(early.isError, true, 'still disabled');
  ok(await m.call('click', { text: 'Finish upload', role: 'button', snapshot: 'none' }));
  assert.match(ok(await m.call('wait_for', { text: 'Next', role: 'button', enabled: true, timeout: 5000, snapshot: 'none' })), /Condition met/);
});

test('a ref whose element now says something else is refused, not clicked', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('fast.html') }));
  const bgmi = refOf(s, /option "Battlegrounds Mobile India 2021"/);
  ok(await m.call('click', { text: 'Filter', role: 'button', snapshot: 'none' }));
  const r = await m.call('click', { ref: bgmi });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /now reads "Free Fire"/);
  assert.equal(await m.js('window.__picked || null'), null, 'nothing was picked');
  ok(await m.call('click', { text: 'Battlegrounds Mobile India 2021', role: 'option', snapshot: 'none' }));
  assert.equal(await m.js('window.__picked'), 'Battlegrounds Mobile India 2021');
});

test('evaluate: the code also arrives as "expression"; an empty script is an error, not "undefined"', async () => {
  ok(await m.call('navigate', { url: fx.url('fast.html') }));
  assert.equal(ok(await m.call('evaluate', { script: 'document.title' })), 'Result: "Fast"');
  assert.equal(ok(await m.call('evaluate', { expression: 'document.title' })), 'Result: "Fast"');
  assert.equal(ok(await m.call('evaluate', { script: 'return document.title' })), 'Result: "Fast"');
  const r = await m.call('evaluate', { script: '' });
  assert.equal(r.isError, true);
  assert.match(r.text, /needs the JavaScript in "script"/);
});

test('wait_for url: a path with slashes is a substring, not a broken regex', async () => {
  ok(await m.call('navigate', { url: fx.url('fast.html') }));
  assert.match(ok(await m.call('wait_for', { url: '/fast.html', timeout: 2000, snapshot: 'none' })), /Condition met/);
  assert.match(ok(await m.call('wait_for', { url: '/fast\\.html$/', timeout: 2000, snapshot: 'none' })), /Condition met/);
});
