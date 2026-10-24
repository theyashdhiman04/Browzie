// Working alongside Browzie (visible window).
//   A. You work in another window while Browzie types: Browzie must not stop, must not take the focus,
//      and the page must still see a focused document receiving the keys.
//   B. You type in the Browzie window itself: that is taking over, Browzie must stop at once.
// Your typing is simulated with Shift taps (they type nothing). Simulated input is flagged as
// injected and normally ignored by the overlay; BROWZIE_LENS_COUNT_INJECTED=1 makes this test's
// overlay count it, as it would count your real keyboard.
//   node test/takeover-check.js
import { spawn, spawnSync } from 'child_process';
import { launch, fixtureServer, Mcp, refOf, sleep } from './harness.js';

process.env.BROWZIE_LENS_COUNT_INJECTED = '1'; // inherited by the test browser, its host and overlay

const WIN = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Kb {
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort vk; [FieldOffset(12)] public uint flags; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public static uint ShiftTap() { var i = new INPUT[2]; i[0].type = 1; i[0].vk = 0x10; i[1].type = 1; i[1].vk = 0x10; i[1].flags = 2; return SendInput(2, i, 40); }
  public static string Front() { var s = new System.Text.StringBuilder(256); GetWindowText(GetForegroundWindow(), s, 256); return s.ToString(); }
}
'@`;
const ps = (body) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN + '\n' + body], { encoding: 'utf8' }).stdout.trim();
// "your other work": a small window that takes the focus for a while
function otherWindow(ms) {
  const script = `Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form; $f.Text = 'Your other work'; $f.Width = 360; $f.Height = 160; $f.StartPosition = 'Manual'; $f.Left = 40; $f.Top = 40
$t = New-Object System.Windows.Forms.Timer; $t.Interval = ${ms}; $t.Add_Tick({ $f.Close() }); $t.Start()
$f.Add_Shown({ $f.Activate() }); [void]$f.ShowDialog()`;
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
}

const fx = await fixtureServer();
const b = await launch({ headless: false });
const m = new Mcp(b.host.pid);
let ok = true;
try {
  await m.init();
  const nav = await m.call('navigate', { url: fx.url('probe.html') });
  const field = refOf(nav.text, /textbox "Type here"/);

  // ---- A: you are working in another window
  const other = otherWindow(40000); // stays up longer than the typing; closed explicitly below
  await sleep(1500);
  const front0 = ps('[Kb]::Front()');
  console.log('A. focused window:', JSON.stringify(front0));
  // Windows does not let a program take the focus while someone is using the PC; then this
  // scenario cannot be set up, and simulated keys would land in that person's window: skip
  if (front0 !== 'Your other work') {
    console.log('   SKIP  Windows kept another window in front (someone is using this PC). Run this check when the PC is idle.');
    other.kill();
    throw new Error('SKIP');
  }
  const sentence = 'Browzie keeps typing while you work in another window.';
  const typing = m.call('type', { ref: field, text: sentence });
  const fronts = [];
  let done = false;
  typing.then(() => (done = true));
  while (!done) {
    await sleep(700);
    const f = ps('[Kb]::Front()');
    fronts.push(f);
    if (f === 'Your other work') ps('[Kb]::ShiftTap() | Out-Null'); // your keystrokes, in your window
  }
  const r = await typing;
  const typed = await m.js("document.getElementById('t').value");
  const keys = await m.js("window.__probe.events.filter((e) => e.t === 'keydown' && e.key !== 'Shift')");
  const a1 = !r.isError && typed === sentence;
  const a2 = !fronts.some((f) => /Browzie probe/.test(f));
  const a3 = keys.length > 0 && keys.every((e) => e.hf);
  console.log(`   ${a1 ? 'PASS' : 'FAIL'}  Browzie finished despite your typing elsewhere: ${r.isError ? r.text.split('\n')[0] : JSON.stringify(typed)}`);
  console.log(`   ${a2 ? 'PASS' : 'FAIL'}  the Browzie window never took the focus (${fronts.length} checks)`);
  console.log(`   ${a3 ? 'PASS' : 'FAIL'}  the page saw every key with document.hasFocus() true`);
  ok = ok && a1 && a2 && a3;
  other.kill();
  await sleep(800);

  // ---- B: you type in the Browzie window itself
  ps(`$w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate('Browzie probe')`);
  await sleep(800);
  const front1 = ps('[Kb]::Front()');
  console.log('B. focused window:', JSON.stringify(front1));
  if (!/Browzie probe/.test(front1)) {
    console.log('   SKIP  Windows did not bring the Browzie window to the front (someone is using this PC).');
    throw new Error('SKIP');
  }
  const typing2 = m.call('type', { ref: field, text: ' And it stops when you type in its window.', clear: false });
  await sleep(3000);
  if (/Browzie probe/.test(ps('[Kb]::Front()'))) ps('[Kb]::ShiftTap() | Out-Null');
  const r2 = await typing2;
  const b1 = r2.isError && /typed in the Browzie window/.test(r2.text);
  console.log(`   ${b1 ? 'PASS' : 'FAIL'}  ${r2.text.split('\n')[0]}`);
  ok = ok && b1;
} catch (e) {
  if (e.message !== 'SKIP') throw e;
  ok = null;
} finally {
  m.close();
  await b.close();
  fx.close();
}
console.log(ok === null ? '\nSKIPPED (this PC is in use; run it when idle)' : ok ? '\nPASS  Browzie works alongside you and yields only to input in its own window' : '\nFAIL');
process.exit(ok === false ? 1 : 0);
