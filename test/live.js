// Live test on real websites in a visible window (Chrome for Testing, throwaway profile):
//   1. bot.sannysoft.com            classic automation and fingerprint checks (a debugging-port launch fails "WebDriver")
//   2. deviceandbrowserinfo.com     "are you a bot" page, including DevTools-protocol detection
//   3. en.wikipedia.org             a real task: search, open the article, read it
// Screen grabs of the virtual cursor and Browzie's own page screenshots go to test/out/.
//   node test/live.js        (keep your hands off the mouse while it runs, or Browzie yields to you)
import fs from 'fs';
import path from 'path';
import { launch, Mcp, refOf, sleep, pipeRequest, grabScreen, ROOT } from './harness.js';

const out = path.join(ROOT, 'test', 'out');
fs.mkdirSync(out, { recursive: true });
const b = await launch({ headless: false });
const m = new Mcp(b.host.pid);
const results = [];
const note = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
async function shot(file) {
  const r = await m.call('screenshot', {});
  if (r.image) fs.writeFileSync(path.join(out, file), Buffer.from(r.image.data, 'base64'));
}
async function grabCursor(file, w = 520, h = 300) {
  const where = JSON.parse(await pipeRequest(b.host, 'lens_where'));
  grabScreen(where.x - w * 0.35, where.y - h * 0.45, w, h, path.join(out, file));
  return where;
}
const iso = async (script) => {
  const r = await m.call('evaluate', { script, maxChars: 200000 });
  if (r.isError) throw new Error(r.text);
  return JSON.parse(r.text.replace(/^Result: /, ''));
};

try {
  await m.init();

  // 1. sannysoft
  try {
    const nav = await m.call('navigate', { url: 'https://bot.sannysoft.com/' });
    if (nav.isError) throw new Error(nav.text);
    await m.call('scroll', { direction: 'down', amount: 500 }); // a person looks around
    await sleep(2500);
    const rows = await iso(`[...document.querySelectorAll('tr')].map((tr) => { const td = tr.querySelectorAll('td'); return td.length >= 2 ? { name: td[0].innerText.trim().replace(/\\s+/g, ' '), result: td[td.length - 1].innerText.trim().slice(0, 60).replace(/\\s+/g, ' '), cls: td[td.length - 1].className } : null; }).filter(Boolean)`);
    const failed = rows.filter((r) => /failed/.test(r.cls));
    const warned = rows.filter((r) => /warn/.test(r.cls));
    const passed = rows.filter((r) => /passed/.test(r.cls));
    const wd = rows.find((r) => /^WebDriver\b/.test(r.name) && !/Advanced/.test(r.name));
    note('sannysoft: WebDriver row passes', wd && /passed/.test(wd.cls), wd ? wd.result : 'row not found');
    note('sannysoft: no failed checks', failed.length === 0, `${passed.length} passed, ${warned.length} warnings, ${failed.length} failed${failed.length ? ': ' + failed.map((f) => f.name).join(', ') : ''}`);
    if (warned.length) console.log('      warnings:', warned.map((w) => `${w.name} = ${w.result}`).join('; '));
    await m.call('scroll', { to: 'top' });
    await shot('live-sannysoft.jpg');
  } catch (e) {
    note('sannysoft', false, e.message.split('\n')[0]);
  }

  // 2. deviceandbrowserinfo "are you a bot"
  try {
    const nav = await m.call('navigate', { url: 'https://deviceandbrowserinfo.com/are_you_a_bot' });
    if (nav.isError) throw new Error(nav.text);
    await sleep(5000);
    const text = (await m.call('read', { max: 6000 })).text;
    const verdict = /You are (a )?human/i.test(text) ? 'human' : /You are a bot|bot detected/i.test(text) ? 'bot' : 'unclear';
    note('deviceandbrowserinfo verdict is "human"', verdict === 'human', verdict);
    const flagged = [...text.matchAll(/^\s*([A-Za-z][\w ]{3,60}?)\s*[:\-]?\s*(true)\s*$/gim)].map((x) => x[1].trim());
    if (flagged.length) console.log('      signals reported true:', flagged.slice(0, 12).join(', '));
    await shot('live-areyouabot.jpg');
  } catch (e) {
    note('deviceandbrowserinfo', false, e.message.split('\n')[0]);
  }

  // 3. a real task on Wikipedia, with the cursor on screen
  try {
    const nav = await m.call('navigate', { url: 'https://en.wikipedia.org/wiki/Main_Page' });
    if (nav.isError) throw new Error(nav.text);
    const box = refOf(nav.text, /(searchbox|textbox|combobox) "Search Wikipedia"/);
    await m.call('hover', { ref: box });
    await sleep(250);
    await grabCursor('live-cursor-search.png');
    const typed = await m.call('type', { ref: box, text: 'Alan Turing', submit: true });
    if (typed.isError) throw new Error(typed.text);
    const w = await m.call('wait_for', { text: 'mathematician', timeout: 15000 });
    note('Wikipedia: searched by typing and pressing Enter', !w.isError, typed.text.split('\n')[0]);
    const read = await m.call('read', { selector: '#mw-content-text', max: 1500 });
    note('Wikipedia: article opened and read', /Alan Turing/.test(read.text) && /mathematician/i.test(read.text), read.text.split('\n')[0]);
    const snap = await m.call('snapshot', { viewportOnly: true, interactiveOnly: true });
    const link = refOf(snap.text, /link "(computer scientist|mathematician|logician)"/i);
    const h = await m.call('hover', { ref: link });
    await sleep(900); // Wikipedia shows a page preview on hover
    await grabCursor('live-cursor-hover.png', 760, 420);
    note('Wikipedia: hovered a link with the cursor (page preview)', !h.isError, h.text.split('\n')[0]);
    await shot('live-wikipedia.jpg');
  } catch (e) {
    note('Wikipedia task', false, e.message.split('\n')[0]);
  }
} finally {
  m.close();
  await b.close();
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed} of ${results.length} live checks passed. Images in test/out/`);
process.exit(failed ? 1 : 0);
