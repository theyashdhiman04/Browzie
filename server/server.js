#!/usr/bin/env node
// Browzie MCP server: what Claude Code starts (stdio). A thin adapter: it finds the Browzie host that
// your Chrome started (named pipe + token from %LOCALAPPDATA%\Browzie\hosts), forwards tool calls,
// and returns text and images. No API keys: Claude Code's own login is the model, Chrome's own
// profile is the browser identity.
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const env = process.env;
const ROOT = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Browzie');
const HOSTS = env.BROWZIE_HOSTS_DIR || path.join(ROOT, 'hosts');
const SESSION = crypto.randomUUID();
const debug = (...a) => env.BROWZIE_DEBUG && process.stderr.write('[browzie] ' + a.join(' ') + '\n');
const LENS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lens', 'browzie-lens.exe');

// ------------------------------------------------------------------ tools
const target = {
  ref: { type: 'string', description: 'Element ref from a snapshot, e.g. "e12" or "f1e3" (best)' },
  text: { type: 'string', description: 'Visible text or accessible name of the element' },
  selector: { type: 'string', description: 'CSS selector (must match one element unless nth is given)' },
  role: { type: 'string', description: 'With text: only this role (button, link, textbox...)' },
  nth: { type: 'integer', description: '1-based pick when several elements match' },
};
// Input tools: what to send back after the step.
const after = {
  snapshot: { type: 'string', enum: ['diff', 'none'], description: 'diff (default): what changed on the page; none: one line only (cheapest; dialogs, bot checks and navigation are still reported)' },
  wait: { type: 'integer', description: 'With text/selector: ms to wait for the element to appear (default 3000)' },
};
const TOOLS = [
  {
    name: 'navigate',
    description: 'Open a URL in Browzie\'s window (or back/forward/reload, or in a new tab) and return a compact snapshot. Interactive elements carry refs like [e12].',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, action: { type: 'string', enum: ['back', 'forward', 'reload'] }, newTab: { type: 'boolean' }, snapshot: { type: 'string', enum: ['full', 'none'] }, maxChars: { type: 'integer' } } },
  },
  {
    name: 'snapshot',
    description: 'Compact text snapshot of the current page (instant, no input). Scope with ref/selector, viewportOnly or interactiveOnly.',
    inputSchema: { type: 'object', properties: { ref: target.ref, selector: target.selector, viewportOnly: { type: 'boolean' }, interactiveOnly: { type: 'boolean' }, maxChars: { type: 'integer' } } },
  },
  {
    name: 'click',
    description: 'Move the visible cursor to an element and click it with real mouse input (fast). Scrolls with the wheel if needed; waits up to 3 s for a text/selector target to appear. Returns what changed on the page.',
    inputSchema: { type: 'object', properties: { ...target, ...after, x: { type: 'number', description: 'X in the latest screenshot (CSS px)' }, y: { type: 'number' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, doubleClick: { type: 'boolean' }, modifiers: { type: 'array', items: { type: 'string', enum: ['Control', 'Shift', 'Alt', 'Meta'] } }, force: { type: 'boolean', description: 'Click even if something covers it' } } },
  },
  {
    name: 'fill',
    description: 'Fill several form fields: click each field, select existing text, type it (fast). value: text; true/false for checkboxes and radios; option label for selects; YYYY-MM-DD for dates; a file path (or array) for file inputs or for a button that opens the file chooser.',
    inputSchema: {
      type: 'object',
      required: ['fields'],
      properties: {
        fields: { type: 'array', items: { type: 'object', required: ['value'], properties: { ...target, value: { type: ['string', 'number', 'boolean', 'array'], items: { type: 'string' } } } } },
        submit: { type: 'boolean', description: 'Press Enter after the last field' },
        snapshot: after.snapshot,
      },
    },
  },
  {
    name: 'type',
    description: 'Type text into the focused element or into ref/selector (clicked first). Short text goes in as real keystrokes, long text (over 40 characters) a few words at a time, so a caption takes about a second. If typing stops part way, call type with resume: true.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        ref: target.ref,
        selector: target.selector,
        clear: { type: 'boolean', description: 'Select existing text first so it is replaced' },
        submit: { type: 'boolean', description: 'Press Enter afterwards' },
        typos: { type: 'boolean', description: 'Now and then hit a neighbouring key and fix it with Backspace, as people do (for free text like captions and comments; never for codes, URLs or exact values)' },
        resume: { type: 'boolean', description: 'Finish a type call that stopped part way (no text needed): checks the field, then types the rest' },
        snapshot: after.snapshot,
      },
    },
  },
  {
    name: 'press',
    description: 'Press keys or shortcuts, e.g. "Enter", "Escape", "Tab", "Control+A", "Shift+Tab". Space-separated combos run in order.',
    inputSchema: { type: 'object', required: ['keys'], properties: { keys: { type: 'string' }, repeat: { type: 'integer' }, snapshot: after.snapshot } },
  },
  {
    name: 'hover',
    description: 'Move the cursor onto an element and rest there (opens hover menus and tooltips).',
    inputSchema: { type: 'object', properties: { ...target, ...after, x: { type: 'number' }, y: { type: 'number' } } },
  },
  {
    name: 'scroll',
    description: 'Scroll with the mouse wheel: the page or the container holding ref, by direction/amount, to an edge, or bring ref into view.',
    inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', description: 'CSS px (default: most of a screen)' }, to: { type: 'string', enum: ['top', 'bottom', 'left', 'right'] }, ref: target.ref, snapshot: after.snapshot } },
  },
  {
    name: 'wait_for',
    description: 'Wait for text, a selector, a URL (substring or /regex/), their disappearance, or a fixed time. enabled: true waits until the element named by text/selector (and role) is there and not disabled (a Next button after an upload). Returns a viewport snapshot unless snapshot: "none".',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, textGone: { type: 'string' }, selector: { type: 'string' }, selectorGone: { type: 'string' }, role: target.role, nth: target.nth, enabled: { type: 'boolean' }, url: { type: 'string' }, time: { type: 'number' }, timeout: { type: 'number', description: 'ms, at most 110000' }, snapshot: { type: 'string', enum: ['viewport', 'none'] } } },
  },
  {
    name: 'screenshot',
    description: 'Screenshot of the viewport in CSS pixels (x,y can be clicked directly). labels:true draws refs on the image. The virtual cursor is not in the image.',
    inputSchema: { type: 'object', properties: { labels: { type: 'boolean' }, quality: { type: 'integer' } } },
  },
  {
    name: 'find',
    description: 'Search the whole page (all frames) by text, name, role or CSS selector and get refs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, selector: { type: 'string' }, role: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'read',
    description: 'Readable text of the page (or of ref/selector), with paging.',
    inputSchema: { type: 'object', properties: { ref: target.ref, selector: target.selector, offset: { type: 'integer' }, max: { type: 'integer' } } },
  },
  {
    name: 'tabs',
    description: 'List, open, switch to or close Browzie\'s tabs (its window, and popup windows the page opened, such as a sign-in window). select/close take the tab number from the list (1, 2, ...); without one they act on the current tab.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'select', 'close'] }, id: { type: 'integer', description: 'Tab number as listed (1-based)' }, url: { type: 'string' } } },
  },
  {
    name: 'upload',
    description: 'Upload files: clicks a file input, or a button / drop area that opens the file chooser, and answers the chooser with these files (the Windows dialog never opens).',
    inputSchema: { type: 'object', required: ['files'], properties: { ...target, ...after, files: { type: 'array', items: { type: 'string' }, description: 'Full paths of the files' } } },
  },
  {
    name: 'dialog',
    description: 'Accept or dismiss an open alert/confirm/prompt dialog.',
    inputSchema: { type: 'object', properties: { accept: { type: 'boolean' }, text: { type: 'string', description: 'Answer for a prompt' } } },
  },
  {
    name: 'handoff',
    description: 'Hand control to the human and wait: for CAPTCHAs and other bot checks (Browzie never solves them), logins with 2FA, payments, anything needing a person. Returns when the check is gone or the user clicks Done.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'What you need the user to do' }, timeout: { type: 'number', description: 'ms, default 300000' } } },
  },
  {
    name: 'signin',
    description: 'Sign in with a login saved in Chrome\'s password manager. Browzie never types, reads or sees the password: it clicks into the sign-in form so Chrome lists the saved logins, the user picks one in Chrome\'s own list (one click), and Browzie then presses the form\'s button. One step per call (a username-first page, then the password page). Returns when the step is gone.',
    inputSchema: { type: 'object', properties: { timeout: { type: 'number', description: 'ms, default 300000' } } },
  },
  {
    name: 'evaluate',
    description: 'Run JavaScript in the page and return JSON. The code goes in "script" (an expression, statements, or a function body with return). Runs in an isolated world by default (sees the DOM, not page globals, leaves no trace); world:"main" sees page globals.',
    inputSchema: { type: 'object', required: ['script'], properties: { script: { type: 'string' }, world: { type: 'string', enum: ['isolated', 'main'] }, maxChars: { type: 'integer', description: 'Result size limit (default 20000)' } } },
  },
];
// Loaded up front so Claude needs no tool-search step for an ordinary browsing task.
const CORE = new Set(['navigate', 'snapshot', 'click', 'fill', 'type', 'press', 'scroll', 'screenshot', 'handoff', 'batch']);
TOOLS.push({
  name: 'batch',
  description: 'Run several steps in one call (saves a model turn per step). Each step is {action, ...that tool\'s arguments}; action is navigate, click, fill, type, press, hover, scroll, wait_for, upload or dialog. Target later steps by text/role/selector, since their refs do not exist yet. Stops at the first failing step. Returns one line per step and the full result of the last.',
  inputSchema: {
    type: 'object',
    required: ['steps'],
    properties: {
      steps: {
        type: 'array',
        items: { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['navigate', 'click', 'fill', 'type', 'press', 'hover', 'scroll', 'wait_for', 'upload', 'dialog'] } }, additionalProperties: true },
      },
    },
  },
});
const INSTRUCTIONS = `Browzie drives the user's own Chrome with a visible virtual cursor and real, fast input.
- navigate returns a compact snapshot; interactive elements have refs like [e12] (f1e3 inside iframes). Target by ref, or by text (+ role) for steps whose refs you have not seen yet.
- click/fill/type/press/hover/scroll are quick and return only what changed (long diffs are shortened). snapshot: "none" returns one line: use it for steps you will verify another way. Put known sequences of steps in one batch call; text/selector targets wait up to 3 s to appear, so most steps need no wait_for. wait_for {text, role, enabled: true} waits for a button to become usable.
- A ref that now names a different element than when you saw it (a re-rendered list) is refused instead of clicked; target by text or take a new snapshot.
- snapshot/find/read/screenshot are instant and send no input; prefer them to look around.
- If a result says HUMAN CHECK (a CAPTCHA or bot check), do not try to solve or bypass it. Call handoff and wait for the user.
- The user can keep working in other windows while Browzie works. If they click or type in the Browzie window, Browzie stops the action and says so; continue after they are done.
- Browzie's window lives on the virtual desktop where this Claude Code runs, not the one the user is on, and never takes the focus. Popup windows a page opens (a "sign in with..." window) are followed like tabs. For a sign-in that needs a password, call signin (the user picks their saved login in Chrome's own list; Browzie never sees it); 2FA codes are the user's: call handoff.
- A type into "the focused element" fails when no text field has the focus, instead of losing the keys.
- Long text: type commits it in word chunks (about a second for a caption); if it stops part way, type with resume: true finishes it. No clipboard is needed.
- evaluate takes its code in "script".`;

// ------------------------------------------------------------------ host discovery and connection
function liveHosts() {
  let files = [];
  try {
    files = fs.readdirSync(HOSTS).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(HOSTS, f), 'utf8'));
      process.kill(h.pid, 0); // throws if the host process is gone
      out.push(h);
    } catch (e) {
      try {
        fs.unlinkSync(path.join(HOSTS, f));
      } catch (er) {}
    }
  }
  if (env.BROWZIE_HOST_PID) return out.filter((h) => String(h.pid) === env.BROWZIE_HOST_PID);
  return out.filter((h) => !/HeadlessChrome/.test(h.ua || '') || env.BROWZIE_ALLOW_HEADLESS).sort((a, b) => b.startedAt - a.startedAt);
}

function findChrome() {
  if (env.BROWZIE_CHROME_PATH) return env.BROWZIE_CHROME_PATH;
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
  for (const r of roots) {
    const p = path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
// Chrome counts as running while any chrome.exe process is. (The profile's lock file used to tell,
// but current Chrome opens it shared: it read as free while Chrome ran, and starting chrome.exe
// then opened an empty New Tab window in the Chrome you were using.)
function chromeRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    return /"chrome\.exe"/i.test(out);
  } catch (e) {
    return true; // not sure: never risk opening a window in a Chrome that is already open
  }
}

let conn = null; // { sock, pending: Map, buf }
let seq = 0;
let seenHost = false; // this session has talked to a host: a missing one is the extension restarting, not Chrome closed
async function connect() {
  if (conn) return conn;
  let hosts = liveHosts();
  if (!hosts.length) {
    const chrome = findChrome();
    if (chrome && !seenHost && !chromeRunning()) {
      debug('starting Chrome', chrome);
      startMinimised(chrome);
    }
    // Chrome stops the extension's background worker now and then (often when the computer is very
    // busy); the worker and its host come back by themselves, sometimes only after 20 s or more.
    for (let i = 0; i < 180 && !hosts.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
      hosts = liveHosts();
    }
  }
  if (!hosts.length) {
    throw new Error('Browzie is not connected to Chrome. Make sure Chrome is open and the Browzie extension is installed and enabled (chrome://extensions, "Load unpacked" -> the extension folder). Run "node scripts/install.js --check" for a diagnosis.');
  }
  const h = hosts[0];
  const sock = net.connect(h.pipe);
  const c = { sock, pending: new Map(), buf: '', browser: null };
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.setEncoding('utf8');
  sock.write(JSON.stringify({ t: 'hello', token: h.token, session: SESSION }) + '\n');
  sock.on('data', (d) => {
    c.buf += d;
    let i;
    while ((i = c.buf.indexOf('\n')) >= 0) {
      const line = c.buf.slice(0, i);
      c.buf = c.buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (m.t === 'welcome') c.browser = m.browser;
      if (m.t === 'progress' && c.pending.has(m.id)) c.pending.get(m.id).progress(m);
      if (m.t === 'res' && c.pending.has(m.id)) {
        const p = c.pending.get(m.id);
        c.pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      }
    }
  });
  const drop = () => {
    if (conn === c) conn = null;
    const msg = 'Chrome closed or restarted the Browzie extension while this ran, so it may or may not have happened. Check the page (snapshot), then call the tool again if needed.';
    for (const p of c.pending.values()) p.reject(Object.assign(new Error(msg), { dropped: true }));
    c.pending.clear();
  };
  sock.on('close', drop);
  sock.on('error', drop);
  conn = c;
  seenHost = true;
  const cfg = {};
  if (env.BROWZIE_PACE) cfg.pace = env.BROWZIE_PACE;
  if (env.BROWZIE_ATTACH === '0') cfg.attach = false; // diagnostics only: never attach the debugger
  if (env.BROWZIE_YIELD) cfg.yield = env.BROWZIE_YIELD; // window (default) | any | off
  const anchor = homeDesktop();
  if (anchor) cfg.anchor = anchor;
  if (Object.keys(cfg).length) await request('configure', cfg, 10000).catch(() => {});
  return c;
}
// Where this session's Browzie windows go: the virtual desktop of the terminal (or app) this Claude
// Code runs in, found once by walking up from this process. BROWZIE_DESKTOP picks a desktop instead
// (its number in Task View, or its id), or "off" leaves it to Chrome.
let home;
function homeDesktop() {
  if (home !== undefined) return home;
  home = null;
  const want = (env.BROWZIE_DESKTOP || '').trim();
  if (/^off$/i.test(want)) return (home = 'off');
  if (want) return (home = { desktop: want });
  if (process.platform !== 'win32' || !fs.existsSync(LENS)) return home;
  try {
    const out = JSON.parse(execFileSync(LENS, ['--anchor', String(process.pid)], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim());
    if (out.hwnd) home = out;
    debug('home window', JSON.stringify(out));
  } catch (e) {
    debug('no home window:', e.message);
  }
  return home;
}
// Starts Chrome minimised and without activating it (you keep working where you are); falls back
// to a plain start without the overlay.
function startMinimised(chrome) {
  if (process.platform === 'win32' && fs.existsSync(LENS)) {
    try {
      const out = JSON.parse(execFileSync(LENS, ['--launch', chrome], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim());
      if (out.pid) return;
    } catch (e) {
      debug('minimised start failed:', e.message);
    }
  }
  spawn(chrome, [], { detached: true, stdio: 'ignore' }).unref();
}
// A request times out after timeoutMs without an answer; progress from the extension (a long text
// being typed) restarts that clock.
async function request(cmd, args, timeoutMs, onProgress) {
  const c = await connect();
  const id = String(++seq);
  return new Promise((resolve, reject) => {
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)} s without progress`));
      }, timeoutMs);
    };
    arm();
    c.pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
      progress: (m) => {
        arm();
        if (onProgress) onProgress(m);
      },
    });
    c.sock.write(JSON.stringify({ t: 'req', id, cmd, args }) + '\n');
  });
}
// Upload paths are checked here, where the files are: a missing file fails before any click.
function checkFiles(name, args) {
  const lists = [];
  if (name === 'upload') lists.push(args.files ?? args.paths ?? args.path);
  if (name === 'batch') for (const s of args.steps || []) if (s && s.action === 'upload') lists.push(s.files ?? s.paths ?? s.path);
  for (const l of lists) {
    const files = Array.isArray(l) ? l : l == null ? [] : [l];
    if (!files.length) throw new Error('upload needs files: full paths of the files to upload.');
    for (const f of files) {
      if (typeof f !== 'string' || !path.isAbsolute(f)) throw new Error(`Give full paths for upload (got ${JSON.stringify(f)}).`);
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error(`No such file: ${f}`);
    }
  }
}

// Commands that only look are safe to repeat when the extension restarts under them; input is not
// (the click may already have happened).
const READS = new Set(['snapshot', 'find', 'read', 'screenshot', 'wait_for']);
const readsOnly = (name, args) => READS.has(name) || (name === 'tabs' && (!args.action || args.action === 'list'));

// ------------------------------------------------------------------ MCP over stdio (JSON-RPC 2.0, one message per line)
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}
async function onRpc(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'browzie', version: '0.1.0' },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS.map((t) => (CORE.has(t.name) ? { ...t, _meta: { 'anthropic/alwaysLoad': true } } : t)) });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some((t) => t.name === name)) return replyError(id, -32602, `Unknown tool ${name}`);
    const t0 = Date.now();
    try {
      const args = { ...((params && params.arguments) || {}) };
      // the code of evaluate is "script"; other names for it used to run an empty script
      if (name === 'evaluate' && args.script == null) args.script = args.expression ?? args.code ?? args.js ?? args.function;
      checkFiles(name, args);
      const timeout = name === 'handoff' || name === 'signin' ? 16 * 60000 : name === 'batch' ? 10 * 60000 : name === 'wait_for' ? 116000 : 180000;
      const token = params && params._meta && params._meta.progressToken;
      const onProgress = token == null ? null : (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: m.progress, total: m.total, message: m.message } }) + '\n');
      let r;
      try {
        r = await request(name, args, timeout, onProgress);
      } catch (e) {
        if (!e.dropped || !readsOnly(name, args)) throw e;
        debug(name, 'repeated after the extension restarted');
        r = await request(name, args, timeout, onProgress);
      }
      debug(name, Date.now() - t0, 'ms');
      const content = [];
      if (r && typeof r === 'object') {
        if (r.text) content.push({ type: 'text', text: r.text });
        if (r.image) content.push({ type: 'image', data: r.image.data, mimeType: r.image.mimeType });
      } else content.push({ type: 'text', text: String(r) });
      return reply(id, { content });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
}

let inBuf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  inBuf += d;
  let i;
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim();
    inBuf = inBuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      continue;
    }
    onRpc(msg).catch((e) => msg.id !== undefined && replyError(msg.id, -32603, e.message));
  }
});
process.stdin.on('end', () => process.exit(0));
