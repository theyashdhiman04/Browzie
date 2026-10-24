// Browzie setup.
//   node scripts/install.js            build the cursor overlay, register the native host, add the MCP server
//   node scripts/install.js --check    diagnose an installation
//   node scripts/install.js --remove   undo everything this script did
// Options: --no-mcp (skip "claude mcp add"), --test-browsers (also register the host for
// Chrome for Testing and Chromium, used by the test suite).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_NAME = 'com.browzie.bridge';
const EXT_ID = fs.readFileSync(path.join(ROOT, 'extension', 'EXTENSION_ID'), 'utf8').trim();
const BAT = path.join(ROOT, 'host', 'browzie-host.bat');
const MANIFEST = path.join(ROOT, 'host', `${HOST_NAME}.json`);
const LENS_SRC = path.join(ROOT, 'lens', 'Lens.cs');
const LENS_EXE = path.join(ROOT, 'lens', 'browzie-lens.exe');
const SERVER = path.join(ROOT, 'server', 'server.js');
const BROWSER_KEYS = { chrome: 'Software\\Google\\Chrome', cft: 'Software\\Google\\Chrome for Testing', chromium: 'Software\\Chromium' };
const args = new Set(process.argv.slice(2));
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => console.log('  FAIL ' + m);

function reg(op, key, data) {
  const a = op === 'add' ? ['add', `HKCU\\${key}`, '/ve', '/t', 'REG_SZ', '/d', data, '/f'] : op === 'delete' ? ['delete', `HKCU\\${key}`, '/f'] : ['query', `HKCU\\${key}`, '/ve'];
  const r = spawnSync('reg', a, { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout : null;
}
const hostKey = (b) => `${BROWSER_KEYS[b]}\\NativeMessagingHosts\\${HOST_NAME}`;

// The native installer ships claude.exe (run directly: arguments stay intact); an npm install
// ships claude.cmd, which needs a shell, and then every argument with spaces or brackets must be
// quoted (this folder is "New folder (16)").
function claude(cmdArgs, opts = {}) {
  const direct = spawnSync('claude', cmdArgs, { encoding: 'utf8', ...opts });
  if (!direct.error) return direct;
  return spawnSync('claude', cmdArgs.map((a) => (/[\s()&^]/.test(a) ? `"${a}"` : a)), { encoding: 'utf8', shell: true, ...opts });
}

function buildLens() {
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) {
    bad('csc.exe not found; the on-screen cursor will be disabled (Browzie still works).');
    return;
  }
  // build next to it and swap: a running overlay keeps its exe locked, but it can be renamed
  const fresh = LENS_EXE.replace(/\.exe$/, '.new.exe');
  execFileSync(csc, ['/nologo', '/target:winexe', '/optimize', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', `/out:${fresh}`, LENS_SRC], { stdio: 'inherit' });
  const old = LENS_EXE.replace(/\.exe$/, '.old.exe');
  try {
    fs.rmSync(old, { force: true });
  } catch (e) {}
  if (fs.existsSync(LENS_EXE)) fs.renameSync(LENS_EXE, fs.existsSync(old) ? old + '.' + Date.now() : old);
  fs.renameSync(fresh, LENS_EXE);
  ok('built the cursor overlay ' + path.relative(ROOT, LENS_EXE));
}

function install() {
  if (process.platform !== 'win32') {
    console.log('This build of Browzie targets Windows. See DESIGN.md for the macOS and Linux ports.');
    process.exit(1);
  }
  buildLens();
  fs.writeFileSync(BAT, `@echo off\r\n"${process.execPath}" "%~dp0host.js" %*\r\n`);
  fs.writeFileSync(MANIFEST, JSON.stringify({ name: HOST_NAME, description: 'Browzie: bridge between Chrome and Claude Code', path: BAT, type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2));
  ok('wrote the native host manifest (only extension ' + EXT_ID + ' may start it)');
  const browsers = args.has('--test-browsers') ? ['chrome', 'cft', 'chromium'] : ['chrome'];
  for (const b of browsers) {
    if (reg('add', hostKey(b), MANIFEST) === null) bad('could not register for ' + b);
    else ok(`registered the native host for ${b} (HKCU\\${hostKey(b)})`);
  }
  if (!args.has('--no-mcp')) {
    claude(['mcp', 'remove', 'browzie', '-s', 'user']);
    const r = claude(['mcp', 'add', 'browzie', '-s', 'user', '--', process.execPath, SERVER]);
    if (r.status === 0) ok('added the MCP server "browzie" to Claude Code (user scope)');
    else bad('claude mcp add failed: ' + (r.stderr || r.stdout).trim() + `\n       Add it yourself: claude mcp add browzie -s user -- "${process.execPath}" "${SERVER}"`);
  }
  console.log(`
Last step (once): load the extension into your everyday Chrome
  1. open chrome://extensions
  2. turn on "Developer mode" (top right)
  3. "Load unpacked" -> ${path.join(ROOT, 'extension')}
Then restart Claude Code and ask, for example: "use browzie to open news.ycombinator.com".`);
}

function check() {
  console.log('Browzie check');
  fs.existsSync(LENS_EXE) ? ok('cursor overlay built') : bad('cursor overlay missing: run install');
  const q = reg('query', hostKey('chrome'));
  q && q.includes(MANIFEST) ? ok('native host registered for Chrome') : bad('native host not registered for Chrome: run install');
  if (fs.existsSync(MANIFEST)) {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    fs.existsSync(m.path) ? ok('host launcher ' + m.path) : bad('host launcher missing: ' + m.path);
  }
  const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Browzie', 'hosts');
  let live = [];
  try {
    live = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))).filter((h) => {
      try {
        process.kill(h.pid, 0);
        return true;
      } catch (e) {
        return false;
      }
    });
  } catch (e) {}
  live.length ? live.forEach((h) => ok(`connected browser: ${h.ua}`)) : bad('no browser connected: is Chrome open with the Browzie extension enabled?');
  const r = claude(['mcp', 'get', 'browzie']);
  if (r.status !== 0) bad('MCP server not registered (claude mcp get browzie)');
  else if (/Connected/.test(r.stdout)) ok('MCP server registered and starts');
  else bad('MCP server registered but does not start:\n' + r.stdout.trim());
}

function remove() {
  for (const b of Object.keys(BROWSER_KEYS)) if (reg('delete', hostKey(b)) !== null) ok('unregistered the native host for ' + b);
  claude(['mcp', 'remove', 'browzie', '-s', 'user']);
  ok('removed the MCP server (if it was there)');
  for (const f of [BAT, MANIFEST]) fs.rmSync(f, { force: true });
  console.log('Remove the extension from chrome://extensions yourself.');
}

if (args.has('--check')) check();
else if (args.has('--remove')) remove();
else install();
