// Tab-level browser operations shared by the MCP tools and both agents.
import * as cdp from './cdp.js';
import * as inj from './inject.js';

let currentTabId = null;
const shotScale = new Map(); // tabId -> CSS px per screenshot px

export function setCurrentTab(tabId) {
  currentTabId = tabId;
}

const BLOCKED = /^(chrome|edge|brave|about|chrome-extension|devtools|view-source):|^https:\/\/chrome(webstore)?\.google\.com\/(webstore)?/i;

export function isRestricted(url) {
  return !url || BLOCKED.test(url);
}

/** The tab to act on: explicit id, then the agent's current tab, then the active tab. */
export async function resolveTab(tabId) {
  if (tabId != null) {
    const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!tab) throw new Error(`No tab with id ${tabId}. Call tabs_context to list tabs.`);
    return tab;
  }
  if (currentTabId != null) {
    const tab = await chrome.tabs.get(currentTabId).catch(() => null);
    if (tab) return tab;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (tab) return tab;
  const [any] = await chrome.tabs.query({ active: true, windowType: 'normal' });
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

/** Run an injected function, retrying across navigations. */
export async function run(tabId, func, ...args) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
      return res?.result;
    } catch (e) {
      lastError = e;
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
  const metrics = await cdp.send(tabId, 'Page.getLayoutMetrics');
  const cssW = metrics.cssVisualViewport.clientWidth;
  const shot = await withTimeout(cdp.send(tabId, 'Page.captureScreenshot', { format: 'jpeg', quality: 80, optimizeForSpeed: true }), 10000,
    'Screenshot timed out (the tab may be minimized).');
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
  await run(tabId, inj.setIndicator, on, label).catch(() => {});
}

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
