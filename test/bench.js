// Latency benchmark (headless Chrome for Testing, local pages, median of N).
//   node test/bench.js
// Read tools are as fast as the transport allows. Input tools are deliberately human-paced; their
// numbers are reported separately as "human time" and are not something to optimise away.
import { launch, fixtureServer, Mcp, refOf } from './harness.js';

const N = 15;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fx = await fixtureServer();
const b = await launch({ headless: true });
const m = new Mcp(b.host.pid);
await m.init();
const rows = [];
async function measure(label, fn, gap = 0) {
  const times = [];
  let size = 0;
  for (let i = 0; i < N; i++) {
    if (gap) await new Promise((r) => setTimeout(r, gap));
    const t0 = performance.now();
    const r = await fn(i);
    times.push(performance.now() - t0);
    if (r && r.isError) throw new Error(`${label}: ${r.text}`);
    size = r && r.text ? r.text.length : 0;
  }
  rows.push([label, median(times), size]);
}
try {
  await m.call('navigate', { url: fx.url('form.html') });
  await measure('round trip through every hop (status)', () => m.call('tabs', {}));
  await measure('snapshot of a form page', () => m.call('snapshot', {}));
  await measure('find an element', () => m.call('find', { query: 'Email' }));
  await measure('read page text', () => m.call('read', {}));
  // spaced out: Chrome allows two captures per second, back-to-back calls wait for a slot
  await measure('viewport screenshot (JPEG, CSS px)', () => m.call('screenshot', {}), 600);
  await m.call('navigate', { url: fx.url('frames.html') });
  await measure('snapshot with 3 iframes (2 cross-origin, 1 nested)', () => m.call('snapshot', {}));
  await measure('navigate + full snapshot', (i) => m.call('navigate', { url: fx.url(`form.html?${i}`) }));
  const s = await m.call('navigate', { url: fx.url('probe.html') });
  const target = refOf(s.text, /button "Target"/);
  const field = refOf(s.text, /textbox "Type here"/);
  const human = [];
  for (let i = 0; i < 5; i++) {
    human.push((await m.call('click', { ref: i % 2 ? target : field })).ms);
  }
  rows.push(['click incl. human movement, dwell and pacing (human time)', median(human), 0]);
  const typing = (await m.call('type', { ref: field, text: 'twenty characters ok' })).ms;
  rows.push(['type 20 characters (human time)', typing, 0]);
} finally {
  m.close();
  await b.close();
  fx.close();
}
console.log('| Operation | Median | Reply |\n|---|---:|---:|');
for (const [label, ms, size] of rows) console.log(`| ${label} | ${ms.toFixed(0)} ms | ${size ? size + ' chars' : ''} |`);
