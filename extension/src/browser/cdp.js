// chrome.debugger wrapper: trusted input events and screenshots that work in
// background tabs, without Chrome's --remote-debugging-port.

const attached = new Map(); // tabId -> Promise<void>

export function attach(tabId) {
  if (!attached.has(tabId)) {
    const p = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, '1.3');
      } catch (e) {
        if (!/already attached/i.test(e.message)) throw friendly(e);
      }
      // Keep background tabs rendering (rAF, animations) without bringing them to the front.
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    })();
    attached.set(tabId, p);
    p.catch(() => attached.delete(tabId));
  }
  return attached.get(tabId);
}

export async function send(tabId, method, params = {}) {
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (e) {
    if (/not attached|detached/i.test(e.message)) {
      attached.delete(tabId);
      await attach(tabId);
      return chrome.debugger.sendCommand({ tabId }, method, params);
    }
    throw friendly(e);
  }
}

export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

export function detachAll() {
  return Promise.all([...attached.keys()].map(detach));
}

function friendly(e) {
  if (/Cannot access|chrome:\/\/|chrome-extension:\/\/|Cannot attach/i.test(e.message)) {
    return new Error(`Chrome blocks extensions on this page (${e.message}). Navigate to a normal http(s) page first.`);
  }
  return e;
}

if (globalThis.chrome?.debugger) {
  chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => attached.delete(tabId));
}

// ---------- input helpers ----------

const MOD = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };
const KEYS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

/** Parse "ctrl+shift+a" into a CDP key event description. */
export function parseChord(chord) {
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
  let modifiers = 0;
  const keyPart = parts.pop();
  for (const p of parts) {
    const bit = MOD[p.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${p}" in "${chord}"`);
    modifiers |= bit;
  }
  let def = KEYS[keyPart.toLowerCase()];
  if (!def && /^f([1-9]|1[0-2])$/i.test(keyPart)) {
    const n = Number(keyPart.slice(1));
    def = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
  }
  if (!def && keyPart.length === 1) {
    const ch = keyPart;
    const upper = ch.toUpperCase();
    const code = /[a-z]/i.test(ch) ? `Key${upper}` : /[0-9]/.test(ch) ? `Digit${ch}` : '';
    def = { key: modifiers & 8 ? upper : ch, code, keyCode: upper.charCodeAt(0), text: ch };
  }
  if (!def) throw new Error(`Unknown key "${keyPart}"`);
  const out = { ...def, modifiers };
  if (modifiers & (2 | 4)) {
    delete out.text;
    const cmd = EDIT_COMMANDS[keyPart.toLowerCase()];
    if (cmd) out.commands = [cmd];
  }
  return out;
}

export async function pressChord(tabId, chord) {
  const k = parseChord(chord);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text, unmodifiedText: k.text, commands: k.commands });
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

export async function mouseClick(tabId, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
  for (let i = 1; i <= clickCount; i++) {
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
    await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
  }
}

export function mouseMove(tabId, x, y) {
  return send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}

export function wheel(tabId, x, y, deltaX, deltaY) {
  return send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
}

export async function insertText(tabId, text, { replace = false } = {}) {
  if (replace) {
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, commands: ['selectAll'] });
    await send(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  }
  await send(tabId, 'Input.insertText', { text });
}

export function modifierMask(list) {
  return (list || []).reduce((m, p) => m | (MOD[String(p).toLowerCase()] || 0), 0);
}
