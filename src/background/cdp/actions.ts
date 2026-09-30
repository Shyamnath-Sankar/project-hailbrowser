import type { IndexedElement } from "../../shared/types";

/**
 * Real input through the Chrome DevTools Protocol. Synthetic DOM events are
 * rejected by many sites (they check isTrusted), so every click and keystroke
 * goes through the debugger instead.
 */

const attached = new Set<number>();

export async function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attached.add(tabId);
  await send(tabId, "Page.enable");
  await send(tabId, "DOM.enable");
  await send(tabId, "Runtime.enable");
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The tab may already be gone; nothing to clean up.
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

function send<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  return chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>;
}

const center = (el: IndexedElement) => ({
  x: el.box.x + el.box.w / 2,
  y: el.box.y + el.box.h / 2,
});

async function mouse(
  tabId: number,
  type: "mousePressed" | "mouseReleased" | "mouseMoved",
  x: number,
  y: number,
  clickCount = 1,
): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" ? "none" : "left",
    buttons: type === "mousePressed" ? 1 : 0,
    clickCount: type === "mouseMoved" ? 0 : clickCount,
  });
}

/** Scrolls an element into view before acting, since boxes are viewport-relative. */
async function ensureInView(tabId: number, el: IndexedElement): Promise<IndexedElement> {
  const vh = await viewportHeight(tabId);
  const c = center(el);
  if (c.y >= 40 && c.y <= vh - 40) return el;

  const delta = c.y - vh / 2;
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 20,
    y: Math.min(Math.max(c.y, 100), vh - 100),
    deltaX: 0,
    deltaY: delta,
  });
  await pause(350);
  return { ...el, box: { ...el.box, y: el.box.y - delta } };
}

async function viewportHeight(tabId: number): Promise<number> {
  const res = await send<{ result?: { value?: number } }>(tabId, "Runtime.evaluate", {
    expression: "window.innerHeight",
    returnByValue: true,
  });
  return res.result?.value ?? 800;
}

export async function clickElement(tabId: number, el: IndexedElement): Promise<void> {
  const target = await ensureInView(tabId, el);
  const c = center(target);
  await mouse(tabId, "mouseMoved", c.x, c.y);
  await mouse(tabId, "mousePressed", c.x, c.y);
  await mouse(tabId, "mouseReleased", c.x, c.y);
}

export async function hoverElement(tabId: number, el: IndexedElement): Promise<void> {
  const target = await ensureInView(tabId, el);
  const c = center(target);
  await mouse(tabId, "mouseMoved", c.x, c.y);
}

export async function typeText(
  tabId: number,
  el: IndexedElement,
  text: string,
  clear: boolean,
): Promise<void> {
  await clickElement(tabId, el);
  await pause(80);
  if (clear) {
    await pressKey(tabId, "Control+a");
    await pressKey(tabId, "Delete");
  }
  // insertText fires the input events frameworks listen for, and is far faster
  // than dispatching one key event per character.
  await send(tabId, "Input.insertText", { text });
}

/** Key names accept modifier prefixes, e.g. "Control+a" or "Shift+Tab". */
export async function pressKey(tabId: number, combo: string): Promise<void> {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  let modifiers = 0;
  for (const mod of parts) {
    const m = mod.toLowerCase();
    if (m === "alt") modifiers |= 1;
    else if (m === "control" || m === "ctrl") modifiers |= 2;
    else if (m === "meta" || m === "cmd") modifiers |= 4;
    else if (m === "shift") modifiers |= 8;
  }

  const spec = KEYS[key] ?? KEYS[key.toLowerCase()];
  const base = spec ?? {
    key,
    code: `Key${key.toUpperCase()}`,
    windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
  };

  await send(tabId, "Input.dispatchKeyEvent", {
    type: base.text ? "keyDown" : "rawKeyDown",
    modifiers,
    ...base,
  });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, ...base });
}

interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const KEYS: Record<string, KeySpec> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  a: { key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" },
};

export async function scrollBy(
  tabId: number,
  direction: "up" | "down",
  amount?: number,
): Promise<void> {
  const vh = await viewportHeight(tabId);
  const delta = (amount ?? Math.round(vh * 0.8)) * (direction === "down" ? 1 : -1);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 20,
    y: Math.round(vh / 2),
    deltaX: 0,
    deltaY: delta,
  });
}

/** JPEG keeps the payload small enough to send on most steps. */
export async function screenshot(tabId: number): Promise<string> {
  const res = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 60,
    captureBeyondViewport: false,
  });
  return `data:image/jpeg;base64,${res.data}`;
}

export const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
