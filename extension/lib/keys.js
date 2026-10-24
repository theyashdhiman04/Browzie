// US keyboard layout definitions for Input.dispatchKeyEvent.
const KEYS = new Map();

function def(key, code, keyCode, text, location = 0) {
  KEYS.set(key, { key, code, keyCode, text, location });
}

def('Enter', 'Enter', 13, '\r');
def('Tab', 'Tab', 9);
def('Backspace', 'Backspace', 8);
def('Delete', 'Delete', 46);
def('Escape', 'Escape', 27);
def('ArrowLeft', 'ArrowLeft', 37);
def('ArrowUp', 'ArrowUp', 38);
def('ArrowRight', 'ArrowRight', 39);
def('ArrowDown', 'ArrowDown', 40);
def('Home', 'Home', 36);
def('End', 'End', 35);
def('PageUp', 'PageUp', 33);
def('PageDown', 'PageDown', 34);
def('Insert', 'Insert', 45);
def('Shift', 'ShiftLeft', 16, undefined, 1);
def('Control', 'ControlLeft', 17, undefined, 1);
def('Alt', 'AltLeft', 18, undefined, 1);
def('Meta', 'MetaLeft', 91, undefined, 1);
def('CapsLock', 'CapsLock', 20);
def('ContextMenu', 'ContextMenu', 93);
def(' ', 'Space', 32, ' ');
for (let i = 1; i <= 12; i++) def('F' + i, 'F' + i, 111 + i);
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  const upper = lower.toUpperCase();
  def(lower, 'Key' + upper, 65 + i, lower);
  KEYS.set(upper, { key: upper, code: 'Key' + upper, keyCode: 65 + i, text: upper, location: 0, shift: true });
}
const shiftedDigits = ')!@#$%^&*(';
for (let d = 0; d <= 9; d++) {
  def(String(d), 'Digit' + d, 48 + d, String(d));
  const s = shiftedDigits[d];
  KEYS.set(s, { key: s, code: 'Digit' + d, keyCode: 48 + d, text: s, location: 0, shift: true });
}
for (const [plain, shifted, code, keyCode] of [
  [';', ':', 'Semicolon', 186],
  ['=', '+', 'Equal', 187],
  [',', '<', 'Comma', 188],
  ['-', '_', 'Minus', 189],
  ['.', '>', 'Period', 190],
  ['/', '?', 'Slash', 191],
  ['`', '~', 'Backquote', 192],
  ['[', '{', 'BracketLeft', 219],
  ['\\', '|', 'Backslash', 220],
  [']', '}', 'BracketRight', 221],
  ["'", '"', 'Quote', 222],
]) {
  def(plain, code, keyCode, plain);
  KEYS.set(shifted, { key: shifted, code, keyCode, text: shifted, location: 0, shift: true });
}

const ALIASES = {
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  space: ' ',
  spacebar: ' ',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pgup: 'PageUp',
  pagedown: 'PageDown',
  pgdn: 'PageDown',
  insert: 'Insert',
  ins: 'Insert',
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  super: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  capslock: 'CapsLock',
  contextmenu: 'ContextMenu',
  plus: '+',
};

const MOD_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function normalizeKey(name) {
  if (KEYS.has(name)) return name;
  const a = ALIASES[name.toLowerCase()];
  if (a) return a;
  if (/^f([1-9]|1[0-2])$/i.test(name)) return name.toUpperCase();
  return null;
}

// "Control+Shift+K" -> { mods: ['Control', 'Shift'], key: 'K' }. "Control++" presses the + key.
function parseCombo(combo) {
  const s = String(combo);
  if (!s) throw new Error('Empty key');
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '+' && cur !== '') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur !== '') parts.push(cur);
  const keyName = parts.pop();
  const mods = parts.map((m) => {
    const n = normalizeKey(m.trim());
    if (!n || !MOD_BITS[n]) throw new Error(`Unknown modifier "${m}" in "${s}". Use Control, Shift, Alt or Meta.`);
    return n;
  });
  const key = keyName.length === 1 ? keyName : normalizeKey(keyName.trim());
  if (!key || (key.length > 1 && !KEYS.has(key))) throw new Error(`Unknown key "${keyName}" in "${s}"`);
  return { mods, key };
}

function keyInfo(key) {
  return KEYS.get(key) || null;
}


// CDP parameters for one key event. type: 'down' | 'up'. Keys that produce text send keyDown
// with text (so keypress and input fire); everything else sends rawKeyDown, like a real keyboard.
function keyEvent(info, type, modifiers) {
  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    modifiers,
    location: info.location || 0,
  };
  if (type === 'up') return { type: 'keyUp', ...base };
  const withText = info.text !== undefined && !(modifiers & (1 | 2 | 4));
  return withText ? { type: 'keyDown', ...base, text: info.text, unmodifiedText: info.text } : { type: 'rawKeyDown', ...base };
}

// The key a character is typed with, or null when the US layout has no key for it (it is then
// committed with Input.insertText, the way an IME or the emoji panel delivers text).
function keyForChar(ch) {
  if (ch === '\n' || ch === '\r') return KEYS.get('Enter');
  if (ch === '\t') return KEYS.get('Tab');
  return KEYS.get(ch) || null;
}

export { parseCombo, keyInfo, MOD_BITS, normalizeKey, keyEvent, keyForChar };
