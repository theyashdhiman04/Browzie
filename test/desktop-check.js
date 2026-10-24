// Virtual desktop check. Browzie's windows must open on the desktop of the Claude Code session that
// drives them (here: a desktop you are not looking at), never activate, and never pull you over:
//   - the session window and a popup window the page opens land on that desktop
//   - the window you are working in stays the foreground window, and your desktop stays in view
//   - the page counts as visible and focused there, and real input reaches it
//   node test/desktop-check.js         uses the last desktop that is not the one in view
//   node test/desktop-check.js 3       uses desktop 3
// Needs two or more virtual desktops. A minimised Chrome for Testing window shows up in your
// taskbar for the duration of the check.
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { launch, fixtureServer, Mcp, refOf, sleep, pipeRequest, ROOT } from './harness.js';

const LENS = path.join(ROOT, 'lens', 'browzie-lens.exe');
const desks = () => JSON.parse(execFileSync(LENS, ['--desktops'], { encoding: 'utf8' }).trim());
const ps = (script) => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const NATIVE = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IVDM { [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out int on); [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id); }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string Info() { IntPtr h = GetForegroundWindow(); var t = new System.Text.StringBuilder(256); GetWindowText(h, t, 256); var c = new System.Text.StringBuilder(128); GetClassName(h, c, 128); uint pid; GetWindowThreadProcessId(h, out pid); return h.ToInt64() + " " + c + " pid " + pid + " [" + t + "]"; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  public static int Cloaked(long h) { int v; return DwmGetWindowAttribute(new IntPtr(h), 14, out v, 4) == 0 ? v : -1; }
  public static string Desk(long h) { var m = (IVDM)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"))); Guid g; return m.GetWindowDesktopId(new IntPtr(h), out g) == 0 ? g.ToString() : "?"; }
}
'@
`;
const foreground = () => Number(ps(`${NATIVE}[W]::GetForegroundWindow().ToInt64()`));
const deskOf = (hwnd) => ps(`${NATIVE}[W]::Desk(${hwnd})`);
const fgInfo = () => ps(`${NATIVE}[W]::Info()`);
const iconic = (hwnd) => ps(`${NATIVE}[W]::IsIconic([IntPtr]${hwnd})`) === 'True';
const cloaked = (hwnd) => ps(`${NATIVE}[W]::Cloaked(${hwnd})`);

const d0 = desks();
if (d0.desktops.length < 2) {
  console.log('Only one virtual desktop: add one (Win+Ctrl+D, then come back) to run this check.');
  process.exit(0);
}
const pick = process.argv[2] ? Number(process.argv[2]) : d0.desktops.map((d, i) => i + 1).filter((i) => d0.desktops[i - 1] !== d0.current).pop();
const target = d0.desktops[pick - 1];
console.log(`Desktop in view: ${d0.desktops.indexOf(d0.current) + 1}; Browzie's home desktop for this check: ${pick}`);
const fg0 = foreground();

const fails = [];
const check = (cond, what) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}`);
  if (!cond) fails.push(what);
};
// You may keep working while this runs, so a new foreground window only fails the check when it
// is on Browzie's desktop (a window there can only be in front because Browzie put it there).
const fgCheck = (what) => {
  const fg = foreground();
  const ok = fg === fg0 || deskOf(fg) !== target;
  check(ok, ok ? what : `${what} (the foreground is now ${fgInfo()})`);
};
console.log(`your foreground window: ${fgInfo()}`);
const fx = await fixtureServer();
const b = await launch({ headless: false, minimised: true });
fgCheck('starting Chrome did not change your foreground window');
const m = new Mcp(b.host.pid, { BROWZIE_DESKTOP: String(pick), BROWZIE_PACE: 'brisk' });
try {
  await m.init();
  for (let i = 0; i < 40 && !JSON.parse(await pipeRequest(b.host, 'status')).lens; i++) await sleep(250);
  const s = await m.call('navigate', { url: fx.url('extras.html') });
  if (s.isError) throw new Error(s.text);
  const st = JSON.parse(await pipeRequest(b.host, 'status'));
  const mine = st.all.find((x) => x.placed);
  check(!!mine && mine.placed.found, `the session window was found and placed (${JSON.stringify(mine && mine.placed)})`);
  if (mine && mine.placed.found) {
    check(deskOf(mine.placed.hwnd) === target, `the session window is on desktop ${pick}`);
    check(!iconic(mine.placed.hwnd), 'it is restored there, not minimised');
  }
  fgCheck('opening the session window did not change your foreground window');
  check(desks().current === d0.current, 'your desktop is still the one in view');
  const vis = await m.js('[document.visibilityState, document.hasFocus()]');
  check(vis[0] === 'visible' && vis[1] === true, `the page is visible and focused there (${vis})`);
  fgCheck('the page being used did not change your foreground window');
  const shot = await m.call('screenshot', {});
  check(!shot.isError, `a screenshot works there (${shot.text.split('\n')[0]})`);
  const c = await m.call('click', { text: 'Hide like count', role: 'button' });
  check(!c.isError && (await m.js('clicks')).includes('Hide like count'), `a click reaches the page (${c.text.split('\n')[0]})`);
  const t = await m.call('type', { ref: refOf(s.text, /textbox "Caption"/), text: 'Typed on another desktop.' });
  check(!t.isError && (await m.js('document.getElementById("cap").value')) === 'Typed on another desktop.', 'typing reaches the page');
  const p = await m.call('click', { text: 'Sign in with Example', role: 'button' });
  check(/opened a popup window/.test(p.text), 'the sign-in popup window was followed');
  fgCheck('the popup window did not change your foreground window');
  check(desks().current === d0.current, 'the popup window did not take your view to its desktop');
  await sleep(500);
  const st2 = JSON.parse(await pipeRequest(b.host, 'status'));
  const pp = (st2.all.find((x) => x.popupsPlaced && x.popupsPlaced.length) || {}).popupsPlaced || [];
  const last = pp[pp.length - 1];
  check(!!last && last.found, `the popup window was found (${JSON.stringify(last)})`);
  if (last && last.found) check(deskOf(last.hwnd) === target, `the popup window is on desktop ${pick}`);
  if (process.env.BROWZIE_DIAG) console.log(`      popup page ${await m.js('[document.visibilityState, document.hasFocus(), performance.now() | 0]')}`);
  const pshot = await m.call('screenshot', {});
  if (process.env.BROWZIE_DIAG) console.log(`      popup page ${await m.js('[document.visibilityState, document.hasFocus(), performance.now() | 0]')}, cloaked ${last && cloaked(last.hwnd)}`);
  check(!pshot.isError, `a screenshot of the popup works there (${pshot.text.split('\n')[0]}, ${pshot.ms} ms)`);
  if (last && last.found) check(!iconic(last.hwnd), 'the popup is restored there, not minimised');
  const pvis = await m.js('[document.visibilityState, document.hasFocus()]');
  check(pvis[0] === 'visible', `the popup page is visible there (${pvis})`);
  const done = await m.call('click', { text: 'Continue', role: 'button' });
  check(/popup window closed; Browzie is back/.test(done.text), 'closing the popup returns to the page that opened it');
  fgCheck('closing it did not change your foreground window');
  check(desks().current === d0.current, 'your desktop is still the one in view');
} finally {
  m.close();
  await b.close();
  fx.close();
}
console.log(fails.length ? `\n${fails.length} check(s) failed` : '\nAll desktop checks passed');
process.exit(fails.length ? 1 : 0);
