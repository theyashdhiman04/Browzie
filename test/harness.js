// Test harness: a throwaway Chrome for Testing profile with the Browzie extension loaded, the real
// native host (started by that Chrome), and the real MCP server driven over stdio exactly like
// Claude Code drives it. Nothing here touches your everyday Chrome profile.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import net from 'net';
import { spawn, spawnSync, execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOSTS = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Browzie', 'hosts');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chrome for Testing accepts --load-extension (branded Chrome 137+ ignores it).
export function testChrome() {
  if (process.env.BROWZIE_TEST_CHROME) return process.env.BROWZIE_TEST_CHROME;
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('win64-')).sort().reverse() : [];
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Chrome for Testing not found. Install it with: npx @puppeteer/browsers install chrome@stable (or set BROWZIE_TEST_CHROME)');
}

// ------------------------------------------------------------------ fixture server (two origins)
export function fixtureServer() {
  const dir = path.join(ROOT, 'test', 'fixtures');
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/recaptcha/api2/anchor')) {
      // stand-in for the reCAPTCHA checkbox frame: same path shape, no Google code
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><body style="margin:0;font:14px sans-serif"><label><input type=checkbox> I am not a robot</label></body>');
    }
    if (u.pathname === '/go') {
      res.statusCode = 302;
      res.setHeader('location', u.searchParams.get('to') || '/');
      return res.end();
    }
    if (u.pathname === '/slow') {
      return setTimeout(() => res.end('{"ok":true}'), Number(u.searchParams.get('ms') || 600));
    }
    const file = path.join(dir, path.normalize(u.pathname).replace(/^([/\\])+/, '') || 'index.html');
    if (!file.startsWith(dir) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain');
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ port, url: (p) => `http://127.0.0.1:${port}/${p}`, other: (p) => `http://localhost:${port}/${p}`, close: () => srv.close() });
    });
  });
}

// ------------------------------------------------------------------ browser with the extension
// A stand-in for the ChildProcess of a Chrome started by browzie-lens.exe --launch.
function launchMinimised(args, testId) {
  const lensExe = path.join(ROOT, 'lens', 'browzie-lens.exe');
  const out = JSON.parse(execFileSync(lensExe, ['--launch', testChrome(), ...args], { encoding: 'utf8', env: { ...process.env, BROWZIE_TEST_ID: testId } }).trim());
  if (!out.pid) throw new Error('browzie-lens.exe --launch failed: ' + JSON.stringify(out));
  const proc = new EventEmitter();
  proc.pid = out.pid;
  proc.exitCode = null;
  const alive = () => {
    try {
      process.kill(out.pid, 0);
      return true;
    } catch (e) {
      return false;
    }
  };
  const poll = setInterval(() => {
    if (alive()) return;
    clearInterval(poll);
    proc.exitCode = 0;
    proc.emit('exit', 0);
  }, 200);
  poll.unref();
  proc.kill = () => {
    try {
      process.kill(out.pid);
    } catch (e) {}
  };
  return proc;
}
// Test profiles left behind by runs that were killed (older than two hours: no run takes that long).
function sweepProfiles() {
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (!f.startsWith('browzie-test-')) continue;
    const p = path.join(os.tmpdir(), f);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs > 2 * 3600e3) fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (e) {}
  }
}
// minimised: start it the way the MCP server starts Chrome (through the overlay, minimised and not
// activated), so a visible test does not pull its window over whatever you are doing.
export async function launch({ headless = true, extraArgs = [], minimised = false } = {}) {
  sweepProfiles();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browzie-test-'));
  const before = new Set(fs.existsSync(HOSTS) ? fs.readdirSync(HOSTS) : []);
  const startedAt = Date.now();
  const args = [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    `--load-extension=${path.join(ROOT, 'extension')}`,
    ...(headless ? ['--headless=new', '--window-size=1280,860'] : []),
    ...extraArgs,
    'about:blank',
  ];
  // the host this browser starts inherits BROWZIE_TEST_ID and writes it into its discovery file,
  // so parallel test runs never pick each other's browser
  const testId = Math.random().toString(36).slice(2);
  const proc = minimised ? launchMinimised(args, testId) : spawn(testChrome(), args, { stdio: 'ignore', env: { ...process.env, BROWZIE_TEST_ID: testId } });
  let host = null;
  for (let i = 0; i < 120 && !host; i++) {
    await sleep(100);
    const now = fs.existsSync(HOSTS) ? fs.readdirSync(HOSTS) : [];
    for (const f of now) {
      if (before.has(f)) continue;
      try {
        const h = JSON.parse(fs.readFileSync(path.join(HOSTS, f), 'utf8'));
        if (h.testId === testId) host = h;
      } catch (e) {}
    }
  }
  if (!host) {
    proc.kill();
    throw new Error('The Browzie host did not start (is the native host registered? run: node scripts/install.js --no-mcp --test-browsers)');
  }
  return {
    proc,
    host,
    profile,
    async close() {
      // Chrome's child processes keep profile files open for a moment after it exits
      const exited = proc.exitCode != null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
      proc.kill();
      await Promise.race([exited, sleep(5000)]);
      await sleep(300);
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
      } catch (e) {}
    },
  };
}

// ------------------------------------------------------------------ MCP client (what Claude Code does)
export class Mcp {
  constructor(hostPid, env = {}) {
    this.proc = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      env: { ...process.env, BROWZIE_HOST_PID: String(hostPid), BROWZIE_ALLOW_HEADLESS: '1', ...env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.seq = 0;
    this.pending = new Map();
    this.progress = []; // notifications/progress the server sent
    this.buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        if (m.method === 'notifications/progress') this.progress.push(m.params);
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p(m);
        }
      }
    });
  }
  rpc(method, params) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    const r = await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return r.result;
  }
  async call(name, args = {}, meta) {
    const t0 = Date.now();
    const r = await this.rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const res = r.result || { content: [{ type: 'text', text: JSON.stringify(r.error) }], isError: true };
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const image = res.content.find((c) => c.type === 'image');
    return { text, image, isError: !!res.isError, ms: Date.now() - t0 };
  }
  async js(script) {
    const r = await this.call('evaluate', { script, world: 'main', maxChars: 5e6 });
    if (r.isError) throw new Error(r.text);
    return JSON.parse(r.text.replace(/^Result: /, ''));
  }
  close() {
    this.proc.kill();
  }
}

// One request straight to the host pipe, as its own session (for test-only commands that are
// not MCP tools, such as lens_where).
export function pipeRequest(host, cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(host.pipe);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ t: 'hello', token: host.token, session: 'test-' + process.pid }) + '\n');
      sock.write(JSON.stringify({ t: 'req', id: '1', cmd, args }) + '\n');
    });
    sock.on('data', (d) => {
      buf += d;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.t !== 'res') continue;
        sock.end();
        m.ok ? resolve(m.result) : reject(new Error(m.error));
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
  });
}

// DPI-aware grab of a physical-pixel rectangle of the real screen into a PNG (visible tests only).
export function grabScreen(x, y, w, h, file) {
  const ps = `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v); }
'@
[Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$b = New-Object System.Drawing.Bitmap ${Math.round(w)}, ${Math.round(h)}
$g = [System.Drawing.Graphics]::FromImage($b)
$g.CopyFromScreen(${Math.round(x)}, ${Math.round(y)}, 0, 0, $b.Size)
$b.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

// ref of the first snapshot line that matches
export function refOf(text, re) {
  for (const line of text.split('\n')) if (re.test(line)) {
    const m = /\[((?:f\d+)?e\d+)\]/.exec(line);
    if (m) return m[1];
  }
  throw new Error(`no ref for ${re} in:\n${text}`);
}
