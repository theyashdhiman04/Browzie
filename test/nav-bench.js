// Navigation time on real, heavy sites (headless Chrome for Testing), median of 3 per site.
//   node test/nav-bench.js
import { launch, Mcp } from './harness.js';

const SITES = ['https://www.youtube.com/', 'https://github.com/trending', 'https://vercel.com/', 'https://en.wikipedia.org/wiki/Alan_Turing'];
const b = await launch({ headless: true });
const m = new Mcp(b.host.pid);
await m.init();
const median = (xs) => [...xs].sort((a, c) => a - c)[1];
try {
  await m.call('navigate', { url: 'https://example.com/', snapshot: 'none' }); // warm the window
  for (const url of SITES) {
    const times = [];
    let lines = 0;
    for (let i = 0; i < 3; i++) {
      const r = await m.call('navigate', { url });
      if (r.isError) throw new Error(r.text);
      times.push(r.ms);
      lines = r.text.split('\n').length;
    }
    console.log(`${url.padEnd(44)} ${String(median(times)).padStart(5)} ms  (${times.join(', ')})  ${lines} snapshot lines`);
  }
} finally {
  m.close();
  await b.close();
}
