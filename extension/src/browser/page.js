// Tab-level browser operations shared by the MCP tools and both agents.
import * as cdp from './cdp.js';
import * as inj from './inject.js';

let currentTabId = null;
let currentTabListener = null;
const shotScale = new Map(); // tabId -> CSS px per screenshot px

// The agent's tab survives service-worker restarts (session storage lasts until Chrome closes).
const restored = globalThis.chrome?.storage?.session
  ? chrome.storage.session.get('hailCurrentTab').then(({ hailCurrentTab }) => { if (currentTabId == null && hailCurrentTab != null) currentTabId = hailCurrentTab; }).catch(() => {})
  : Promise.resolve();

export function setCurrentTab(tabId, { quiet = false } = {}) {
  currentTabId = tabId;
  chrome.storage?.session?.set({ hailCurrentTab: tabId }).catch(() => {});
  if (!quiet) currentTabListener?.(tabId);
}

export function currentTab() {
  return currentTabId;
}

/** Called whenever an agent switches to, opens or navigates a tab. */
export function onCurrentTab(fn) {
  currentTabListener = fn;
}

const BLOCKED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):|^https:\/\/chrome(webstore)?\.google\.com\/(webstore)?/i;

export function isRestricted(url) {
  return !url || BLOCKED.test(url);
}

const ownPage = (t) => (t?.url || t?.pendingUrl || '').startsWith(`chrome-extension://${globalThis.chrome?.runtime?.id}/`);

/** The tab to act on: explicit id, then the agent's current tab, then the active tab (never HailBrowser's own pages). */
export async function resolveTab(tabId) {
  await restored;
  if (tabId != null) {
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab) throw new Error(`No tab with id ${tabId}. Call tabs_context to list tabs.`);
    return tab;
  }
  if (currentTabId != null) {
    const tab = await chrome.tabs.get(currentTabId).catch(() => null);
    if (tab && !ownPage(tab)) return tab;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (tab && !ownPage(tab)) return tab;
  const any = (await chrome.tabs.query({ active: true, windowType: 'normal' })).find((t) => !ownPage(t))
    || (await chrome.tabs.query({ windowType: 'normal' })).find((t) => !ownPage(t));
  if (!any) throw new Error('No browser tab available. Call tabs_create first.');
  return any;
}

export async function waitForLoad(tabId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Tab was closed');
    if (tab.status === 'complete') return tab;
    await sleep(100);
  }
  return chrome.tabs.get(tabId);
}

const RUN_TIMEOUT_MS = 20000;

/** Run an injected function, retrying across navigations. Never hangs: dialogs and frozen pages fail with a reason. */
export async function run(tabId, func, ...args) {
  const open = cdp.openDialog(tabId);
  if (open) throw new cdp.DialogError(open);
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const exec = chrome.scripting.executeScript({ target: { tabId }, func, args });
      const [res] = await withTimeout(cdp.raceDialog(tabId, exec), RUN_TIMEOUT_MS,
        `The page did not respond within ${RUN_TIMEOUT_MS / 1000}s. It may be busy, or frozen by a dialog (alert/confirm) ` +
        'that opened before HailBrowser was watching: call handle_dialog to close it, or take a screenshot to check.');
      return res?.result;
    } catch (e) {
      lastError = e;
      if (e instanceof cdp.DialogError || /did not respond within/.test(e.message)) throw e;
      if (/Cannot access|cannot be scripted|chrome:\/\//i.test(e.message)) {
        throw new Error('Chrome blocks extensions on this page. Navigate to a normal http(s) page first.');
      }
      if (!/Frame|removed|navigat|No tab|context invalidated|back\/forward cache/i.test(e.message)) throw e;
      await sleep(150);
      await waitForLoad(tabId, 8000).catch(() => {});
    }
  }
  throw lastError;
}

export async function observe(tabId, opts) {
  const snap = await run(tabId, inj.pageSnapshot, opts || {});
  if (!snap || snap.error) throw new Error(snap?.error || 'Could not read the page');
  return snap;
}

export async function navigate(tabId, url) {
  if (url === 'back' || url === 'forward') {
    await (url === 'back' ? chrome.tabs.goBack(tabId) : chrome.tabs.goForward(tabId)).catch(() => {});
  } else if (url === 'reload') {
    await chrome.tabs.reload(tabId);
  } else {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    if (!/^(https?|file|data):/i.test(url)) throw new Error('Only http(s), file and data URLs can be opened.');
    await chrome.tabs.update(tabId, { url });
  }
  await sleep(120);
  return waitForLoad(tabId);
}

export async function screenshot(tabId, maxWidth = 1280) {
  // The model should see the page itself, not HailBrowser's glow and status pill.
  const hid = await run(tabId, inj.overlayVisible, false).catch(() => false);
  try {
    return await capturePage(tabId, maxWidth);
  } finally {
    if (hid) run(tabId, inj.overlayVisible, true).catch(() => {});
  }
}

async function capturePage(tabId, maxWidth) {
  const metrics = await cdp.send(tabId, 'Page.getLayoutMetrics');
  const cssW = metrics.cssVisualViewport.clientWidth;
  const capture = (extra, ms) => withTimeout(cdp.send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true, ...extra }), ms,
    'Screenshot timed out (the tab may be minimized or its window hidden). Use read_page instead.');
  let shot;
  try {
    shot = await capture({}, 4000);
  } catch (e) {
    if (!/timed out/.test(e.message)) throw e;
    // Background tabs sometimes produce no new frame. Capturing "beyond the viewport" resizes the
    // view for the capture, which forces Chrome to draw one; clip it back to what is on screen.
    const v = metrics.cssVisualViewport;
    shot = await capture({ captureBeyondViewport: true, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 } }, 8000);
  }
  const blob = await (await fetch(`data:image/jpeg;base64,${shot.data}`)).blob();
  const bmp = await createImageBitmap(blob);
  const width = Math.min(Math.round(cssW), maxWidth);
  const height = Math.round(bmp.height * (width / bmp.width));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bmp, 0, 0, width, height);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  shotScale.set(tabId, cssW / width);
  return { data: toBase64(await out.arrayBuffer()), mimeType: 'image/jpeg', width, height };
}

/** Screenshot pixel coordinates -> CSS pixels used by CDP input. */
export function toCss(tabId, x, y) {
  const s = shotScale.get(tabId) || 1;
  return [x * s, y * s];
}

export async function pointFor(tabId, nodeId) {
  const point = await run(tabId, inj.resolveNode, nodeId);
  if (!point) throw new Error('Could not locate the element');
  if (point.error === 'stale') throw new StaleError('That element no longer exists. Read the page again for fresh refs.');
  if (point.error === 'covered') throw new Error(`The element is covered by "${point.coveredBy}". Close the overlay or scroll first.`);
  if (point.error) throw new Error(`Element ${point.error}`);
  return point;
}

export async function setIndicator(tabId, on, label) {
  // executeScript rejects `undefined` arguments, so always pass a string (an undefined label used to
  // make every "turn the glow off" call fail silently).
  await run(tabId, inj.setIndicator, !!on, label || '').catch(() => {});
}

/**
 * After an input that may navigate (click, Enter), wait briefly for navigation to
 * start and, if it does, for the new page to load. Returns the settled tab.
 */
export async function settleAfterInput(tabId, beforeUrl, windowMs = 400) {
  const started = Date.now();
  while (Date.now() - started < windowMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('Tab was closed');
    if (tab.status === 'loading' || (tab.pendingUrl && tab.pendingUrl !== beforeUrl)) return waitForLoad(tabId);
    if (tab.url !== beforeUrl) return tab; // same-document navigation (SPA)
    await sleep(50);
  }
  return chrome.tabs.get(tabId);
}

/**
 * Collect tabs opened while an action runs (target=_blank links, window.open) until stop().
 * Chrome does not reliably credit the opener (noopener links, background tabs), so every tab
 * created during the short action window counts.
 */
export function watchNewTabs(tabId) {
  const opened = [];
  const listener = (t) => { if (t.id !== tabId) opened.push(t.id); };
  chrome.tabs.onCreated.addListener(listener);
  return {
    async stop(graceMs = 0) { // callers already waited for navigation; new tabs show up within that
      if (graceMs) await sleep(graceMs);
      chrome.tabs.onCreated.removeListener(listener);
      const tabs = await Promise.all(opened.map((id) => chrome.tabs.get(id).catch(() => null)));
      return tabs.filter(Boolean);
    },
  };
}

export function shorten(s, n = 200) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const SPECIAL_INPUT_HINT = 'Use the format the browser expects, e.g. 2026-09-20 for dates, 19:30 for times, 2026-09 for months, #ff0000 for colors.';

export class StaleError extends Error {}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
