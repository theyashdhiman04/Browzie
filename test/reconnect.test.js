// The MCP server when Chrome restarts the extension under a running command: a stand-in host
// (named pipe + discovery file, no browser) drops the connection mid-request and comes back a few
// seconds later, the way the real host does when Chrome stops the extension's background worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { ROOT, sleep } from './harness.js';

function fakeHost(dir, behave) {
  const token = crypto.randomBytes(8).toString('hex');
  const pipe = `\\\\.\\pipe\\browzie-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const file = path.join(dir, `${process.pid}.json`);
  const publish = () => fs.writeFileSync(file, JSON.stringify({ pipe, token, pid: process.pid, startedAt: Date.now(), ua: 'fake' }));
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.t === 'hello') sock.write(JSON.stringify({ t: 'welcome', browser: {} }) + '\n');
        if (m.t !== 'req') continue;
        seen.push(m.cmd);
        if (behave(m, seen) === 'drop') {
          // the host exits and a new one shows up later
          fs.rmSync(file, { force: true });
          sock.destroy();
          setTimeout(publish, 3000);
          return;
        }
        sock.write(JSON.stringify({ t: 'res', id: m.id, ok: true, result: `${m.cmd} ok` }) + '\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(pipe, () => (publish(), resolve({ seen, close: () => server.close() }))));
}

function mcp(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
  let id = 0;
  const waiting = new Map();
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (waiting.has(m.id)) waiting.get(m.id)(m);
    }
  });
  const call = (method, params) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { call, tool: (name, args) => call('tools/call', { name, arguments: args }).then((m) => m.result), kill: () => p.kill() };
}

test('a read-only command is repeated once the extension is back; input is not repeated', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browzie-hosts-'));
  const host = await fakeHost(dir, (m, seen) => {
    const n = seen.filter((c) => c === m.cmd).length;
    return (m.cmd === 'snapshot' || m.cmd === 'click') && n === 1 ? 'drop' : 'answer';
  });
  const s = mcp({ BROWZIE_HOSTS_DIR: dir, BROWZIE_HOST_PID: String(process.pid), BROWZIE_DESKTOP: 'off' });
  try {
    await s.call('initialize', {});
    const snap = await s.tool('snapshot', {});
    assert.equal(snap.isError, undefined, JSON.stringify(snap));
    assert.equal(snap.content[0].text, 'snapshot ok');
    assert.equal(host.seen.filter((c) => c === 'snapshot').length, 2);

    await sleep(3500); // the host is back
    const click = await s.tool('click', { ref: 'e1' });
    assert.equal(click.isError, true);
    assert.match(click.content[0].text, /may or may not have happened/);
    await sleep(3500);
    assert.equal(host.seen.filter((c) => c === 'click').length, 1);
  } finally {
    s.kill();
    host.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
