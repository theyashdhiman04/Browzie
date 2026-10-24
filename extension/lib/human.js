// Browzie human input model.
// Pure functions with no browser APIs, so the extension service worker and the Node tests run the
// same code. Every plan is a list of timed events; the executor only replays it. Times are in ms
// from the start of the plan, positions in CSS pixels of the top-level viewport.
//
// The numbers come from the motor-control literature (Fitts' law pointing times, minimum-jerk
// trajectories with a primary movement plus a corrective sub-movement, log-normal keystroke
// timing) and were checked against a real mouse trace recorded on this machine: about one event
// per 6 to 19 ms, curved paths, non-zero movementX/Y, button held for tens of milliseconds.

// ------------------------------------------------------------------ randomness
// mulberry32: small, fast, seedable (tests replay exact plans).
export function makeRng(seed) {
  let a = (seed === undefined ? (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) : seed) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Log-normal sample from [median, sigma, min, max].
export function logn(r, spec) {
  const [median, sigma, lo, hi] = spec;
  return clamp(median * Math.exp(sigma * gauss(r)), lo, hi);
}

// ------------------------------------------------------------------ pace profiles
const HUMAN = {
  name: 'human',
  fitts: [110, 125], // movement time = a + b * log2(1 + D / W), ms
  moveSigma: 0.16, // trial-to-trial variation of movement time
  moveMin: 140,
  moveMax: 1700,
  dwell: [95, 0.4, 35, 420], // pointer resting on the target before the button goes down
  hold: [88, 0.25, 48, 190], // button down -> up
  dblGap: [115, 0.2, 70, 190], // first click up -> second click down
  firstKey: [180, 0.4, 60, 600], // field focused -> first keystroke
  key: [165, 0.38, 60, 700], // keydown -> next keydown
  keyHold: [86, 0.24, 42, 170], // keydown -> keyup
  shiftLead: [70, 0.3, 28, 160], // Shift down before the shifted key
  wordPause: [0.16, 220, 0.5], // chance after a space, median, sigma
  thinkPause: [0.02, 700, 0.4], // rare longer pause anywhere
  sentencePause: [330, 0.45, 100, 1800], // extra before the first letter of a new sentence
  linePause: [450, 0.5, 150, 2600], // extra after a line break: reading back, thinking of the next line
  pick: [450, 0.5, 150, 2000], // a character with no key (emoji): picked from a panel
  drift: [0.985, 0.03, 0.35], // the rhythm wanders over a long text: AR(1) coefficient, step, bound (log scale)
  typoRate: 0.012, // with typos on: chance that a letter inside a word hits a neighbouring key
  notice: [300, 0.4, 130, 900], // the slip -> the first Backspace
  backspace: [115, 0.3, 60, 260], // Backspace -> Backspace
  afterFix: [140, 0.4, 50, 450], // the last Backspace -> typing on
  notch: 100, // CSS px per wheel notch (Chrome on Windows at default settings)
  burst: [2, 6], // notches per flick of the wheel
  notchGap: [42, 0.3, 16, 110],
  burstGap: [300, 0.4, 120, 900],
  gap: [420, 0.45, 160, 1800], // minimum time between two input actions
  afterNav: [900, 0.35, 350, 2600], // looking at a freshly loaded page before acting on it
  perMinute: 40, // input actions per origin per minute, hard cap
  navPerMinute: 14, // navigations per origin per minute, hard cap
};

// "brisk" is a fast, practised user. Still inside human ranges: nothing teleports, every
// key is a real down/up pair, and the hard caps stay.
const BRISK = {
  ...HUMAN,
  name: 'brisk',
  fitts: [80, 95],
  moveMin: 110,
  dwell: [60, 0.4, 25, 260],
  hold: [72, 0.22, 42, 150],
  firstKey: [110, 0.4, 45, 400],
  key: [105, 0.35, 45, 420],
  keyHold: [72, 0.22, 38, 140],
  wordPause: [0.08, 160, 0.5],
  thinkPause: [0.008, 500, 0.4],
  sentencePause: [220, 0.45, 80, 1200],
  linePause: [300, 0.5, 100, 1800],
  pick: [320, 0.5, 120, 1400],
  typoRate: 0.008,
  notice: [230, 0.4, 100, 700],
  backspace: [95, 0.3, 50, 220],
  afterFix: [100, 0.4, 40, 350],
  burstGap: [210, 0.4, 90, 600],
  gap: [260, 0.45, 110, 1200],
  afterNav: [600, 0.35, 250, 1800],
  perMinute: 60,
  navPerMinute: 20,
};

// "fast" (the default since 2026-10-21, the user's call): as quick as real input can be. The pointer
// still travels a short curved path and every click and key is a real down/up pair, but movements
// take tens of milliseconds, the waits between actions are short, and a text longer than chunkOver
// characters is committed a few words at a time (Input.insertText, as an IME or dictation commits
// text) instead of key by key. Line breaks are still the Enter key. settle: how long an action
// waits for the page to calm down before it reports.
const FAST = {
  ...BRISK,
  name: 'fast',
  fitts: [22, 24],
  moveSigma: 0.1,
  moveMin: 45,
  moveMax: 250,
  punct: [10, 0.3, 4, 30],
  modGap: [15, 0.3, 6, 40],
  modUp: [10, 0.3, 4, 30],
  dwell: [18, 0.3, 8, 60],
  hold: [32, 0.2, 18, 60],
  dblGap: [70, 0.2, 45, 110],
  firstKey: [25, 0.3, 10, 80],
  key: [14, 0.25, 6, 40],
  keyHold: [16, 0.2, 8, 35],
  shiftLead: [14, 0.3, 6, 40],
  wordPause: [0, 0, 0.5],
  thinkPause: [0, 0, 0.4],
  sentencePause: [12, 0.3, 4, 40],
  linePause: [20, 0.3, 8, 60],
  pick: [20, 0.3, 8, 60],
  drift: [0.9, 0.01, 0.05],
  notice: [60, 0.3, 30, 150],
  backspace: [20, 0.3, 10, 50],
  afterFix: [25, 0.3, 10, 70],
  notchGap: [12, 0.3, 6, 30],
  burst: [4, 10],
  burstGap: [40, 0.3, 20, 100],
  gap: [35, 0.3, 12, 100],
  afterNav: [120, 0.3, 50, 300],
  perMinute: 400,
  navPerMinute: 60,
  chunkOver: 40, // longer texts go in as word chunks
  chunk: 32, // about this many characters per chunk, cut at a space
  settle: { first: 40, quiet: 80, soft: 700, busy: 400, poll: 40, navQuiet: 120, wheelLand: 70, focus: [20, 0.3, 8, 50] },
};

export const PACES = { human: HUMAN, brisk: BRISK, fast: FAST };
export const paceOf = (name) => PACES[name] || FAST;

// ------------------------------------------------------------------ pointer movement
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

// Movement time from Fitts' law with log-normal trial noise.
export function movementTime(D, W, P, r) {
  const id = Math.log2(1 + D / Math.max(4, W));
  const t = (P.fitts[0] + P.fitts[1] * id) * Math.exp(P.moveSigma * gauss(r));
  return clamp(t, D < 8 ? 60 : P.moveMin, P.moveMax);
}

// Sideways bow of a path: people move in slight arcs, not ruler-straight lines.
function bowFor(D, r) {
  return clamp(gauss(r) * 0.055 * D, -0.14 * D, 0.14 * D);
}

// One sub-movement from a to b, sampled at irregular, frame-like intervals.
function sampleSegment(a, b, T, bow, t0, r, out) {
  const L = dist(a, b);
  if (L < 0.01) return t0;
  const ux = (b.x - a.x) / L;
  const uy = (b.y - a.y) / L;
  // gamma < 1 warps time so velocity peaks before the midpoint and decelerates over a longer
  // tail, the asymmetric bell measured for aimed movements
  const gamma = 0.86 + 0.08 * r();
  // physiological tremor, 8 to 12 Hz, a fraction of a pixel to about half a pixel, zero at both ends
  const tremA = Math.min(0.55, 0.12 + L / 1600);
  const tremF = 8 + 4 * r();
  const tremP = r() * 2 * Math.PI;
  let t = 0;
  for (;;) {
    t += 7 + 10 * r();
    const done = t >= T;
    const u = done ? 1 : t / T;
    const w = Math.pow(u, gamma);
    const s = w * w * w * (10 - 15 * w + 6 * w * w); // minimum-jerk position profile
    const env = Math.sin(Math.PI * s);
    const lat = bow * env + (done ? 0 : tremA * Math.sin((2 * Math.PI * tremF * t) / 1000 + tremP) * env);
    out.push({ x: a.x + ux * L * s - uy * lat, y: a.y + uy * L * s + ux * lat, t: t0 + Math.min(t, T) });
    if (done) return t0 + T;
  }
}

// Path from `from` to `to`. width = size of the target along the movement (Fitts' W).
// Returns [{x, y, t}], ending exactly on `to`. The first point is the first move event; the
// pointer is assumed to already be at `from`.
export function planMove(from, to, o = {}) {
  const r = o.rng || makeRng();
  const P = o.pace || HUMAN;
  const D = dist(from, to);
  if (D < 0.5) return [];
  const T = movementTime(D, o.width || 24, P, r);
  const out = [];
  if (D > 90 && r() < 0.7) {
    // ballistic primary movement that lands near the target, usually a little short,
    // then a slower corrective sub-movement onto it
    const ux = (to.x - from.x) / D;
    const uy = (to.y - from.y) / D;
    const along = D * (-0.035 + 0.03 * gauss(r));
    const across = D * 0.018 * gauss(r);
    const mid = { x: to.x + ux * along - uy * across, y: to.y + uy * along + ux * across };
    const T1 = T * (0.76 + 0.08 * r());
    let t = sampleSegment(from, mid, T1, bowFor(D, r), 0, r, out);
    t += 8 + 45 * r();
    sampleSegment(mid, to, Math.max(70, T - T1 + 40 * r()), bowFor(dist(mid, to), r) * 0.5, t, r, out);
  } else {
    sampleSegment(from, to, T, bowFor(D, r), 0, r, out);
  }
  out[out.length - 1] = { x: to.x, y: to.y, t: out[out.length - 1].t };
  return out;
}

// Where inside a target box a person clicks: near the middle, never exactly the centre twice,
// never in the outer fifth of the box.
export function aimPoint(box, r) {
  const ix = Math.min(box.width * 0.2, Math.max(1, box.width / 2 - 1));
  const iy = Math.min(box.height * 0.2, Math.max(1, box.height / 2 - 1));
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const x = clamp(cx + gauss(r) * box.width * 0.13, box.left + ix, box.left + box.width - ix);
  const y = clamp(cy + gauss(r) * box.height * 0.15, box.top + iy, box.top + box.height - iy);
  return { x, y };
}

// Button timings for a click (or double click).
export function planClick(o = {}) {
  const r = o.rng || makeRng();
  const P = o.pace || HUMAN;
  const clicks = [];
  let t = logn(r, P.dwell);
  for (let i = 0; i < (o.count || 1); i++) {
    if (i) t += logn(r, P.dblGap);
    const hold = logn(r, P.hold);
    clicks.push({ down: t, up: t + hold, clickCount: i + 1 });
    t += hold;
  }
  return clicks;
}

// ------------------------------------------------------------------ typing
// Neighbouring keys on a US keyboard (rows are staggered: a key sits below the gap between two keys
// of the row above), for the occasional slip of a finger.
const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const NEAR = new Map();
ROWS.forEach((row, ri) => {
  const up = ROWS[ri - 1] || '';
  const down = ROWS[ri + 1] || '';
  for (let i = 0; i < row.length; i++) NEAR.set(row[i], [row[i - 1], row[i + 1], up[i], up[i + 1], down[i - 1], down[i]].filter(Boolean));
});
const isLetter = (c) => !!c && /\p{L}/u.test(c);

// The strokes a person makes for `chars`. With a typo rate, a letter inside a word now and then
// hits a neighbouring key; the slip is noticed after zero to two more letters and taken back with
// Backspace. Each stroke records n, the characters of the text correctly in the field after it, and
// x, the wrong characters after those (so a stopped job knows exactly what the field holds).
function strokes(chars, r, rate) {
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const near = NEAR.get(ch.toLowerCase());
    if (rate > 0 && near && isLetter(chars[i - 1]) && isLetter(chars[i + 1]) && r() < rate) {
      let wrong = near[Math.floor(r() * near.length)];
      if (ch !== ch.toLowerCase()) wrong = wrong.toUpperCase();
      out.push({ ch: wrong, n: i, x: 1 });
      const more = r() < 0.5 ? 0 : r() < 0.75 ? 1 : 2;
      let k = 0;
      while (k < more && isLetter(chars[i + 1 + k])) {
        out.push({ ch: chars[i + 1 + k], n: i, x: 2 + k });
        k++;
      }
      for (let b = k + 1; b > 0; b--) out.push({ bs: true, n: i, x: b - 1, first: b === k + 1 });
    }
    out.push({ ch, n: i + 1, x: 0 });
  }
  return out;
}

// keyOf(ch) -> { shift: bool, code } for keys on the keyboard, or null for characters committed as
// text (IME-style). Returns [{t, type: 'down'|'up'|'insert', ch|key|text, n, x}] sorted by time
// (n, x: see strokes(), on the event that changes the field). Keys roll over like real typing: the
// next key often goes down before the previous one is up. o.typos: true (or a rate) lets fingers slip.
export function planTyping(text, o = {}) {
  const r = o.rng || makeRng();
  const P = o.pace || HUMAN;
  const keyOf = o.keyOf || ((ch) => ({ shift: /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch), code: ch.toLowerCase() }));
  const upAt = new Map(); // physical key -> when it was last released
  const ev = [];
  const chars = [...String(text)];
  if (P.chunk && chars.length > P.chunkOver && !o.typos) return planChunks(chars, P, r, keyOf);
  const list = strokes(chars, r, o.typos ? (typeof o.typos === 'number' ? o.typos : P.typoRate) : 0);
  const [keep, step, bound] = P.drift || HUMAN.drift;
  let drift = 0;
  let t = 0;
  let shiftDown = false;
  let lastShiftedDown = 0;
  let lastUp = 0;
  let prev; // the character struck before this one (none right after a Backspace)
  let before; // and the one before that
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const ch = s.ch;
    drift = clamp(keep * drift + step * gauss(r), -bound, bound);
    let gap;
    if (s.bs) gap = logn(r, s.first ? P.notice : P.backspace);
    else {
      gap = i === 0 ? logn(r, P.firstKey) : logn(r, P.key) * Math.exp(drift);
      if (list[i - 1] && list[i - 1].bs) gap += logn(r, P.afterFix);
      if (prev === ' ' && r() < P.wordPause[0]) gap += logn(r, [P.wordPause[1], P.wordPause[2], 60, 1200]);
      if (prev && /[.,;:!?]/.test(prev)) gap += logn(r, P.punct || [140, 0.4, 40, 600]);
      if (prev === ' ' && before && /[.!?]/.test(before)) gap += logn(r, P.sentencePause);
      if (prev === '\n') gap += logn(r, P.linePause);
      if (r() < P.thinkPause[0]) gap += logn(r, [P.thinkPause[1], P.thinkPause[2], 250, 2500]);
      if (prev === ch) gap *= 0.8;
    }
    t += gap;
    const info = s.bs ? { shift: false, code: 'Backspace' } : keyOf(ch);
    if (!info) {
      // no key for it: picked from the emoji panel (a run of them goes quicker)
      if (prev === undefined || keyOf(prev)) t += logn(r, P.pick);
      if (shiftDown) {
        ev.push({ t: Math.max(lastShiftedDown + 15, t - 30), type: 'up', key: 'Shift' });
        shiftDown = false;
      }
      ev.push({ t, type: 'insert', text: ch, n: s.n, x: s.x });
      lastUp = t;
      before = prev;
      prev = ch;
      continue;
    }
    if (info.shift && !shiftDown) {
      const lead = logn(r, P.shiftLead);
      ev.push({ t: Math.max(lastUp > 0 ? lastUp - 20 : 0, t - lead, 0), type: 'down', key: 'Shift' });
      shiftDown = true;
    } else if (!info.shift && shiftDown) {
      ev.push({ t: Math.max(lastShiftedDown + 15, t - logn(r, [45, 0.4, 12, 120])), type: 'up', key: 'Shift' });
      shiftDown = false;
    }
    // one finger, one key: the same key ("ll", or 1 then !) cannot go down again before it is up
    const code = info.code || ch.toLowerCase();
    if (upAt.has(code) && t < upAt.get(code) + 12) t = upAt.get(code) + 12 + logn(r, [25, 0.4, 5, 80]);
    const hold = logn(r, P.keyHold);
    upAt.set(code, t + hold);
    if (s.bs) {
      ev.push({ t, type: 'down', key: 'Backspace', n: s.n, x: s.x });
      ev.push({ t: t + hold, type: 'up', key: 'Backspace' });
    } else {
      ev.push({ t, type: 'down', ch, n: s.n, x: s.x });
      ev.push({ t: t + hold, type: 'up', ch });
    }
    if (info.shift) lastShiftedDown = t;
    lastUp = Math.max(lastUp, t + hold);
    before = s.bs ? undefined : prev;
    prev = s.bs ? undefined : ch;
  }
  if (shiftDown) ev.push({ t: lastUp + logn(r, [30, 0.4, 8, 90]), type: 'up', key: 'Shift' });
  // stable sort by time; a key's up never precedes its own down
  return ev.map((e, i) => ({ ...e, i })).sort((a, b) => a.t - b.t || a.i - b.i).map(({ i, ...e }) => e);
}

// Fast pace, long text: word chunks of about P.chunk characters committed as text (cut after a
// space), line breaks as real Enter key presses. Same event shape as planTyping.
function planChunks(chars, P, r, keyOf) {
  const ev = [];
  let t = logn(r, P.firstKey);
  let run = '';
  let start = 0;
  const flush = (end) => {
    if (!run) return;
    ev.push({ t, type: 'insert', text: run, n: end, x: 0 });
    t += logn(r, P.key);
    run = '';
    start = end;
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\n' && keyOf(ch)) {
      flush(i);
      const hold = logn(r, P.keyHold);
      ev.push({ t, type: 'down', ch, n: i + 1, x: 0 });
      ev.push({ t: t + hold, type: 'up', ch });
      t += hold + logn(r, P.linePause);
      start = i + 1;
      continue;
    }
    run += ch;
    if (i + 1 - start >= P.chunk && ch === ' ') flush(i + 1);
  }
  flush(chars.length);
  return ev;
}

// Timings for a key combination such as Control+A: modifiers down in order, key tap,
// modifiers up in reverse, each with a human-sized gap.
export function planCombo(mods, o = {}) {
  const r = o.rng || makeRng();
  const P = o.pace || HUMAN;
  const ev = [];
  let t = 0;
  for (const m of mods) {
    ev.push({ t, type: 'down', key: m });
    t += logn(r, P.modGap || [65, 0.3, 25, 150]);
  }
  for (let i = 0; i < (o.repeat || 1); i++) {
    if (i) t += logn(r, P.key);
    ev.push({ t, type: 'down', key: '*' });
    t += logn(r, P.keyHold);
    ev.push({ t, type: 'up', key: '*' });
  }
  for (const m of [...mods].reverse()) {
    t += logn(r, P.modUp || [40, 0.35, 12, 110]);
    ev.push({ t, type: 'up', key: m });
  }
  return ev;
}

// ------------------------------------------------------------------ wheel
// Wheel notches to scroll by `delta` CSS px along one axis: flicks of a few notches with short
// gaps, longer pauses between flicks. Returns [{t, delta}] (delta per notch, signed).
export function planWheel(delta, o = {}) {
  const r = o.rng || makeRng();
  const P = o.pace || HUMAN;
  const notch = o.notch || P.notch;
  const n = Math.max(1, Math.round(Math.abs(delta) / notch));
  const sign = delta < 0 ? -1 : 1;
  const out = [];
  let t = 0;
  let left = n;
  while (left > 0) {
    const k = Math.min(left, P.burst[0] + Math.floor(r() * (P.burst[1] - P.burst[0] + 1)));
    for (let i = 0; i < k; i++) {
      out.push({ t, delta: sign * notch });
      t += logn(r, P.notchGap);
    }
    left -= k;
    if (left > 0) t += logn(r, P.burstGap);
  }
  return out;
}

// ------------------------------------------------------------------ pixel grid
// A real mouse can only stand on physical pixels. With a display scale S (devicePixelRatio /
// page zoom) and the viewport origin `o` in screen DIPs, the screen position o + c*Z must be a
// multiple of 1/S. snap() moves a CSS viewport coordinate onto that grid.
export function snapper({ ox = 0, oy = 0, scale = 1, zoom = 1 } = {}) {
  const S = scale > 0 ? scale : 1;
  const Z = zoom > 0 ? zoom : 1;
  const one = (o, c) => (Math.round((o + c * Z) * S) / S - o) / Z;
  return (p) => ({ x: one(ox, p.x), y: one(oy, p.y) });
}
