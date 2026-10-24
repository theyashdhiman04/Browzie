// Footprint test: drives probe.html like a person and checks everything a bot-detection script on
// that page could observe. Run headless (default) or in a visible window:
//   node test/footprint.js [--headed]
// Exit code 0 only if every check passes. Also exported for the test suite.
import { launch, fixtureServer, Mcp, refOf } from './harness.js';

export async function footprint({ headed = false, log = console.log } = {}) {
  const fx = await fixtureServer();
  const b = await launch({ headless: !headed });
  const m = new Mcp(b.host.pid, { BROWZIE_PACE: 'human' }); // this measures the person-like pace; fast trades it for speed
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  try {
    await m.init();
    // the first page in a brand-new window sees the window settle (also without Browzie attached);
    // judge Browzie on a page loaded into the settled window
    await m.call('navigate', { url: fx.url('probe.html?warmup'), snapshot: 'none' });
    const nav = await m.call('navigate', { url: fx.url('probe.html') });
    const target = refOf(nav.text, /button "Target"/);
    const field = refOf(nav.text, /textbox "Type here"/);
    const c = await m.call('click', { ref: target });
    log('click:', c.text.split('\n')[0]);
    const ty = await m.call('type', { ref: field, text: 'Hello, World 42' });
    log('type :', ty.text.split('\n')[0]);
    const sc = await m.call('scroll', { direction: 'down', amount: 400 });
    log('wheel:', sc.text.split('\n')[0]);
    const P = await m.js('window.__probe');
    const dpr = await m.js('devicePixelRatio');
    const ev = P.events;
    const by = (t) => ev.filter((e) => e.t === t);

    check('the click arrived exactly once', P.clicks === 1, String(P.clicks));
    check('the page saw no viewport resize while Browzie worked', P.resizes === 0, String(P.resizes));
    check('navigator.webdriver is false', P.webdriver === false, String(P.webdriver));
    check('no DevTools-protocol tell (console serialisation)', P.cdp === false, String(P.cdp));
    check('extension files unreachable from the page', P.extProbe === 'blocked', P.extProbe);
    check('no DOM nodes added to the page', P.added.length === 0, P.added.join(','));
    check('no attributes changed on the page', P.attrs.length === 0, P.attrs.slice(0, 5).join(','));
    check('every input event is trusted', ev.length > 0 && ev.every((e) => e.tr), `${ev.filter((e) => !e.tr).length} untrusted of ${ev.length}`);

    const moves = by('pointermove');
    const down = by('pointerdown')[0];
    const before = down ? moves.filter((e) => e.ts < down.ts) : [];
    check('pointer travels to the target (no teleport)', before.length >= 8, `${before.length} moves before the press`);
    const maxStep = Math.max(...before.map((e) => Math.hypot(e.mx, e.my)));
    const way = before.length ? Math.hypot(before[before.length - 1].cx - before[0].cx, before[before.length - 1].cy - before[0].cy) : 0;
    check('no single pointer step covers more than a quarter of the way', way > 0 && maxStep < 0.25 * way, `largest ${maxStep.toFixed(1)} px of ${way.toFixed(0)} px`);
    const gaps = moves.slice(1).map((e, i) => e.ts - moves[i].ts).filter((g) => g < 200);
    const medGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    check('move events arrive at a mouse-like rate (5 to 25 ms)', medGap >= 5 && medGap <= 25, `median ${medGap && medGap.toFixed(1)} ms`);
    // path is curved, not a ruler-straight line
    if (before.length > 4) {
      const a = before[0];
      const z = before[before.length - 1];
      const L = Math.hypot(z.cx - a.cx, z.cy - a.cy) || 1;
      const dev = Math.max(...before.map((p) => Math.abs((z.cx - a.cx) * (a.cy - p.cy) - (a.cx - p.cx) * (z.cy - a.cy)) / L));
      check('path is not a perfect straight line', dev > 0.5, `max deviation ${dev.toFixed(2)} px over ${L.toFixed(0)} px`);
    }
    check('pointerdown pressure is 0.5 like a real mouse button', down && Math.abs(down.pr - 0.5) < 1e-6, down && String(down.pr));
    const md = by('mousedown')[0];
    const mu = by('mouseup')[0];
    check('button held 40 to 200 ms', md && mu && mu.ts - md.ts >= 40 && mu.ts - md.ts <= 200, md && mu && `${(mu.ts - md.ts).toFixed(0)} ms`);
    const onGrid = moves.every((e) => Math.abs(e.sx * dpr - Math.round(e.sx * dpr)) < 0.02 && Math.abs(e.sy * dpr - Math.round(e.sy * dpr)) < 0.02);
    check(`pointer positions sit on the physical pixel grid (dpr ${dpr})`, onGrid, onGrid ? 'all on grid' : 'some off grid');

    const kd = by('keydown').filter((e) => e.key !== 'Shift');
    const ku = by('keyup').filter((e) => e.key !== 'Shift');
    const holds = kd.map((d) => {
      const u = ku.find((x) => x.code === d.code && x.ts >= d.ts);
      return u ? u.ts - d.ts : null;
    }).filter((x) => x != null);
    check('every key has a down and an up', kd.length === 15 && ku.length === 15, `${kd.length} down, ${ku.length} up`);
    check('keys held 30 to 200 ms', holds.length && holds.every((h) => h >= 30 && h <= 200), `min ${Math.min(...holds).toFixed(0)}, max ${Math.max(...holds).toFixed(0)} ms`);
    const iki = kd.slice(1).map((e, i) => e.ts - kd[i].ts);
    const meanIki = iki.reduce((a, x) => a + x, 0) / iki.length;
    check('typing rhythm is human (mean 90 to 400 ms between keys)', meanIki >= 90 && meanIki <= 400, `mean ${meanIki.toFixed(0)} ms`);
    const shiftDowns = by('keydown').filter((e) => e.key === 'Shift').length;
    check('capitals typed with a real Shift key', shiftDowns >= 2, `${shiftDowns} Shift presses for "H" and "W"`);
    check('keys only go to a focused page', kd.every((e) => e.hf), kd.every((e) => e.hf) ? 'document.hasFocus() true' : 'typed while unfocused');
    const typed = await m.js("document.getElementById('t').value");
    check('typed text arrived exactly', typed === 'Hello, World 42', JSON.stringify(typed));

    const wheels = by('wheel');
    // a busy renderer merges quick notches into one event (it does that with a real wheel too)
    const total = wheels.reduce((s, w) => s + w.dy, 0);
    check('scrolling uses whole wheel notches', wheels.length >= 2 && wheels.every((w) => w.dy % 100 === 0 && w.dm === 0) && total === 400, `${wheels.length} wheel events, ${total} px in notches of 100`);
    log('resize events seen by the page (debugger bar):', P.resizes);
  } finally {
    m.close();
    await b.close();
    fx.close();
  }
  return checks;
}

if (process.argv[1] && process.argv[1].endsWith('footprint.js')) {
  const checks = await footprint({ headed: process.argv.includes('--headed') });
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.pass).length;
  console.log(failed ? `\n${failed} check(s) failed` : `\nall ${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
