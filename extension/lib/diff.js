// Line diff (Myers O(ND)) used to report only what changed on the page after an action.
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, off, d);
    }
  }
  return null;
}

function backtrack(trace, a, b, off, dEnd) {
  let x = a.length;
  let y = b.length;
  const ops = [];
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(['=', x - 1, y - 1]);
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push(['+', -1, y - 1]);
      y--;
    } else {
      ops.push(['-', x - 1, -1]);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push(['=', x - 1, y - 1]);
    x--;
    y--;
  }
  return ops.reverse();
}

const indentOf = (line) => line.length - line.trimStart().length;

function shorten(line) {
  let s = line.trim().replace(/ \[(f\d+)?e\d+\].*$/, '');
  if (s.length > 60) s = s.slice(0, 59) + '…';
  return s;
}

// Ancestor path of a line: the nearest less-indented lines above it.
function pathOf(lines, idx) {
  const out = [];
  let want = idx < lines.length ? indentOf(lines[idx]) : 0;
  for (let i = Math.min(idx, lines.length) - 1; i >= 0 && want > 0 && out.length < 3; i--) {
    const ind = indentOf(lines[i]);
    if (ind < want) {
      out.unshift(shorten(lines[i]));
      want = ind;
    }
  }
  return out.join(' > ');
}

// Returns { text, added, removed } or null when the change is too large to be worth diffing.
function diffLines(oldLines, newLines, { context = 1, maxD = 400 } = {}) {
  let s = 0;
  while (s < oldLines.length && s < newLines.length && oldLines[s] === newLines[s]) s++;
  let ea = oldLines.length;
  let eb = newLines.length;
  while (ea > s && eb > s && oldLines[ea - 1] === newLines[eb - 1]) {
    ea--;
    eb--;
  }
  if (ea === s && eb === s) return { text: '', added: 0, removed: 0 };
  const A = oldLines.slice(s, ea);
  const B = newLines.slice(s, eb);
  const mid = myers(A, B, maxD);
  if (!mid) return null;
  // Full op list in absolute indices.
  const ops = [];
  for (let i = 0; i < s; i++) ops.push(['=', i, i]);
  for (const [op, ai, bi] of mid) ops.push([op, ai < 0 ? -1 : ai + s, bi < 0 ? -1 : bi + s]);
  for (let i = 0; i < oldLines.length - ea; i++) ops.push(['=', ea + i, eb + i]);

  const changed = ops.map((o) => o[0] !== '=');
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(ops.length - 1, i + context); j++) keep[j] = true;
  }
  const out = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    // start of a hunk: name where its first changed line lives
    let where = '';
    for (let j = i; j < ops.length && keep[j]; j++) {
      if (ops[j][0] === '+') {
        where = pathOf(newLines, ops[j][2]);
        break;
      }
      if (ops[j][0] === '-') {
        where = pathOf(oldLines, ops[j][1]);
        break;
      }
    }
    out.push('@@' + (where ? ' in ' + where : ''));
    while (i < ops.length && keep[i]) {
      const [op, ai, bi] = ops[i];
      if (op === '=') out.push('  ' + newLines[bi]);
      else if (op === '+') {
        out.push('+ ' + newLines[bi]);
        added++;
      } else {
        out.push('- ' + oldLines[ai]);
        removed++;
      }
      i++;
    }
  }
  return { text: out.join('\n'), added, removed };
}

// Keeps a diff short enough to be worth reading: a run of removed lines shows its first 3, a run of
// added lines its first `added` (a 90-option list that opened is mostly noise), and the whole text
// stops at `max` characters. Says what it left out.
function compactDiff(text, { max = 2500, removed = 3, added = 30 } = {}) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const sign = lines[i].slice(0, 2);
    if (sign !== '- ' && sign !== '+ ') {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].slice(0, 2) === sign) j++;
    const keep = sign === '- ' ? removed : added;
    out.push(...lines.slice(i, i + keep));
    if (j - i > keep) out.push(`${sign}... ${j - i - keep} more ${sign === '- ' ? 'removed' : 'added'} lines (snapshot or find shows them)`);
    i = j;
  }
  let s = out.join('\n');
  if (s.length > max) {
    const cut = s.lastIndexOf('\n', max);
    const left = s.slice(cut > 0 ? cut : max).split('\n').length - 1;
    s = s.slice(0, cut > 0 ? cut : max) + `\n... diff cut here, ${left} more lines (snapshot shows the page)`;
  }
  return s;
}

export { diffLines, myers, compactDiff };
