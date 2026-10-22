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
  if (el.inputType) line += ` type=${el.inputType}`;
  if (el.multiple) line += ' multiple';
  if (el.value) line += ` value="${el.value}"`;
  if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
  for (const k of ['checked', 'selected', 'expanded']) if (el[k] != null) line += ` ${k}=${el[k]}`;
  if (el.options) line += ` options=[${el.options.slice(0, 15).map((o) => o.label).join(' | ')}${el.options.length > 15 ? ' | …' : ''}]`;
  if (el.href && el.role === 'link') line += ` -> ${el.href}`;
  if (!el.inViewport) line += ' (offscreen)';
  return line;
}

export function formatSnapshot(snap, { includeText = true } = {}) {
  const more = [snap.omitted && `${snap.omitted} more omitted (use find)`, snap.offscreen && `${snap.offscreen} more off-screen (scroll or use find)`].filter(Boolean);
  const lines = [
    `Page: ${page.shorten(snap.title || '(untitled)', 150)} — ${page.shorten(snap.url, 300)}`,
    `Viewport ${snap.viewport.w}x${snap.viewport.h}, scrolled ${snap.scroll.y}/${Math.max(0, snap.scroll.height - snap.viewport.h)}px`,
    '',
    `Interactive elements (${snap.elements.length}${more.length ? `, ${more.join(', ')}` : ''}):`,
    ...snap.elements.map(formatElement),
  ];
  if (includeText && snap.text) lines.push('', 'Visible text:', snap.text);
  return lines.join('\n');
}

async function describeTab(tab) {
  return `Tab ${tab.id}: ${page.shorten(tab.title || '(untitled)', 120)} — ${page.shorten(tab.url || tab.pendingUrl || '', 200)}`;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** CSS point for a ref or screenshot x,y, with a clear error when neither is usable. */
async function pointArg(tab, { ref, x, y }, tool) {
  if (ref != null) return page.pointFor(tab.id, parseRef(ref));
  if (isNum(x) && isNum(y)) {
    const [px, py] = page.toCss(tab.id, x, y);
    await page.run(tab.id, inj.yieldIndicator, px, py).catch(() => {});
    return { x: px, y: py };
  }
  throw new Error(`${tool} needs a ref (from read_page/find) or numeric x and y (from a screenshot).`);
}

/** Lines about tabs the action opened, so pop-ups are never silent. */
async function newTabNotes(watch) {
  const tabs = await watch.stop();
  return tabs.map((t) => `\nOpened new tab ${t.id}: ${page.shorten(t.title || 'loading…', 120)} — ${page.shorten(t.pendingUrl || t.url || '', 200)}` +
    ' (still acting on the current tab; call tabs_select to switch).').join('');
}

const HANDLERS = {
  async tabs_context() {
    const current = await page.resolveTab().catch(() => null);
    const tabs = await chrome.tabs.query({ windowType: 'normal' });
    const lines = tabs.map((t) => `${t.id === current?.id ? '→' : ' '} [${t.id}] ${t.active ? '(active) ' : ''}${page.shorten(t.title || '(untitled)', 120)} — ${page.shorten(t.url || t.pendingUrl || '', 200)}`);
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

  async read_page({ tabId, viewportOnly = false, maxElements = 300, compact = false }) {
    const tab = await page.resolveTab(tabId);
    const snap = await page.observe(tab.id, compact
      ? { viewportOnly: true, maxElements: Math.min(maxElements, 150), maxText: 1500 }
      : { viewportOnly, maxElements, maxText: 4000 });
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
    if (!['left', 'right', 'middle'].includes(button)) throw new Error('button must be "left", "right" or "middle".');
    const { x: px, y: py } = await pointArg(tab, { ref, x, y }, 'click');
    const watch = page.watchNewTabs(tab.id);
    await cdp.mouseClick(tab.id, px, py, { button, clickCount: Math.min(Math.max(Number(clickCount) || 1, 1), 3), modifiers: cdp.modifierMask(modifiers) });
    const now = cdp.openDialog(tab.id) ? tab : await page.settleAfterInput(tab.id, tab.url);
    if (now.url === tab.url) await page.run(tab.id, inj.waitSettled, false).catch(() => {});
    return text(`Clicked ${ref != null ? ref : `(${Math.round(px)}, ${Math.round(py)})`}. Page: ${page.shorten(now.title, 120)} — ${page.shorten(now.url, 300)}${await newTabNotes(watch)}`);
  },

  async type({ text: value, ref, tabId, clear, submit }) {
    if (typeof value !== 'string') throw new Error('type needs text (a string).');
    const tab = await page.resolveTab(tabId);
    let info = null, id = null, where = '', note = '';
    if (ref != null) {
      id = parseRef(ref);
      const { x, y } = await page.pointFor(tab.id, id);
      await cdp.mouseClick(tab.id, x, y);
      info = await page.run(tab.id, inj.focusNode, id);
      where = ` into ${ref}`;
      if (info?.special) {
        const res = await page.run(tab.id, inj.setNativeValue, id, value);
        if (res?.error) throw new Error(res.error);
        if (value && !res.value) throw new Error(`The ${info.kind} field rejected "${value}". ${page.SPECIAL_INPUT_HINT}`);
        if (res.value !== value) note = ` The ${info.kind} field stored "${res.value}" (nearest allowed value).`;
      }
    } else {
      // No ref: type into whatever has focus, but say what that is (and refuse if nothing does).
      const focused = await page.run(tab.id, inj.focusedInfo);
      if (!focused) throw new Error('Nothing on the page has keyboard focus, so the text would go nowhere. Pass the field\'s ref.');
      where = ` into the focused ${focused.tag}${focused.type ? `[${focused.type}]` : ''}${focused.label ? ` "${focused.label}"` : ''}`;
    }
    if (!info?.special) await cdp.insertText(tab.id, value, { replace: clear ?? ref != null });
    if (id != null && !info?.special && !submit) {
      // Read back what the field holds: masks and validators can change or drop typed text.
      const got = await page.run(tab.id, inj.readValue, id).catch(() => null);
      const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
      if (got && !got.password && value && !norm(got.value).includes(norm(value))) {
        note = norm(got.value) ? ` Note: the field now shows ${JSON.stringify(page.shorten(got.value, 120))} (the page reformatted or changed the input).`
          : ' Warning: the field is still empty; the page did not accept the typed text.';
      } else if (got?.password && value && !got.value) note = ' Warning: the field is still empty.';
    }
    if (submit) {
      const watch = page.watchNewTabs(tab.id);
      await cdp.pressChord(tab.id, 'Enter');
      if (!cdp.openDialog(tab.id)) await page.settleAfterInput(tab.id, tab.url);
      note += await newTabNotes(watch);
    } else {
      await page.run(tab.id, inj.waitSettled, !!info?.autocomplete).catch(() => {});
    }
    return text(`Typed ${JSON.stringify(value.length > 80 ? value.slice(0, 80) + '…' : value)}${where}${submit ? ' and pressed Enter' : ''}.${note}`);
  },

  async press_key({ keys, tabId, repeat = 1 }) {
    if (typeof keys !== 'string' || !keys.trim()) throw new Error('press_key needs keys, e.g. "Enter" or "ctrl+a Backspace".');
    const tab = await page.resolveTab(tabId);
    const chords = keys.split(/\s+/).filter(Boolean);
    for (const chord of chords) cdp.parseChord(chord); // validate everything before pressing anything
    const watch = page.watchNewTabs(tab.id);
    for (let i = 0; i < Math.min(Math.max(Number(repeat) || 1, 1), 50); i++) {
      for (const chord of chords) {
        await cdp.pressChord(tab.id, chord);
        if (cdp.openDialog(tab.id)) break;
      }
    }
    const now = cdp.openDialog(tab.id) ? tab : await page.settleAfterInput(tab.id, tab.url, 250);
    if (now.url === tab.url) await page.run(tab.id, inj.waitSettled, false).catch(() => {});
    return text(`Pressed ${keys}${repeat > 1 ? ` ×${repeat}` : ''}.${now.url !== tab.url ? ` Page: ${page.shorten(now.title, 120)} — ${page.shorten(now.url, 300)}` : ''}${await newTabNotes(watch)}`);
  },

  async scroll({ direction, amount = 5, ref, x, y, tabId }) {
    const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    if (!DIRS[direction]) throw new Error('direction must be "up", "down", "left" or "right".');
    if (amount != null && (!isNum(amount) || amount <= 0)) throw new Error('amount must be a positive number of wheel ticks.');
    const tab = await page.resolveTab(tabId);
    const d = 120 * Math.min(amount ?? 5, 50);
    const [dx, dy] = DIRS[direction].map((v) => v * d);
    let point = null;
    if (ref != null || x != null || y != null) point = await pointArg(tab, { ref, x, y }, 'scroll');
    const probe = await page.run(tab.id, inj.scrollProbe, null, point?.x ?? null, point?.y ?? null, dx, dy);
    if (!probe || probe.error) throw new Error('Could not find anything to scroll there. Read the page again.');
    let after = await page.run(tab.id, inj.scrollCheck, probe, dx, dy, 'direct');
    if (after && !after.error && !after.moved && dy) {
      // Nothing scrollable moved: the site may scroll through its own wheel handler (maps, feeds).
      // Vertical only: a horizontal wheel at the page edge is Chrome's swipe gesture for back/forward.
      await cdp.wheel(tab.id, point?.x ?? probe.x, point?.y ?? probe.y, dx, dy);
      after = await page.run(tab.id, inj.scrollCheck, probe, dx, dy, 'wheel');
    }
    if (!after || after.error) throw new Error('The scrolled area disappeared. Read the page again.');
    const where = probe.isPage ? 'the page' : `inside ${probe.label}`;
    const [at, max] = dy ? [after.top, after.maxTop] : [after.left, after.maxLeft];
    const pos = `${Math.min(at, max)}/${max}px`;
    if (!after.moved) {
      const edge = { up: 'top', down: 'bottom', left: 'left edge', right: 'right edge' }[direction];
      const atEdge = (dx || dy) < 0 ? at <= 0 : at >= max - 1;
      return text(atEdge ? `Nothing scrolled: ${where} is already at the ${edge} (${pos}).`
        : `Nothing scrolled: ${where} did not move (${pos}); it may still be loading. Try again or wait.`);
    }
    return text(`Scrolled ${direction} ${where}: now at ${pos}.`);
  },

  async select_option({ ref, option, options, tabId }) {
    if (ref == null) throw new Error('select_option needs the ref of a <select>.');
    const want = Array.isArray(options) && options.length ? options.map(String) : option;
    if (want == null || want === '') throw new Error('Give option (one value or label) or options (a list, for multi-selects).');
    const tab = await page.resolveTab(tabId);
    const res = await page.run(tab.id, inj.selectOptionNode, parseRef(ref), want);
    if (res?.error === 'stale') throw new page.StaleError('That element no longer exists. Read the page again for fresh refs.');
    if (res?.error) throw new Error(res.error + (res.options ? `. Options: ${res.options.join(' | ')}` : ''));
    return text(`Selected ${res.selected.map((l) => `"${l}"`).join(', ') || 'nothing'}.`);
  },

  async hover({ ref, x, y, tabId }) {
    const tab = await page.resolveTab(tabId);
    const { x: px, y: py } = await pointArg(tab, { ref, x, y }, 'hover');
    await cdp.mouseMove(tab.id, px, py);
    await page.sleep(200);
    return text(`Hovered ${ref != null ? ref : `(${Math.round(px)}, ${Math.round(py)})`}.`);
  },

  async handle_dialog({ accept = true, text: promptText, tabId }) {
    const tab = await page.resolveTab(tabId);
    const d = await cdp.handleDialog(tab.id, accept !== false, promptText);
    if (!d) return text('No dialog is open on this tab.');
    const now = accept !== false && d.type === 'beforeunload' ? await page.settleAfterInput(tab.id, tab.url, 800) : tab;
    return text(`${accept !== false ? 'Accepted' : 'Dismissed'} the ${d.type} dialog${d.message ? ` "${page.shorten(d.message, 200)}"` : ''}.` +
      (now.url !== tab.url ? ` Page: ${page.shorten(now.title, 120)} — ${page.shorten(now.url, 300)}` : ''));
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
    if (typeof code !== 'string' || !code.trim()) throw new Error('javascript needs code.');
    let res = await evaluate(`(async () => (${code}\n))()`, false);
    if (!res) throw new cdp.DialogError(cdp.openDialog(tab.id));
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

  async stop_task(args, ctx) {
    if (!ctx.stopTask) throw new Error('stop_task is only available to external agents.');
    return text(await ctx.stopTask());
  },
};

const NO_TAB = new Set(['tabs_context', 'tabs_create', 'tabs_close', 'wait', 'run_task', 'stop_task']);

/** Dialog news for the tab: alerts closed automatically, or a dialog still waiting for handle_dialog. */
async function dialogNotes(name, args) {
  if (NO_TAB.has(name) || !globalThis.chrome?.tabs) return '';
  const tab = await page.resolveTab(args.tabId).catch(() => null);
  if (!tab) return '';
  const alerts = cdp.takeHandledAlerts(tab.id).map((m) => `\nThe page showed an alert (closed automatically): "${page.shorten(m, 300)}"`);
  const open = name === 'handle_dialog' ? null : cdp.openDialog(tab.id);
  return alerts.join('') + (open ? `\n${new cdp.DialogError(open).message}` : '');
}

/** Execute one tool. Never throws: errors come back as isError results the model can read. */
export async function executeTool(name, args, ctx) {
  const handler = HANDLERS[name];
  if (!handler) return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}"` }] };
  args ||= {};
  if (ctx?.signal?.aborted) return { isError: true, content: [{ type: 'text', text: 'Cancelled before it started.' }] };
  let result;
  try {
    result = await handler(args, ctx);
  } catch (e) {
    result = { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
  }
  const notes = await dialogNotes(name, args).catch(() => '');
  if (notes) {
    const last = [...result.content].reverse().find((c) => c.type === 'text');
    if (last && !last.text.includes(notes.trim())) last.text += notes;
    else if (!last) result.content.push({ type: 'text', text: notes.trim() });
  }
  return result;
}
