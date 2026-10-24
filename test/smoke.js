// Quick end-to-end smoke run: one browser, a few tools, everything printed.
//   node test/smoke.js [--headed]
import { launch, fixtureServer, Mcp } from './harness.js';

const headed = process.argv.includes('--headed');
const fx = await fixtureServer();
const b = await launch({ headless: !headed });
console.log('host', b.host.pid, b.host.ua);
const m = new Mcp(b.host.pid);
await m.init();
const show = (label, r) => console.log(`\n=== ${label} (${r.ms} ms)${r.isError ? ' ERROR' : ''}\n${r.text.slice(0, 1500)}`);
try {
  show('navigate form', await m.call('navigate', { url: fx.url('form.html') }));
  show('click checkbox', await m.call('click', { text: 'I agree to the terms' }));
  show('snapshot', await m.call('snapshot', { interactiveOnly: true }));
} finally {
  m.close();
  await b.close();
  fx.close();
}
