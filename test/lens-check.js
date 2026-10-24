// Pixel check for the on-screen cursor. Opens a visible test window and parks the virtual cursor
// on a button at several places, then compares two independent answers to "where is the pointer":
//   - Chrome: screenX/screenY of the last trusted pointer event, times the display scale
//   - the overlay: the physical pixel where it drew the arrow tip
// They must agree to within 1 physical pixel. Works with the screen locked.
//   node test/lens-check.js            coordinate check (a test window appears for a few seconds)
//   node test/lens-check.js --visual   also grab the real screen around the tip into test/out/
//                                      (only when you are at the machine: it captures your screen)
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { launch, fixtureServer, Mcp, refOf, sleep, pipeRequest, ROOT } from './harness.js';

const visual = process.argv.includes('--visual');

function grab(x, y, w, h, file) {
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
'@
[Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$b = New-Object System.Drawing.Bitmap ${w}, ${h}
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(${x}, ${y}, 0, 0, $b.Size)
$b.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

const fx = await fixtureServer();
const b = await launch({ headless: false });
const m = new Mcp(b.host.pid);
let worst = 0;
let runs = 0;
try {
  await m.init();
  await m.call('navigate', { url: fx.url('probe.html?warmup'), snapshot: 'none' });
  const nav = await m.call('navigate', { url: fx.url('probe.html') });
  const dpr = await m.js('devicePixelRatio');
  for (const target of [/button "Target"/, /textbox "Type here"/, /button "Target"/]) {
    const h = await m.call('hover', { ref: refOf(nav.text, target) });
    if (h.isError) throw new Error(h.text);
    await sleep(150);
    const last = await m.js("window.__probe.events.filter((e) => e.t === 'pointermove').pop()");
    const where = JSON.parse(await pipeRequest(b.host, 'lens_where'));
    const chrome = { x: last.sx * dpr, y: last.sy * dpr };
    const dx = where.x - chrome.x;
    const dy = where.y - chrome.y;
    const off = Math.hypot(dx, dy);
    worst = Math.max(worst, off);
    runs++;
    console.log(`${h.text.split('\n')[0]}\n  Chrome put the pointer at physical (${chrome.x.toFixed(2)}, ${chrome.y.toFixed(2)}); the overlay drew the tip at (${where.x}, ${where.y}): off by ${off.toFixed(2)} px`);
    if (visual) {
      fs.mkdirSync(path.join(ROOT, 'test', 'out'), { recursive: true });
      grab(where.x - 60, where.y - 40, 200, 120, path.join(ROOT, 'test', 'out', `lens-${runs}.png`));
    }
  }
} finally {
  m.close();
  await b.close();
  fx.close();
}
const ok = runs === 3 && worst <= 1;
console.log(`${ok ? 'PASS' : 'FAIL'}  overlay tip within ${worst.toFixed(2)} physical px of the real pointer over ${runs} positions (scale ${(await Promise.resolve(1)) && ''}checked at the display's own DPI)`);
if (visual) console.log('screen grabs: test/out/lens-*.png');
process.exit(ok ? 0 : 1);
