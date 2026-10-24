// The on-screen overlay behaves (visible window, a few seconds):
//   1. while Browzie acts, the cursor and the purple frame are shown, and the frame lines up with the
//      page area to the pixel
//   2. a few seconds after the action, both are gone
//   3. after you resize the window, the next action draws the frame at the new size and place
//   4. when you switch to another tab, both disappear at once
//   node test/overlay-check.js
import { launch, fixtureServer, Mcp, refOf, sleep, pipeRequest } from './harness.js';

const fx = await fixtureServer();
const b = await launch({ headless: false });
const m = new Mcp(b.host.pid);
let ok = true;
const check = (name, pass, detail) => {
  ok = ok && pass;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const where = async () => JSON.parse(await pipeRequest(b.host, 'lens_where'));
// the page area in physical pixels, from Chrome's own last pointer event
async function pageRect() {
  const p = await m.js("(() => { const e = window.__probe.events.filter((x) => x.t === 'pointermove').pop(); return { sx: e.sx, sy: e.sy, cx: e.cx, cy: e.cy, w: innerWidth, h: innerHeight, dpr: devicePixelRatio }; })()");
  const L = (p.sx - p.cx) * p.dpr;
  const T = (p.sy - p.cy) * p.dpr;
  return [L, T, L + p.w * p.dpr, T + p.h * p.dpr];
}
const off = (a, e) => Math.max(...a.map((v, i) => Math.abs(v - e[i])));
try {
  await m.init();
  await m.call('navigate', { url: fx.url('probe.html?warmup'), snapshot: 'none' });
  const nav = await m.call('navigate', { url: fx.url('probe.html') });
  const target = refOf(nav.text, /button "Target"/);

  await m.call('hover', { ref: target });
  let w = await where();
  let e = await pageRect();
  check('1. during an action the cursor and frame are shown', w.shown && w.frameShown, JSON.stringify(w));
  check('1. the frame lines up with the page area', off(w.frame, e) <= 1.5, `frame ${w.frame.join(',')} vs page ${e.map((v) => v.toFixed(1)).join(',')}`);

  await sleep(8600);
  w = await where();
  check('2. a few seconds after the action both are gone', !w.shown && !w.frameShown, `cursor ${w.shown}, frame ${w.frameShown}`);

  await pipeRequest(b.host, 'test_resize');
  await sleep(1200);
  await m.call('hover', { ref: target });
  w = await where();
  e = await pageRect();
  check('3. after a resize the frame fits the new page area', w.frameShown && off(w.frame, e) <= 1.5, `frame ${w.frame.join(',')} vs page ${e.map((v) => v.toFixed(1)).join(',')}`);

  // 5. reading (no input at all) also shows the resting cursor and the frame
  await sleep(8600);
  await m.call('read', { max: 200 });
  await sleep(300);
  w = await where();
  check('5. reading the page shows the resting cursor and the frame', w.shown && w.frameShown, `cursor ${w.shown}, frame ${w.frameShown}`);
  const moves = await m.js("window.__probe.events.filter((e) => e.t === 'pointermove').length");
  await m.call('read', { max: 200 });
  check('5. and sends nothing to the page', (await m.js("window.__probe.events.filter((e) => e.t === 'pointermove').length")) === moves, 'no pointer events from reading');

  await pipeRequest(b.host, 'test_user_tab');
  await sleep(600);
  w = await where();
  check('4. switching to another tab hides them at once', !w.shown && !w.frameShown, `cursor ${w.shown}, frame ${w.frameShown}`);
} finally {
  m.close();
  await b.close();
  fx.close();
}
console.log(ok ? '\nPASS  overlay only while Browzie acts, aligned to the page' : '\nFAIL');
process.exit(ok ? 0 : 1);
