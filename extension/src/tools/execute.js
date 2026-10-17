// Tool executor. Results use MCP content parts: {type:'text',text} | {type:'image',data,mimeType}.
import * as cdp from '../browser/cdp.js';
import * as inj from '../browser/inject.js';
import * as page from '../browser/page.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });

export function parseRef(value) {
  const m = /^(?:ref_)?(\d+)$/.exec(String(value ?? '').trim());
  if (!m) throw new Error(`Invalid ref "${value}". Use a ref like "ref_12" from read_page or find.`);
  return Number(m[1]);
}

export function formatElement(el) {
  let line = `[ref_${el.id}] ${el.role} "${el.label}"`;
  if (el.value) line += ` value="${el.value}"`;
  if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
  for (const k of ['checked', 'selected', 'expanded']) if (el[k] != null) line += ` ${k}=${el[k]}`;
  if (el.options) line += ` options=[${el.options.slice(0, 15).map((o) => o.label).join(' | ')}${el.options.length > 15 ? ' | …' : ''}]`;
  if (el.href && el.role === 'link') line += ` -> ${el.href}`;
  if (!el.inViewport) line += ' (offscreen)';
  return line;
}

export function formatSnapshot(snap, { includeText = true } = {}) {
  const lines = [
    `Page: ${snap.title || '(untitled)'} — ${snap.url}`,
    `Viewport ${snap.viewport.w}x${snap.viewport.h}, scrolled ${snap.scroll.y}/${Math.max(0, snap.scroll.height - snap.viewport.h)}px`,
    '',
    `Interactive elements (${snap.elements.length}${snap.omitted ? `, ${snap.omitted} more omitted` : ''}):`,
    ...snap.elements.map(formatElement),
  ];
  if (includeText && snap.text) lines.push('', 'Visible text:', snap.text);
  return lines.join('\n');
}

async function describeTab(tab) {
  return `Tab ${tab.id}: ${tab.title || '(untitled)'} — ${tab.url || tab.pendingUrl || ''}`;
}

const HANDLERS = {
  async tabs_context() {
    const current = await page.resolveTab().catch(() => null);
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const lines = tabs.map((t) => `${t.id === current?.id ? '→' : ' '} [${t.id}] ${t.active ? '(active) ' : ''}${t.title || '(untitled)'} — ${t.url || t.pendingUrl || ''}`);
    return text(`Current agent tab: ${current ? current.id : 'none'}\n${lines.join('\n')}`);
  },

  async tabs_create({ url, activate }) {
    const tab = await chrome.tabs.create({ url: 'about:blank', active: !!activate });
    page.setCurrentTab(tab.id);
    if (url) await page.navigate(tab.id, url);
    return text(`Opened and selected ${await describeTab(await chrome.tabs.get(tab.id))}`);
  },

  async tabs_select({ tabId, activate }) {
    const tab = await page.resolveTab(tabId);
    page.setCurrentTab(tab.id);
    if (activate) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return text(`Selected ${await describeTab(tab)}`);
  },

  async tabs_close({ tabId }) {
    const tab = await page.resolveTab(tabId);
    await cdp.detach(tab.id);
    await chrome.tabs.remove(tab.id);
    return text(`Closed tab ${tab.id}`);
  },

  async navigate({ url, tabId }) {
    const tab = await page.resolveTab(tabId);
    page.setCurrentTab(tab.id);
    const done = await page.navigate(tab.id, url);
    return text(`Loaded ${await describeTab(done)}`);
  },

  async read_page({ tabId, viewportOnly = false, maxElements = 300 }) {
    const tab = await page.resolveTab(tabId);
    const snap = await page.observe(tab.id, { viewportOnly, maxElements, maxText: 4000 });
    return text(formatSnapshot(snap));
  },

  async find({ query, tabId }) {
    const tab = await page.resolveTab(tabId);
    const snap = await page.observe(tab.id, { maxElements: 2000, maxText: 0 });
    const q = String(query).toLowerCase();
    const hits = snap.elements.filter((el) => [el.role, el.label, el.value, el.placeholder, el.href].some((v) => v && String(v).toLowerCase().includes(q)));
    if (!hits.length) return text(`No interactive element matches "${query}". Try get_page_text or a screenshot.`);
    return text(hits.slice(0, 25).map(formatElement).join('\n') + (hits.length > 25 ? `\n…${hits.length - 25} more` : ''));
  },

  async get_page_text({ tabId, maxChars = 20000 }) {
    const tab = await page.resolveTab(tabId);
    const res = await page.run(tab.id, inj.pageText, maxChars);
    return text(`${res.title} — ${res.url}\n\n${res.text}${res.truncated ? `\n\n[truncated: ${res.total} chars total]` : ''}`);
  },

  async screenshot({ tabId }) {
    const tab = await page.resolveTab(tabId);
    const shot = await page.screenshot(tab.id);
    return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType },
      { type: 'text', text: `Screenshot ${shot.width}x${shot.height} of ${tab.url}` }] };
  },

  async click({ ref, x, y, tabId, button = 'left', clickCount = 1, modifiers }) {
    const tab = await page.resolveTab(tabId);
    let px, py;
    if (ref != null) {
      ({ x: px, y: py } = await page.pointFor(tab.id, parseRef(ref)));
    } else if (x != null && y != null) {
      [px, py] = page.toCss(tab.id, x, y);
    } else throw new Error('Give a ref or x and y.');
    await cdp.mouseClick(tab.id, px, py, { button, clickCount, modifiers: cdp.modifierMask(modifiers) });
    await page.run(tab.id, inj.waitSettled, false).catch(() => {});
    const now = await chrome.tabs.get(tab.id);
    return text(`Clicked ${ref != null ? ref : `(${Math.round(px)}, ${Math.round(py)})`}. Page: ${now.title} — ${now.url}`);
  },

  async type({ text: value, ref, tabId, clear, submit }) {
    const tab = await page.resolveTab(tabId);
    if (ref != null) {
      const id = parseRef(ref);
      const { x, y } = await page.pointFor(tab.id, id);
      await cdp.mouseClick(tab.id, x, y);
      await page.run(tab.id, inj.focusNode, id);
    }
    await cdp.insertText(tab.id, value, { replace: clear ?? ref != null });
    if (submit) await cdp.pressChord(tab.id, 'Enter');
    await page.run(tab.id, inj.waitSettled, !submit).catch(() => {});
    return text(`Typed ${JSON.stringify(value.length > 80 ? value.slice(0, 80) + '…' : value)}${ref ? ` into ${ref}` : ''}${submit ? ' and pressed Enter' : ''}.`);
  },

  async press_key({ keys, tabId, repeat = 1 }) {
    const tab = await page.resolveTab(tabId);
    const chords = String(keys).split(/\s+/).filter(Boolean);
    for (let i = 0; i < Math.min(repeat, 50); i++) for (const chord of chords) await cdp.pressChord(tab.id, chord);
    await page.run(tab.id, inj.waitSettled, false).catch(() => {});
    return text(`Pressed ${keys}${repeat > 1 ? ` ×${repeat}` : ''}.`);
  },

  async scroll({ direction, amount = 5, ref, x, y, tabId }) {
    const tab = await page.resolveTab(tabId);
    let px, py;
    if (ref != null) ({ x: px, y: py } = await page.pointFor(tab.id, parseRef(ref)));
    else if (x != null && y != null) [px, py] = page.toCss(tab.id, x, y);
    else {
      const m = await cdp.send(tab.id, 'Page.getLayoutMetrics');
      px = m.cssVisualViewport.clientWidth / 2;
      py = m.cssVisualViewport.clientHeight / 2;
    }
    const d = 120 * amount;
    const [dx, dy] = { up: [0, -d], down: [0, d], left: [-d, 0], right: [d, 0] }[direction] || [0, d];
    await cdp.wheel(tab.id, px, py, dx, dy);
    await page.sleep(150);
    const pos = await page.run(tab.id, () => [Math.round(scrollY), document.documentElement.scrollHeight - innerHeight]);
    return text(`Scrolled ${direction}. Page scroll ${pos[0]}/${pos[1]}px.`);
  },

  async select_option({ ref, option, tabId }) {
    const tab = await page.resolveTab(tabId);
    const res = await page.run(tab.id, inj.selectOptionNode, parseRef(ref), option);
    if (res?.error) throw new Error(res.error + (res.options ? `. Options: ${res.options.join(' | ')}` : ''));
    return text(`Selected "${res.selected}".`);
  },

  async hover({ ref, x, y, tabId }) {
    const tab = await page.resolveTab(tabId);
    let px, py;
    if (ref != null) ({ x: px, y: py } = await page.pointFor(tab.id, parseRef(ref)));
    else [px, py] = page.toCss(tab.id, x, y);
    await cdp.mouseMove(tab.id, px, py);
    await page.sleep(200);
    return text('Hovered.');
  },

  async wait({ seconds }) {
    await page.sleep(Math.min(Math.max(Number(seconds) || 1, 0), 10) * 1000);
    return text(`Waited ${seconds}s.`);
  },

  async javascript({ code, tabId }, ctx) {
    if (!ctx.settings.tools.allowJavascript) throw new Error('The javascript tool is disabled in HailBrowser settings.');
    const tab = await page.resolveTab(tabId);
    const evaluate = (expression, replMode) => cdp.send(tab.id, 'Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true, replMode, timeout: 15000,
    });
    // Try as an expression first (so `await fetch(...)` returns its value), then as a
    // REPL-style script (statements; the last expression is the result).
    let res = await evaluate(`(async () => (${code}\n))()`, false);
    if (res.exceptionDetails?.exception?.className === 'SyntaxError') res = await evaluate(code, true);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    const value = res.result.value;
    const out = value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return text(out.length > 30000 ? out.slice(0, 30000) + '\n[truncated]' : out);
  },

  async run_task(args, ctx) {
    if (!ctx.runTask) throw new Error('run_task is only available to external agents.');
    return ctx.runTask(args);
  },
};

/** Execute one tool. Never throws: errors come back as isError results the model can read. */
export async function executeTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}"` }] };
  try {
    return await handler(args || {}, ctx);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
  }
}
