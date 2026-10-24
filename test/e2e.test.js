// End-to-end suite: the real extension, native host and MCP server against a throwaway Chrome for
// Testing profile (headless). Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { launch, fixtureServer, Mcp, refOf, sleep, pipeRequest, ROOT } from './harness.js';
import { footprint } from './footprint.js';

let fx;
let b;
let m;
before(async () => {
  fx = await fixtureServer();
  b = await launch({ headless: true });
  m = new Mcp(b.host.pid, { BROWZIE_PACE: 'brisk' });
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

test('form: every field type is filled with real clicks and keystrokes', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('form.html') }));
  const r = ok(
    await m.call('fill', {
      fields: [
        { ref: refOf(s, /textbox "Full name"/), value: 'Ada Lovelace' },
        { ref: refOf(s, /textbox "Email"/), value: 'ada@example.com' },
        { ref: refOf(s, /combobox "Country"/), value: 'United Kingdom' },
        { ref: refOf(s, /checkbox "I agree/), value: true },
        { ref: refOf(s, /radio "Pro"/), value: true },
        { ref: refOf(s, /textbox "Start date"/), value: '2026-11-05' },
        { ref: refOf(s, /slider "Volume"/), value: 7 },
        { ref: refOf(s, /textbox "Bio"/), value: 'Line one\nLine two' },
        { ref: refOf(s, /textbox "Password"/), value: 'S3cret!' },
      ],
    })
  );
  assert.match(r, /Filled 9 field/);
  const sub = ok(await m.call('click', { text: 'Create account', role: 'button' }));
  assert.match(sub, /Submitted/);
  const out = await m.js("document.getElementById('out').textContent");
  const data = JSON.parse(out.replace('Submitted ', ''));
  assert.deepEqual(data, { name: 'Ada Lovelace', email: 'ada@example.com', country: 'United Kingdom', agree: 'on', plan: 'pro', start: '2026-11-05', vol: '7', bio: 'Line one\nLine two', pw: 'S3cret!' });
});

test('iframes: same-origin, cross-origin and nested buttons are clicked through the parents', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('frames.html') }));
  const refs = [...s.matchAll(/button "Frame button" \[(f\d+e\d+)\]/g)].map((x) => x[1]);
  assert.equal(refs.length, 3, s);
  for (const ref of refs) ok(await m.call('click', { ref }));
  const after2 = ok(await m.call('snapshot', {}));
  assert.match(after2, /Clicked in same/);
  assert.match(after2, /Clicked in cross/);
  assert.match(after2, /Clicked in nested/);
});

test('long page: the target is wheel-scrolled into view, never scrolled by script', async () => {
  ok(await m.call('navigate', { url: fx.url('long.html') }));
  await m.js("window.__w = 0; addEventListener('wheel', () => window.__w++, true); 1");
  const r = ok(await m.call('click', { text: 'Bottom button' }));
  assert.match(r, /Bottom clicked/);
  assert.ok((await m.js('window.__w')) >= 10, 'wheel events moved the page');
  assert.ok((await m.js('scrollY')) > 2500);
});

test('a row past the end of a list that scrolls by itself is wheel-scrolled into view, not "covered"', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('picker.html') }));
  const r = ok(await m.call('click', { ref: refOf(s, /button "foxtrot"/) }));
  assert.equal(await m.js("document.getElementById('out').textContent"), 'Picked foxtrot', r);
  assert.ok((await m.js("document.getElementById('list').scrollTop")) > 0, 'the list itself was scrolled');
  assert.equal(await m.js('scrollY'), 0, 'not the page');
  const back = ok(await m.call('scroll', { ref: refOf(s, /button "alpha"/) }));
  assert.match(back, /Scrolled e\d+ into view \(\d+ wheel move/);
  assert.doesNotMatch(back, /No visible change/);
  assert.equal(await m.js("document.getElementById('list').scrollTop"), 0);
});

test('closed shadow roots are read and clicked', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('shadow.html') }));
  assert.match(s, /Inside a closed root/);
  const r = ok(await m.call('click', { ref: refOf(s, /button "Secret button"/) }));
  assert.match(r, /Secret clicked/);
});

test('bot checks: input is refused and handoff waits for the human', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('captcha.html') }));
  assert.match(s, /HUMAN CHECK on this page: reCAPTCHA checkbox/);
  const pay = refOf(s, /button "Pay now"/);
  const refused = await m.call('click', { ref: pay });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /HUMAN CHECK/);
  assert.equal(await m.js("document.getElementById('pay').textContent"), 'Pay now', 'nothing was clicked');
  // the "human" solves it: a token appears, as reCAPTCHA does after a solve
  const waiting = m.call('handoff', { timeout: 20000 });
  await sleep(1500);
  await m.js("document.querySelector('[name=g-recaptcha-response]').value = 'x'.repeat(40); 1");
  const done = await waiting;
  assert.equal(done.isError, false, done.text);
  assert.match(done.text, /The user is done/);
  assert.match(ok(await m.call('click', { ref: pay })), /Paid/);
});

test('dialogs never hang an action', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('dialogs.html') }));
  const r = ok(await m.call('click', { ref: refOf(s, /button "Place order"/) }));
  assert.match(r, /confirm dialog/);
  const d = ok(await m.call('dialog', { accept: true }));
  assert.match(d, /Accepted the confirm "Proceed with order\?"/);
  assert.match(d, /confirmed/);
});

test('a tab opened by the page is followed', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('popup.html') }));
  const r = ok(await m.call('click', { ref: refOf(s, /link "Open details"/) }));
  assert.match(r, /opened a new tab/);
  assert.match(r, /Details page/);
  const list = ok(await m.call('tabs', {}));
  assert.equal(list.split('\n').length, 2, list);
  ok(await m.call('tabs', { action: 'close' }));
});

test('wait_for, find, read and screenshot', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('delayed.html') }));
  ok(await m.call('click', { ref: refOf(s, /button "Ship"/) }));
  assert.match(ok(await m.call('wait_for', { text: 'Order shipped', timeout: 5000 })), /Condition met/);
  assert.match(ok(await m.call('find', { query: 'shipped' })), /Order shipped/);
  assert.match(ok(await m.call('read', {})), /Order shipped/);
  const shot = await m.call('screenshot', { labels: true });
  assert.equal(shot.isError, false, shot.text);
  assert.ok(shot.image && shot.image.data.length > 1000);
  const vw = await m.js('innerWidth');
  assert.match(shot.text, new RegExp(`${vw}x\\d+ CSS px`));
});

test('type with clear, then keyboard shortcuts', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('form.html') }));
  const name = refOf(s, /textbox "Full name"/);
  ok(await m.call('type', { ref: name, text: 'first' }));
  ok(await m.call('type', { ref: name, text: 'Second', clear: true }));
  assert.equal(await m.js("document.querySelector('[name=name]').value"), 'Second');
  ok(await m.call('press', { keys: 'Control+a Backspace' }));
  assert.equal(await m.js("document.querySelector('[name=name]').value"), '');
});

test('evaluate: expressions, statements, nested returns, top-level await', async () => {
  ok(await m.call('navigate', { url: fx.url('form.html') }));
  const val = async (script, world) => JSON.parse(ok(await m.call('evaluate', { script, world })).replace(/^Result: /, ''));
  assert.deepEqual(await val('[1, 2].map((x) => { return x * 2; })'), [2, 4]);
  assert.equal(await val('const a = 20; return a + 1'), 21);
  assert.equal(await val('let n = document.querySelectorAll("input").length; n'), 8);
  assert.equal(await val('await new Promise((r) => setTimeout(() => r(7), 10))'), 7);
  assert.equal(await val('() => document.title'), 'Signup');
  assert.equal(await val('(() => { const t = document.title; return t.length; })()'), 6, 'a self-calling function is a value, not a function to call');
  assert.equal(await val('document.title'), 'Signup');
  assert.equal(await val('typeof window.__browzie', 'main'), 'undefined', 'nothing of Browzie in the page world');
});

test('batch: a whole flow in one call, stopping at the first failing step', async () => {
  const r = await m.call('batch', {
    steps: [
      { action: 'navigate', url: fx.url('form.html') },
      { action: 'fill', fields: [{ text: 'Full name', value: 'Grace Hopper' }, { text: 'Country', value: 'India' }] },
      { action: 'click', text: 'Create account', role: 'button' },
    ],
  });
  const text = ok(r);
  assert.match(text, /^1\. Opened/m);
  assert.match(text, /^2\. Filled 2 field/m);
  assert.match(text, /^3\. Clicked button "Create account"/m);
  assert.match(text, /Submitted .*Grace Hopper.*India/);
  const bad = await m.call('batch', { steps: [{ action: 'click', text: 'No such button anywhere' }, { action: 'press', keys: 'Enter' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /1\. click FAILED/);
  assert.match(bad.text, /stopped at step 1 of 2/);
});

test('two Claude sessions at once: separate windows, input never interleaves', async () => {
  const m2 = new Mcp(b.host.pid, { BROWZIE_PACE: 'brisk' });
  await m2.init();
  try {
    const [s1, s2] = await Promise.all([m.call('navigate', { url: fx.url('probe.html?a') }), m2.call('navigate', { url: fx.url('probe.html?b') })]);
    const [c1, c2] = await Promise.all([m.call('click', { ref: refOf(ok(s1), /Target/) }), m2.call('click', { ref: refOf(ok(s2), /Target/) })]);
    ok(c1);
    ok(c2);
    const ev1 = (await m.js('window.__probe.events')).filter((e) => e.t !== 'keydown');
    const ev2 = (await m2.js('window.__probe.events')).filter((e) => e.t !== 'keydown');
    const span = (ev) => [Math.min(...ev.map((e) => e.wall)), Math.max(...ev.map((e) => e.wall))];
    const [a0, a1] = span(ev1);
    const [b0, b1] = span(ev2);
    assert.ok(a1 < b0 || b1 < a0, `input overlapped: [${a0}, ${a1}] vs [${b0}, ${b1}]`);
    assert.equal(await m.js('window.__probe.clicks'), 1);
    assert.equal(await m2.js('window.__probe.clicks'), 1);
    // reads are never blocked by the other session's input
    const t0 = Date.now();
    const pending = m2.call('click', { ref: refOf(ok(s2), /Target/) });
    await sleep(100);
    ok(await m.call('snapshot', {}));
    assert.ok(Date.now() - t0 < 1500, 'snapshot waited for the other session');
    ok(await pending);
  } finally {
    m2.close();
  }
});

test('a popup window (sign-in) is followed, flagged for handoff, and left when it closes', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('extras.html') }));
  const r = ok(await m.call('click', { ref: refOf(s, /button "Sign in with Example"/) }));
  assert.match(r, /opened a popup window; Browzie switched to it/);
  assert.match(r, /It asks for a password\. Call signin/);
  assert.match(r, /\[tab 2, popup window\] Example sign-in/);
  const list = ok(await m.call('tabs', {}));
  assert.match(list, /\* \[tab 2\] \(popup window\) Example sign-in/);
  const c = ok(await m.call('click', { text: 'Continue', role: 'button' }));
  assert.match(c, /That popup window closed; Browzie is back on the tab that opened it/);
  assert.match(c, /Signed in/);
  assert.equal(ok(await m.call('tabs', {})).split('\n').length, 1);
});

test('tabs: numbers as listed, clear errors', async () => {
  ok(await m.call('navigate', { url: fx.url('extras.html') }));
  const e1 = await m.call('tabs', { action: 'select', id: 5 });
  assert.equal(e1.isError, true);
  assert.match(e1.text, /There is no tab 5; there is 1 tab:\n\* \[tab 1\] Extras/);
  const e2 = await m.call('tabs', { action: 'select', id: 0 });
  assert.match(e2.text, /Tab numbers start at 1/);
  assert.match(ok(await m.call('tabs', { action: 'select', id: 1 })), /\[tab 1\] Extras/);
  const e3 = await m.call('tabs', { action: 'close' });
  assert.match(e3.text, /last tab of the Browzie window/);
});

test('text matching: never from inside a word, whole words first, invisible characters ignored', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('extras.html') }));
  assert.match(s, /button "Next step"/, 'the zero-width space is not in the name');
  ok(await m.call('click', { text: 'hide', role: 'button' }));
  ok(await m.call('click', { text: 'Next', role: 'button' }));
  assert.deepEqual(await m.js('clicks'), ['Hide like count', 'Ne​xt step']);
  await m.js('document.getElementById("hide").remove(), 1');
  const r = await m.call('click', { text: 'hide like', role: 'button' });
  assert.equal(r.isError, true);
  assert.match(r.text, /start inside a word there: button "Unhide like count"/);
  assert.deepEqual(await m.js('clicks'), ['Hide like count', 'Ne​xt step'], 'Unhide was not clicked');
  assert.match(ok(await m.call('find', { query: 'standings' })), /👇🔥/);
});

test('upload: a button that opens the file chooser gets the files (no Windows dialog)', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('extras.html') }));
  const a = path.join(ROOT, 'test', 'fixtures', 'page2.html');
  const b2 = path.join(ROOT, 'test', 'fixtures', 'form.html');
  const r = ok(await m.call('upload', { ref: refOf(s, /button "Select files"/), files: [a, b2] }));
  assert.match(r, /Uploaded button "Select files" \[e\d+\]: page2\.html, form\.html/);
  assert.equal(await m.js('document.getElementById("files").textContent'), 'page2.html, form.html');
  // fill does the same for a button given file paths
  ok(await m.call('fill', { fields: [{ text: 'Select files', role: 'button', value: [a] }] }));
  assert.equal(await m.js('document.getElementById("files").textContent'), 'page2.html');
  const bad = await m.call('upload', { text: 'Select files', files: [path.join(ROOT, 'no-such-file.mp4')] });
  assert.match(bad.text, /No such file/);
  assert.match(ok(await m.call('wait_for', { text: 'page2.html', snapshot: 'none' })), /^Condition met after \d+ ms$/);
});

test('long typing: progress is reported, and a stopped type call resumes exactly', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('extras.html') }));
  const cap = refOf(s, /textbox "Caption"/);
  const text = 'Do chicken dinner, phir bhi ticket nahi! Final standings mein ek point ka farak tha.\nAapke hisaab se kya zaroori hai? Comment karo 👇';
  const total = [...text].length;
  m.progress = [];
  const typing = m.call('type', { ref: cap, text, typos: true }, { progressToken: 'p1' });
  await sleep(4500);
  await pipeRequest(b.host, 'test_takeover'); // you clicked into the Browzie window
  const stopped = await typing;
  assert.equal(stopped.isError, true);
  const hit = /Typing stopped after (\d+) of (\d+) characters: call type with resume: true/.exec(stopped.text);
  assert.ok(hit, stopped.text);
  const n = Number(hit[1]);
  assert.equal(Number(hit[2]), total);
  assert.ok(n > 3 && n < total, `stopped part way (${n})`);
  assert.ok(m.progress.length >= 1 && m.progress.every((p) => p.progressToken === 'p1' && p.total === total), JSON.stringify(m.progress));
  const r = ok(await m.call('type', { resume: true }));
  assert.match(r, /Finished typing \(resumed at character/);
  assert.equal(await m.js('document.getElementById("cap").value'), text);
  const again = await m.call('type', { resume: true });
  assert.match(again.text, /no stopped typing to resume/);
});

test('a dialog kept in a zero-height wrapper at the top edge is read and clicked; off-page text is not', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('wrapped.html') }));
  assert.match(s, /How you'll appear/);
  assert.doesNotMatch(s, /Off-page text/);
  assert.match(ok(await m.call('find', { query: 'Select picture' })), /button "Select picture"/);
  ok(await m.call('click', { ref: refOf(s, /button "Select picture"/) }));
  assert.equal(await m.js("document.getElementById('pick').textContent"), 'Picked');
});

test('an iframe that went elsewhere after load (a redirect) is in snapshots, and its refs from find click', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('moved.html') }));
  ok(await m.call('click', { ref: refOf(s, /button "Frame button"/) }));
  assert.match(ok(await m.call('snapshot', {})), /Clicked in moved/);
  // a fresh page whose frame no snapshot has listed: the ref comes from find
  ok(await m.call('navigate', { url: fx.url('moved.html'), snapshot: 'none' }));
  const f = ok(await m.call('find', { query: 'Frame button' }));
  ok(await m.call('click', { ref: refOf(f, /Frame button/) }));
  assert.match(ok(await m.call('find', { query: 'Clicked in' })), /Clicked in moved/);
});

test('type sends no keys when no text field has the focus', async () => {
  ok(await m.call('navigate', { url: fx.url('form.html') }));
  await m.js("window.__keys = 0; addEventListener('keydown', () => window.__keys++, true); 1");
  const r = await m.call('type', { text: 'lost' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Nothing that takes text has the focus \(nothing has the focus\), so nothing was typed/);
  assert.equal(await m.js('window.__keys'), 0);
});

const waitFor = async (script, want, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await m.js(script);
    if (v === want || Date.now() > end) return v;
    await sleep(200);
  }
};

test('signin: Browzie clicks into the form, the user picks a saved login, Browzie sends it', async () => {
  const s = ok(await m.call('navigate', { url: fx.url('login.html') }));
  assert.match(s, /It asks for a password\. Call signin/);
  const p = m.call('signin', { timeout: 30000 });
  assert.equal(await waitFor("(document.activeElement && document.activeElement.name) || ''", 'user'), 'user', 'Browzie clicked into the username field');
  assert.equal(await m.js('window.__sent'), 0, 'nothing is sent before the pick');
  await pipeRequest(b.host, 'test_autofill'); // the user picked the login: Chrome filled the form
  const r = ok(await p);
  assert.match(r, /Chrome filled the saved login the user picked and Browzie pressed button "Sign in"/);
  assert.match(r, /Welcome back/);
  assert.equal(await m.js('window.__sent'), 1);
});

test("signin: a form Chrome filled on page load is the user's to send; Browzie only waits", async () => {
  ok(await m.call('navigate', { url: fx.url('login.html') }));
  await pipeRequest(b.host, 'test_autofill');
  const p = m.call('signin', { timeout: 30000 });
  await sleep(2500);
  assert.equal(await m.js('window.__sent'), 0, 'Browzie did not send it');
  await m.js("document.getElementById('f').requestSubmit(), 1"); // the user clicks Sign in
  assert.match(ok(await p), /the user finished it/);
  assert.equal(await m.js('window.__sent'), 1);
});

test('signin: no sign-in form, and a new-password form, are refused before any input', async () => {
  ok(await m.call('navigate', { url: fx.url('page2.html') }));
  assert.match((await m.call('signin', {})).text, /There is no sign-in form on this page/);
  ok(await m.call('navigate', { url: fx.url('login.html') }));
  await m.js("document.querySelector('[name=pass]').setAttribute('autocomplete', 'new-password'); document.querySelector('[name=user]').remove(); 1");
  const r = await m.call('signin', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /asks for a new password/);
});

test('footprint: what a bot-detection script on the page can observe', async () => {
  const checks = await footprint({ log: () => {} });
  const failed = checks.filter((c) => !c.pass);
  assert.equal(failed.length, 0, failed.map((c) => `${c.name}: ${c.detail}`).join('\n'));
});
