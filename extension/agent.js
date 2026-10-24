/* Browzie page agent (content script, ISOLATED world).
   Injected on demand into each frame of a tab Browzie drives, never into other tabs. Page scripts
   can neither see nor tamper with it, and it leaves nothing for them to find: no DOM nodes, no
   attributes, no page-world globals, no synthetic events. It only reads: element refs (kept in
   this world's memory), compact snapshots, hit-testing, geometry for the virtual cursor and
   bot-check detection. All input arrives from the service worker as real browser input. */
(() => {
  'use strict';
  const VERSION = 4;
  const G = globalThis;
  if (G.__browzie && G.__browzie.v === VERSION) return;

  // ---------------------------------------------------------------- refs
  let prefix = '';
  let counter = 0;
  const refMap = new Map(); // ref -> WeakRef<Element>
  let refOf = new WeakMap(); // Element -> ref
  const marks = new WeakMap(); // iframe Element -> marker
  let markCount = 0;

  function setup(o) {
    if (!o) return;
    if (typeof o.prefix === 'string' && o.prefix !== prefix) {
      // a new Browzie session numbered this frame differently: re-issue refs with the new prefix
      if (refMap.size) {
        refMap.clear();
        refOf = new WeakMap();
      }
      prefix = o.prefix;
    }
    if (o.start > counter) counter = o.start;
  }
  function refFor(el) {
    const old = refOf.get(el);
    if (old && refMap.has(old)) return old;
    const r = prefix + 'e' + ++counter;
    refOf.set(el, r);
    refMap.set(r, new WeakRef(el));
    return r;
  }
  function lookup(ref) {
    const w = refMap.get(ref);
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  }
  function prune() {
    for (const [r, w] of refMap) {
      const el = w.deref();
      if (!el || !el.isConnected) refMap.delete(r);
    }
  }
  const gone = (ref) => `Ref ${ref} not found: the element was removed or the page changed. Take a new snapshot.`;
  function markOf(el) {
    let m = marks.get(el);
    if (!m) marks.set(el, (m = 'm' + ++markCount));
    return m;
  }

  // ---------------------------------------------------------------- mutation clock
  const t0 = performance.now();
  let lastMut = t0;
  const ownNodes = new WeakSet();
  const observed = new WeakSet();
  let hasShadow = false;
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes' && m.attributeName === 'style') continue;
      if (m.type === 'childList' && onlyOwn(m)) continue;
      if (ownNodes.has(m.target)) continue;
      lastMut = performance.now();
      return;
    }
  });
  function onlyOwn(m) {
    if (!m.addedNodes.length && !m.removedNodes.length) return false;
    for (const n of m.addedNodes) if (!ownNodes.has(n)) return false;
    for (const n of m.removedNodes) if (!ownNodes.has(n)) return false;
    return true;
  }
  function observe(root) {
    if (observed.has(root)) return;
    observed.add(root);
    try {
      mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}
  }
  observe(document);

  // ---------------------------------------------------------------- small helpers
  // Invisible characters some sites put into labels ("Next​") are dropped, so names match what
  // is on screen. Zero-width joiners stay: emoji sequences and Indic scripts need them.
  const INVISIBLE = /[​⁠﻿­]/g;
  const clean = (s) => (s == null ? '' : String(s)).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  // Where a cut at n leaves an emoji (a surrogate pair) whole: one unit earlier if n would split it.
  const cutEnd = (s, n) => (n > 0 && n < s.length && /[\ud800-\udbff]/.test(s[n - 1]) ? n - 1 : n);
  const trunc = (s, n) => (s.length > n ? s.slice(0, cutEnd(s, n - 1)) + '…' : s);
  const q = (s) => JSON.stringify(s);
  const vp = () => {
    const v = G.visualViewport;
    return v ? { w: v.width, h: v.height } : { w: innerWidth, h: innerHeight };
  };
  function nextFrame() {
    return new Promise((res) => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          res();
        }
      };
      requestAnimationFrame(fin);
      setTimeout(fin, 50);
    });
  }
  function kidsOf(n) {
    const sr = rootOf(n);
    if (sr) return sr.childNodes;
    if (n.localName === 'slot') {
      const a = n.assignedNodes({ flatten: true });
      if (a.length) return a;
    }
    return n.childNodes;
  }
  // Rendered = has a box and no content-visibility:hidden / closed <details> ancestor.
  // display:contents has no box of its own but its children render, so it counts.
  function rendered(n) {
    if (!n.checkVisibility || n.checkVisibility()) return true;
    return getComputedStyle(n).display === 'contents';
  }
  // closed shadow roots opened through chrome.dom (see rootOf)
  const closedRoots = new WeakMap();
  // host -> true once checked for good; false if checked while still an undefined custom element
  // (it may attach a shadow root when it is defined later, so it is checked again only then)
  const checkedHosts = new WeakMap();
  let hostQueue = [];
  let hostCapped = false;
  const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'canvas', 'video', 'audio', 'iframe', 'svg', 'select', 'textarea']);
  // Closed shadow roots are hidden from page JavaScript; a content script may open them with
  // chrome.dom.openOrClosedShadowRoot, so they are read and clicked like open ones.
  const CAN_HOST = /^(article|aside|blockquote|body|div|footer|h[1-6]|header|main|nav|p|section|span)$/;
  const noRoot = new WeakSet();
  function rootOf(n) {
    if (n.shadowRoot) return n.shadowRoot;
    if (n.nodeType !== 1) return null;
    const known = closedRoots.get(n);
    if (known) return known;
    if (noRoot.has(n)) return null;
    const ln = n.localName;
    const custom = ln.includes('-');
    if (!custom && !CAN_HOST.test(ln)) return null;
    let sr = null;
    try {
      sr = (chrome.dom && chrome.dom.openOrClosedShadowRoot(n)) || null;
    } catch (e) {}
    if (sr) {
      closedRoots.set(n, sr);
      observe(sr);
      hasShadow = true;
    } else if (!custom || n.matches(':defined')) noRoot.add(n);
    return sr;
  }
  function frameIdOf(el) {
    for (const target of [el, el.contentWindow]) {
      try {
        const id = target ? chrome.runtime.getFrameId(target) : -1;
        if (id >= 0) return id;
      } catch (e) {}
    }
    return -1;
  }
  function maybeHost(el, ln, r, S) {
    if (el.shadowRoot || closedRoots.has(el) || S) return; // rootOf() opens closed roots itself
    if (S.hosts.length >= 1000) {
      S.hostsCapped = true;
      return;
    }
    const seen = checkedHosts.get(el);
    if (seen === true || (seen === false && !el.matches(':defined'))) return;
    if (ln.includes('-') || (!el.firstChild && r.width >= 16 && r.height >= 16 && !VOID_TAGS.has(ln))) S.hosts.push(el);
  }
  function registerClosed(host, root) {
    if (root) {
      closedRoots.set(host, root);
      observe(root);
      hasShadow = true;
    }
    checkedHosts.set(host, !!root || !host.localName.includes('-') || host.matches(':defined'));
    return !!root;
  }
  function takeHosts() {
    const h = hostQueue;
    hostQueue = [];
    return h;
  }
  function composedParent(n) {
    if (n.assignedSlot) return n.assignedSlot;
    if (n.parentNode) return n.parentNode.nodeType === 11 ? n.parentNode.host || null : n.parentNode;
    return n.host || null;
  }
  function containsComposed(a, b) {
    for (let n = b; n; n = composedParent(n)) if (n === a) return true;
    return false;
  }
  function deepActive() {
    let a = document.activeElement;
    while (a && rootOf(a) && rootOf(a).activeElement) a = rootOf(a).activeElement;
    return a;
  }
  function hitAt(x, y) {
    let e = document.elementFromPoint(x, y);
    while (e && rootOf(e)) {
      const inner = rootOf(e).elementFromPoint(x, y);
      if (!inner || inner === e) break;
      e = inner;
    }
    return e;
  }
  function qsa(sel) {
    let els;
    try {
      els = Array.from(document.querySelectorAll(sel));
    } catch (e) {
      return { error: `Invalid CSS selector ${q(sel)}: ${e.message}` };
    }
    if (!els.length) {
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          const sr = rootOf(el);
          if (sr) {
            hasShadow = true;
            els.push(...sr.querySelectorAll(sel));
            walk(sr);
          }
        }
      };
      walk(document);
    }
    return { els };
  }
  function docSize() {
    const de = document.documentElement;
    const b = document.body;
    return {
      w: Math.max(de ? de.scrollWidth : 0, b ? b.scrollWidth : 0),
      h: Math.max(de ? de.scrollHeight : 0, b ? b.scrollHeight : 0),
    };
  }

  // ---------------------------------------------------------------- roles & names
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'param', 'source', 'track', 'datalist']);
  const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'font', 'tt', 'strike', 'big', 'wbr', 'img', 'svg', 'slot']);
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'file']);
  const CONTAINER = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'form', 'search', 'dialog', 'alertdialog', 'list', 'menu', 'menubar', 'tablist', 'tabpanel', 'table', 'grid', 'treegrid', 'tree', 'toolbar', 'group', 'radiogroup', 'alert', 'article', 'listbox']);
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'draggable', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'checkbox', 'radio', 'switch', 'clickable', 'cell', 'gridcell', 'columnheader', 'rowheader', 'tooltip']);
  const CHECKABLE = new Set(['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio']);
  const NESTED_INTERACTIVE = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[contenteditable="true"]';
  const SET_VALUE_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

  function insideSectioning(el) {
    const p = el.parentElement;
    return !!(p && p.closest('article,aside,main,nav,section'));
  }
  function implicitRole(el, ln) {
    switch (ln) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : '';
      case 'button':
        return 'button';
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        switch (t) {
          case 'hidden':
            return 'hidden';
          case 'button':
          case 'submit':
          case 'reset':
          case 'image':
            return 'button';
          case 'checkbox':
            return 'checkbox';
          case 'radio':
            return 'radio';
          case 'range':
            return 'slider';
          case 'number':
            return 'spinbutton';
          case 'file':
            return 'file';
          case 'search':
            return el.hasAttribute('list') ? 'combobox' : 'searchbox';
          default:
            return el.hasAttribute('list') ? 'combobox' : 'textbox';
        }
      }
      case 'select':
        return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea':
        return 'textbox';
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading';
      case 'img':
        return el.getAttribute('alt') === '' ? '' : 'img';
      case 'nav':
        return 'navigation';
      case 'main':
        return 'main';
      case 'aside':
        return 'complementary';
      case 'header':
        return insideSectioning(el) ? '' : 'banner';
      case 'footer':
        return insideSectioning(el) ? '' : 'contentinfo';
      case 'form':
        return 'form';
      case 'search':
        return 'search';
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : '';
      case 'article':
        return 'article';
      case 'dialog':
        return 'dialog';
      case 'ul':
      case 'ol':
      case 'menu':
        return 'list';
      case 'li':
        return 'listitem';
      case 'table':
        return 'table';
      case 'tr':
        return 'row';
      case 'td':
        return 'cell';
      case 'th':
        return 'columnheader';
      case 'fieldset':
        return 'group';
      case 'summary':
        return 'button';
      case 'option':
        return 'option';
      case 'progress':
        return 'progressbar';
      case 'meter':
        return 'meter';
      case 'iframe':
      case 'frame':
        return 'iframe';
      default:
        return '';
    }
  }
  function roleOf(el, ln) {
    const r = el.getAttribute('role');
    if (r) {
      const first = r.trim().split(/\s+/)[0].toLowerCase();
      if (first === 'presentation' || first === 'none' || first === 'generic') {
        if (ln === 'input' || ln === 'select' || ln === 'textarea' || ln === 'button' || (ln === 'a' && el.hasAttribute('href'))) return implicitRole(el, ln);
        return '';
      }
      if (first) return first;
    }
    return implicitRole(el, ln);
  }
  function textOf(root, max, skip) {
    let out = '';
    const visit = (n) => {
      if (out.length > max) return;
      if (n.nodeType === 3) {
        out += n.data;
        return;
      }
      if (n.nodeType !== 1 || n === skip) return;
      const ln = n.localName;
      if (SKIP.has(ln)) return;
      if (n !== root) {
        if (n.getAttribute('aria-hidden') === 'true') return;
        if (!rendered(n)) return;
        const al = n.getAttribute('aria-label');
        if (al && al.trim()) {
          out += ' ' + al + ' ';
          return;
        }
      }
      if (ln === 'img' || ln === 'area') {
        out += ' ' + (n.getAttribute('alt') || '') + ' ';
        return;
      }
      if (ln === 'svg') {
        const t = n.querySelector('title');
        if (t) out += ' ' + t.textContent + ' ';
        return;
      }
      if (ln === 'input') {
        const t = (n.type || '').toLowerCase();
        if (t === 'button' || t === 'submit' || t === 'reset') out += ' ' + n.value + ' ';
        return;
      }
      if (ln === 'select' || ln === 'textarea' || ln === 'iframe' || ln === 'video' || ln === 'audio' || ln === 'canvas' || ln === 'object') return;
      if (ln === 'br') {
        out += ' ';
        return;
      }
      const block = !INLINE_TAGS.has(ln);
      if (block) out += ' ';
      for (const c of kidsOf(n)) visit(c);
      if (block) out += ' ';
    };
    visit(root);
    return trunc(clean(out), max);
  }
  function ariaName(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const root = el.getRootNode();
      let s = '';
      for (const id of ids.split(/\s+/)) {
        if (!id) continue;
        const t = root.getElementById ? root.getElementById(id) : document.getElementById(id);
        if (t) s += ' ' + (t === el ? clean(el.getAttribute('aria-label')) : textOf(t, 150));
      }
      s = clean(s);
      if (s) return s;
    }
    const al = el.getAttribute('aria-label');
    return al ? clean(al) : '';
  }
  // Returns {name, fromPh, long}. long: the name would come from a large block of content.
  function nameOf(el, ln, role) {
    const a = ariaName(el);
    if (a) return { name: a };
    if (ln === 'input' || ln === 'textarea' || ln === 'select') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      if (ln === 'input' && (t === 'button' || t === 'submit' || t === 'reset')) return { name: clean(el.value) || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : '') };
      if (ln === 'input' && t === 'image') return { name: clean(el.getAttribute('alt') || el.value || 'Submit') };
      const labels = el.labels;
      if (labels && labels.length) {
        let s = '';
        for (const l of labels) s += ' ' + textOf(l, 120, el);
        s = clean(s);
        if (s) return { name: s };
      }
      const ti = clean(el.getAttribute('title'));
      if (ti) return { name: ti };
      const ph = clean(el.getAttribute('placeholder') || el.getAttribute('aria-placeholder'));
      if (ph) return { name: ph, fromPh: true };
      return { name: '' };
    }
    if (ln === 'img' || ln === 'area') return { name: clean(el.getAttribute('alt') || el.getAttribute('title')) };
    if (ln === 'svg') {
      const t = el.querySelector('title');
      return { name: clean(t ? t.textContent : '') };
    }
    if (ln === 'fieldset') {
      const lg = el.querySelector('legend');
      return { name: lg ? textOf(lg, 100) : '' };
    }
    if (ln === 'table') return { name: el.caption ? textOf(el.caption, 100) : '' };
    if (ln === 'iframe' || ln === 'frame') {
      let host = '';
      try {
        host = el.src ? new URL(el.src, location.href).host : '';
      } catch (e) {}
      return { name: clean(el.getAttribute('title') || el.getAttribute('name')) || host };
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const t = textOf(el, 400);
      if (t.length > 140) return { name: clean(el.getAttribute('title')), long: true };
      return { name: t || clean(el.getAttribute('title')) };
    }
    if (role === 'dialog' || role === 'alertdialog') {
      const h = el.querySelector('h1,h2,h3,h4,h5,h6,[role=heading]');
      return { name: h ? textOf(h, 100) : '' };
    }
    return { name: clean(el.getAttribute('title')) };
  }
  function hrefOf(el) {
    const h = el.getAttribute('href');
    if (!h || /^\s*javascript:/i.test(h)) return '';
    if (h === '#') return '';
    try {
      const u = new URL(h, document.baseURI);
      if (u.origin === location.origin && location.origin !== 'null') return trunc(u.pathname + u.search + u.hash, 90);
      return trunc(u.href, 110);
    } catch (e) {
      return trunc(h, 90);
    }
  }
  function checkState(el, ln, role) {
    if (ln === 'input') return el.indeterminate ? 'mixed' : el.checked ? 'checked' : 'unchecked';
    const ac = el.getAttribute('aria-checked');
    if (ac === 'true') return 'checked';
    if (ac === 'mixed') return 'mixed';
    if (CHECKABLE.has(role)) return 'unchecked';
    return '';
  }
  function attrsOf(el, ln, role, nm, focus) {
    const a = [];
    const type = ln === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    if (ln === 'input' || ln === 'textarea') {
      if (CHECKABLE.has(role)) a.push(checkState(el, ln, role));
      else if (type === 'file') {
        const n = el.files ? el.files.length : 0;
        a.push(n ? `files=${q(Array.from(el.files).map((f) => f.name).join(', '))}` : 'no file');
        if (el.multiple) a.push('multiple');
        if (el.accept) a.push('accept=' + q(el.accept));
      } else if (role !== 'button' && type !== 'range') {
        if (ln === 'input' && !TEXT_INPUT_TYPES.has(type) && type !== 'text') a.push('type=' + type);
        else if (type === 'password' || type === 'email' || type === 'number' || type === 'tel' || type === 'url') a.push('type=' + type);
        const v = el.value;
        const auto = autofilled(el);
        // a password is never shown, nor its length (Chrome hides a saved one from pages until a
        // click, but :autofill already tells that it is there)
        if (type === 'password') {
          if (v || auto) a.push('value=(hidden)');
        } else if (v) a.push('value=' + q(trunc(v, 100)));
        if (auto) a.push('filled by Chrome');
        const ph = el.getAttribute('placeholder');
        if (ph && !nm.fromPh && !v) a.push('placeholder=' + q(trunc(clean(ph), 50)));
      }
    } else if (ln === 'select') {
      const opts = Array.from(el.options);
      const sel = opts.filter((o) => o.selected).map((o) => clean(o.label || o.text));
      a.push('value=' + q(trunc(sel.join(', '), 80)));
      if (opts.length) {
        const shown = opts.slice(0, 8).map((o) => trunc(clean(o.label || o.text), 30));
        a.push('options=' + JSON.stringify(shown) + (opts.length > 8 ? `+${opts.length - 8} more` : ''));
      }
      if (el.multiple) a.push('multiple');
    } else {
      const cs = checkState(el, ln, role);
      if (cs && CHECKABLE.has(role)) a.push(cs);
    }
    if (role === 'textbox' && ln !== 'input' && ln !== 'textarea' && el.isContentEditable) {
      const v = clean(el.innerText);
      if (v) a.push('value=' + q(trunc(v, 100)));
    }
    const ae = el.getAttribute('aria-expanded');
    if (ae === 'true') a.push('expanded');
    else if (ae === 'false') a.push('collapsed');
    if (el.getAttribute('aria-selected') === 'true' || (ln === 'option' && el.selected)) a.push('selected');
    if (el.getAttribute('aria-pressed') === 'true') a.push('pressed');
    const cur = el.getAttribute('aria-current');
    if (cur && cur !== 'false') a.push('current');
    if (((ln === 'input' || ln === 'select' || ln === 'textarea' || ln === 'button') && el.matches(':disabled')) || el.getAttribute('aria-disabled') === 'true') a.push('disabled');
    if (el.required || el.getAttribute('aria-required') === 'true') a.push('required');
    if ((ln === 'input' || ln === 'textarea') && el.readOnly) a.push('readonly');
    if (el.getAttribute('aria-invalid') === 'true') a.push('invalid');
    if (role === 'slider' || role === 'spinbutton') {
      const now = el.getAttribute('aria-valuenow');
      if (now !== null && ln !== 'input') a.push('value=' + now);
      if (ln === 'input' && type === 'range') a.push(`value=${el.value} min=${el.min || 0} max=${el.max || 100}`);
    }
    if (role === 'link') {
      const h = hrefOf(el);
      if (h) a.push('→ ' + h);
    }
    if (el === focus) a.push('focused');
    return a.join(' ');
  }
  function heuristicRole(el, ln, st, c) {
    if (c.inter || ln === 'label' || ln === 'body' || ln === 'html') return '';
    if (el.hasAttribute('onclick') || el.hasAttribute('ng-click') || el.hasAttribute('v-on:click')) return 'clickable';
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '' && +ti >= 0) return 'clickable';
    if (el.getAttribute('draggable') === 'true') return 'draggable';
    if (st.cursor === 'pointer' && c.cursor !== 'pointer') return 'clickable';
    return '';
  }
  function interactiveRoleOf(el, ln, role, st, c) {
    if (ln === 'select') return role === 'listbox' ? 'listbox' : 'combobox';
    if (INTERACTIVE.has(role) && role !== 'listbox') return role;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    if (CONTAINER.has(role) || role === 'heading' || role === 'row' || role === 'hidden') return '';
    return heuristicRole(el, ln, st, c);
  }
  function rowText(el) {
    const cells = [];
    for (const ch of el.children) {
      const r = ch.getAttribute('role');
      if (ch.localName === 'td' || ch.localName === 'th' || r === 'cell' || r === 'gridcell' || r === 'columnheader' || r === 'rowheader') {
        if (!rendered(ch)) continue;
        cells.push(trunc(textOf(ch, 80), 60));
      }
    }
    if (!cells.length) return trunc(textOf(el, 300), 200);
    return trunc(cells.join(' | '), 300);
  }

  // ---------------------------------------------------------------- the walker
  function newState(o) {
    const v = vp();
    return {
      entries: [],
      depth: 0,
      max: o.maxEntries || 8000,
      full: false,
      buf: [],
      bufEl: null,
      textMax: o.textMax || 300,
      interactiveOnly: !!o.interactiveOnly,
      viewportOnly: !!o.viewportOnly,
      vw: v.w,
      vh: v.h,
      sx: scrollX,
      sy: scrollY,
      focus: deepActive(),
      refs: 0,
      done: new WeakSet(),
      hosts: [],
    };
  }
  function inView(r, S) {
    return r.bottom > 0 && r.right > 0 && r.top < S.vh && r.left < S.vw && (r.width > 0 || r.height > 0);
  }
  function push(S, e) {
    if (S.entries.length >= S.max) {
      S.full = true;
      return null;
    }
    e.depth = S.depth;
    S.entries.push(e);
    return e;
  }
  // Emits the buffered run of text. Links that sat inside the text are written inline as
  // [name](ref); a link standing alone becomes its own line again.
  function flush(S) {
    if (!S.buf.length) return;
    const pieces = S.buf.slice();
    S.buf.length = 0;
    const el = S.bufEl;
    S.bufEl = null;
    const links = [];
    let onlySpace = true;
    let prose = false;
    for (const p of pieces) {
      if (typeof p === 'string') {
        if (onlySpace && /\S/.test(p)) onlySpace = false;
        if (!prose && /[\p{L}\p{N}]/u.test(p)) prose = true;
      } else links.push(p.link);
    }
    // links with no words around them (menus, "Home | About") stay one per line with hrefs
    if (links.length && !prose) {
      for (const l of links) l.inline = false;
      return;
    }
    if (onlySpace && !links.length) return;
    if (S.interactiveOnly) return;
    let raw = '';
    for (const p of pieces) raw += typeof p === 'string' ? p : '\u0001' + links.indexOf(p.link) + '\u0002';
    let text = '';
    let plain = '';
    const marks = [];
    for (const part of clean(raw).split(/(\u0001\d+\u0002)/)) {
      const m = /^\u0001(\d+)\u0002$/.exec(part);
      if (m) {
        const l = links[+m[1]];
        marks.push({ pos: text.length, link: l });
        text += `[${l.name}](${l.ref})`;
        plain += l.name;
      } else {
        text += part;
        plain += part;
      }
    }
    let overflow = [];
    const limit = links.length ? Math.max(S.textMax, 700) : S.textMax;
    if (text.length > limit) {
      let cut = limit;
      for (const m of marks) if (m.pos < cut && m.pos + m.link.name.length + m.link.ref.length + 4 > cut) cut = m.pos;
      cut = cutEnd(text, cut);
      overflow = marks.filter((m) => m.pos >= cut).map((m) => m.link);
      text = text.slice(0, cut).trimEnd() + '…';
    }
    let y = 0;
    let iv = true;
    if (el) {
      const r = el.getBoundingClientRect();
      y = r.top + S.sy;
      iv = inView(r, S);
    }
    if (S.viewportOnly && !iv) return;
    push(S, { kind: 'text', text, plain, el, y, inView: iv, full: true });
    // links cut off by truncation still get a line so their refs are never lost
    for (const l of overflow) push(S, { ...l, inline: false, dup: true });
  }
  function sizedChild(el) {
    for (const ch of el.children) {
      const r = ch.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }
  function walkKids(el, S, c) {
    const sr = rootOf(el);
    if (sr) {
      hasShadow = true;
      observe(sr);
      for (let n = sr.firstChild; n; n = n.nextSibling) walkNode(n, S, c);
      return;
    }
    if (el.localName === 'slot') {
      const a = el.assignedNodes({ flatten: true });
      if (a.length) {
        for (const n of a) walkNode(n, S, c);
        return;
      }
    }
    for (let n = el.firstChild; n; n = n.nextSibling) walkNode(n, S, c);
  }
  function walkNode(n, S, c) {
    if (S.full) return;
    if (n.nodeType === 3) {
      if (c.noText || !c.vis) return;
      const t = n.data;
      if (!t) return;
      if (!S.buf.length) {
        if (!/\S/.test(t)) return;
        S.bufEl = c.block;
      }
      S.buf.push(t);
      return;
    }
    if (n.nodeType === 1) walkEl(n, S, c);
  }
  function walkEl(el, S, c) {
    const ln = el.localName;
    if (SKIP.has(ln) || ownNodes.has(el)) return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('inert')) return;
    const st = getComputedStyle(el);
    const disp = st.display;
    if (disp === 'none') return;
    if (disp === 'contents') {
      // a host styled :host { display: contents } still renders its (possibly closed) shadow tree
      if (ln.includes('-')) maybeHost(el, ln, { width: 0, height: 0 }, S);
      const cc = st.visibility === 'visible' ? c : { vis: false, noText: c.noText, inter: c.inter, cursor: st.cursor, block: c.block, sc: c.sc };
      walkKids(el, S, cc);
      return;
    }
    // closed <details>, hidden=until-found and content-visibility:hidden ancestors
    if (el.checkVisibility && !el.checkVisibility()) return;
    const formCtl = ln === 'input' || ln === 'select' || ln === 'textarea';
    if (st.opacity === '0' && !formCtl) return;
    const r = el.getBoundingClientRect();
    // positioned far off the page (a common way to hide things); not applicable inside a
    // scrolled container, where content above the scroll position legitimately sits at negative y
    if (!formCtl && !c.sc && (st.position === 'absolute' || st.position === 'fixed')) {
      // a box with no width or height is a wrapper whose children draw outside it (YouTube keeps
      // its dialogs in a zero-height container at the top edge): it only counts as off the page
      // when it lies wholly beyond the edge, not on it
      const flat = r.width === 0 || r.height === 0;
      const past = (v) => (flat ? v < 0 : v <= 0);
      const off = st.position === 'fixed' ? past(r.right) || past(r.bottom) || r.left >= S.vw || r.top >= S.vh : past(r.right + S.sx) || past(r.bottom + S.sy);
      if (off) return;
    }
    const sc = c.sc || ((st.overflowX !== 'visible' || st.overflowY !== 'visible') && (el.scrollTop > 0 || el.scrollLeft > 0) && el !== document.scrollingElement && ln !== 'body' && ln !== 'html');
    // a zero-size box that clips hides its content; html and body never clip (their overflow
    // applies to the viewport), and some sites (YouTube) give them zero height
    if ((r.width <= 1 || r.height <= 1) && st.overflowX !== 'visible' && st.overflowY !== 'visible' && !formCtl && ln !== 'html' && ln !== 'body') return;
    maybeHost(el, ln, r, S);
    const vis = st.visibility === 'visible';
    const inline = disp.startsWith('inline');
    if (!inline) flush(S);
    else if (disp !== 'inline' && S.buf.length) S.buf.push(' ');
    const role = roleOf(el, ln);
    if (role === 'hidden') return;
    const cursor = st.cursor;
    const block = inline ? c.block : el;
    const irole = interactiveRoleOf(el, ln, role, st, c);

    if (irole) {
      const hasBox = r.width > 0 && r.height > 0;
      if (vis && (hasBox || sizedChild(el))) {
        const nm = nameOf(el, ln, irole === 'clickable' ? 'clickable' : role || irole);
        if (irole === 'link' && disp === 'inline' && !c.noText && c.vis && !S.interactiveOnly && nm.name && !nm.long && nm.name.length <= 80 && !el.querySelector(NESTED_INTERACTIVE)) {
          // a link inside running text: keep it in the sentence as [name](ref)
          const e = { kind: 'item', role: irole, name: nm.name, el, ref: refFor(el), attrs: attrsOf(el, ln, irole, nm, S.focus), y: r.top + S.sy, inView: inView(r, S), inline: true };
          S.refs++;
          if (!S.viewportOnly || e.inView) push(S, e);
          if (!S.buf.length) S.bufEl = c.block;
          S.buf.push({ link: e });
          return;
        }
        flush(S);
        if (S.done.has(el)) return;
        S.done.add(el);
        const e = { kind: 'item', role: irole, name: nm.name, el, ref: refFor(el), attrs: attrsOf(el, ln, irole, nm, S.focus), y: r.top + S.sy, inView: inView(r, S) };
        S.refs++;
        if (!S.viewportOnly || e.inView) push(S, e);
        if (formCtl || ln === 'img' || ln === 'svg' || ln === 'iframe' || ln === 'video' || ln === 'audio' || ln === 'canvas') return;
        S.depth++;
        walkKids(el, S, { vis, noText: !nm.long, inter: true, cursor, block: el, sc });
        flush(S);
        S.depth--;
        return;
      }
    }
    if (role === 'row') {
      flush(S);
      const h = heuristicRole(el, ln, st, c);
      const name = vis ? rowText(el) : '';
      if (name || h) {
        const e = { kind: 'item', role: 'row', name, el, ref: h ? refFor(el) : '', attrs: '', y: r.top + S.sy, inView: inView(r, S) };
        if (h) S.refs++;
        if (!S.viewportOnly || e.inView) push(S, e);
      }
      S.depth++;
      walkKids(el, S, { vis, noText: true, inter: c.inter || !!h, cursor, block: el, sc });
      S.depth--;
      return;
    }
    if (CONTAINER.has(role) && !(role === 'group' && !ariaName(el) && ln !== 'fieldset')) {
      flush(S);
      const nm = nameOf(el, ln, role);
      let attrs = '';
      if ((role === 'dialog' || role === 'alertdialog') && (el.getAttribute('aria-modal') === 'true' || safeMatches(el, ':modal'))) attrs = 'modal';
      const open = push(S, { kind: 'open', role, name: nm.name, el, attrs, y: r.top + S.sy, inView: r.top >= 0 && r.top < S.vh && inView(r, S) });
      S.depth++;
      walkKids(el, S, { vis, noText: c.noText, inter: c.inter, cursor, block: el, sc });
      flush(S);
      S.depth--;
      if (open && S.entries[S.entries.length - 1] === open) S.entries.pop();
      return;
    }
    if (role === 'heading') {
      flush(S);
      const level = /^h[1-6]$/.test(ln) ? +ln[1] : +el.getAttribute('aria-level') || 2;
      const name = ariaName(el) || textOf(el, 200);
      if (name && vis) {
        const e = { kind: 'item', role: 'h' + level, name, el, ref: '', attrs: '', y: r.top + S.sy, inView: inView(r, S) };
        if (!S.viewportOnly || e.inView) push(S, e);
      }
      S.depth++;
      walkKids(el, S, { vis, noText: true, inter: c.inter, cursor, block: el, sc });
      S.depth--;
      return;
    }
    if (role === 'iframe') {
      if (vis && r.width > 2 && r.height > 2) {
        flush(S);
        const nm = nameOf(el, ln, role);
        const e = { kind: 'frame', role: 'iframe', name: nm.name, el, frameId: frameIdOf(el), src: el.src || '', nth: sameSrcIndex(el), attrs: '', y: r.top + S.sy, inView: inView(r, S) };
        if (!S.viewportOnly || e.inView) push(S, e);
      }
      return;
    }
    if (role === 'img' || ln === 'img' || ln === 'svg') {
      if (!c.noText && vis && r.width >= 8 && r.height >= 8) {
        const nm = nameOf(el, ln, 'img');
        if (nm.name) {
          if (!inline) flush(S);
          const e = { kind: 'item', role: 'img', name: nm.name, el, ref: '', attrs: '', y: r.top + S.sy, inView: inView(r, S) };
          if (!S.interactiveOnly && (!S.viewportOnly || e.inView)) {
            flush(S);
            push(S, e);
          }
        }
      }
      return;
    }
    if (ln === 'video' || ln === 'audio' || ln === 'canvas') {
      if (vis && r.width >= 20 && r.height >= 20) {
        flush(S);
        const e = { kind: 'item', role: ln, name: clean(el.getAttribute('aria-label') || el.getAttribute('title')), el, ref: refFor(el), attrs: ln === 'canvas' ? 'drawn pixels: use screenshot to see it' : el.paused ? 'paused' : 'playing', y: r.top + S.sy, inView: inView(r, S) };
        S.refs++;
        if (!S.viewportOnly || e.inView) push(S, e);
      }
      return;
    }
    if (formCtl || ln === 'object' || ln === 'embed' || ln === 'hr' || ln === 'math') return;
    if (ln === 'br') {
      if (!c.noText && c.vis && S.buf.length) S.buf.push(' ');
      return;
    }
    let noText = c.noText;
    if (ln === 'label' && el.control) {
      noText = true;
      const ctl = el.control;
      if (vis && !S.done.has(ctl) && !(ctl.checkVisibility && ctl.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }))) {
        // a CSS toggle: the real input is hidden and the label is what people click
        const cln = ctl.localName;
        const cst = getComputedStyle(ctl);
        const crole = interactiveRoleOf(ctl, cln, roleOf(ctl, cln), cst, { inter: false, cursor: 'auto' }) || roleOf(ctl, cln);
        if (crole) {
          flush(S);
          const nm = nameOf(ctl, cln, crole);
          const e = { kind: 'item', role: crole, name: nm.name, el: ctl, ref: refFor(ctl), attrs: attrsOf(ctl, cln, crole, nm, S.focus), y: r.top + S.sy, inView: inView(r, S) };
          S.done.add(ctl);
          S.refs++;
          if (!S.viewportOnly || e.inView) push(S, e);
        }
      }
    }
    if (ln === 'details' && !el.open) {
      // only the summary of a closed <details> is on screen
      for (const ch of el.children) if (ch.localName === 'summary') walkEl(ch, S, { vis, noText, inter: c.inter, cursor, block, sc });
      if (!inline) flush(S);
      return;
    }
    if (ln === 'legend' && el.parentElement && el.parentElement.localName === 'fieldset') noText = true;
    const cc = vis === c.vis && cursor === c.cursor && block === c.block && noText === c.noText && sc === c.sc ? c : { vis, noText, inter: c.inter, cursor, block, sc };
    walkKids(el, S, cc);
    if (!inline) flush(S);
  }
  function safeMatches(el, sel) {
    try {
      return el.matches(sel);
    } catch (e) {
      return false;
    }
  }
  function rootCtx(root) {
    return { vis: true, noText: false, inter: false, cursor: 'auto', block: root, sc: false };
  }
  function fmt(e, S) {
    const pad = '  '.repeat(e.depth);
    if (e.kind === 'text') return pad + q(e.full ? e.text : trunc(e.text, S.textMax));
    let s = pad + e.role;
    if (e.name) s += ' ' + q(trunc(e.name, 120));
    if (e.ref) s += ' [' + e.ref + ']';
    if (e.attrs) s += ' ' + e.attrs;
    return s;
  }
  function collect(o) {
    const S = newState(o || {});
    const root = document.documentElement;
    if (root) walkEl(root, S, rootCtx(root));
    flush(S);
    hostQueue = S.hosts;
    hostCapped = !!S.hostsCapped;
    return S;
  }

  // ---------------------------------------------------------------- public: snapshot
  function snapshot(o) {
    o = o || {};
    if (refMap.size > 5000) prune();
    let root = document.documentElement;
    if (o.ref) {
      root = lookup(o.ref);
      if (!root) return { error: gone(o.ref) };
    } else if (o.selector) {
      const m = qsa(o.selector);
      if (m.error) return m;
      if (!m.els.length) return { error: `No element matches selector ${q(o.selector)}` };
      root = m.els[0];
    }
    const S = newState(o);
    if (root) walkEl(root, S, rootCtx(root));
    flush(S);
    hostQueue = S.hosts;
    hostCapped = !!S.hostsCapped;
    const lines = [];
    const ys = [];
    const iv = [];
    const frames = [];
    for (const e of S.entries) {
      if (e.inline) continue;
      if (e.kind === 'frame') frames.push({ frameId: e.frameId, src: e.src, nth: e.nth, index: lines.length, depth: e.depth });
      lines.push(fmt(e, S));
      ys.push(Math.round(e.y));
      iv.push(e.inView ? 1 : 0);
    }
    const d = docSize();
    return {
      lines,
      ys,
      iv,
      frames,
      truncated: S.full,
      refs: S.refs,
      hosts: S.hosts.length,
      hostsCapped: !!S.hostsCapped,
      url: location.href,
      title: document.title,
      vw: Math.round(S.vw),
      vh: Math.round(S.vh),
      sx: Math.round(S.sx),
      sy: Math.round(S.sy),
      sw: d.w,
      sh: d.h,
    };
  }

  // ---------------------------------------------------------------- public: describe / find / query
  function nearestInteractive(el) {
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 10; n = composedParent(n), i++) {
      const ln = n.localName;
      if (ln === 'body' || ln === 'html') break;
      const role = roleOf(n, ln);
      const st = getComputedStyle(n);
      if (interactiveRoleOf(n, ln, role, st, { inter: false, cursor: n.parentElement ? getComputedStyle(n.parentElement).cursor : 'auto' })) return n;
    }
    return null;
  }
  function describe(el) {
    if (!el || el.nodeType !== 1) return 'nothing';
    const ln = el.localName;
    const role = roleOf(el, ln);
    const st = getComputedStyle(el);
    const irole = interactiveRoleOf(el, ln, role, st, { inter: false, cursor: 'auto' }) || role || ln;
    let nm = nameOf(el, ln, irole).name;
    if (!nm) nm = textOf(el, 60);
    return `${irole}${nm ? ' ' + q(trunc(nm, 80)) : ''} [${refFor(el)}]`;
  }
  function describeRef(ref) {
    const el = lookup(ref);
    return el ? describe(el) : gone(ref);
  }
  function entryFor(el) {
    const ln = el.localName;
    const role = roleOf(el, ln);
    const st = getComputedStyle(el);
    const irole = interactiveRoleOf(el, ln, role, st, { inter: false, cursor: 'auto' });
    const r = el.getBoundingClientRect();
    const S = { sy: scrollY, vw: vp().w, vh: vp().h };
    if (irole) {
      const nm = nameOf(el, ln, irole);
      return { kind: 'item', role: irole, name: nm.name, el, ref: refFor(el), attrs: attrsOf(el, ln, irole, nm, deepActive()), inView: inView(r, S) };
    }
    const nm = nameOf(el, ln, role).name || textOf(el, 200);
    return { kind: 'text', role: role || ln, text: nm, el, inView: inView(r, S) };
  }
  function score(hay, ql) {
    const h = clean(hay).toLowerCase();
    if (!h) return 0;
    if (h === ql) return 100;
    if (h.startsWith(ql)) return 80;
    const i = h.indexOf(ql);
    if (i < 0) return 0;
    return /[\s\W]/.test(h[i - 1]) ? 65 : 50;
  }
  // Text lines belong to their block; narrow to the deepest visible element holding the text,
  // so hover/click land on e.g. the <span>Products</span> rather than the whole block.
  function narrow(el, ql) {
    if (!ql) return el;
    let best = el;
    for (let depth = 0; depth < 40; depth++) {
      let next = null;
      for (const c of kidsOf(best)) {
        if (c.nodeType !== 1 || SKIP.has(c.localName) || ownNodes.has(c)) continue;
        if (!rendered(c)) continue;
        if (textOf(c, ql.length + 4000).toLowerCase().includes(ql)) {
          next = c;
          break;
        }
      }
      if (!next) break;
      best = next;
    }
    return best;
  }
  function snippet(text, ql) {
    const t = clean(text);
    if (t.length <= 140) return t;
    const i = ql ? t.toLowerCase().indexOf(ql) : 0;
    let s = Math.max(0, i - 50);
    if (/[\udc00-\udfff]/.test(t[s] || '')) s++; // never start in the middle of an emoji
    const e = cutEnd(t, s + 140);
    return (s > 0 ? '…' : '') + t.slice(s, e) + (e < t.length ? '…' : '');
  }
  function find(o) {
    o = o || {};
    const limit = Math.max(1, Math.min(o.limit || 15, 60));
    let items;
    if (o.selector) {
      const m = qsa(o.selector);
      if (m.error) return m;
      items = m.els.slice(0, 300).filter((el) => el.checkVisibility ? el.checkVisibility() : true).map(entryFor);
    } else {
      items = collect({ maxEntries: 20000 }).entries.filter((e) => (e.kind === 'item' || e.kind === 'text') && !e.dup);
    }
    if (o.role) {
      const r = o.role.toLowerCase();
      items = items.filter((e) => e.role === r || (r === 'heading' && /^h\d$/.test(e.role)) || (r === 'text' && e.kind === 'text'));
    }
    const ql = clean(o.query).toLowerCase();
    const scored = [];
    items.forEach((e, i) => {
      let s = 1;
      if (ql) {
        s = score(e.kind === 'text' ? e.plain || e.text : e.name, ql);
        if (!s && e.attrs) s = score(e.attrs, ql) ? 40 : 0;
        if (!s) return;
        if (e.kind === 'item' && e.ref) s += 5;
        if (e.inView) s += 2;
      }
      scored.push({ e, i, s });
    });
    scored.sort((a, b) => b.s - a.s || a.i - b.i);
    const lines = scored.slice(0, limit).map(({ e }) => {
      if (e.kind === 'text') return `text ${q(snippet(e.plain || e.text, ql))} [${refFor(narrow(e.el, ql))}]${e.inView ? '' : ' (offscreen)'}`;
      let s = e.role + (e.name ? ' ' + q(trunc(e.name, 120)) : '') + ` [${e.ref || refFor(e.el)}]`;
      if (e.attrs) s += ' ' + e.attrs;
      if (!e.inView) s += ' (offscreen)';
      return s;
    });
    return { lines, total: scored.length, hosts: hostQueue.length, hostsCapped: hostCapped };
  }
  // Partial text matches. The text has to start where a word starts: "Hide like count" never
  // matches "Unhide like count" (clicking that would flip a setting back). Matches that also end
  // where a word ends beat ones that stop inside a word ("Next" beats "Nextdoor").
  const WORDCH = /[\p{L}\p{N}\p{M}]/u;
  function partialRank(s, t) {
    let best = 0;
    for (let i = s.indexOf(t); i >= 0; i = s.indexOf(t, i + 1)) {
      if (i > 0 && WORDCH.test(s[i - 1]) && WORDCH.test(t[0])) continue;
      const j = i + t.length;
      best = Math.max(best, j < s.length && WORDCH.test(s[j]) && WORDCH.test(t[t.length - 1]) ? 1 : 2);
      if (best === 2) break;
    }
    return best;
  }
  function partialMatches(list, key, t) {
    const ranked = list.map((e) => [e, partialRank(key(e), t)]).filter(([, r]) => r > 0);
    const top = ranked.reduce((m, [, r]) => Math.max(m, r), 0);
    return ranked.filter(([, r]) => r === top).map(([e]) => e);
  }
  function query(o) {
    o = o || {};
    let cands = [];
    let near = [];
    if (o.selector) {
      const m = qsa(o.selector);
      if (m.error) return m;
      const visible = m.els.filter((el) => (el.checkVisibility ? el.checkVisibility() : true));
      cands = visible.length ? visible : m.els;
    } else if (o.text != null) {
      const t = clean(o.text).toLowerCase();
      if (!t) return { error: 'Empty text' };
      const entries = collect({ maxEntries: 20000 }).entries.filter((e) => !e.dup);
      const role = o.role ? o.role.toLowerCase() : '';
      const items = entries.filter((e) => e.kind === 'item' && (!role || e.role === role || (role === 'heading' && /^h\d$/.test(e.role))));
      const name = (e) => clean(e.name).toLowerCase();
      let pool = items.filter((e) => name(e) === t);
      if (!pool.length && !o.exact) pool = partialMatches(items, name, t);
      if (!pool.length && !role) {
        const texts = entries.filter((e) => e.kind === 'text');
        const txt = (e) => clean(e.plain || e.text).toLowerCase();
        pool = texts.filter((e) => txt(e) === t);
        if (!pool.length && !o.exact) pool = partialMatches(texts, txt, t);
      }
      cands = [...new Set(pool.map((e) => (e.kind === 'text' ? narrow(e.el, t) : e.el)))];
      // what only a part of a word would have matched, so the error can say why it was refused
      if (!cands.length && !o.exact) near = items.filter((e) => name(e).includes(t)).slice(0, 4).map((e) => describe(e.el));
    } else return { error: 'No selector or text given' };
    const what = o.selector ? `selector ${q(o.selector)}` : `text ${q(o.text)}`;
    if (!cands.length && near.length) return { error: `No element matches ${what}. Not matched, because the text would start inside a word there: ${near.join('; ')}. Use its ref if one of those is meant.`, none: true, hosts: hostQueue.length, hostsCapped: hostCapped };
    if (!cands.length) return { error: `No element matches ${what}`, none: true, hosts: hostQueue.length, hostsCapped: hostCapped };
    if (o.nth) {
      const el = cands[o.nth - 1];
      if (!el) return { error: `Only ${cands.length} element(s) match ${what}; nth=${o.nth} is out of range` };
      return { ref: refFor(el), desc: describe(el) };
    }
    if (cands.length > 1) return { error: `${cands.length} elements match ${what}. Use one of these refs (or pass nth)`, candidates: cands.slice(0, 8).map(describe) };
    return { ref: refFor(cands[0]), desc: describe(cands[0]) };
  }

  // ---------------------------------------------------------------- geometry & pointer
  function bestRect(el) {
    const v = vp();
    let best = null;
    for (const r of el.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      if (!best) best = r;
      if (r.bottom > 0 && r.right > 0 && r.top < v.h && r.left < v.w) return r;
    }
    if (best) return best;
    const b = el.getBoundingClientRect();
    if (b.width >= 1 && b.height >= 1) return b;
    for (const ch of el.children) {
      const r = ch.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) return r;
    }
    return null;
  }
  function clipVp(r) {
    const v = vp();
    const x1 = Math.max(r.left, 0);
    const y1 = Math.max(r.top, 0);
    const x2 = Math.min(r.right, v.w);
    const y2 = Math.min(r.bottom, v.h);
    if (x2 - x1 < 1 || y2 - y1 < 1) return null;
    return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
  }
  function candidates(v) {
    const fr = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.1, 0.5], [0.9, 0.5]];
    return fr.map(([fx, fy]) => [v.left + v.width * fx, v.top + v.height * fy]);
  }
  // A person aims near the middle of a target, a little differently every time.
  function gaussian() {
    let u = 0;
    while (u === 0) u = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
  }
  function aim(v) {
    const ix = Math.min(v.width * 0.2, Math.max(1, v.width / 2 - 1));
    const iy = Math.min(v.height * 0.2, Math.max(1, v.height / 2 - 1));
    const lim = (x, a, b) => Math.min(b, Math.max(a, x));
    return [
      lim(v.left + v.width / 2 + gaussian() * v.width * 0.13, v.left + ix, v.left + v.width - ix),
      lim(v.top + v.height / 2 + gaussian() * v.height * 0.15, v.top + iy, v.top + v.height - iy),
    ];
  }
  // After the cursor arrives: is this element (or its label) still what is under it?
  function hits(ref, x, y) {
    const el = lookup(ref);
    if (!el) return { error: gone(ref) };
    const hit = hitAt(x, y);
    const ok = hit && (hit === el || containsComposed(el, hit) || (el.labels && Array.from(el.labels).some((l) => containsComposed(l, hit))));
    return { ok: !!ok, by: ok ? '' : hit ? describe(nearestInteractive(hit) || hit) : 'nothing' };
  }
  function sameRect(a, b) {
    return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
  }
  async function point(ref, o) {
    o = o || {};
    const el = lookup(ref);
    if (!el) return { error: gone(ref) };
    if (el.localName === 'option') return { error: `${ref} is an <option>; use fill on its <select> with the option label` };
    const desc = describe(el);
    const targets = [el];
    if (el.labels) for (const l of el.labels) targets.push(l);
    let firstFail = null;
    for (const target of targets) {
      let r = bestRect(target);
      if (!r) continue;
      let v = clipVp(r);
      const area = r.width * r.height;
      const vpArea = vp().w * vp().h;
      if (!v || v.width * v.height < 0.5 * Math.min(area, vpArea)) {
        // out of view: the service worker scrolls with the mouse wheel (scrollPlan) and asks again
        return { scroll: true, desc };
      }
      for (let i = 0; i < 8; i++) {
        await nextFrame();
        const r2 = bestRect(target);
        if (!r2) break;
        const stable = sameRect(r, r2);
        r = r2;
        if (stable) break;
      }
      if (!r) continue;
      v = clipVp(r);
      if (!v) continue;
      const pts = candidates(v);
      if (o.left) pts.unshift([v.left + Math.min(8, v.width * 0.12), v.top + v.height / 2]);
      else if (!o.exact) pts.unshift(aim(v));
      const ok = (hit) => hit && (hit === target || containsComposed(target, hit) || (el.labels && Array.from(el.labels).some((l) => containsComposed(l, hit))) || containsComposed(el, hit));
      for (const [x, y] of pts) {
        if (ok(hitAt(x, y))) return { x, y, desc, w: v.width, h: v.height };
      }
      if (!firstFail) firstFail = { x: pts[0][0], y: pts[0][1], hit: hitAt(pts[0][0], pts[0][1]) };
    }
    if (!firstFail) return { error: `${desc} is not visible (it has no layout box). It may be hidden or collapsed.` };
    if (o.force) return { x: firstFail.x, y: firstFail.y, desc, forced: true, w: 24, h: 24 };
    // inside the viewport, but below the end of a list that scrolls by itself (what is "on top"
    // there is just whatever follows the list): that list is wheel-scrolled, as a person would
    if (clippedByScroller(el)) return { scroll: true, desc };
    const by = firstFail.hit ? describe(nearestInteractive(firstFail.hit) || firstFail.hit) : 'nothing (outside the page)';
    return { error: 'covered', desc, by, x: firstFail.x, y: firstFail.y };
  }
  // Full-page bot challenges that are not a third-party iframe (see Tab.humanCheck).
  function humanCheck() {
    const t = document.title.trim();
    const u = location.href;
    const cf =
      document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]') &&
      document.querySelector('#challenge-stage, #challenge-form, #challenge-running, #challenge-error-text');
    if (/^(Just a moment\.\.\.|Attention Required! \| Cloudflare|Please Wait\.\.\. \| Cloudflare)$/i.test(t) || /[?&]__cf_chl_/.test(u) || cf) return 'Cloudflare bot check';
    if (/\/sorry\/index/.test(u) && document.querySelector('#captcha-form, #recaptcha')) return 'Google "unusual traffic" check';
    if (document.querySelector('form[action*="validateCaptcha"]')) return 'Amazon robot check';
    const px = document.querySelector('#px-captcha');
    if (px && px.getClientRects().length) return 'HUMAN press-and-hold check';
    return null;
  }
  // Called on an <iframe>: is it actually shown (not parked off the page, hidden or tiny)?
  function frameShown(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 30 || r.height < 30) return false;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const se = document.scrollingElement || document.documentElement;
    return r.bottom + scrollY > 0 && r.right + scrollX > 0 && r.top + scrollY < se.scrollHeight && r.left + scrollX < se.scrollWidth;
  }
  function at(x, y) {
    const hit = hitAt(x, y);
    if (!hit) return 'nothing';
    return describe(nearestInteractive(hit) || hit);
  }
  // Called on an <iframe> element in its parent document. (x, y) is a point inside the iframe's
  // viewport. Returns that point in this document's viewport, scrolled into view if needed, and
  // whether this document actually shows the iframe there (an overlay could cover it).
  async function frameHit(el, x, y) {
    const at = () => {
      const f = frameRect(el, false);
      return [f.x + x, f.y + y];
    };
    let [px, py] = at();
    if (!visibleAt(el, px, py)) return { x: px, y: py, offscreen: true };
    const hit = hitAt(px, py);
    const ok = hit && (hit === el || containsComposed(el, hit));
    return { x: px, y: py, covered: ok ? null : hit ? describe(nearestInteractive(hit) || hit) : 'nothing' };
  }
  const isPageScroller = (n) => n === document.scrollingElement || n === document.documentElement || n === document.body;
  // Is viewport point (px, py) inside the part of el that the viewport and every clipping
  // ancestor (scroll panes, overflow:hidden boxes) leave visible?
  function visibleAt(el, px, py) {
    const v = vp();
    if (px < 0 || py < 0 || px >= v.w || py >= v.h) return false;
    for (let n = composedParent(el); n && n.nodeType === 1; n = composedParent(n)) {
      if (isPageScroller(n)) continue;
      const st = getComputedStyle(n);
      if (st.overflowX === 'visible' && st.overflowY === 'visible') continue;
      const r = n.getBoundingClientRect();
      const l = r.left + n.clientLeft;
      const t = r.top + n.clientTop;
      if (px < l || py < t || px >= l + n.clientWidth || py >= t + n.clientHeight) return false;
    }
    return true;
  }
  // Does a pane that scrolls (not the page) hide part of el?
  function clippedByScroller(el) {
    const r = bestRect(el) || el.getBoundingClientRect();
    for (let n = composedParent(el); n && n.nodeType === 1; n = composedParent(n)) {
      if (isPageScroller(n)) break;
      if (!canScroll(n, 'x') && !canScroll(n, 'y')) continue;
      const b = n.getBoundingClientRect();
      const l = b.left + n.clientLeft;
      const t = b.top + n.clientTop;
      if (r.top < t - 0.5 || r.bottom > t + n.clientHeight + 0.5 || r.left < l - 0.5 || r.right > l + n.clientWidth + 0.5) return true;
    }
    return false;
  }
  // Containers are never scrolled by script: Browzie scrolls them with the mouse wheel.
    function sameSrcIndex(el) {
    let n = 0;
    for (const f of deepFrames()) {
      if (f === el) return n;
      if ((f.src || '') === (el.src || '')) n++;
    }
    return n;
  }
  // The <iframe>/<frame> element in this document that holds the frame with this extension frameId.
  // Out-of-process frames may not map back to an id from here; then the service worker's hint
  // (the frame's URL and its position among frames with that URL) picks the element.
  function frameEl(fid, hint) {
    const direct = frameElById(fid);
    if (direct || !hint) return direct;
    const same = deepFrames().filter((f) => (f.src || '') === hint.src);
    return same[hint.nth || 0] || (same.length === 1 ? same[0] : null);
  }
  function frameElById(fid) {
    let found = null;
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (found) return;
        if ((el.localName === 'iframe' || el.localName === 'frame') && frameIdOf(el) === fid) {
          found = el;
          return;
        }
        const sr = rootOf(el);
        if (sr) walk(sr);
      }
    };
    walk(document);
    return found;
  }
  // Every iframe element here with what the service worker needs to tell them apart.
  function frameList() {
    return { list: deepFrames().map((f) => ({ frameId: frameIdOf(f), src: f.src || '', nth: sameSrcIndex(f) })) };
  }
  function frameRectById(fid, hint) {
    const el = frameEl(fid, hint);
    return el ? frameRect(el) : { error: 'frame element not found' };
  }
  async function frameHitById(fid, x, y, hint) {
    const el = frameEl(fid, hint);
    return el ? frameHit(el, x, y) : { error: 'frame element not found' };
  }
  function frameScrollPlan(fid, hint) {
    const el = frameEl(fid, hint);
    return el ? scrollPlanFor(el) : { error: 'frame element not found' };
  }
  function frameRect(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      frameId: frameIdOf(el),
      x: r.left + (parseFloat(s.borderLeftWidth) || 0) + (parseFloat(s.paddingLeft) || 0),
      y: r.top + (parseFloat(s.borderTopWidth) || 0) + (parseFloat(s.paddingTop) || 0),
      w: r.width,
      h: r.height,
    };
  }

  // ---------------------------------------------------------------- forms
  // Strict boolean parsing: anything else is an error rather than a silent "false".
  function toBool(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    const s = String(v).trim().toLowerCase();
    if (/^(true|on|yes|checked|check|1|y|select|selected)$/.test(s)) return true;
    if (/^(false|off|no|unchecked|uncheck|0|n|deselect|unselected)$/.test(s)) return false;
    return null;
  }
  // <select>: Browzie clicks it, closes the popup with Escape and steps to the option with the
  // arrow keys, as a keyboard user does. Returns how many enabled options to step over.
  function selectOptions(el, value, desc) {
    if (el.multiple) return { error: `${desc} is a multi-select list; click each option with Control held` };
    const want = String(Array.isArray(value) ? value[0] : value);
    const opts = Array.from(el.options).filter((o) => !o.disabled);
    const norm = (s) => clean(s).toLowerCase();
    let idx = opts.findIndex((o) => clean(o.label || o.text) === clean(want));
    if (idx < 0) idx = opts.findIndex((o) => o.value === want);
    if (idx < 0) idx = opts.findIndex((o) => norm(o.label || o.text) === norm(want));
    if (idx < 0) {
      const all = opts.map((o) => q(clean(o.label || o.text))).slice(0, 30).join(', ');
      return { error: `${desc} has no option ${q(want)}. Options: ${all}` };
    }
    const cur = opts.indexOf(el.selectedOptions[0]);
    const label = clean(opts[idx].label || opts[idx].text);
    if (cur === idx) return { kind: 'done', desc, value: label, note: 'already selected' };
    return { kind: 'select', desc, delta: cur < 0 ? idx + 1 : idx - cur, label };
  }
  // Date and time fields take typed digits segment by segment, in the order the browser shows
  // them for its UI language.
  function dateKeys(el, type, value, desc) {
    const v = String(value).trim();
    const lang = new Intl.DateTimeFormat().resolvedOptions().locale || navigator.language || 'en-US';
    const order = new Intl.DateTimeFormat(lang, { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(2024, 2, 9))
      .map((p) => p.type)
      .filter((t) => t === 'year' || t === 'month' || t === 'day');
    const h12 = new Intl.DateTimeFormat(lang, { hour: 'numeric' }).resolvedOptions().hourCycle === 'h12';
    const datePart = (d) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
      if (!m) return null;
      const seg = { year: m[1], month: m[2], day: m[3] };
      return order.map((t) => seg[t]).join('');
    };
    const timePart = (t) => {
      const m = /^(\d{2}):(\d{2})$/.exec(t);
      if (!m) return null;
      if (!h12) return m[1] + m[2];
      const h = +m[1];
      return String(h % 12 || 12).padStart(2, '0') + m[2] + (h >= 12 ? 'P' : 'A');
    };
    let text = null;
    let hint = '';
    if (type === 'date') {
      text = datePart(v);
      hint = 'YYYY-MM-DD';
    } else if (type === 'time') {
      text = timePart(v);
      hint = 'HH:MM (24 h)';
    } else if (type === 'datetime-local') {
      const [d, t] = v.split('T');
      const a = datePart(d || '');
      const b = timePart(t || '');
      text = a && b ? a + b : null;
      hint = 'YYYY-MM-DDTHH:MM';
    } else if (type === 'month') {
      const m = /^(\d{4})-(\d{2})$/.exec(v);
      text = m ? (order.indexOf('year') < order.indexOf('month') ? m[1] + m[2] : m[2] + m[1]) : null;
      hint = 'YYYY-MM';
    } else return { error: `${desc} is a ${type} field; Browzie cannot fill it with the keyboard yet` };
    if (!text) return { error: `${desc} needs ${hint}, got ${q(v)}` };
    // the other common segment orders, tried only if the field shows something else afterwards
    const alts = [];
    if (type === 'date' || type === 'datetime-local') {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
      const rest = type === 'datetime-local' ? text.slice(8) : '';
      for (const o of [['month', 'day', 'year'], ['day', 'month', 'year'], ['year', 'month', 'day']]) {
        const seg = { year: m[1], month: m[2], day: m[3] };
        const alt = o.map((k) => seg[k]).join('') + rest;
        if (alt !== text && !alts.includes(alt)) alts.push(alt);
      }
    }
    return { kind: 'keys', desc, text, alts, expect: v, hint };
  }
  // Range sliders move with the arrow keys, one step per press.
  function rangePlan(el, value, desc) {
    const want = Number(value);
    if (!Number.isFinite(want)) return { error: `${desc} is a slider; give a number` };
    const step = el.step === 'any' ? 1 : Number(el.step) || 1;
    const min = el.min === '' ? 0 : Number(el.min);
    const max = el.max === '' ? 100 : Number(el.max);
    const target = Math.min(max, Math.max(min, want));
    const n = Math.round((target - Number(el.value)) / step);
    if (!n) return { kind: 'done', desc, value: el.value, note: 'already there' };
    if (Math.abs(n) > 150) return { error: `${desc}: ${Math.abs(n)} steps is too far for the keyboard; drag the slider instead` };
    return { kind: 'press', desc, key: n > 0 ? 'ArrowRight' : 'ArrowLeft', count: Math.abs(n), expect: String(target) };
  }
  function editableRoot(el) {
    if (!el.isContentEditable) return null;
    let n = el;
    while (n.parentElement && n.parentElement.isContentEditable) n = n.parentElement;
    return n;
  }
  function prepareFill(ref, value) {
    const el = lookup(ref);
    if (!el) return { error: gone(ref) };
    const desc = describe(el);
    const ln = el.localName;
    const type = ln === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    const role = roleOf(el, ln);
    if (ln === 'select') {
      if (el.matches(':disabled')) return { error: `${desc} is disabled` };
      return selectOptions(el, value, desc);
    }
    if (type === 'checkbox' || type === 'radio' || (CHECKABLE.has(role) && ln !== 'input')) {
      const want = toBool(value);
      if (want === null) return { error: `${desc} is a ${type || role}; give value true or false (got ${q(String(value))})` };
      const cur = type ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (cur === want) return { kind: 'done', desc, value: want ? 'checked' : 'unchecked', note: 'already ' + (want ? 'checked' : 'unchecked') };
      if ((type === 'radio' || role === 'radio') && !want) return { error: `${desc}: a radio button cannot be unchecked directly; select another option in its group` };
      return { kind: 'click', desc, want };
    }
    if (type === 'file') return { kind: 'file', desc };
    if ((ln === 'input' || ln === 'textarea') && el.matches(':disabled')) return { error: `${desc} is disabled` };
    if (SET_VALUE_TYPES.has(type)) {
      if (type === 'range') return rangePlan(el, value, desc);
      if (type === 'color') return { error: `${desc} is a colour picker; Browzie only types into fields. Ask the user to pick the colour.` };
      return dateKeys(el, type, value, desc);
    }
    if (ln === 'input' || ln === 'textarea') {
      if (el.readOnly) return { error: `${desc} is read-only` };
      return { kind: 'text', desc, empty: el.value === '', masked: type === 'password' };
    }
    const ed = editableRoot(el);
    if (ed) return { kind: 'text', desc, empty: !clean(ed.textContent), rich: true };
    return { error: `${desc} is not a fillable field. Click it first or use type.` };
  }
  function value(ref) {
    const el = lookup(ref);
    if (!el) return { error: gone(ref) };
    const ln = el.localName;
    if (ln === 'select') return { value: Array.from(el.selectedOptions).map((o) => clean(o.label || o.text)).join(', ') };
    if (ln === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return { value: el.checked ? 'checked' : 'unchecked', checked: el.checked };
    if (ln === 'input' || ln === 'textarea') return { value: el.value };
    const role = roleOf(el, ln);
    if (CHECKABLE.has(role)) return { value: el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked', checked: el.getAttribute('aria-checked') === 'true' };
    const ed = editableRoot(el);
    if (ed) return { value: ed.innerText.replace(/\n$/, '') };
    return { value: clean(el.textContent) };
  }
  // Native form validation: when the browser refuses to submit a form it fires "invalid" at each
  // bad field. Listening for exactly that (instead of guessing from field state) means it is only
  // reported when a submit really was blocked.
  let invalidLog = null;
  let invalidHooked = false;
  function armInvalid() {
    invalidLog = [];
    if (!invalidHooked) {
      invalidHooked = true;
      addEventListener('invalid', (e) => {
        if (invalidLog && e.target && !invalidLog.includes(e.target)) invalidLog.push(e.target);
      }, true);
    }
    return true;
  }
  function invalidSeen() {
    const list = invalidLog || [];
    invalidLog = null;
    return { issues: list.slice(0, 6).map((f) => `${describe(f)}: ${f.validationMessage}`) };
  }
  function kind(ref) {
    const el = lookup(ref);
    if (!el) return { error: gone(ref) };
    return { file: el.localName === 'input' && el.type === 'file', multiple: !!el.multiple, desc: describe(el) };
  }
  // Chrome's password manager (or address autofill) filled this field. Only that fact is read:
  // Chrome keeps a saved password's value from pages until the user clicks.
  const autofilled = (el) => safeMatches(el, ':autofill') || safeMatches(el, ':-webkit-autofill');
  // Where keystrokes would go now, and whether that takes text. frame: the focus is inside an iframe
  // (its own agent answers for it).
  const NO_TEXT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'range', 'color', 'hidden']);
  function takesText(el) {
    const ln = el.localName;
    if (ln === 'input') return !el.disabled && !el.readOnly && !NO_TEXT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
    if (ln === 'textarea') return !el.disabled && !el.readOnly;
    if (el.isContentEditable) return true;
    return /^(textbox|searchbox|combobox|spinbutton)$/.test(el.getAttribute('role') || '');
  }
  function focusInfo() {
    const a = deepActive();
    const none = !a || a === document.body || a === document.documentElement;
    const ln = a ? a.localName : '';
    return { has: document.hasFocus(), frame: ln === 'iframe' || ln === 'frame', editable: !none && takesText(a), desc: none ? '' : describe(a) };
  }
  // The sign-in form on this page: its password field (or, on a "username first" page, the username
  // field), whether Chrome filled them, and the button that sends it. Never reads a password.
  // signup: the only password fields are for a new password (creating an account, changing it).
  function loginForm() {
    const shown = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && !el.disabled && (!el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    };
    const typeOf = (el) => (el.getAttribute('type') || 'text').toLowerCase();
    const acOf = (el) => (el.getAttribute('autocomplete') || '').toLowerCase();
    const inputs = (qsa('input').els || []).filter(shown);
    const pws = inputs.filter((el) => typeOf(el) === 'password');
    const pw = pws.find((el) => !/new-password/.test(acOf(el))) || null;
    const userLike = (el) => {
      const ty = typeOf(el);
      if (ty !== 'text' && ty !== 'email' && ty !== 'tel') return false;
      if (ty === 'email' || /\b(username|email|webauthn)\b/.test(acOf(el))) return true;
      return /user|e-?mail|login|identifier|account|phone|mobile/i.test(`${el.name} ${el.id} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`);
    };
    const users = inputs.filter(userLike);
    let user = null;
    if (pw) user = (pw.form && users.find((el) => el.form === pw.form)) || users.find((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
    else if (!pws.length) user = users[0] || null;
    if (!pw && !user) return { none: true, signup: pws.length > 0, url: location.href };
    const field = pw || user;
    const box = field.form || field.closest('[role=dialog], main') || document;
    const btns = Array.from(box.querySelectorAll('button, input[type=submit], [role=button]')).filter(shown);
    const SUBMIT = /^(sign ?in|log ?in|login|next|continue|submit|verify)\b/i;
    const submit = (field.form && btns.find((b) => b.type === 'submit' && b.form === field.form)) || btns.find((b) => SUBMIT.test(clean(b.value || b.innerText || b.getAttribute('aria-label') || '')));
    const info = (el) => el && { ref: refFor(el), desc: describe(el), filled: autofilled(el) };
    return { pw: info(pw), user: user && { ...info(user), empty: user.value === '' }, submit: submit ? { ref: refFor(submit), desc: describe(submit) } : null, url: location.href };
  }

  // ---------------------------------------------------------------- scrolling
  function canScroll(el, axis) {
    const se = document.scrollingElement || document.documentElement;
    const room = axis === 'y' ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    if (room < 2) return false;
    if (el === se) {
      const a = getComputedStyle(document.documentElement)[axis === 'y' ? 'overflowY' : 'overflowX'];
      const b = document.body ? getComputedStyle(document.body)[axis === 'y' ? 'overflowY' : 'overflowX'] : 'visible';
      return a !== 'hidden' && a !== 'clip' && b !== 'hidden' && b !== 'clip';
    }
    return /(auto|scroll|overlay)/.test(getComputedStyle(el)[axis === 'y' ? 'overflowY' : 'overflowX']);
  }
  function scrollParent(el, axis) {
    for (let n = el; n && n.nodeType === 1; n = composedParent(n)) if (canScroll(n, axis)) return n;
    return null;
  }
  function pageScroller(axis) {
    const se = document.scrollingElement || document.documentElement;
    if (canScroll(se, axis)) return se;
    const v = vp();
    const mid = hitAt(v.w / 2, v.h / 2);
    const p = mid && scrollParent(mid, axis);
    if (p) return p;
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('*')) {
      if (!canScroll(el, axis)) continue;
      const r = clipVp(el.getBoundingClientRect());
      const a = r ? r.width * r.height : 0;
      if (a > bestArea) {
        best = el;
        bestArea = a;
      }
    }
    return best;
  }
  // For human-paced scrolling with the mouse wheel: where to put the pointer and how far the
  // innermost container that hides the element (or the page) still has to move.
  function pageWheelPoint() {
    const v = vp();
    const se = document.scrollingElement || document.documentElement;
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.3], [0.5, 0.7], [0.25, 0.5], [0.75, 0.5], [0.15, 0.85], [0.85, 0.15]]) {
      const x = v.w * fx;
      const y = v.h * fy;
      const hit = hitAt(x, y);
      if (!hit) continue;
      const sp = scrollParent(hit, 'y');
      if (!sp || sp === se || isPageScroller(sp)) return { x, y };
    }
    return { x: v.w / 2, y: v.h / 2 };
  }
  function scrollPlan(ref) {
    const el = lookup(ref);
    if (!el) return { error: gone(ref) };
    return scrollPlanFor(el);
  }
  function scrollPlanFor(el) {
    const r = bestRect(el) || el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let n = composedParent(el); n && n.nodeType === 1; n = composedParent(n)) {
      if (isPageScroller(n)) break;
      const sx = canScroll(n, 'x');
      const sy = canScroll(n, 'y');
      if (!sx && !sy) continue;
      const b = n.getBoundingClientRect();
      const l = b.left + n.clientLeft;
      const t = b.top + n.clientTop;
      const dx = sx && (r.left < l || r.right > l + n.clientWidth) ? cx - (l + n.clientWidth / 2) : 0;
      const dy = sy && (r.top < t || r.bottom > t + n.clientHeight) ? cy - (t + n.clientHeight / 2) : 0;
      if (!dx && !dy) continue;
      const vis = clipVp({ left: l, top: t, right: l + n.clientWidth, bottom: t + n.clientHeight, width: n.clientWidth, height: n.clientHeight });
      if (!vis) break; // the container is off screen itself: move the page first
      return { need: true, x: vis.left + vis.width / 2, y: vis.top + vis.height / 2, dx, dy, pos: [n.scrollLeft, n.scrollTop] };
    }
    const v = vp();
    const fits = r.top >= 0 && r.bottom <= v.h && r.left >= 0 && r.right <= v.w;
    const big = r.height > v.h && r.top < v.h * 0.6 && r.bottom > v.h * 0.4;
    if (fits || big) return { need: false };
    const p = pageWheelPoint();
    return { need: true, x: p.x, y: p.y, dx: r.left < 0 || r.right > v.w ? cx - v.w / 2 : 0, dy: r.top < 0 || r.bottom > v.h ? cy - v.h / 2 : 0, pos: [scrollX, scrollY] };
  }
  // Where to put the pointer to scroll in a direction with the wheel: over the page, or over the
  // scroll pane that holds the given element.
  function wheelTarget(o) {
    o = o || {};
    const el = o.ref ? lookup(o.ref) : null;
    if (o.ref && !el) return { error: gone(o.ref) };
    const axis = o.direction === 'left' || o.direction === 'right' ? 'x' : 'y';
    const sc = (el && scrollParent(el, axis)) || pageScroller(axis);
    if (!sc) return { error: 'Nothing on this page can scroll ' + (o.direction || 'down') };
    const v = vp();
    let p = null;
    if (!isPageScroller(sc)) {
      const b = sc.getBoundingClientRect();
      const vis = clipVp({ left: b.left + sc.clientLeft, top: b.top + sc.clientTop, right: b.left + sc.clientLeft + sc.clientWidth, bottom: b.top + sc.clientTop + sc.clientHeight, width: sc.clientWidth, height: sc.clientHeight });
      if (vis) p = { x: vis.left + vis.width / 2, y: vis.top + vis.height / 2, w: vis.width, h: vis.height };
    }
    if (!p) p = { ...pageWheelPoint(), w: v.w, h: v.h };
    return { ...p, pos: [sc.scrollLeft, sc.scrollTop] };
  }
  function scroll(o) {
    o = o || {};
    const el = o.ref ? lookup(o.ref) : null;
    if (o.ref && !el) return { error: gone(o.ref) };
    const dir = o.direction || (o.to === 'left' || o.to === 'right' ? o.to : o.to ? (o.to === 'top' ? 'up' : 'down') : 'down');
    const axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
    const sc = (el && scrollParent(el, axis)) || pageScroller(axis);
    if (!sc) return { error: 'Nothing on this page can scroll ' + dir };
    const se = document.scrollingElement || document.documentElement;
    const before = o.from || [sc.scrollLeft, sc.scrollTop];
    const span = axis === 'y' ? (sc === se ? vp().h : sc.clientHeight) : sc === se ? vp().w : sc.clientWidth;
    const amount = o.amount || Math.round(span * 0.85);
    // the scrolling itself happened with the mouse wheel; report where things are
    return {
      amount,
      dir,
      moved: before[0] !== sc.scrollLeft || before[1] !== sc.scrollTop,
      x: Math.round(sc.scrollLeft),
      y: Math.round(sc.scrollTop),
      maxX: Math.max(0, sc.scrollWidth - sc.clientWidth),
      maxY: Math.max(0, sc.scrollHeight - (sc === se ? Math.round(vp().h) : sc.clientHeight)),
      what: sc === se ? 'page' : describe(sc),
    };
  }
  // ---------------------------------------------------------------- reading & waiting
  function pageText() {
    let t = document.body ? document.body.innerText || '' : '';
    if (hasShadow && document.body) t += '\n' + textOf(document.body, 200000);
    return t;
  }
  function check(c) {
    const out = {};
    if (c.text != null || c.textGone != null) {
      const hay = pageText().toLowerCase();
      if (c.text != null) out.text = hay.includes(String(c.text).toLowerCase());
      if (c.textGone != null) out.textGone = !hay.includes(String(c.textGone).toLowerCase());
    }
    const vis = (sel) => {
      const m = qsa(sel);
      if (m.error) return { error: m.error };
      return m.els.some((el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true));
    };
    if (c.selector) {
      const v = vis(c.selector);
      if (v && v.error) return v;
      out.selector = v;
    }
    if (c.selectorGone) {
      const v = vis(c.selectorGone);
      if (v && v.error) return v;
      out.selectorGone = !v;
    }
    out.url = location.href;
    return out;
  }
  function text(o) {
    o = o || {};
    let el = document.body || document.documentElement;
    if (o.ref) {
      el = lookup(o.ref);
      if (!el) return { error: gone(o.ref) };
    } else if (o.selector) {
      const m = qsa(o.selector);
      if (m.error) return m;
      if (!m.els.length) return { error: `No element matches selector ${q(o.selector)}` };
      el = m.els[0];
    }
    let t = el.innerText;
    if (t == null || (!t.trim() && rootOf(el))) t = textOf(el, 500000);
    if (hasShadow && !o.ref && !o.selector) {
      const deep = textOf(el, 500000);
      if (deep.length > clean(t).length * 1.2) t = deep;
    }
    t = String(t).replace(/[ \t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    t = t.replace(INVISIBLE, '');
    const off = Math.max(0, o.offset || 0);
    const max = o.max || 20000;
    return { text: t.slice(off, cutEnd(t, off + max)), total: t.length, offset: off, url: location.href, title: document.title };
  }
  function state() {
    const v = vp();
    const d = docSize();
    const a = deepActive();
    return {
      url: location.href,
      title: document.title,
      ready: document.readyState,
      vw: Math.round(v.w),
      vh: Math.round(v.h),
      sx: Math.round(scrollX),
      sy: Math.round(scrollY),
      sw: d.w,
      sh: d.h,
      dpr: devicePixelRatio,
      focused: a && a !== document.body && a !== document.documentElement ? describe(a) : '',
    };
  }
  function mutationAge() {
    return performance.now() - lastMut;
  }

  // ---------------------------------------------------------------- geometry for the cursor and screenshots
  // The last trusted pointer event tells exactly where this viewport sits on the screen
  // (screenX - clientX), which places the on-screen cursor overlay to the pixel.
  let lastPointer = null;
  addEventListener(
    'pointermove',
    (e) => {
      if (e.isTrusted) lastPointer = { sx: e.screenX, sy: e.screenY, cx: e.clientX, cy: e.clientY, at: Date.now(), wx: screenX, wy: screenY, iw: innerWidth, ih: innerHeight };
    },
    { capture: true, passive: true }
  );
  function geom() {
    const v = vp();
    return {
      dpr: devicePixelRatio,
      wx: screenX,
      wy: screenY,
      ow: outerWidth,
      oh: outerHeight,
      iw: innerWidth,
      ih: innerHeight,
      vw: v.w,
      vh: v.h,
      al: screen.availLeft || 0,
      at: screen.availTop || 0,
      // where the viewport sits on screen is only known from a pointer event taken in the current
      // window position and size; after a move, resize or toolbar change it is stale
      pointer: lastPointer && lastPointer.wx === screenX && lastPointer.wy === screenY && lastPointer.iw === innerWidth && lastPointer.ih === innerHeight ? lastPointer : null,
      focused: document.hasFocus(),
      visible: document.visibilityState,
    };
  }
  // Boxes of the interactive elements in view, for ref labels drawn onto a screenshot image by the
  // service worker (never into the page).
  function labelBoxes() {
    const S = collect({ viewportOnly: true, interactiveOnly: true });
    const out = [];
    for (const e of S.entries) {
      if (e.kind !== 'item' || !e.ref || e.dup) continue;
      const r = bestRect(e.el);
      const v = r && clipVp(r);
      if (v) out.push({ ref: e.ref, x: v.left, y: v.top, w: v.width, h: v.height });
    }
    return out;
  }

  // ---------------------------------------------------------------- bot checks (handed to the human)
  const CAPTCHA_FRAMES = [
    [/\/recaptcha\/(api2|enterprise)\/anchor/, 'reCAPTCHA checkbox'],
    [/\/recaptcha\/(api2|enterprise)\/bframe/, 'reCAPTCHA image challenge'],
    [/hcaptcha\.com\/captcha\//, 'hCaptcha'],
    [/challenges\.cloudflare\.com\/|\/cdn-cgi\/challenge-platform\//, 'Cloudflare Turnstile'],
    [/arkoselabs\.com|funcaptcha\.com/, 'Arkose challenge'],
    [/captcha-delivery\.com/, 'DataDome check'],
    [/geetest\.com/, 'GeeTest'],
    [/awswaf\.com|captcha\.aws/, 'AWS WAF captcha'],
  ];
  function deepFrames() {
    const out = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.localName === 'iframe' || el.localName === 'frame') out.push(el);
        const sr = rootOf(el);
        if (sr) walk(sr);
      }
    };
    walk(document);
    return out;
  }
  // Visible challenges in this document that a person has to solve. Invisible reCAPTCHA badges
  // and widgets that already hold a token do not count.
  function challenges() {
    const out = [];
    const page = humanCheck();
    if (page) out.push({ kind: page, page: true });
    const token = (sel) => Array.from(document.querySelectorAll(sel)).some((t) => (t.value || '').length > 20);
    const solved = {
      recaptcha: token('textarea[name="g-recaptcha-response"]'),
      hcaptcha: token('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]'),
      turnstile: token('input[name="cf-turnstile-response"]'),
    };
    for (const f of deepFrames()) {
      const src = f.src || f.getAttribute('src') || '';
      const m = CAPTCHA_FRAMES.find(([re]) => re.test(src));
      if (!m || /[?&]size=invisible/.test(src) || !frameShown(f)) continue;
      const kind = m[1];
      if (kind === 'reCAPTCHA checkbox' && solved.recaptcha) continue;
      if (kind === 'hCaptcha' && solved.hcaptcha && !/frame=challenge/.test(src)) continue;
      if (kind === 'Cloudflare Turnstile' && solved.turnstile) continue;
      const r = f.getBoundingClientRect();
      out.push({ kind, frameId: frameIdOf(f), box: { x: r.left, y: r.top, w: r.width, h: r.height } });
    }
    return { list: out, url: location.href };
  }

  // Is the element that text/selector/role names there and usable? (wait_for enabled: a "Next"
  // that stays disabled until an upload finishes)
  function enabled(o) {
    const r = query(o);
    const el = r && r.ref ? lookup(r.ref) : null;
    if (!el) return { found: false };
    const off = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('[aria-disabled="true"], fieldset[disabled], [inert]');
    return { found: true, enabled: !off, ref: r.ref };
  }

  // ---------------------------------------------------------------- dispatcher
  const API = { snapshot, find, query, point, hits, at, humanCheck, challenges, scrollPlan, frameScrollPlan, pageWheelPoint, wheelTarget, frameRectById, frameHitById, frameList, prepareFill, value, kind, focusInfo, loginForm, armInvalid, invalidSeen, scroll, check, text, state, mutationAge, describeRef, geom, labelBoxes, enabled };
  function run(method, ctx, args) {
    setup(ctx);
    const fn = API[method];
    if (!fn) return { error: 'Unknown agent method ' + method };
    const res = fn.apply(null, args || []);
    const wrap = (v) => (v && typeof v === 'object' && !(v instanceof Element) && !Array.isArray(v) ? Object.assign(v, { counter }) : v);
    return res && typeof res.then === 'function' ? res.then(wrap) : wrap(res);
  }
  G.__browzie = { v: VERSION, run };
  // The service worker talks to this frame with chrome.tabs.sendMessage(tabId, msg, { frameId }).
  // Chrome loads this file from disk each time it is injected, while a running service worker
  // keeps its old code until the extension reloads: a service worker one version back gets
  // answers too (its calls are the same).
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (!msg || (msg.browzie !== VERSION && msg.browzie !== VERSION - 1)) return undefined;
    let res;
    try {
      res = run(msg.method, msg.ctx, msg.args);
    } catch (e) {
      reply({ error: String((e && e.message) || e) });
      return undefined;
    }
    if (res && typeof res.then === 'function') {
      res.then(
        (v) => reply(v === undefined ? null : v),
        (e) => reply({ error: String((e && e.message) || e) })
      );
      return true;
    }
    reply(res === undefined ? null : res);
    return undefined;
  });
})();
