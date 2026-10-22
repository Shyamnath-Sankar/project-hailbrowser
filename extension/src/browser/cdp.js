// chrome.debugger wrapper: trusted input events and screenshots that work in
// background tabs, without Chrome's --remote-debugging-port.
import { showClick } from './inject.js';

const attached = new Map(); // tabId -> Promise<void>
const dialogs = new Map(); // tabId -> open dialog {type, message, defaultPrompt, url}
const handledAlerts = new Map(); // tabId -> [message] alerts closed automatically, not yet reported
const dialogWaiters = new Map(); // tabId -> Set<() => void> commands to release when a dialog opens

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
      // Page events tell us when alert/confirm/prompt/beforeunload dialogs open.
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
    })();
    attached.set(tabId, p);
    p.catch(() => attached.delete(tabId));
  }
  return attached.get(tabId);
}

export async function send(tabId, method, params = {}) {
  await attach(tabId);
  // Input and script evaluation block while a modal dialog is up.
  if (dialogs.has(tabId) && /^(Input|Runtime)\./.test(method)) throw new DialogError(dialogs.get(tabId));
  const command = async () => {
    const out = await untilDialog(tabId, chrome.debugger.sendCommand({ tabId }, method, params));
    // An input that opened a dialog did its job; anything else can't finish while it's open.
    if (out === DIALOG && !method.startsWith('Input.')) throw new DialogError(dialogs.get(tabId));
    return out === DIALOG ? undefined : out;
  };
  try {
    return await command();
  } catch (e) {
    if (/not attached|detached/i.test(e.message)) {
      attached.delete(tabId);
      await attach(tabId);
      return command();
    }
    throw friendly(e);
  }
}

const DIALOG = Symbol('dialog');

/** Resolve early (with DIALOG) if a dialog opens while the command is in flight. */
function untilDialog(tabId, promise) {
  let release;
  const opened = new Promise((resolve) => { release = () => resolve(DIALOG); });
  if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
  dialogWaiters.get(tabId).add(release);
  return Promise.race([promise, opened]).finally(() => dialogWaiters.get(tabId)?.delete(release));
}

/** Run a non-CDP promise (e.g. executeScript), failing with DialogError if a dialog opens meanwhile. */
export function raceDialog(tabId, promise) {
  return untilDialog(tabId, promise).then((out) => {
    if (out === DIALOG) throw new DialogError(dialogs.get(tabId));
    return out;
  });
}

export function openDialog(tabId) {
  return dialogs.get(tabId) || null;
}

/** Alerts that were closed automatically since the last call. */
export function takeHandledAlerts(tabId) {
  const list = handledAlerts.get(tabId) || [];
  handledAlerts.delete(tabId);
  return list;
}

/** Accept or dismiss the open dialog. Works even if the dialog opened before we attached. */
export async function handleDialog(tabId, accept, promptText) {
  await attach(tabId);
  // Read it first: the "dialog closed" event can arrive before the command resolves.
  const was = dialogs.get(tabId) || { type: 'dialog', message: '' };
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept, ...(promptText != null ? { promptText } : {}) });
  } catch (e) {
    if (/No dialog/i.test(e.message)) { dialogs.delete(tabId); return null; }
    throw friendly(e);
  }
  dialogs.delete(tabId);
  return was;
}

export class DialogError extends Error {
  constructor(d) {
    d ||= { type: 'dialog', message: '' };
    super(`A ${d.type} dialog is open: "${String(d.message).slice(0, 300)}". The page is frozen until it is closed: call handle_dialog with accept=true or false.`);
    this.dialog = d;
  }
}

function onDialogOpening(tabId, params) {
  const d = { type: params.type, message: params.message || '', defaultPrompt: params.defaultPrompt || '', url: params.url };
  if (d.type === 'alert') {
    // A plain alert only informs: close it and report the message with the next tool result.
    if (!handledAlerts.has(tabId)) handledAlerts.set(tabId, []);
    handledAlerts.get(tabId).push(d.message);
    chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
    return;
  }
  dialogs.set(tabId, d);
  for (const release of [...(dialogWaiters.get(tabId) || [])]) release();
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
  chrome.debugger.onDetach.addListener(({ tabId }) => { attached.delete(tabId); dialogs.delete(tabId); });
  chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); dialogs.delete(tabId); handledAlerts.delete(tabId); });
  chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
    if (method === 'Page.javascriptDialogOpening') onDialogOpening(tabId, params);
    else if (method === 'Page.javascriptDialogClosed') dialogs.delete(tabId);
  });
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

let effects = true;
/** Show the agent cursor and click ripple in pages (follows the "glow on controlled tabs" setting). */
export function setEffects(on) {
  effects = !!on;
}

export async function mouseClick(tabId, x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
  if (effects) chrome.scripting.executeScript({ target: { tabId }, func: showClick, args: [x, y] }).catch(() => {});
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
