// Browzie native host.
// Chrome starts this process when the Browzie extension connects (native messaging, stdio). It is
// the hub between the browser and any number of Claude Code sessions:
//
//   extension  <-- native messaging (stdin/stdout, length-prefixed JSON) -->  host
//   host       <-- named pipe \\.\pipe\browzie-<pid>-<rand> (NDJSON, token) -->  MCP servers
//   host       <-- stdin/stdout JSON lines -->  lens (the on-screen cursor overlay)
//
// A named pipe instead of a localhost TCP port means there is nothing a web page can probe
// (sites have been seen port-scanning 127.0.0.1 to fingerprint automation tools).
// The pipe name and a random token are published in %LOCALAPPDATA%\Browzie\hosts\<pid>.json,
// readable only by this Windows user.
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Browzie');
const HOSTS = path.join(ROOT, 'hosts');
fs.mkdirSync(HOSTS, { recursive: true });
const LOG = path.join(ROOT, 'host.log');
const log = (...a) => {
  try {
    const st = fs.statSync(LOG);
    if (st.size > 512 * 1024) fs.renameSync(LOG, LOG + '.1');
  } catch (e) {}
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${a.join(' ')}\n`);
  } catch (e) {}
};
process.on('uncaughtException', (e) => log('uncaught', e && e.stack));

const token = crypto.randomBytes(24).toString('hex');
const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\browzie-${process.pid}-${crypto.randomBytes(4).toString('hex')}` : path.join(os.tmpdir(), `browzie-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
const discovery = path.join(HOSTS, `${process.pid}.json`);

let down = false;
// ------------------------------------------------------------------ native messaging (to the extension)
function toExt(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  if (body.length > 1024 * 1024) {
    log('dropping oversize message to extension', body.length);
    return;
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  if (down) return;
  try {
    process.stdout.write(Buffer.concat([head, body]));
  } catch (e) {
    shutdown();
  }
}
let inBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len).toString('utf8');
    inBuf = inBuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch (e) {
      log('bad message from extension');
      continue;
    }
    fromExt(msg);
  }
});
process.stdin.on('end', shutdown);
process.stdout.on('error', () => shutdown());
process.stdin.on('error', shutdown);

let browser = null;
function fromExt(m) {
  if (m.t === 'hello') {
    browser = { ua: m.ua, install: m.install, ext: m.ext, version: m.version };
    // testId: set only by the test harness (inherited from the Chrome it launched), so parallel test runs find their own browser
    fs.writeFileSync(discovery, JSON.stringify({ pipe: pipePath, token, pid: process.pid, startedAt: Date.now(), testId: process.env.BROWZIE_TEST_ID || undefined, ...browser }));
    log('extension connected', m.ua);
    if (!/HeadlessChrome/.test(m.ua || '') && !process.env.BROWZIE_NO_LENS) startLens();
    return;
  }
  if (m.t === 'res') {
    const i = m.id.indexOf(':');
    const c = clients.get(m.id.slice(0, i));
    if (c) c.send({ t: 'res', id: m.id.slice(i + 1), ok: m.ok, result: m.result, error: m.error });
    return;
  }
  if (m.t === 'progress') {
    // a long action (typing a long text) is still going: keeps the session's request alive
    const i = m.id.indexOf(':');
    const c = clients.get(m.id.slice(0, i));
    if (c) c.send({ t: 'progress', id: m.id.slice(i + 1), progress: m.progress, total: m.total, message: m.message });
    return;
  }
  if (m.t === 'log') {
    log('ext:', String(m.msg).slice(0, 500));
    return;
  }
  if (m.t === 'lens') {
    toLens(m);
    return;
  }
}

// ------------------------------------------------------------------ pipe server (to Claude Code sessions)
const clients = new Map(); // client key -> { send, session }
let clientSeq = 0;
const server = net.createServer((sock) => {
  const key = String(++clientSeq);
  let authed = false;
  let session = null;
  let buf = '';
  const send = (o) => {
    try {
      sock.write(JSON.stringify(o) + '\n');
    } catch (e) {}
  };
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (!authed) {
        if (m.t !== 'hello' || m.token !== token || !m.session) {
          send({ t: 'error', error: 'bad token' });
          sock.destroy();
          return;
        }
        authed = true;
        session = String(m.session);
        clients.set(key, { send, session });
        send({ t: 'welcome', browser });
        log('session connected', session);
        continue;
      }
      if (m.t === 'req') toExt({ t: 'req', id: `${key}:${m.id}`, session, cmd: m.cmd, args: m.args });
    }
  });
  const gone = () => {
    if (!clients.has(key)) return;
    clients.delete(key);
    if (![...clients.values()].some((c) => c.session === session)) toExt({ t: 'session-end', session });
    log('session closed', session);
  };
  sock.on('close', gone);
  sock.on('error', gone);
});
server.listen(pipePath, () => log('listening on', pipePath));
server.on('error', (e) => log('pipe error', e.message));

// ------------------------------------------------------------------ lens (on-screen cursor overlay)
let lens = null;
function startLens() {
  const exe = path.join(HERE, '..', 'lens', 'browzie-lens.exe');
  if (process.platform !== 'win32' || !fs.existsSync(exe)) {
    toExt({ t: 'lens-status', ok: false });
    log('lens not available', exe);
    return;
  }
  lens = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  lens.stdout.setEncoding('utf8');
  lens.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (m.ev === 'input') toExt({ t: 'user-input', kind: m.kind, browzie: !!m.browzie });
      else if (m.ev === 'over') toExt({ t: 'user-over', on: !!m.on });
      else if (m.ev === 'ready') toExt({ t: 'lens-status', ok: true });
      else if (m.ev === 'where') {
        toExt({ t: 'lens-where', where: m });
      } else if (m.ev === 'reply') toExt({ t: 'lens-reply', reply: m });
    }
  });
  lens.on('exit', (code) => {
    log('lens exited', code);
    lens = null;
    toExt({ t: 'lens-status', ok: false });
  });
  lens.stdin.on('error', () => {});
}
function toLens(m) {
  if (!lens) return;
  const { t, ...rest } = m;
  try {
    lens.stdin.write(JSON.stringify(rest) + '\n');
  } catch (e) {}
}

// ------------------------------------------------------------------ shutdown
function shutdown() {
  if (down) return;
  down = true;
  log('browser gone, exiting');
  try {
    fs.unlinkSync(discovery);
  } catch (e) {}
  try {
    server.close();
  } catch (e) {}
  if (lens) lens.kill();
  for (const c of clients.values()) c.send({ t: 'bye' });
  setTimeout(() => process.exit(0), 100);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
