// Browzie service worker: the hands.
// Commands arrive from Claude Code through the native host. Pages are read by the content-script
// agent (isolated world, read-only). Every input is a real browser input event sent through
// chrome.debugger (Input domain), replayed from a human motion/timing plan, and mirrored to the
// on-screen virtual cursor drawn by the native overlay (never inside the page).
import { makeRng, paceOf, planMove, planClick, planTyping, planCombo, planWheel, snapper, logn, clamp } from './lib/human.js';
import { parseCombo, keyInfo, MOD_BITS, keyEvent, keyForChar } from './lib/keys.js';
import { diffLines, compactDiff } from './lib/diff.js';

const HOST_NAME = 'com.browzie.bridge';
const AGENT = 4; // must match VERSION in agent.js
const rng = makeRng();
let pace = paceOf('fast'); // BROWZIE_PACE=human|brisk brings back the slower, person-like timing
// How long actions wait for the page to settle; the fast pace overrides these.
const SETTLE = { first: 120, quiet: 150, soft: 2200, busy: 1200, poll: 60, navQuiet: 300, wheelLand: 180, focus: [120, 0.3, 50, 300] };
const st = () => ({ ...SETTLE, ...(pace.settle || {}) });
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const now = () => Date.now();

// ======================================================================= native host link
let port = null;
let backoff = 1000;
let lensOk = false;
function post(m) {
  if (!port) return;
  try {
    port.postMessage(m);
  } catch (e) {}
}
const xlog = (...a) => post({ t: 'log', msg: a.join(' ') }); // ends up in %LOCALAPPDATA%Browziehost.log
function connectHost() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
    retryHost();
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    port = null;
    lensOk = false;
    retryHost();
  });
  backoff = 1000;
  installId().then((id) => post({ t: 'hello', ext: chrome.runtime.id, version: chrome.runtime.getManifest().version, ua: navigator.userAgent, install: id }));
}
function retryHost() {
  setTimeout(connectHost, backoff);
  backoff = Math.min(backoff * 2, 30000);
  chrome.alarms.create('browzie-reconnect', { delayInMinutes: 0.5 });
}
async function installId() {
  const { installId: id } = await chrome.storage.local.get('installId');
  if (id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ installId: fresh });
  return fresh;
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'browzie-reconnect') connectHost();
  if (a.name === 'browzie-idle') releaseIdle();
});
chrome.runtime.onStartup.addListener(connectHost);
chrome.runtime.onInstalled.addListener(connectHost);
connectHost();

async function onHostMessage(m) {
  if (m.t === 'req') {
    let out;
    try {
      const result = await handle(m.session, m.cmd, m.args || {}, { id: m.id });
      out = { t: 'res', id: m.id, ok: true, result };
    } catch (e) {
      out = { t: 'res', id: m.id, ok: false, error: (e && e.message) || String(e) };
    }
    post(out);
  } else if (m.t === 'user-input') {
    // hardware input only (the overlay ignores input that software injected)
    lastUserInput = now();
    if (yieldMode === 'any' || (yieldMode === 'window' && m.browzie)) lastTakeover = now();
  } else if (m.t === 'user-over') {
    pointerOver = !!m.on;
    lastOverMove = m.on ? now() : 0;
  } else if (m.t === 'lens-where') {
    if (lensWhere) lensWhere(m.where);
  } else if (m.t === 'lens-reply') {
    const done = lensCalls.get(m.reply && m.reply.rid);
    if (done) done(m.reply);
  } else if (m.t === 'lens-status') {
    lensOk = !!m.ok;
  } else if (m.t === 'session-end') {
    endSession(m.session);
  }
}

// ======================================================================= on-screen cursor (native overlay)
// Positions go out in screen DIPs plus the screen's DIP origin; the overlay maps them to physical
// pixels on the monitor that shows the Chrome window.
function lens(op, extra) {
  post({ t: 'lens', op, ...(extra || {}) });
}
// An overlay operation that answers (placing and restoring windows).
const lensCalls = new Map();
let lensSeq = 0;
function lensCall(op, extra, ms = 4000) {
  if (!lensOk) return Promise.reject(new Error('the cursor overlay is not running'));
  const rid = 'r' + ++lensSeq;
  const answer = new Promise((resolve) => lensCalls.set(rid, resolve));
  lens(op, { ...extra, rid });
  return withTimeout(answer, ms, `the overlay did not answer (${op})`).finally(() => lensCalls.delete(rid));
}
// The cursor and frame are shown only while Browzie is acting, on the tab it acts on: they go away
// a few seconds after the last action, at once when another tab becomes active, and when you
// take over.
let lensTab = null;
let lensTimer = null;
function lensActive(t) {
  clearTimeout(lensTimer);
  lensTab = t.tabId;
}
function lensIdle(ms = 8000) {
  clearTimeout(lensTimer);
  lensTimer = setTimeout(() => {
    lens('hide');
    lensTab = null;
  }, ms);
}
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (lensTab != null && tabId !== lensTab) lensIdle(0);
});
function lensAt(g, p) {
  lens('move', { x: g.ox + p.x * g.Z, y: g.oy + p.y * g.Z, al: g.al, at: g.at, s: g.S });
}
function lensFrame(t, g, label = 'Claude is using this window') {
  Promise.all([chrome.windows.get(t.windowId).catch(() => ({})), chrome.tabs.get(t.tabId).catch(() => ({}))]).then(([w, tab]) =>
    lens('frame', { x: g.ox, y: g.oy, w: (g.iw || g.vw) * g.Z, h: (g.ih || g.vh) * g.Z, al: g.al, at: g.at, s: g.S, label, title: tab.title || '', ww: w.width || 0, wh: w.height || 0, wl: w.left || 0, wt: w.top || 0, key: String(t.windowId) })
  );
}

// ======================================================================= sessions, windows, tabs
// One Claude Code session = one Chrome window of its own (tabs grouped as "Claude"), so several
// sessions never fight over the same tab. Reads run in parallel; input is serialised (one mouse).
// Popup windows the session's pages open (a "sign in with..." window) belong to the session too.
const sessions = new Map(); // id -> { id, n, windowId, tabId, groupId, popups, back, anchor, typing }
let sessionCount = 0;
function sessionOf(sid) {
  let s = sessions.get(sid);
  if (!s) {
    s = { id: sid, n: ++sessionCount, windowId: null, tabId: null, groupId: null, popups: new Set(), back: new Map(), anchor: null, typing: null };
    sessions.set(sid, s);
  }
  return s;
}
const tabs = new Map(); // tabId -> tab state
function T(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = { tabId, attached: false, cursor: null, frames: new Map([[0, { prefix: '', counter: 0 }]]), nextPrefix: 1, lastInputAt: 0, navAt: 0, dialog: null, inflight: new Map(), nav: [], actionStart: 0, buttons: 0 };
    tabs.set(tabId, t);
  }
  return t;
}
const tabOf = (s, tabId) => Object.assign(T(tabId), { sid: s.id });

// Sessions are kept in extension storage: after the extension reloads (or Chrome restarts its
// service worker) the same Claude Code sessions reconnect with the same ids and get their
// windows back, as long as those are still open.
const SAVED = 'browzie.sessions';
let saveTimer = null;
function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {};
    for (const s of sessions.values()) if (s.windowId != null) out[s.id] = { n: s.n, windowId: s.windowId, tabId: s.tabId, groupId: s.groupId, popups: [...s.popups], back: [...s.back] };
    chrome.storage.local.set({ [SAVED]: out }).catch(() => {});
  }, 150);
}
async function restoreSessions() {
  try {
    const { [SAVED]: saved } = await chrome.storage.local.get(SAVED);
    for (const [sid, v] of Object.entries(saved || {})) {
      if (sessions.has(sid) || !(await chrome.windows.get(v.windowId).catch(() => null))) continue;
      const s = sessionOf(sid);
      Object.assign(s, { n: v.n || s.n, windowId: v.windowId, tabId: v.tabId, groupId: v.groupId ?? null, back: new Map(v.back || []) });
      for (const p of v.popups || []) if (await chrome.windows.get(p).catch(() => null)) s.popups.add(p);
      sessionCount = Math.max(sessionCount, s.n);
    }
  } catch (e) {}
}
let restored = restoreSessions();

async function sessionTab(sid, create = true) {
  const s = sessionOf(sid);
  if (s.tabId != null) {
    try {
      await chrome.tabs.get(s.tabId);
      return tabOf(s, s.tabId);
    } catch (e) {
      s.tabId = null;
    }
  }
  if (s.windowId != null) {
    try {
      const list = await chrome.tabs.query({ windowId: s.windowId });
      const a = list.find((x) => x.active) || list[0];
      if (a) {
        s.tabId = a.id;
        saveSessions();
        return tabOf(s, a.id);
      }
    } catch (e) {}
  }
  if (!create) throw new Error('Browzie has no tab open yet. Use navigate first.');
  const w = await openWindow(s);
  s.windowId = w.id;
  s.tabId = w.tabs[0].id;
  saveSessions();
  await groupTab(s, s.tabId);
  await settleWindow(tabOf(s, s.tabId));
  return tabOf(s, s.tabId);
}
// Where a session's windows belong: the virtual desktop of the Claude Code session that drives
// them (the server sends its terminal window, or the desktop BROWZIE_DESKTOP names).
const homeOf = (s) => (s.anchor && s.anchor !== 'off' ? { anchor: s.anchor.hwnd || 0, desk: s.anchor.desktop ? String(s.anchor.desktop) : '' } : {});
// A session's window opens on its home desktop, not the one you are working on, and never takes
// the focus: Chrome creates it minimised, the overlay moves it to that desktop and restores it
// there filling the screen, without activating it (activating a window on another desktop would
// switch you over to it). Without the overlay it opens the way Chrome opens windows.
async function openWindow(s) {
  if (!lensOk) return chrome.windows.create({ url: 'about:blank', focused: true, state: 'maximized' });
  const w = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
  const r = await lensCall('place', { key: String(w.id), title: 'about:blank', fill: true, wait: 3000, ...homeOf(s) }, 6000).catch((e) => ({ ok: false, error: e.message }));
  s.placed = r;
  xlog('session window', w.id, 'placed:', JSON.stringify(r));
  if (!r.found) await chrome.windows.update(w.id, { state: 'maximized' }).catch(() => {});
  return w;
}
async function placePopup(s, windowId) {
  if (!lensOk) return;
  const w = await chrome.windows.get(windowId).catch(() => null);
  if (!w) return;
  const r = await lensCall('place', { key: String(windowId), w: w.width, h: w.height, wait: 2500, ...homeOf(s) }, 5000).catch((e) => ({ ok: false, error: e.message }));
  xlog('popup window', windowId, 'placed:', JSON.stringify(r));
  s.popupsPlaced = [...(s.popupsPlaced || []).slice(-4), { window: windowId, ...r }];
}
// A brand-new window keeps resizing for a moment (window state, Chrome's debugging bar). Browzie takes
// the tab and lets the size settle before loading any real page into it.
async function settleWindow(t) {
  await attach(t).catch((e) => xlog('attach on new window failed:', e.message));
  let last = -1;
  let stableSince = now();
  const end = now() + 2500;
  while (now() < end) {
    const h = (await chrome.tabs.get(t.tabId).catch(() => ({}))).height;
    if (h !== last) {
      last = h;
      stableSince = now();
    } else if (now() - stableSince > 400) break;
    await sleep(50);
  }
}
async function groupTab(s, tabId) {
  try {
    const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: s.groupId == null ? { windowId: s.windowId } : undefined, groupId: s.groupId ?? undefined });
    if (s.groupId == null) {
      s.groupId = gid;
      saveSessions();
      const open = [...sessions.values()].filter((x) => x.windowId != null).length;
      await chrome.tabGroups.update(gid, { title: open > 1 ? `Claude ${s.n}` : 'Claude', color: 'purple' });
    }
  } catch (e) {}
}
// The session's tabs: its window's, then its popup windows'.
async function sessionTabs(s) {
  const out = [];
  if (!s) return out;
  for (const wid of [s.windowId, ...s.popups]) {
    if (wid == null) continue;
    try {
      out.push(...(await chrome.tabs.query({ windowId: wid })));
    } catch (e) {}
  }
  return out;
}
const sessionOfWindow = (wid) => [...sessions.values()].find((x) => x.windowId === wid || x.popups.has(wid));
function endSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  saveSessions();
  for (const t of tabs.values()) if (t.windowId === s.windowId || s.popups.has(t.windowId)) detach(t);
  lens('hide');
}
// A tab or window that the session's page opens (a target=_blank link, a window.open popup such as
// a "sign in with..." window) becomes the session's tab: Browzie follows it, and goes back to the tab
// that opened it when it closes. A popup window goes to the session's desktop like its window.
function adopt(sourceTabId, tabId) {
  for (const s of sessions.values()) {
    if (s.tabId !== sourceTabId || tabId === sourceTabId || s.back.has(tabId)) continue;
    s.back.set(tabId, sourceTabId);
    s.tabId = tabId;
    s.followed = tabId;
    tabOf(s, tabId);
    saveSessions();
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        T(tabId).windowId = tab.windowId;
        if (tab.windowId === s.windowId) return groupTab(s, tabId);
        if (s.popups.has(tab.windowId)) return;
        s.popups.add(tab.windowId);
        T(tabId).popup = true;
        saveSessions();
        return placePopup(s, tab.windowId);
      })
      .catch(() => {});
  }
}
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId != null) adopt(tab.openerTabId, tab.id);
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => adopt(d.sourceTabId, d.tabId));
chrome.tabs.onRemoved.addListener((id) => {
  const t = tabs.get(id);
  if (t) t.gone = true;
  tabs.delete(id);
  for (const s of sessions.values()) {
    if (s.tabId === id) s.tabId = s.back.get(id) ?? null; // back to the tab that opened it
    s.back.delete(id);
  }
  saveSessions();
});
chrome.windows.onRemoved.addListener((wid) => {
  for (const s of sessions.values()) {
    if (s.windowId === wid) (s.windowId = null), (s.tabId = null), (s.groupId = null);
    s.popups.delete(wid);
  }
  saveSessions();
});

// ======================================================================= debugger (Input domain + dialogs)
let attachAllowed = true;
async function attach(t) {
  if (t.attached) return;
  if (!attachAllowed) throw new Error('attaching is switched off (configure attach:false)');
  // Chrome shows its "started debugging this browser" bar about a second after the first attach
  // and every page in view shrinks by its height. Waiting for it here (before Browzie opens a page)
  // means the pages Browzie loads never see that resize. The bar is browser-wide, so later
  // attaches do not wait.
  const barShown = [...tabs.values()].some((x) => x.attached);
  const h0 = barShown ? null : (await chrome.tabs.get(t.tabId).catch(() => ({}))).height;
  try {
    await chrome.debugger.attach({ tabId: t.tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw new Error(`Browzie could not take control of this tab (${e.message}). Browser pages such as chrome:// and the Web Store cannot be automated.`);
  }
  t.attached = true;
  await cdp(t, 'Page.enable').catch(() => {}); // only to see alert/confirm/prompt dialogs
  // The page stays in the focused state while Browzie types into it from a background window, the
  // state any page you type into is in (otherwise keystrokes would arrive while it is unfocused).
  await cdp(t, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  if (h0) {
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const h = (await chrome.tabs.get(t.tabId).catch(() => ({}))).height;
      if (h && h !== h0) break;
    }
  }
  chrome.alarms.create('browzie-idle', { delayInMinutes: 5 });
}
function detach(t) {
  if (!t.attached) return;
  t.attached = false;
  chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
}
function releaseIdle() {
  // nobody typed or clicked for 5 minutes: let go of the tabs (the "debugging" bar disappears)
  const quiet = [...tabs.values()].every((t) => now() - t.lastInputAt > 4.5 * 60000);
  if (quiet) for (const t of tabs.values()) detach(t);
  else chrome.alarms.create('browzie-idle', { delayInMinutes: 5 });
}
const cdp = (t, method, params) => chrome.debugger.sendCommand({ tabId: t.tabId }, method, params);
const waiters = new Set();
chrome.debugger.onEvent.addListener((src, method, params) => {
  const t = tabs.get(src.tabId);
  if (!t) return;
  if (method === 'Page.javascriptDialogOpening') {
    t.dialog = params;
    if (t.onDialog) t.onDialog();
  }
  if (method === 'Page.javascriptDialogClosed') t.dialog = null;
  for (const w of waiters) if (w.tabId === src.tabId && w.method === method) w.resolve(params);
});
function debuggerEvent(t, method, ms) {
  let w;
  const p = new Promise((resolve, reject) => {
    w = { tabId: t.tabId, method, resolve };
    waiters.add(w);
    setTimeout(() => reject(new Error(`${method} did not happen within ${ms} ms`)), ms);
  });
  return p.finally(() => waiters.delete(w));
}
chrome.debugger.onDetach.addListener((src, reason) => {
  const t = tabs.get(src.tabId);
  if (t) t.attached = false;
  if (reason === 'canceled_by_user') setPaused(true, 'You clicked Cancel on the debugging bar, so Browzie paused. Click the Browzie toolbar button to resume.');
});

// ======================================================================= page agent
function frameCtx(t, fid) {
  let f = t.frames.get(fid);
  if (!f) {
    f = { prefix: 'f' + t.nextPrefix++, counter: 0 };
    t.frames.set(fid, f);
  }
  return f;
}
function withTimeout(p, ms, msg) {
  let timer;
  return Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(msg)), ms)))]).finally(() => clearTimeout(timer));
}
async function agent(t, fid, method, args = [], timeout = 8000) {
  const f = frameCtx(t, fid);
  const msg = { browzie: AGENT, method, ctx: { prefix: f.prefix, start: f.counter }, args };
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await withTimeout(chrome.tabs.sendMessage(t.tabId, msg, { frameId: fid }), timeout, t.dialog ? 'A dialog is open on the page; answer it with the dialog tool.' : `The page did not answer (${method}).`);
      if (res && typeof res.counter === 'number' && res.counter > f.counter) f.counter = res.counter;
      return res;
    } catch (e) {
      const missing = /Receiving end does not exist|Could not establish connection/i.test(e.message);
      if (!missing || attempt > 0) throw e;
      try {
        await chrome.scripting.executeScript({ target: { tabId: t.tabId, frameIds: [fid] }, files: ['agent.js'], injectImmediately: true });
      } catch (err) {
        throw new Error(`Browzie cannot read this page (${err.message}). Browser pages such as chrome://, about: and the Web Store are off limits to extensions.`);
      }
    }
  }
}
// Gives every iframe listed by a frame's agent its extension frameId. getFrameId() answers for
// same-process frames; out-of-process (cross-site) frames are matched against the browser's own
// frame tree by URL and order. Hints are kept so the parent can find the element again later.
async function resolveFrames(t, parent, list) {
  if (!list.length) return [];
  t.frameHints = t.frameHints || new Map();
  let kids = null;
  const claimed = new Set(list.filter((f) => f.frameId > 0).map((f) => f.frameId));
  const out = [];
  for (const f of list) {
    let fid = f.frameId > 0 ? f.frameId : -1;
    if (fid < 0 && f.src) {
      kids = kids || ((await chrome.webNavigation.getAllFrames({ tabId: t.tabId }).catch(() => [])) || []).filter((k) => k.parentFrameId === parent);
      const strip = (u) => String(u).split('#')[0];
      const same = kids.filter((k) => strip(k.url) === strip(f.src));
      let pick = same[f.nth || 0] || same.find((k) => !claimed.has(k.frameId));
      if (!pick) {
        // the frame went elsewhere after its src was set (a redirect, its own navigation, as
        // YouTube's picture chooser does): the one free frame of that origin, or the only free one
        const free = kids.filter((k) => !claimed.has(k.frameId));
        const near = free.filter((k) => originOf(k.url) === originOf(f.src));
        pick = near.length === 1 ? near[0] : free.length === 1 && list.length === 1 ? free[0] : null;
      }
      if (pick) fid = pick.frameId;
    }
    if (fid < 0) continue;
    claimed.add(fid);
    t.frameHints.set(fid, { parent, src: f.src, nth: f.nth || 0 });
    out.push({ ...f, frameId: fid });
  }
  return out;
}
const hintOf = (t, fid) => (t.frameHints && t.frameHints.get(fid)) || null;
// The hint for a frame no snapshot has listed yet (a ref from find), worked out from its parent.
async function hintFor(t, fid, parent) {
  if (!hintOf(t, fid)) {
    const r = await agent(t, parent, 'frameList', [], 3000).catch(() => null);
    if (r && r.list) await resolveFrames(t, parent, r.list);
  }
  return hintOf(t, fid);
}
function frameOfRef(t, ref) {
  const m = /^(f\d+)?e\d+$/.exec(String(ref || ''));
  if (!m) throw new Error(`"${ref}" is not a ref. Refs look like e12 or f1e3.`);
  const prefix = m[1] || '';
  for (const [fid, f] of t.frames) if (f.prefix === prefix) return fid;
  throw new Error(`Ref ${ref} is from a page that is gone. Take a new snapshot.`);
}
async function childFrames(t) {
  try {
    const all = (await chrome.webNavigation.getAllFrames({ tabId: t.tabId })) || [];
    return all.filter((f) => f.frameId !== 0 && /^https?:|^about:|^data:/.test(f.url));
  } catch (e) {
    return [];
  }
}

// ======================================================================= geometry and the pixel grid
async function geometry(t) {
  const [g, zoom] = await Promise.all([agent(t, 0, 'geom'), chrome.tabs.getZoom(t.tabId).catch(() => 1)]);
  if (!g || g.error) throw new Error((g && g.error) || 'no geometry');
  const Z = zoom || 1;
  const S = g.dpr / Z;
  let ox;
  let oy;
  let exact = false;
  if (g.pointer) {
    // exact: the browser itself told us where this viewport is on screen
    ox = g.pointer.sx - g.pointer.cx * Z;
    oy = g.pointer.sy - g.pointer.cy * Z;
    exact = true;
  } else {
    const border = Math.max(0, (g.ow - g.iw * Z) / 2);
    ox = g.wx + border;
    oy = g.wy + (g.oh - g.ih * Z) - border;
  }
  // vw/vh: the visual viewport (where the page can be clicked, without scrollbars);
  // iw/ih: the whole page area including scrollbars (what the on-screen frame outlines)
  return { ox, oy, Z, S, vw: g.vw, vh: g.vh, iw: g.iw, ih: g.ih, al: g.al, at: g.at, exact, pointer: g.pointer, focused: g.focused, visible: g.visible, snap: snapper({ ox, oy, scale: S, zoom: Z }) };
}

// ======================================================================= safety: pause, user takeover, pacing
let paused = false;
let pauseReason = '';
let lastUserInput = 0;
// What counts as "the human is taking over":
//   window (default)  a click, wheel or key in the Browzie window. Input in your other windows is
//                     ignored, so you can keep working; your pointer resting over the Browzie window
//                     makes Browzie wait until it leaves.
//   any               any mouse or keyboard input anywhere (strict)
//   off               never yield
let yieldMode = 'window';
let lastTakeover = 0;
let pointerOver = false;
let lastOverMove = 0; // last time your real pointer moved inside the Browzie window
const moving = () => now() - lastOverMove < 600;
function setPaused(on, reason) {
  paused = on;
  pauseReason = reason || '';
  chrome.action.setBadgeText({ text: on ? 'II' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' }).catch(() => {});
  if (on) lens('banner', { text: 'Browzie paused. Click the Browzie button in the toolbar to resume.' });
  else lens('banner', { text: '' });
}
class Halt extends Error {}
function checkHalt(t) {
  if (t.dialog) throw new Halt(`A ${t.dialog.type} dialog opened: "${t.dialog.message}". Answer it with the dialog tool.`);
  if (paused) throw new Halt(pauseReason || 'Browzie is paused (toolbar button). Ask the user to resume it.');
  if (t.cancelled && t.cancelled >= t.actionStart) throw new Halt('Browzie gave up on this step: it ran past its time limit (the page or the computer was too busy). Check the page, then run it again.');
  if (lastTakeover > t.actionStart) throw new Halt(yieldMode === 'any' ? 'You used the mouse or keyboard, so Browzie stopped this action and gave you control. Run the step again when you are done.' : 'You clicked or typed in the Browzie window, so Browzie stopped this action and gave you control. Run the step again when you are done.');
}
class Replan extends Error {}
// Your real pointer is moving inside the Browzie window: two pointers would show up in the page, so
// Browzie waits until yours has been still (or gone) for 0.6 s; it does not stop the action. A pointer
// that only rests on the window holds nothing up: Browzie continues from where the page last saw a
// pointer. Returns true if it had to wait.
async function clearOfUser(t) {
  if (!moving() || yieldMode === 'off') return false;
  const end = now() + 60000;
  while (moving()) {
    if (now() > end) throw new Halt('Your mouse kept moving over the Browzie window for a minute, so Browzie stopped. Run the step again when you are done.');
    checkHalt(t);
    await sleep(100);
  }
  await sleep(250 + rng() * 200);
  return true;
}
// Pages whose window is completely covered (or minimised) count as hidden. Input into a hidden
// page is something no person can do, so Browzie waits until any part of its window is visible.
async function ensureVisible(t) {
  let g = await geometry(t);
  if (g.visible !== 'hidden') return g;
  chrome.notifications
    .create('browzie-hidden', { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Browzie is waiting', message: 'Its window is completely covered, so the page counts as hidden. Leave any part of the Browzie window visible (snap it beside your work) and it continues by itself.' })
    .catch(() => {});
  const end = now() + 90000;
  try {
    while (now() < end) {
      await sleep(500);
      if (paused) throw new Halt(pauseReason || 'Browzie is paused.');
      g = await geometry(t);
      if (g.visible !== 'hidden') return g;
    }
  } finally {
    chrome.notifications.clear('browzie-hidden').catch(() => {});
  }
  throw new Halt("Browzie's window was completely covered for 90 s, so the page counted as hidden and Browzie did not act. Ask the user to leave part of the Browzie window visible (or put it on another screen), then run the step again.");
}
async function waitUserIdle() {
  if (yieldMode !== 'any') return;
  const until = now() + 15000;
  while (now() - lastUserInput < 1200) {
    if (now() > until) throw new Halt('The user is using the mouse or keyboard; Browzie waited 15 s and did not take over. Try again in a moment.');
    await sleep(200);
  }
}
const history = new Map(); // origin -> [timestamps] (input) ; 'nav:'+origin -> [timestamps]
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (e) {
    return 'other';
  }
}
async function rateGate(key, perMinute) {
  const list = (history.get(key) || []).filter((x) => now() - x < 60000);
  if (list.length >= perMinute) await sleep(list[0] + 60000 - now() + 50);
  list.push(now());
  history.set(key, list.slice(-200));
}
async function paceGate(t, url) {
  let wait = logn(rng, pace.gap) - (now() - t.lastInputAt);
  if (t.navAt) {
    wait = Math.max(wait, logn(rng, pace.afterNav) - (now() - t.navAt));
    t.navAt = 0;
  }
  if (wait > 0) await sleep(wait);
  await rateGate(originOf(url), pace.perMinute);
}

// Every action that sends input goes through here: one at a time across all sessions (there is
// one mouse and one keyboard focus), only in a visible focused window, never while a bot check is
// waiting for the human, never while the user is touching the mouse or keyboard.
let inputChain = Promise.resolve();
function withInput(t, fn) {
  const run = async () => {
    if (paused) throw new Halt(pauseReason || 'Browzie is paused (toolbar button). Ask the user to resume it.');
    if (t.dialog) throw new Halt(`A ${t.dialog.type} dialog is open: "${t.dialog.message}". Answer it with the dialog tool first.`);
    const tab = await chrome.tabs.get(t.tabId);
    t.windowId = tab.windowId;
    await guardChallenge(t);
    await waitUserIdle();
    await showTab(t, tab);
    await attach(t);
    const g = await ensureVisible(t);
    lensActive(t);
    lensFrame(t, g);
    await paceGate(t, tab.url);
    t.actionStart = now();
    // A step that hangs (a renderer that stops answering) must not hold the one input queue for
    // every later step: after the limit it is cancelled (checkHalt stops it at its next event).
    const limit = pace.settle ? 110000 : 175000;
    const msg = `Browzie gave up on this step after ${limit / 1000} s: the page did not finish taking the input (the computer may be very busy). Check the page, then run it again.`;
    try {
      const work = fn(tab);
      return await withTimeout(work, limit, msg).catch((e) => {
        if (e && e.message === msg) {
          t.cancelled = now();
          work.catch(() => {});
        }
        throw e;
      });
    } catch (e) {
      if (e instanceof Halt) lensIdle(0); // you took over (or Browzie stopped): get out of the way now
      throw e;
    } finally {
      lensIdle();
      t.lastInputAt = now();
      await releaseHeld(t);
    }
  };
  const p = inputChain.then(run, run);
  inputChain = p.catch(() => {});
  return p;
}
// Makes the tab the visible one in its own window without bringing the window to the front:
// you keep working in whatever window you are in. (Chrome's focus emulation, set when Browzie takes
// the tab, keeps the page in the focused state a page you are typing into has.)
// A minimised Browzie window is restored by the overlay without activating it (Chrome's own restore
// activates the window, which would pull you over to its desktop).
async function showTab(t, tab) {
  tab = tab || (await chrome.tabs.get(t.tabId));
  if (!tab.active) await chrome.tabs.update(t.tabId, { active: true });
  const w = await chrome.windows.get(tab.windowId);
  if (w.state !== 'minimized') return;
  const r = lensOk ? await lensCall('restore', { key: String(tab.windowId), title: tab.title || '' }).catch(() => null) : null;
  if (r && r.ok) {
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      if ((await chrome.windows.get(tab.windowId)).state !== 'minimized') return;
    }
  }
  await chrome.windows.update(tab.windowId, { state: 'normal' });
}
async function releaseHeld(t) {
  if (t.buttons && t.cursor) {
    await mouse(t, 'mouseReleased', t.cursor, { button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
    lens('up');
  }
  t.buttons = 0;
  for (const k of t.heldKeys || []) await input(t, 'Input.dispatchKeyEvent', keyEvent(keyInfo(k), 'up', 0)).catch(() => {});
  t.heldKeys = [];
}

// ======================================================================= bot checks: always the human's job
async function challengesIn(t) {
  const found = [];
  const scan = async (fid) => {
    try {
      const r = await agent(t, fid, 'challenges', [], 3000);
      if (r && r.list) for (const c of r.list) found.push({ ...c, url: r.url });
    } catch (e) {}
  };
  await scan(0);
  // challenge widgets nested inside other iframes (checkout and login frames)
  const kids = await childFrames(t);
  const parentsWithCaptcha = new Set(kids.filter((f) => /recaptcha|hcaptcha|challenges\.cloudflare|challenge-platform|arkoselabs|funcaptcha|captcha-delivery|geetest|awswaf/i.test(f.url) && f.parentFrameId > 0).map((f) => f.parentFrameId));
  for (const fid of parentsWithCaptcha) await scan(fid);
  return found;
}
async function guardChallenge(t) {
  let list = await challengesIn(t);
  // Turnstile and similar widgets often pass by themselves within a few seconds
  if (list.length && list.every((c) => /Turnstile|Cloudflare/.test(c.kind))) {
    for (let i = 0; i < 16 && list.length; i++) {
      await sleep(500);
      list = await challengesIn(t);
    }
  }
  if (!list.length) return;
  const kind = [...new Set(list.map((c) => c.kind))].join(', ');
  notifyHuman(t, `${kind} on ${hostOf(list[0].url)}. Please solve it in the Browzie window; Claude continues by itself afterwards.`);
  throw new Halt(`HUMAN CHECK: ${kind} on this page. Browzie never touches bot checks: it stopped input here and asked the user to solve it. Call handoff to wait until they are done.`);
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return 'this page';
  }
}
// Asks you for something (a bot check, a sign-in). It only notifies: the Browzie window is not brought
// to the front, since you may be working on another desktop. Clicking the notification takes you
// to it (Windows switches to its desktop then, which is what you asked for).
let handoffDone = null;
let humanTab = null;
let testAutofill = false; // tests only (test_autofill)
async function notifyHuman(t, message) {
  humanTab = t.tabId;
  chrome.tabs.update(t.tabId, { active: true }).catch(() => {});
  lens('banner', { text: message });
  chrome.notifications.create('browzie-human', { type: 'basic', iconUrl: 'icons/icon128.png', title: 'Browzie needs you', message: message + ' (Click here to open the Browzie window.)', requireInteraction: true, buttons: [{ title: 'Done' }] }).catch(() => {});
}
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id === 'browzie-human' && handoffDone) handoffDone();
});
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== 'browzie-human' || humanTab == null) return;
  try {
    const tab = await chrome.tabs.get(humanTab);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (e) {}
});
chrome.action.onClicked.addListener(() => {
  if (handoffDone) return handoffDone();
  setPaused(!paused, paused ? '' : 'Browzie is paused (you clicked the toolbar button). Ask the user to resume it.');
});

// ======================================================================= low-level input
const BTN = { left: 1, right: 2, middle: 4, none: 0 };
// Input commands only return once the page has handled the event; if that handler opens
// alert/confirm/prompt, they wait for the dialog. Resolve as soon as a dialog shows instead.
function input(t, method, params) {
  if (t.dialog) return Promise.resolve();
  const opened = new Promise((resolve) => (t.onDialog = resolve));
  return Promise.race([cdp(t, method, params), opened]).finally(() => (t.onDialog = null));
}
function mouse(t, type, p, o = {}) {
  return input(t, 'Input.dispatchMouseEvent', {
    type,
    x: p.x,
    y: p.y,
    button: o.button || 'none',
    buttons: o.buttons ?? t.buttons,
    clickCount: o.clickCount || 0,
    modifiers: o.modifiers || 0,
    force: o.force || 0,
    pointerType: 'mouse',
    deltaX: o.deltaX,
    deltaY: o.deltaY,
    timestamp: o.at ? monotonic(t, o.at) / 1000 : undefined,
  });
}
// Key event parameters stamped with the time the plan meant them to happen. Real input carries the
// time it physically occurred, so a page sees human spacing even when the browser delivers late.
const stamp = (t, params, at) => ({ ...params, timestamp: monotonic(t, at) / 1000 });
function monotonic(t, at) {
  const v = Math.max(at, (t.lastTs || 0) + 1);
  t.lastTs = v;
  return v;
}
// Replays a motion plan on the real-time clock. Points snap to the physical pixel grid and points
// that land on the same pixel are dropped (a real mouse does not report "moves" that go nowhere).
// Moves go out on schedule like a real mouse, without waiting for the page to acknowledge each one
// (a busy or throttled renderer acknowledges once per frame); DevTools keeps them in order, and all
// of them are delivered before the function returns, so a following button press lands after them.
async function replayMoves(t, g, path) {
  const start = performance.now();
  const wall = Date.now(); // events carry their planned time, as OS input carries its own
  let last = t.cursor;
  const inflight = [];
  try {
    for (const p of path) {
      const due = start + p.t - performance.now();
      if (due > 0) await sleep(due);
      checkHalt(t);
      if (await clearOfUser(t)) throw new Replan();
      const s = g.snap(p);
      if (last && Math.abs(s.x - last.x) < 1e-6 && Math.abs(s.y - last.y) < 1e-6) continue;
      const sent = mouse(t, 'mouseMoved', s, { button: t.buttons ? 'left' : 'none', at: wall + p.t });
      sent.catch(() => {});
      inflight.push(sent);
      if (inflight.length > 8) await inflight.shift();
      t.lastMoveAt = now();
      if (!g.exact) {
        await sent; // the first trusted move on this document gives the exact on-screen calibration
        Object.assign(g, await geometry(t));
        lensFrame(t, g); // redraw the frame from the exact position
      }
      lensAt(g, s);
      last = s;
      t.cursor = s;
    }
  } finally {
    await Promise.all(inflight);
  }
}
// Moves the cursor to p (top-level viewport CSS px). width = target size for Fitts' law.
async function pointerTo(t, g, p, width) {
  const target = g.snap({ x: clamp(p.x, 0, g.vw - 0.5), y: clamp(p.y, 0, g.vh - 0.5) });
  // If the user moved the real mouse over the page since Browzie's last move, continue from where
  // the page last saw the pointer, so the page never sees the pointer jump.
  if (g.pointer && g.pointer.at > (t.lastMoveAt || 0) + 50) t.cursor = { x: g.pointer.cx, y: g.pointer.cy };
  if (!t.cursor) {
    // the pointer enters the page from the toolbar, near the top edge
    const entry = g.snap({ x: t.restHint ? clamp(t.restHint.x, 4, g.vw - 4) : clamp(target.x + (rng() - 0.5) * 300, 4, g.vw - 4), y: 0.5 + rng() * 2 });
    t.restHint = null;
    await mouse(t, 'mouseMoved', entry);
    t.cursor = entry;
    t.lastMoveAt = now();
    lens('show', { label: 'Claude' });
    lensFrame(t, g);
    lensAt(g, entry);
    g = { ...g, ...(await geometry(t)) }; // first trusted event: calibrate to the exact pixel
    lensFrame(t, g); // and redraw the frame from it
  } else {
    lens('show', { label: 'Claude' });
    lensFrame(t, g);
  }
  const from = t.cursor;
  const t0 = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await replayMoves(t, g, planMove(t.cursor, target, { rng, pace, width }));
      break;
    } catch (e) {
      if (!(e instanceof Replan) || attempt > 5) throw e;
      // your pointer crossed the window: continue from where the page last saw a pointer
      g = { ...g, ...(await geometry(t)) };
      if (g.pointer && g.pointer.at > (t.lastMoveAt || 0) + 50) t.cursor = { x: g.pointer.cx, y: g.pointer.cy };
    }
  }
  return { dist: Math.round(Math.hypot(target.x - from.x, target.y - from.y)), ms: Math.round(performance.now() - t0) };
}
async function wheelAt(t, g, axis, amount) {
  const plan = planWheel(amount, { rng, pace });
  const inflight = [];
  const start = performance.now();
  const wall = Date.now(); // events carry their planned time, as OS input carries its own
  for (const w of plan) {
    const due = start + w.t - performance.now();
    if (due > 0) await sleep(due);
    checkHalt(t);
    const spot = { ...t.cursor };
    if (await clearOfUser(t)) await pointerTo(t, await geometry(t), spot, 200);
    const sent = mouse(t, 'mouseWheel', t.cursor, axis === 'x' ? { deltaX: w.delta, deltaY: 0, at: wall + w.t } : { deltaX: 0, deltaY: w.delta, at: wall + w.t });
    sent.catch(() => {});
    inflight.push(sent);
  }
  await Promise.all(inflight);
  await sleep(st().wheelLand * (1 + rng() * 0.6)); // Chrome animates wheel scrolling; let it land
  return plan.length;
}
async function keyCombo(t, combo, repeat = 1) {
  const { mods, key } = parseCombo(combo);
  let info = keyInfo(key) || { key, code: '', keyCode: 0, text: key.length === 1 ? key : undefined, location: 0 };
  const shortcut = mods.some((m) => m !== 'Shift');
  if (shortcut && /^[A-Z]$/.test(info.key)) info = keyInfo(info.key.toLowerCase()); // Control+A is the a key
  const all = [...mods];
  if (info.shift && !all.includes('Shift')) all.push('Shift'); // "!" means Shift+1 on a real keyboard
  const plan = planCombo(all, { rng, pace, repeat });
  const start = performance.now();
  const wall = Date.now(); // events carry their planned time, as OS input carries its own
  let bits = 0;
  t.heldKeys = [];
  for (const e of plan) {
    const due = start + e.t - performance.now();
    if (due > 0) await sleep(due);
    checkHalt(t);
    if (e.key === '*') {
      await input(t, 'Input.dispatchKeyEvent', stamp(t, keyEvent(info, e.type, bits), wall + e.t));
    } else {
      if (e.type === 'down') bits |= MOD_BITS[e.key];
      else bits &= ~MOD_BITS[e.key];
      await input(t, 'Input.dispatchKeyEvent', stamp(t, keyEvent(keyInfo(e.key), e.type, bits), wall + e.t));
      t.heldKeys = e.type === 'down' ? [...t.heldKeys, e.key] : t.heldKeys.filter((k) => k !== e.key);
    }
  }
}
// Types like a person (see planTyping). o.typos: let fingers slip now and then (fixed with
// Backspace); o.progress(n, total): called every few seconds. t.typed always says how far it got:
// n characters of the text are in the field, followed by x wrong ones (so a stopped job can resume).
async function typeText(t, text, o = {}) {
  const plan = planTyping(text, { rng, pace, typos: o.typos, keyOf: (ch) => { const k = keyForChar(ch); return k ? { shift: !!k.shift, code: k.code } : null; } });
  const total = [...text].length;
  const start = performance.now();
  const wall = Date.now(); // events carry their planned time, as OS input carries its own
  let shift = false;
  let told = start;
  t.heldKeys = [];
  t.typed = { n: 0, x: 0, total };
  for (const e of plan) {
    const due = start + e.t - performance.now();
    if (due > 0) await sleep(due);
    checkHalt(t);
    if (e.type === 'insert') await input(t, 'Input.insertText', { text: e.text });
    else if (e.key === 'Shift') {
      shift = e.type === 'down';
      await input(t, 'Input.dispatchKeyEvent', stamp(t, keyEvent(keyInfo('Shift'), e.type, shift ? MOD_BITS.Shift : 0), wall + e.t));
      t.heldKeys = shift ? ['Shift'] : [];
    } else if (e.key) {
      await input(t, 'Input.dispatchKeyEvent', stamp(t, keyEvent(keyInfo(e.key), e.type, shift ? MOD_BITS.Shift : 0), wall + e.t));
      t.heldKeys = e.type === 'down' ? [...t.heldKeys, e.key] : t.heldKeys.filter((k) => k !== e.key);
    } else await input(t, 'Input.dispatchKeyEvent', stamp(t, keyEvent(keyForChar(e.ch), e.type, shift ? MOD_BITS.Shift : 0), wall + e.t));
    if (e.n != null) t.typed = { n: e.n, x: e.x, total };
    if (o.progress && performance.now() - told > 3000) {
      told = performance.now();
      o.progress(t.typed.n, total);
    }
  }
  return plan.length ? Math.round(plan[plan.length - 1].t) : 0;
}
// Where a stopped type job goes on: the field must still end with what was typed (plus the stray
// characters of a slip being fixed when it stopped), or nothing is touched.
async function resumePoint(t, job, where) {
  const n = job.n || 0;
  const x = job.x || 0;
  if (!job.ref) return { from: n, fixes: x }; // no field to read: what was sent is what is there
  const v = await agent(t, frameOfRef(t, job.ref), 'value', [job.ref]).catch(() => null);
  if (!v || v.error || typeof v.value !== 'string') return { from: n, fixes: x };
  const norm = (s) => s.replace(/\r/g, '').replace(/ /g, ' ').replace(/\n+/g, '\n').trimEnd();
  const have = [...v.value];
  const kept = norm(have.slice(0, Math.max(0, have.length - x)).join(''));
  if (kept.endsWith(norm([...job.text].slice(0, n).join('')))) return { from: n, fixes: x };
  throw new Error(`${where} no longer ends with the ${n} characters typed so far (it was edited since). Look at it, then clear it and type the text again, or type only what is missing.`);
}
// What has the keyboard focus, through iframes: keys typed while nothing that takes text has it
// are lost (a click that landed beside the field after the layout moved). A focus inside a frame
// Browzie cannot read counts as a field.
async function focusedField(t) {
  const top = await agent(t, 0, 'focusInfo', [], 3000).catch(() => null);
  if (!top || top.error) return null;
  if (!top.frame) return top;
  for (const f of await childFrames(t)) {
    const c = await agent(t, f.frameId, 'focusInfo', [], 2000).catch(() => null);
    if (c && !c.error && c.has && !c.frame) return c;
  }
  return { ...top, editable: true };
}
// Long actions tell the MCP server they are still going (it shows progress and keeps waiting).
function progressOf(ctx, what) {
  if (!ctx || !ctx.id) return null;
  return (n, total) => post({ t: 'progress', id: ctx.id, progress: n, total, message: `${what}: ${n} of ${total} characters` });
}

// ======================================================================= locating targets (wheel scrolling, frames)
async function toTop(t, fid, p) {
  let x = p.x;
  let y = p.y;
  let cur = fid;
  while (cur !== 0) {
    const info = await chrome.webNavigation.getFrame({ tabId: t.tabId, frameId: cur });
    if (!info) throw new Error('That frame is gone. Take a new snapshot.');
    const r = await agent(t, info.parentFrameId, 'frameHitById', [cur, x, y, await hintFor(t, cur, info.parentFrameId)]);
    if (r.error) throw new Error(r.error);
    if (r.offscreen) return { offscreen: true, frame: cur, parent: info.parentFrameId };
    if (r.covered) return { covered: r.covered };
    x = r.x;
    y = r.y;
    cur = info.parentFrameId;
  }
  return { x, y };
}
// Scrolls with the mouse wheel until plan() says nothing is hidden any more.
// Returns how many times it turned the wheel (0: it was in view already).
async function wheelReveal(t, fid, plan) {
  for (let i = 0; i < 14; i++) {
    const p = await plan();
    if (p.error) throw new Error(p.error);
    if (!p.need) return i;
    let at = { x: p.x, y: p.y };
    if (fid !== 0) {
      const top = await toTop(t, fid, p);
      if (top.offscreen) {
        await wheelReveal(t, top.parent, () => agent(t, top.parent, 'frameScrollPlan', [top.frame, hintOf(t, top.frame)]));
        continue;
      }
      if (top.covered) throw new Error(`The scroll area is covered by ${top.covered}`);
      at = top;
    }
    const g = await geometry(t);
    await pointerTo(t, g, at, 240);
    const axis = Math.abs(p.dy) >= Math.abs(p.dx) ? 'y' : 'x';
    const amount = clamp(axis === 'y' ? p.dy : p.dx, -1800, 1800);
    await wheelAt(t, g, axis, amount);
  }
  throw new Error('Could not scroll the element into view.');
}
// A target named by text or selector that is not on the page yet (a button that appears after an
// upload, a dialog still opening) is waited for, up to a.wait ms (default 3 s), so a step needs no
// separate wait_for before it.
async function queryRef(t, a) {
  const o = { text: a.text, selector: a.selector, role: a.role, nth: a.nth, exact: a.exact };
  const end = now() + clamp(a.wait ?? 3000, 0, 30000);
  for (;;) {
    const r = await agent(t, 0, 'query', [o]);
    if (r && r.ref) return r;
    if (r && r.none) {
      for (const f of await childFrames(t)) {
        const c = await agent(t, f.frameId, 'query', [o]).catch(() => null);
        if (c && c.ref) return c;
      }
      if (now() < end) {
        await sleep(150);
        continue;
      }
    }
    const extra = r && r.candidates ? '\n  ' + r.candidates.join('\n  ') : '';
    throw new Error(((r && r.error) || 'Nothing matches') + extra);
  }
}
// Where to click, in top-level viewport CSS px. Scrolls the target into view with the wheel.
async function locate(t, a, o = {}) {
  if (a.x != null && a.y != null && a.ref == null) return { x: Number(a.x), y: Number(a.y), desc: `point (${a.x}, ${a.y})`, w: 16, h: 16 };
  const ref = a.ref || (await queryRef(t, a)).ref;
  const fid = frameOfRef(t, ref);
  let coveredSince = 0;
  let nudged = false;
  for (let i = 0; i < 12; i++) {
    const p = await agent(t, fid, 'point', [ref, { force: a.force, left: o.left }]);
    if (p.error === 'covered') {
      // backdrops and toasts that are fading out cover a target for a moment: look again, as a
      // person waits for the animation to finish, before calling it covered
      coveredSince = coveredSince || now();
      if (now() - coveredSince < 1200) {
        i--;
        await sleep(150);
        continue;
      }
      // still covered near the top or bottom edge: most likely a sticky bar (a "Give us
      // feedback" footer). Scroll the target towards the middle once and look again.
      if (!nudged && fid === 0 && p.x != null) {
        nudged = true;
        const g = await geometry(t);
        const dy = p.y > g.vh * 0.6 ? Math.round(p.y - g.vh * 0.45) : p.y < g.vh * 0.25 ? -Math.round(g.vh * 0.45 - p.y) : 0;
        if (dy) {
          await pointerTo(t, g, { x: p.x, y: clamp(p.y - Math.sign(dy) * 140, 10, g.vh - 10) }, 200);
          await wheelAt(t, g, 'y', dy);
          coveredSince = 0;
          continue;
        }
      }
      throw new Error(`${p.desc} is covered by ${p.by}. Close or move past that first (or pass force: true).`);
    }
    if (p.error) throw new Error(p.error);
    if (p.scroll) {
      await wheelReveal(t, fid, () => agent(t, fid, 'scrollPlan', [ref]));
      continue;
    }
    if (fid === 0) return { ...p, ref, fid };
    const top = await toTop(t, fid, p);
    if (top.covered) throw new Error(`${p.desc} is covered by ${top.covered}`);
    if (top.offscreen) {
      await wheelReveal(t, top.parent, () => agent(t, top.parent, 'frameScrollPlan', [top.frame, hintOf(t, top.frame)]));
      continue;
    }
    return { ...p, x: top.x, y: top.y, ref, fid };
  }
  throw new Error('Could not bring the element into view.');
}
// Moves onto the target and confirms it is still the thing under the pointer (pages shift while
// the cursor travels); re-aims with a short correction if it moved.
async function moveOnto(t, a, o = {}) {
  if (a.ref && !a.force) await checkRefName(t, a.ref);
  let target = await locate(t, a, o);
  let g = await geometry(t);
  let moved = await pointerTo(t, g, target, Math.min(target.w || 24, target.h || 24));
  for (let i = 0; i < 2 && target.ref && target.fid === 0 && !a.force; i++) {
    const h = await agent(t, 0, 'hits', [target.ref, t.cursor.x, t.cursor.y]);
    if (h.error) throw new Error(h.error);
    if (h.ok) break;
    target = await locate(t, { ...a, ref: target.ref }, o);
    g = await geometry(t);
    const m2 = await pointerTo(t, g, target, Math.min(target.w || 24, target.h || 24));
    moved = { dist: moved.dist + m2.dist, ms: moved.ms + m2.ms };
    if (i === 1) {
      const h2 = await agent(t, 0, 'hits', [target.ref, t.cursor.x, t.cursor.y]);
      if (!h2.ok) throw new Error(`${target.desc} keeps moving; ${h2.by} is under the pointer now.`);
    }
  }
  return { target, moved, g };
}
function modBits(list) {
  let b = 0;
  for (const m of list || []) {
    const k = { control: 'Control', ctrl: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' }[String(m).toLowerCase()] || m;
    if (MOD_BITS[k]) b |= MOD_BITS[k];
  }
  return b;
}
async function pressButton(t, a) {
  const clicks = planClick({ rng, pace, count: a.doubleClick ? 2 : 1 });
  const button = a.button || 'left';
  const mods = (a.modifiers || []).map((m) => ({ control: 'Control', ctrl: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta' }[String(m).toLowerCase()] || m));
  let bits = 0;
  t.heldKeys = [];
  for (const m of mods) {
    bits |= MOD_BITS[m] || 0;
    await input(t, 'Input.dispatchKeyEvent', keyEvent(keyInfo(m), 'down', bits));
    t.heldKeys.push(m);
    await sleep(logn(rng, [70, 0.3, 30, 160]));
  }
  const start = performance.now();
  const wall = Date.now(); // events carry their planned time, as OS input carries its own
  for (const c of clicks) {
    let due = start + c.down - performance.now();
    if (due > 0) await sleep(due);
    checkHalt(t);
    const spot = { ...t.cursor };
    if (await clearOfUser(t)) {
      // a point read off an old screenshot may now be something else (an ad, a moved button)
      if (a.x != null && a.ref == null) throw new Halt('The page may have changed while your mouse was moving over the Browzie window, so Browzie did not click that screen position. Take a new screenshot or snapshot and click again.');
      await pointerTo(t, await geometry(t), spot, 24); // move back onto the target first
      await sleep(logn(rng, pace.dwell));
    }
    t.buttons = BTN[button];
    // force 0.5: a mouse button without pressure sensing reports pressure 0.5 while pressed
    await mouse(t, 'mousePressed', t.cursor, { button, buttons: t.buttons, clickCount: c.clickCount, modifiers: bits, force: 0.5, at: wall + c.down });
    lens('down');
    due = start + c.up - performance.now();
    if (due > 0) await sleep(due);
    t.buttons = 0;
    await mouse(t, 'mouseReleased', t.cursor, { button, buttons: 0, clickCount: c.clickCount, modifiers: bits, at: wall + c.up });
    lens('up');
  }
  for (const m of [...mods].reverse()) {
    await sleep(logn(rng, [45, 0.35, 15, 120]));
    bits &= ~(MOD_BITS[m] || 0);
    await input(t, 'Input.dispatchKeyEvent', keyEvent(keyInfo(m), 'up', bits));
  }
  t.heldKeys = [];
}

// ======================================================================= reading pages
async function snapshotLines(t, o = {}) {
  const main = await agent(t, 0, 'snapshot', [{ viewportOnly: o.viewportOnly, interactiveOnly: o.interactiveOnly, ref: o.ref && frameOfRef(t, o.ref) === 0 ? o.ref : undefined, selector: o.selector }]);
  if (!main || main.error) throw new Error((main && main.error) || 'empty snapshot');
  return { main, rows: await frameRows(t, 0, main, o, 0) };
}
// A frame's snapshot lines with the content of its iframes spliced in under each iframe line,
// recursively (nested and cross-origin frames included).
async function frameRows(t, fid, snap, o, depth) {
  const rows = snap.lines.map((line, i) => ({ line, iv: snap.iv ? snap.iv[i] : 0 }));
  if (depth > 5) return rows;
  const frames = (await resolveFrames(t, fid, snap.frames || [])).sort((a, b) => b.index - a.index);
  for (const f of frames) {
    const sub = await agent(t, f.frameId, 'snapshot', [{ interactiveOnly: o.interactiveOnly }], 4000).catch((e) => (xlog('frame snapshot failed', f.frameId, e.message), null));
    if (!sub || sub.error || !sub.lines) continue;
    const inner = await frameRows(t, f.frameId, sub, o, depth + 1);
    const pad = '  '.repeat(f.depth + 1);
    const iv = rows[f.index] ? rows[f.index].iv : 0;
    rows.splice(f.index + 1, 0, ...inner.map((r) => ({ line: pad + r.line, iv: iv && r.iv })));
  }
  return rows;
}
function budget(rows, maxChars) {
  let total = rows.reduce((n, r) => n + r.line.length + 1, 0);
  if (total <= maxChars) return { lines: rows.map((r) => r.line), note: '' };
  const first = Math.max(0, rows.findIndex((r) => r.iv));
  let start = Math.max(0, first - 25);
  const out = [];
  let used = 0;
  for (let i = start; i < rows.length && used + rows[i].line.length + 1 <= maxChars; i++) {
    out.push(rows[i].line);
    used += rows[i].line.length + 1;
  }
  const after = rows.length - start - out.length;
  return { lines: out, note: `(snapshot cut to ${maxChars} chars around the viewport: ${start} lines above and ${after} below not shown; scroll, or use find)` };
}
async function header(t, main) {
  const s = sessionOfWindow(t.windowId);
  const list = s ? await sessionTabs(s) : [];
  const n = list.findIndex((x) => x.id === t.tabId) + 1 || 1;
  const popup = s && s.popups.has(t.windowId) ? ', popup window' : '';
  let h = `[tab ${n}${popup}] ${main.title || ''}\n${main.url}\nviewport ${main.vw}x${main.vh} | scroll ${main.sx},${main.sy} | page ${main.sw}x${main.sh}`;
  if (t.dialog) h += `\n! A ${t.dialog.type} dialog is open: "${t.dialog.message}". Answer it with the dialog tool first.`;
  return h;
}
async function challengeLine(t) {
  const list = await challengesIn(t).catch(() => []);
  if (!list.length) return '';
  return `\n! HUMAN CHECK on this page: ${[...new Set(list.map((c) => c.kind))].join(', ')}. Browzie will not touch it; call handoff so the user can solve it.`;
}
async function fullSnapshot(t, o = {}) {
  let tab = await chrome.tabs.get(t.tabId);
  t.windowId = tab.windowId;
  let snap;
  try {
    snap = await snapshotLines(t, o);
  } catch (e) {
    if (/off limits|cannot read/i.test(e.message)) return `[tab] ${tab.title || ''}\n${tab.url}\n(${e.message})`;
    throw e;
  }
  t.lastRows = o.ref || o.selector || o.viewportOnly || o.interactiveOnly ? t.lastRows : snap.rows.map((r) => r.line);
  const b = budget(snap.rows, o.maxChars || 16000);
  return (await header(t, snap.main)) + (await challengeLine(t)) + '\n' + b.lines.join('\n') + (b.note ? '\n' + b.note : '');
}
async function linesNow(t) {
  try {
    return (await snapshotLines(t)).rows.map((r) => r.line);
  } catch (e) {
    return null;
  }
}

// ======================================================================= waiting for the page
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  const t = tabs.get(d.tabId);
  if (t && d.frameId === 0) t.nav.push({ e: 'start', at: now(), url: d.url });
});
chrome.webNavigation.onCommitted.addListener((d) => {
  const t = tabs.get(d.tabId);
  if (t && d.frameId === 0) t.nav.push({ e: 'commit', at: now(), url: d.url, bfcache: (d.transitionQualifiers || []).includes('forward_back') });
});
chrome.webNavigation.onDOMContentLoaded.addListener((d) => {
  const t = tabs.get(d.tabId);
  if (t && d.frameId === 0) t.nav.push({ e: 'dcl', at: now(), url: d.url });
});
chrome.webNavigation.onErrorOccurred.addListener((d) => {
  const t = tabs.get(d.tabId);
  if (t && d.frameId === 0) t.nav.push({ e: 'error', at: now(), url: d.url, error: d.error });
});
for (const ev of [chrome.webNavigation.onHistoryStateUpdated, chrome.webNavigation.onReferenceFragmentUpdated]) {
  ev.addListener((d) => {
    const t = tabs.get(d.tabId);
    if (t && d.frameId === 0) t.nav.push({ e: 'same-doc', at: now(), url: d.url });
  });
}
const TRACKED = new Set(['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'other']);
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    const t = tabs.get(d.tabId);
    if (t && TRACKED.has(d.type)) t.inflight.set(d.requestId, now());
  },
  { urls: ['<all_urls>'] }
);
for (const ev of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) {
  ev.addListener(
    (d) => {
      const t = tabs.get(d.tabId);
      if (t) t.inflight.delete(d.requestId);
    },
    { urls: ['<all_urls>'] }
  );
}
// After an action: wait while a navigation it started is loading, requests it started are in
// flight (long polls ignored after 2.5 s) and the DOM is still changing. No fixed sleeps. Pages
// that never stop changing (timers, video players, live counters) only hold an action that did
// not navigate for o.soft ms (a little longer while its requests are still out).
async function settle(t, since, maxMs = 6000, o = {}) {
  const S = st();
  const network = o.network !== false;
  const quietMs = o.quiet || S.quiet;
  const soft = o.soft || S.soft;
  await sleep(S.first);
  const end = now() + maxMs;
  while (now() < end) {
    if (t.dialog || t.gone) return;
    const evs = t.nav.filter((e) => e.at >= since);
    const started = evs.some((e) => e.e === 'start');
    const loaded = evs.some((e) => e.e === 'dcl' || e.e === 'error');
    const loading = started && !loaded;
    const busy = network && [...t.inflight.values()].some((s) => s >= since - 30 && now() - s < 2500);
    if (!started && now() - since > soft + (busy ? S.busy : 0)) return;
    let quiet = false;
    if (!loading) {
      try {
        const age = await agent(t, 0, 'mutationAge', [], 1500);
        quiet = typeof age === 'number' && age >= quietMs;
      } catch (e) {
        quiet = false;
      }
    }
    if (!loading && !busy && quiet) return;
    await sleep(S.poll);
  }
}
// The tab an action ran in closed (a sign-in popup that closes itself when done): the session is
// back on the tab that opened it.
async function closedReport(t, head) {
  const s = sessions.get(t.sid);
  const back = s && s.tabId != null && s.tabId !== t.tabId ? tabOf(s, s.tabId) : null;
  if (!back) return `${head}\nThat tab closed.`;
  await sleep(300);
  await settle(back, now() - 1500, 3000).catch(() => {});
  return `${head}\nThat ${t.popup ? 'popup window' : 'tab'} closed; Browzie is back on the tab that opened it.\n${await fullSnapshot(back)}`;
}
// o.snapshot: "none" reports only the one line (plus dialogs, bot checks and navigation), for steps
// whose outcome the caller checks some other way; the page is still left to settle first.
async function report(t, verb, since, before, extra = '', o = {}) {
  await settle(t, since);
  // a sign-in popup often closes itself right after its last button: give it a moment to
  for (let i = 0; t.popup && !t.gone && i < 12; i++) await sleep(100);
  if (t.dialog) return `${verb}${extra ? ' ' + extra : ''}\n! A ${t.dialog.type} dialog opened: "${t.dialog.message}". Answer it with the dialog tool (accept true or false).`;
  const tab = await chrome.tabs.get(t.tabId).catch(() => null);
  if (!tab || t.gone) return closedReport(t, `${verb}${extra ? ' ' + extra : ''}`);
  const navigated = t.nav.some((e) => e.at >= since && e.e === 'commit');
  const head = `${verb}${extra ? ' ' + extra : ''}`;
  if (navigated) {
    t.navAt = now();
    if (o.snapshot === 'none') return `${head}\nNavigated to ${tab.url}${await challengeLine(t)}`;
    return `${head}\nNavigated to ${tab.url}\n${await fullSnapshot(t)}`;
  }
  if (o.snapshot === 'none') {
    t.lastRows = null;
    return `${head}${await challengeLine(t)}`;
  }
  const after = await linesNow(t);
  if (!before || !after) return `${head}\n${await fullSnapshot(t)}`;
  t.lastRows = after;
  const d = diffLines(before, after);
  const chk = await challengeLine(t);
  const dlg = t.dialog ? `\n! A ${t.dialog.type} dialog opened: "${t.dialog.message}". Answer it with the dialog tool.` : '';
  if (!d) return `${head}${chk}${dlg}\nPage changed a lot:\n${await fullSnapshot(t)}`;
  // (the snapshot holds the whole page, so a scroll that only moves the view changes nothing in it)
  if (!d.text) return `${head}${chk}${dlg}\nThe page's content did not change.`;
  return `${head}${chk}${dlg}\nPage changed (+${d.added} -${d.removed} lines):\n${compactDiff(d.text)}`;
}

// ======================================================================= tools
function normUrl(u) {
  u = String(u || '').trim();
  if (!u) throw new Error('No url given');
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)(:|\/|$)/.test(u)) return 'http://' + u;
  return 'https://' + u;
}
async function waitLoaded(t, since, ms) {
  const end = now() + ms;
  while (now() < end) {
    const evs = t.nav.filter((e) => e.at >= since);
    const err = evs.find((e) => e.e === 'error' && !/ERR_ABORTED/.test(e.error || ''));
    if (err) throw new Error(`Navigation failed: ${err.error} (${err.url})`);
    if (evs.some((e) => e.e === 'dcl' || e.e === 'same-doc' || (e.e === 'commit' && e.bfcache))) return;
    if (t.dialog) return;
    await sleep(40);
  }
}

// The page opened a tab or a popup window and Browzie switched to it.
async function followedReport(s, first) {
  const nt = tabOf(s, s.followed);
  const since = now() - 3000;
  await waitLoaded(nt, since, 15000).catch(() => {});
  await settle(nt, since, 3000);
  nt.navAt = now();
  const tab = await chrome.tabs.get(nt.tabId).catch(() => null);
  if (!tab) return `${first}\nThe page opened a tab that closed again at once.`;
  nt.windowId = tab.windowId;
  const popup = s.popups.has(tab.windowId);
  let note = popup ? 'The page opened a popup window; Browzie switched to it (it closes by itself or with tabs close, then Browzie goes back).' : 'The page opened a new tab; Browzie switched to it.';
  note += await signinNote(nt);
  return `${first}\n${note}\n${await fullSnapshot(nt)}`;
}
// A password form on the page: how to use a login Chrome has saved.
async function signinNote(t) {
  const f = await agent(t, 0, 'loginForm', [], 3000).catch(() => null);
  if (!f || f.error) return '';
  if (f.none) return f.signup ? '\n! It asks for a new password (a sign-up or password change form); signin only uses logins Chrome has saved.' : '';
  if (!f.pw) return '';
  return `\n! It asks for a password${f.pw.filled ? ' (Chrome already filled a saved one)' : ''}. Call signin: the user picks their saved login in Chrome's own list and Browzie carries on; Browzie never types or sees a password.`;
}

let lastCapture = 0;
let lensWhere = null;
const BATCHABLE = new Set(['navigate', 'click', 'fill', 'type', 'press', 'hover', 'scroll', 'wait_for', 'dialog', 'upload']);
const COMMANDS = {
  // Several steps in one call: one model turn instead of many. Each step is the same command
  // with the same human pacing; only the model round trips between them disappear. Stops at the
  // first failing step and reports what ran.
  async batch(sid, a, ctx) {
    const steps = Array.isArray(a.steps) ? a.steps : [];
    if (!steps.length) throw new Error('batch needs steps, e.g. [{"action":"click","text":"Sign in"}]');
    if (steps.length > 25) throw new Error('At most 25 steps per batch.');
    const out = [];
    for (let i = 0; i < steps.length; i++) {
      const { action, ...args } = steps[i] || {};
      if (!BATCHABLE.has(action)) throw new Error(`Step ${i + 1}: "${action}" cannot be batched. Use one of: ${[...BATCHABLE].join(', ')}`);
      let r;
      try {
        r = await COMMANDS[action](sid, args, ctx);
      } catch (e) {
        out.push(`${i + 1}. ${action} FAILED: ${e.message}`);
        throw new Error(`${out.join('\n')}\n(stopped at step ${i + 1} of ${steps.length})`);
      }
      const text = typeof r === 'string' ? r : r.text;
      out.push(`${i + 1}. ${i === steps.length - 1 ? text : text.split('\n')[0]}`);
    }
    return out.join('\n');
  },

  // tests: open a tab in the session window the way you would (not Browzie's tab)
  async test_user_tab(sid) {
    for (const s of sessions.values()) if (s.windowId != null) {
      await chrome.tabs.create({ windowId: s.windowId, url: 'about:blank', active: true });
      return 'ok';
    }
    throw new Error('no session window');
  },
  // tests: you resize the Browzie window (restore it from maximised to a smaller size)
  async test_resize() {
    for (const s of sessions.values()) if (s.windowId != null) {
      await chrome.windows.update(s.windowId, { state: 'normal' });
      await chrome.windows.update(s.windowId, { left: 80, top: 60, width: 1100, height: 760 });
      return 'ok';
    }
    throw new Error('no session window');
  },
  // tests: the same signal the overlay sends when the human touches the mouse or keyboard
  // (it can only make Browzie stop)
  async test_user_input() {
    lastUserInput = now();
    return 'ok';
  },
  // tests: the signal the overlay sends when the human clicks or types in the Browzie window
  async test_takeover() {
    lastTakeover = now();
    return 'ok';
  },
  // tests: where the overlay drew the cursor tip, in physical screen pixels
  async lens_where() {
    if (!lensOk) throw new Error('the cursor overlay is not running');
    const p = new Promise((resolve) => (lensWhere = resolve));
    lens('where');
    try {
      return JSON.stringify(await withTimeout(p, 2000, 'the overlay did not answer'));
    } finally {
      lensWhere = null;
    }
  },

  async navigate(sid, a) {
    const s0 = sessions.get(sid);
    let t;
    if (a.newTab && s0 && s0.windowId != null) {
      const tab = await chrome.tabs.create({ windowId: s0.windowId, url: 'about:blank', active: true });
      await groupTab(s0, tab.id);
      s0.tabId = tab.id;
      saveSessions();
      t = tabOf(s0, tab.id);
    } else t = await sessionTab(sid);
    // Take the tab before the page loads: Chrome's "debugging this browser" bar then appears before
    // the page exists, so the page never sees its viewport shrink.
    await showTab(t).catch(() => {});
    await attach(t).catch((e) => xlog('early attach failed:', e.message));
    const since = now();
    if (a.action === 'back') await chrome.tabs.goBack(t.tabId);
    else if (a.action === 'forward') await chrome.tabs.goForward(t.tabId);
    else if (a.action === 'reload') await chrome.tabs.reload(t.tabId);
    else {
      const url = normUrl(a.url);
      await rateGate('nav:' + originOf(url), pace.navPerMinute);
      await chrome.tabs.update(t.tabId, { url });
    }
    await waitLoaded(t, since, a.timeout || 30000);
    await settle(t, since, 3500, { network: false, quiet: st().navQuiet });
    t.navAt = now();
    const note = await signinNote(t);
    if (a.snapshot === 'none') {
      const tab = await chrome.tabs.get(t.tabId);
      return `Opened ${tab.url} (${now() - since} ms)${note}`;
    }
    return `Opened (${now() - since} ms)${note}\n${await fullSnapshot(t, a)}`;
  },

  async snapshot(sid, a) {
    return fullSnapshot(await sessionTab(sid, false), a);
  },

  async click(sid, a) {
    const t = await sessionTab(sid, false);
    const s = sessions.get(sid);
    if (s) s.followed = null;
    const out = await withInput(t, async () => {
      const before = a.snapshot === 'none' ? null : await linesNow(t);
      const since = now();
      const { target, moved } = await moveOnto(t, a);
      await pressButton(t, a);
      const what = a.doubleClick ? 'Double-clicked' : a.button === 'right' ? 'Right-clicked' : 'Clicked';
      return report(t, `${what} ${target.desc}`, since, before, `(moved ${moved.dist} px in ${moved.ms} ms, ${now() - since} ms total)`, a);
    });
    if (s && s.followed && s.followed === s.tabId) return followedReport(s, out.split('\n')[0]);
    return out;
  },

  async hover(sid, a) {
    const t = await sessionTab(sid, false);
    return withInput(t, async () => {
      const before = a.snapshot === 'none' ? null : await linesNow(t);
      const since = now();
      const { target, moved } = await moveOnto(t, a);
      await sleep(logn(rng, [260, 0.3, 120, 600]));
      return report(t, `Hovering ${target.desc}`, since, before, `(moved ${moved.dist} px in ${moved.ms} ms)`, a);
    });
  },

  // Long texts take a while at a person's speed. If typing stops part way (you clicked into the
  // Browzie window, the call timed out), type {resume: true} finishes the same text from where it
  // stopped, after checking that the field still holds what was typed.
  async type(sid, a, ctx) {
    const t = await sessionTab(sid, false);
    const s = sessionOf(sid);
    let job = { text: String(a.text ?? ''), ref: a.ref, selector: a.selector, nth: a.nth, tabId: t.tabId, typos: !!a.typos };
    let from = 0;
    if (a.resume) {
      job = s.typing;
      if (!job) throw new Error('There is no stopped typing to resume. Use type with text.');
      if (job.tabId !== t.tabId) throw new Error('The stopped typing was in another tab; select that tab first (tabs).');
    }
    return withInput(t, async () => {
      const before = a.snapshot === 'none' ? null : await linesNow(t);
      const since = now();
      let where = 'the focused element';
      let fixes = 0;
      if (job.ref || job.selector) {
        const { target } = await moveOnto(t, { ref: job.ref, selector: job.selector, nth: job.nth });
        where = target.desc;
        await pressButton(t, {});
        await sleep(logn(rng, st().focus));
        if (a.clear && !a.resume) await keyCombo(t, 'Control+a');
      }
      const focus = await focusedField(t);
      if (focus && !focus.editable) {
        const on = focus.desc ? `the focus is on ${focus.desc}` : 'nothing has the focus';
        throw new Error(job.ref || job.selector ? `Clicking ${where} did not put the cursor in a text field (${on}), so nothing was typed. Target the text field itself.` : `Nothing that takes text has the focus (${on}), so nothing was typed. Click the field first or pass its ref. For keys and shortcuts use press.`);
      }
      if (a.resume) {
        ({ from, fixes } = await resumePoint(t, job, where));
        await keyCombo(t, 'Control+End');
        if (fixes) {
          await sleep(logn(rng, pace.notice));
          await keyCombo(t, 'Backspace', fixes);
        }
        await sleep(logn(rng, pace.afterFix));
      }
      const rest = [...job.text].slice(from).join('');
      s.typing = { ...job, n: from, x: 0 };
      t.typed = null;
      let ms;
      try {
        ms = await typeText(t, rest, { typos: job.typos, progress: progressOf(ctx, 'typing') });
        s.typing = null;
      } catch (e) {
        if (t.typed) s.typing = { ...job, n: from + t.typed.n, x: t.typed.x };
        if (e instanceof Halt && s.typing) e.message += ` (Typing stopped after ${s.typing.n} of ${[...job.text].length} characters: call type with resume: true to finish it.)`;
        throw e;
      }
      if (a.submit) {
        await sleep(logn(rng, pace.key));
        await keyCombo(t, 'Enter');
      }
      const verb = a.resume ? `Finished typing (resumed at character ${from + 1}${fixes ? `, removed ${fixes} stray character(s) first` : ''})` : `Typed ${JSON.stringify(job.text.slice(0, 60))}`;
      return report(t, `${verb} into ${where}`, since, before, `(${ms} ms of typing)`, a);
    });
  },

  async press(sid, a) {
    const t = await sessionTab(sid, false);
    const s = sessions.get(sid);
    if (s) s.followed = null;
    const out = await withInput(t, async () => {
      const before = a.snapshot === 'none' ? null : await linesNow(t);
      const since = now();
      const combos = String(a.keys).trim().split(/\s+/);
      for (let i = 0; i < combos.length; i++) {
        if (i) await sleep(logn(rng, pace.key));
        await keyCombo(t, combos[i], a.repeat || 1);
      }
      return report(t, `Pressed ${a.keys}`, since, before, '', a);
    });
    if (s && s.followed && s.followed === s.tabId) return followedReport(s, out.split('\n')[0]);
    return out;
  },

  async fill(sid, a, ctx) {
    const t = await sessionTab(sid, false);
    return withInput(t, async () => {
      const before = a.snapshot === 'none' ? null : await linesNow(t);
      const since = now();
      const done = [];
      for (let i = 0; i < (a.fields || []).length; i++) {
        const f = a.fields[i];
        if (i) await sleep(logn(rng, pace.gap) * 0.6);
        const ref = f.ref || (await queryRef(t, f)).ref;
        const fid = frameOfRef(t, ref);
        let plan = await agent(t, fid, 'prepareFill', [ref, f.value]);
        // file paths for a button ("Select files"): it opens the file chooser, which gets the files
        if (plan.error && /not a fillable field/.test(plan.error) && looksLikePaths(f.value)) plan = { kind: 'file', desc: (await agent(t, fid, 'describeRef', [ref]).catch(() => null)) || ref };
        if (plan.error) throw new Error(`Field ${i + 1}: ${plan.error}${done.length ? `\n(already filled: ${done.join('; ')})` : ''}`);
        done.push(await fillOne(t, ref, fid, plan, f.value, ctx));
      }
      if (a.submit) {
        await sleep(logn(rng, pace.key));
        await keyCombo(t, 'Enter');
      }
      return report(t, `Filled ${done.length} field(s):\n  ${done.join('\n  ')}`, since, before, '', a);
    });
  },

  async scroll(sid, a) {
    const t = await sessionTab(sid, false);
    return withInput(t, async () => {
      const before = a.snapshot === 'none' ? null : await linesNow(t);
      const since = now();
      if (a.ref && !a.direction && !a.to) {
        const fid = frameOfRef(t, a.ref);
        const turns = await wheelReveal(t, fid, () => agent(t, fid, 'scrollPlan', [a.ref]));
        return report(t, turns ? `Scrolled ${a.ref} into view (${turns} wheel move(s))` : `${a.ref} was in view already`, since, before, '', a);
      }
      const dir = a.direction || (a.to === 'top' ? 'up' : a.to === 'left' ? 'left' : a.to === 'right' ? 'right' : 'down');
      const axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
      const fid = a.ref ? frameOfRef(t, a.ref) : 0;
      const w = await agent(t, fid, 'wheelTarget', [{ ref: a.ref, direction: dir }]);
      if (w.error) throw new Error(w.error);
      const span = axis === 'y' ? w.h : w.w;
      let amount = a.to ? 40000 : a.amount || Math.round(span * 0.85);
      if (a.to) amount = Math.min(amount, 100 * 60); // at most 60 notches; long pages need several calls
      if (dir === 'up' || dir === 'left') amount = -amount;
      let at = { x: w.x, y: w.y };
      if (fid !== 0) {
        const top = await toTop(t, fid, at);
        if (top.offscreen || top.covered) throw new Error('That scroll area is not visible.');
        at = top;
      }
      const g = await geometry(t);
      await pointerTo(t, g, at, 300);
      const notches = await wheelAt(t, g, axis, amount);
      const m = await agent(t, fid, 'scroll', [{ ref: a.ref, direction: dir, measureOnly: true, from: w.pos }]);
      const where = m && !m.error ? `now at ${m.x},${m.y} of ${m.maxX},${m.maxY} (${m.what})${m.moved ? '' : ', it did not move: already at the end'}` : '';
      return report(t, `Scrolled ${dir} with ${notches} wheel notch(es)`, since, before, where, a);
    });
  },

  // At most 110 s: Claude Code moves a tool call that runs past 120 s into the background, and the
  // step then has to be fetched back. enabled: true waits until the element that text/selector
  // (with role) names is there and not disabled.
  async wait_for(sid, a) {
    const t = await sessionTab(sid, false);
    const since = now();
    const timeout = Math.min(a.timeout || 15000, 110000);
    if (a.time) {
      await sleep(Math.min(a.time, 60000));
      return `Waited ${a.time} ms`;
    }
    const m = a.url ? /^\/(.+)\/([dgimsuy]*)$/.exec(a.url) : null;
    let urlRe = null;
    try {
      urlRe = m ? new RegExp(m[1], m[2]) : null;
    } catch (e) {
      urlRe = null; // a path such as /channel/x/monetization is a substring, not a regex
    }
    for (;;) {
      const tab = await chrome.tabs.get(t.tabId).catch(() => null);
      if (!tab) throw new Error('The tab closed while waiting. Use tabs to see what is open.');
      let ok = true;
      if (a.enabled && (a.text != null || a.selector)) {
        const e = (await agent(t, 0, 'enabled', [{ text: a.text, selector: a.selector, role: a.role, nth: a.nth }], 3000).catch(() => null)) || {};
        ok = !!(e.found && e.enabled);
      } else {
        const c = (await agent(t, 0, 'check', [{ text: a.text, textGone: a.textGone, selector: a.selector, selectorGone: a.selectorGone }], 3000).catch(() => null)) || {};
        if (c.error) throw new Error(c.error);
        if (a.text != null) ok = ok && !!c.text;
        if (a.textGone != null) ok = ok && !!c.textGone;
        if (a.selector) ok = ok && !!c.selector;
        if (a.selectorGone) ok = ok && !!c.selectorGone;
      }
      if (a.url) ok = ok && (urlRe ? urlRe.test(tab.url) : tab.url.includes(a.url));
      if (ok) return a.snapshot === 'none' ? `Condition met after ${now() - since} ms` : `Condition met after ${now() - since} ms\n${await fullSnapshot(t, { viewportOnly: true })}`;
      if (now() - since > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${JSON.stringify(a)}`);
      await sleep(pace.settle ? 100 : 150);
    }
  },

  async screenshot(sid, a) {
    const t = await sessionTab(sid, false);
    const tab = await chrome.tabs.get(t.tabId);
    if (!tab.active) await chrome.tabs.update(t.tabId, { active: true });
    const g = await geometry(t);
    // Chrome allows two captures per second; wait for a slot instead of failing
    const wait = lastCapture + 520 - now();
    if (wait > 0) await sleep(wait);
    lastCapture = now();
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (e) {
      await sleep(600);
      lastCapture = now();
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (e2) {
        // A window on a desktop you are not looking at (a popup that just opened there) may have no
        // frame Chrome can read back; the debugger Browzie already holds asks the page for one.
        if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(e2.message)) throw e2;
        await attach(t);
        const r = await Promise.race([cdp(t, 'Page.captureScreenshot', { format: 'png' }), sleep(4000).then(() => null)]);
        if (!r) throw new Error(`Chrome has no picture of this window (${e2.message}): it has not been drawn since it opened on a desktop you are not looking at. snapshot, find and read still work.`);
        dataUrl = 'data:image/png;base64,' + r.data;
      }
    }
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    // scale to CSS pixels so an x,y read off the image is exactly where a click lands
    const W = Math.round(g.vw);
    const H = Math.round(g.vh);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, W, H);
    let note = '';
    if (a.labels) {
      const boxes = await agent(t, 0, 'labelBoxes');
      const colors = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#e377c2', '#8c564b'];
      ctx.font = 'bold 10px Consolas, monospace';
      (boxes || []).forEach((b, i) => {
        const c = colors[i % colors.length];
        ctx.strokeStyle = c;
        ctx.lineWidth = 2;
        ctx.strokeRect(b.x, b.y, b.w, b.h);
        const tw = ctx.measureText(b.ref).width + 6;
        const ly = b.y >= 13 ? b.y - 13 : b.y;
        ctx.fillStyle = c;
        ctx.fillRect(b.x, ly, tw, 13);
        ctx.fillStyle = '#fff';
        ctx.fillText(b.ref, b.x + 3, ly + 10);
      });
      note = `, ${(boxes || []).length} refs labelled`;
    }
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: (a.quality || 80) / 100 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { text: `Screenshot of the viewport, ${W}x${H} CSS px${note}. x,y on this image can be passed to click.`, image: { data: btoa(bin), mimeType: 'image/jpeg' } };
  },

  async find(sid, a) {
    const t = await sessionTab(sid, false);
    const out = [];
    const r = await agent(t, 0, 'find', [a]);
    if (r.error) throw new Error(r.error);
    out.push(...r.lines);
    for (const f of await childFrames(t)) {
      const c = await agent(t, f.frameId, 'find', [a], 3000).catch(() => null);
      if (c && c.lines) out.push(...c.lines);
    }
    return out.length ? out.slice(0, a.limit || 30).join('\n') : `Nothing matches ${JSON.stringify(a.query || a.selector)}`;
  },

  async read(sid, a) {
    const t = await sessionTab(sid, false);
    const fid = a.ref ? frameOfRef(t, a.ref) : 0;
    const r = await agent(t, fid, 'text', [a]);
    if (r.error) throw new Error(r.error);
    const more = r.offset + r.text.length < r.total ? `\n(${r.total - r.offset - r.text.length} more chars: read again with offset ${r.offset + r.text.length})` : '';
    return `${r.title}\n${r.url}\n\n${r.text}${more}`;
  },

  // Tabs are numbered 1, 2, ... in the order list shows them (the session's window, then its popup
  // windows). select/close take that number as id (or tab / index), or no number for the current one.
  async tabs(sid, a) {
    await restored;
    const s = sessions.get(sid);
    const list = await sessionTabs(s);
    const act = a.action || 'list';
    const where = (x) => (s && s.popups.has(x.windowId) ? ' (popup window)' : '');
    const listing = () => list.map((x, i) => `${x.id === s.tabId ? '*' : ' '} [tab ${i + 1}]${where(x)} ${x.title || ''} | ${x.url}`).join('\n');
    if (act === 'new') return COMMANDS.navigate(sid, { url: a.url || 'about:blank', newTab: true });
    if (act === 'select' || act === 'close') {
      if (!list.length) throw new Error('Browzie has no tabs open yet. Use navigate first.');
      const raw = a.id ?? a.tab ?? a.index;
      const n = raw == null || raw === '' ? null : Number(String(raw).replace(/^tab\s*/i, ''));
      if (n != null && !(Number.isInteger(n) && n >= 1)) throw new Error(`Tab numbers start at 1 (got ${JSON.stringify(raw)}). The tabs:\n${listing()}`);
      const tab = n != null ? list[n - 1] : list.find((x) => x.id === s.tabId);
      if (!tab) throw new Error(`${n != null ? `There is no tab ${n}` : 'No tab is current'}; there ${list.length === 1 ? 'is 1 tab' : `are ${list.length} tabs`}:\n${listing()}`);
      const label = `tab ${list.indexOf(tab) + 1}`;
      if (act === 'close') {
        if (list.length === 1 && !s.popups.has(tab.windowId)) throw new Error('That is the last tab of the Browzie window; closing it would close the window. Navigate it elsewhere instead.');
        await chrome.tabs.remove(tab.id);
        await sleep(150);
        const left = await sessionTabs(s);
        if (s.tabId === tab.id || !left.some((x) => x.id === s.tabId)) s.tabId = s.back.get(tab.id) ?? (left[0] && left[0].id) ?? null;
        return `Closed ${label}${where(tab)}. Current tab now: ${(left.find((x) => x.id === s.tabId) || {}).title || 'none'}`;
      }
      s.tabId = tab.id;
      saveSessions();
      await chrome.tabs.update(tab.id, { active: true });
      return fullSnapshot(tabOf(s, tab.id), { viewportOnly: true });
    }
    if (!list.length) return 'No tabs yet. Use navigate.';
    return listing();
  },

  async dialog(sid, a) {
    const t = await sessionTab(sid, false);
    if (!t.dialog) return 'No dialog is open.';
    const d = t.dialog;
    await cdp(t, 'Page.handleJavaScriptDialog', { accept: a.accept !== false, promptText: a.text });
    t.dialog = null;
    await sleep(200);
    return `${a.accept !== false ? 'Accepted' : 'Dismissed'} the ${d.type} "${d.message}"\n${await fullSnapshot(t, { viewportOnly: true })}`;
  },

  async evaluate(sid, a) {
    const t = await sessionTab(sid, false);
    await attach(t);
    let contextId;
    if (a.world !== 'main') {
      const tree = await cdp(t, 'Page.getFrameTree');
      const w = await cdp(t, 'Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'browzie-eval' });
      contextId = w.executionContextId;
    }
    const src = String(a.script ?? a.expression ?? a.code ?? '').trim();
    if (!src) throw new Error('evaluate needs the JavaScript in "script", e.g. {"script": "document.title"}.');
    // Decided by what the script is, never by how it looks: as an expression first (a value that
    // is a function gets called); if it does not parse as one, as statements whose last expression
    // is the result (top-level await allowed); only if Chrome rejects a top-level `return`, as a
    // function body. A parse failure runs nothing, so no step runs the script twice.
    const run = (expression, replMode) => cdp(t, 'Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true, replMode, allowUnsafeEvalBlockedByCSP: true });
    const errText = (x) => (x.exceptionDetails ? (x.exceptionDetails.exception && x.exceptionDetails.exception.description) || x.exceptionDetails.text : '');
    let r = await run(`(async () => { const v = (\n${src}\n); return typeof v === 'function' ? await v() : await v; })()`, false);
    if (/^SyntaxError/.test(errText(r))) r = await run(src, true);
    if (/Illegal return statement/.test(errText(r))) r = await run(`(async () => { ${src} })()`, false);
    if (r.exceptionDetails) throw new Error('Script error: ' + errText(r));
    const v = r.result.value;
    const max = a.maxChars || 20000;
    const out = v === undefined ? 'undefined' : JSON.stringify(v, null, max > 20000 ? 0 : 1);
    const cut = out.length > max && /[\ud800-\udbff]/.test(out[max - 1]) ? max - 1 : max; // never half an emoji
    return 'Result: ' + out.slice(0, cut);
  },

  // Hand control to the human (bot checks, 2FA, payment approval...). Waits until the bot check is
  // gone, or the user clicks "Done" on the notification or the Browzie toolbar button.
  async handoff(sid, a) {
    const t = await sessionTab(sid, false);
    const since = now();
    const timeout = Math.min(a.timeout || 300000, 900000);
    const had = await challengesIn(t);
    const reason = a.reason || (had.length ? `${[...new Set(had.map((c) => c.kind))].join(', ')}: please solve it.` : 'Please take over for a moment.');
    await notifyHuman(t, `${reason} Click Done on this notification (or the Browzie toolbar button) when finished.`);
    lens('hide'); // the human is driving now
    let clicked = false;
    handoffDone = () => (clicked = true);
    try {
      let clearSince = 0;
      for (;;) {
        if (clicked) break;
        if (had.length) {
          const list = await challengesIn(t);
          if (!list.length) {
            clearSince = clearSince || now();
            if (now() - clearSince > 1500) break;
          } else clearSince = 0;
        }
        if (now() - since > timeout) throw new Error(`The user did not finish within ${Math.round(timeout / 1000)} s. Ask them in chat, then call handoff again.`);
        await sleep(400);
      }
    } finally {
      handoffDone = null;
      lens('banner', { text: '' });
      chrome.notifications.clear('browzie-human').catch(() => {});
    }
    t.lastRows = null;
    return `The user is done (${Math.round((now() - since) / 1000)} s).\n${await fullSnapshot(t)}`;
  },

  // Signs in with a login saved in Chrome's password manager. Browzie never types, reads or sees a
  // password: it clicks into the sign-in form so Chrome lists the logins it saved for the site, and
  // the user picks one in Chrome's own list (that pick is their approval). Only when Chrome has just
  // filled the form on such a pick does Browzie press its button; a form Chrome filled by itself on
  // page load is the user's to send. One sign-in step per call (a "username first" page, then the
  // password page). Returns when the step is gone, or when the user clicks Done.
  async signin(sid, a) {
    const t = await sessionTab(sid, false);
    const since = now();
    const timeout = Math.min(a.timeout || 300000, 900000);
    let found = null;
    let top = null;
    for (const fid of [0, ...(await childFrames(t)).map((f) => f.frameId)]) {
      const f = await agent(t, fid, 'loginForm', [], 3000).catch(() => null);
      if (fid === 0) top = f;
      if (f && !f.error && !f.none) {
        found = { f, fid };
        break;
      }
    }
    if (!found) throw new Error(top && top.signup ? 'This form asks for a new password (a sign-up or password change form). signin only uses logins Chrome has saved; hand this to the user.' : 'There is no sign-in form on this page (no password or username field). Open the sign-in page first.');
    const { fid, f: first } = found;
    const step = first.pw ? 'pw' : 'user';
    const fieldOf = (f) => (!f ? null : step === 'pw' ? f.pw : f.pw ? null : f.user);
    const filledNow = (f) => {
      const x = fieldOf(f);
      return !!x && (x.filled || testAutofill);
    };
    const prefilled = filledNow(first);
    const site = hostOf(first.url);
    const send = first.submit ? first.submit.desc.replace(/\s*\[[^\]]*\]$/, '') : 'the sign-in button';
    if (!prefilled) {
      // into the form like a person: Chrome then lists the logins it saved for this site
      const target = first.user && first.user.empty ? first.user : fieldOf(first);
      await withInput(t, async () => {
        await moveOnto(t, { ref: target.ref });
        await pressButton(t, {});
      });
    }
    const ask = prefilled
      ? `Chrome filled your saved login for ${site}. If it is the right account, click ${send} to sign in.`
      : `Sign in to ${site}: pick your saved login in Chrome's list under the ${step === 'pw' ? 'sign-in' : 'username'} field (click the field if the list is not showing). Browzie never sees the password and carries on by itself. If nothing is saved, sign in yourself.`;
    await notifyHuman(t, `${ask} Click Done here if Browzie does not notice.`);
    lens('hide');
    let clicked = false;
    handoffDone = () => (clicked = true);
    let pressed = '';
    let tried = false;
    let how = 'the user clicked Done';
    try {
      for (;;) {
        if (clicked) break;
        if (!(await chrome.tabs.get(t.tabId).catch(() => null)) || t.gone) {
          how = 'the sign-in window closed';
          break;
        }
        const f = await agent(t, fid, 'loginForm', [], 3000).catch(() => null);
        const cur = f && !f.error && !f.none ? f : null;
        if (!fieldOf(cur)) {
          how = pressed ? `Chrome filled the saved login the user picked and Browzie pressed ${pressed}` : 'the user finished it';
          break;
        }
        if (!prefilled && !tried && filledNow(cur)) {
          tried = true;
          await sleep(logn(rng, pace.gap));
          try {
            await withInput(t, async () => {
              if (cur.submit) {
                await moveOnto(t, { ref: cur.submit.ref });
                await pressButton(t, {});
              } else await keyCombo(t, 'Enter');
            });
            pressed = cur.submit ? cur.submit.desc : 'Enter';
          } catch (e) {
            if (!(e instanceof Halt)) throw e;
            await notifyHuman(t, `Chrome filled your saved login for ${site}. Click ${send} to sign in.`);
          }
          lens('hide');
        }
        if (now() - since > timeout) throw new Error(`The sign-in was not finished within ${Math.round(timeout / 1000)} s. Ask the user in chat, then call signin (or handoff) again.`);
        await sleep(400);
      }
    } finally {
      handoffDone = null;
      testAutofill = false;
      lens('banner', { text: '' });
      chrome.notifications.clear('browzie-human').catch(() => {});
    }
    const head = `Sign-in step on ${site} done after ${Math.round((now() - since) / 1000)} s: ${how}.`;
    if (!(await chrome.tabs.get(t.tabId).catch(() => null)) || t.gone) return closedReport(t, head);
    await settle(t, now() - 1500, 3000).catch(() => {});
    t.lastRows = null;
    return `${head}${await signinNote(t)}\n${await fullSnapshot(t)}`;
  },
  // tests: Chrome's password manager has just filled the sign-in field (it cannot be made to in a
  // test profile); cleared when signin ends
  async test_autofill() {
    testAutofill = true;
    return 'ok';
  },

  async status(sid) {
    const s = sessions.get(sid);
    const all = [...sessions.values()].map((x) => ({ n: x.n, window: x.windowId, tab: x.tabId, popups: [...x.popups], placed: x.placed || null, popupsPlaced: x.popupsPlaced || [] }));
    return JSON.stringify({ paused, pace: pace.name, lens: lensOk, session: s ? { window: s.windowId, tab: s.tabId } : null, sessions: sessions.size, all, version: chrome.runtime.getManifest().version });
  },

  // Uploads files through a file input or a button that opens the file chooser.
  async upload(sid, a) {
    const t = await sessionTab(sid, false);
    return withInput(t, async () => {
      const before = a.snapshot === 'none' ? null : await linesNow(t);
      const since = now();
      const ref = a.ref || (await queryRef(t, a)).ref;
      const desc = (await agent(t, frameOfRef(t, ref), 'describeRef', [ref]).catch(() => null)) || ref;
      const done = await uploadInto(t, ref, a.files ?? a.paths ?? a.path, desc);
      return report(t, `Uploaded ${done}`, since, before, '', a);
    });
  },

  async configure(sid, a) {
    if (a.pace) pace = paceOf(a.pace);
    if (a.attach !== undefined) attachAllowed = !!a.attach;
    if (['window', 'any', 'off'].includes(a.yield)) yieldMode = a.yield;
    // the session's home desktop: where its Claude Code runs (its terminal window), or a desktop by
    // number or id, or "off" (Chrome decides, as before)
    if (a.anchor !== undefined) sessionOf(sid).anchor = a.anchor;
    const s = sessions.get(sid);
    const home = s && s.anchor ? (s.anchor === 'off' ? 'off' : s.anchor.desktop ? `desktop ${s.anchor.desktop}` : `the window of ${s.anchor.exe || 'Claude Code'}`) : 'not set';
    return `pace: ${pace.name}, yield: ${yieldMode}, home desktop: ${home}`;
  },
};

// Fills one field with real input: click into it, select what is there, type.
async function fillOne(t, ref, fid, plan, value, ctx) {
  if (plan.kind === 'done') return `${plan.desc}: ${plan.value}${plan.note ? ` (${plan.note})` : ''}`;
  if (plan.kind === 'file') return uploadInto(t, ref, value, plan.desc);
  const { target } = await moveOnto(t, { ref }, { left: plan.kind === 'keys' });
  if (plan.kind === 'click') {
    await pressButton(t, {});
    await sleep(80);
    const v = await agent(t, fid, 'value', [ref]);
    return `${plan.desc}: ${v.value}`;
  }
  if (plan.kind === 'press') {
    await pressButton(t, {});
    await sleep(logn(rng, [150, 0.3, 60, 400]));
    const v0 = await agent(t, fid, 'prepareFill', [ref, value]); // the click may have moved the slider
    if (v0.kind === 'press') await keyCombo(t, v0.key, v0.count);
    const v = await agent(t, fid, 'value', [ref]);
    return `${plan.desc}: ${v.value}`;
  }
  if (plan.kind === 'select') {
    await pressButton(t, {});
    await sleep(logn(rng, [260, 0.3, 120, 600]));
    await keyCombo(t, 'Escape');
    await sleep(logn(rng, [180, 0.3, 80, 400]));
    const key = plan.delta > 0 ? 'ArrowDown' : 'ArrowUp';
    await keyCombo(t, key, Math.abs(plan.delta));
    let v = await agent(t, fid, 'value', [ref]);
    if (v.value !== plan.label) {
      await keyCombo(t, 'Enter');
      v = await agent(t, fid, 'value', [ref]);
    }
    if (v.value !== plan.label) throw new Error(`${plan.desc}: wanted ${JSON.stringify(plan.label)} but it shows ${JSON.stringify(v.value)}`);
    return `${plan.desc}: ${v.value}`;
  }
  await pressButton(t, {});
  await sleep(logn(rng, [140, 0.3, 60, 350]));
  if (plan.kind === 'keys') {
    const tries = [plan.text, ...(plan.alts || [])];
    let v;
    for (let i = 0; i < tries.length; i++) {
      if (i) {
        // wrong segment order for this browser: click back into the first segment and retype
        await sleep(logn(rng, [350, 0.3, 150, 900]));
        await moveOnto(t, { ref }, { left: true });
        await pressButton(t, {});
        await sleep(logn(rng, [140, 0.3, 60, 350]));
      }
      await typeText(t, tries[i]);
      v = await agent(t, fid, 'value', [ref]);
      if (v.value === plan.expect) return `${plan.desc}: ${v.value}`;
    }
    throw new Error(`${plan.desc}: typed ${plan.hint} but the field shows ${JSON.stringify(v && v.value)}`);
  }
  if (!plan.empty) {
    await keyCombo(t, 'Control+a');
    await sleep(logn(rng, [90, 0.3, 40, 250]));
  }
  const text = String(value);
  if (text === '' && !plan.empty) await keyCombo(t, 'Backspace');
  else await typeText(t, text, { progress: progressOf(ctx, 'filling') });
  const v = await agent(t, fid, 'value', [ref]);
  const shown = plan.masked ? '(hidden)' : JSON.stringify(v.value);
  if (!plan.masked && v.value !== text && !plan.rich) return `${target.desc}: field shows ${shown}, not exactly what was typed (maxlength or formatting?)`;
  return `${target.desc}: ${shown}`;
}

// File inputs, and buttons that open a file chooser ("Select files", "Upload"): click like a person;
// the file chooser that opens is answered with the given paths instead of showing the Windows
// dialog. The page sees a click and then files picked, as when you choose them.
const looksLikePaths = (v) => (Array.isArray(v) ? v : [v]).every((x) => typeof x === 'string' && /^([a-z]:[\\/]|\\\\|\/)/i.test(x));
async function uploadInto(t, ref, value, desc) {
  const files = (Array.isArray(value) ? value : [value]).map(String);
  if (!files.length || !looksLikePaths(files)) throw new Error(`${desc}: give the files as full paths (C:\\...\\clip.mp4)`);
  await cdp(t, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const chooser = debuggerEvent(t, 'Page.fileChooserOpened', 6000);
    chooser.catch(() => {});
    await moveOnto(t, { ref });
    await pressButton(t, {});
    let ev;
    try {
      ev = await chooser;
    } catch (e) {
      throw new Error(`Clicking ${desc} did not open a file chooser. Pick the button or drop area that does (or the file input itself).`);
    }
    if (files.length > 1 && ev.mode === 'selectSingle') throw new Error(`${desc} takes one file; got ${files.length}.`);
    await cdp(t, 'DOM.setFileInputFiles', { files, backendNodeId: ev.backendNodeId });
  } finally {
    await cdp(t, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
  return `${desc}: ${files.map((f) => f.split(/[\\/]/).pop()).join(', ')}`;
}

// Commands that use the tab without sending input still show that Claude is using it: the cursor
// rests where it last was (or at the top edge, where it will enter from) and the frame is drawn.
// Nothing is sent to the page; it is the overlay only.
const PRESENT = new Set(['navigate', 'snapshot', 'read', 'find', 'wait_for', 'screenshot', 'evaluate', 'dialog', 'tabs', 'batch']);
async function presence(sid) {
  const s = sessions.get(sid);
  if (!s || s.tabId == null) return;
  const t = T(s.tabId);
  const tab = await chrome.tabs.get(t.tabId);
  if (!tab.active) return;
  t.windowId = tab.windowId;
  const g = await geometry(t);
  if (g.visible === 'hidden') return;
  lensActive(t);
  lensFrame(t, g);
  if (!t.cursor) t.restHint = { x: g.vw / 2, y: 2 };
  lens('show', { label: 'Claude' });
  lensAt(g, t.cursor || t.restHint);
  lensIdle();
}
async function handle(sid, cmd, args, ctx) {
  const fn = COMMANDS[cmd];
  if (!fn) throw new Error(`Unknown command ${cmd}`);
  await restored;
  if (PRESENT.has(cmd)) presence(sid).catch(() => {});
  try {
    const r = await fn(sid, args, ctx);
    const s = sessions.get(sid);
    if (s && s.tabId != null) noteNames(s.tabId, typeof r === 'string' ? r : r && r.text);
    return r;
  } finally {
    if (PRESENT.has(cmd)) presence(sid).catch(() => {});
  }
}
// The name each ref had when Claude last saw it (snapshot, diff, find). Lists that re-render reuse
// their elements with new text (a filtered picker can put
// a different title under the same ref), so an input aimed at a ref first checks that the
// element still says what it said.
const seenNames = new Map(); // tabId + ':' + ref -> name
const NAMED = /^(?:[+ ] )?\s*[\w-]+ "((?:[^"\\]|\\.)*)" \[((?:f\d+)?e\d+)\]/;
function noteNames(tabId, text) {
  if (!text) return;
  for (const line of String(text).split('\n')) {
    const m = NAMED.exec(line);
    if (!m) continue;
    const key = tabId + ':' + m[2];
    seenNames.delete(key);
    seenNames.set(key, m[1]);
  }
  while (seenNames.size > 6000) seenNames.delete(seenNames.keys().next().value);
}
async function checkRefName(t, ref) {
  const was = seenNames.get(t.tabId + ':' + ref);
  if (was == null) return;
  const d = await agent(t, frameOfRef(t, ref), 'describeRef', [ref]).catch(() => null);
  const m = typeof d === 'string' ? NAMED.exec(d) : null;
  if (!m) return; // gone or unnamed: locate reports that
  const norm = (s) => s.replace(/…$/, '').trim().toLowerCase();
  const a = norm(was);
  const b = norm(m[1]);
  if (a.startsWith(b) || b.startsWith(a)) return;
  throw new Error(`${ref} now reads "${m[1]}", not "${was}" as when you saw it (the list or page re-rendered), so Browzie did not touch it. Target it by text, or take a new snapshot and use the new ref (force: true skips this check).`);
}
