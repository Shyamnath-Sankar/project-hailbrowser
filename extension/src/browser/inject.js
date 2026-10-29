// Functions injected into pages with chrome.scripting.executeScript({func}).
// Each one must be self-contained: they are serialized, so they cannot use
// anything from module scope. State lives on window.__hail in the extension's
// isolated world (invisible to the page's own scripts).
//
// The snapshot approach (one atomic DOM read, WeakMap node identities, visible
// text only) is adapted from browser-use/jev-ultrafast (MIT, (c) 2026 Browser Use).

export function pageSnapshot(opts) {
  const o = Object.assign({ viewportOnly: false, maxElements: 400, maxText: 6000 }, opts || {});
  if (!document.body) return { error: 'Page has no body yet' };
  // Each document starts at a random base so a stale ref from a previous page
  // fails loudly instead of silently matching an element on the new page.
  const H = (window.__hail ||= { ids: new WeakMap(), nodes: new Map(), next: (100 + Math.floor(Math.random() * 900)) * 10 });
  const identity = (e) => {
    if (!H.ids.has(e)) H.ids.set(e, H.next++);
    const id = H.ids.get(e);
    H.nodes.set(id, e);
    return id;
  };
  for (const [id, e] of H.nodes) if (!e.isConnected) H.nodes.delete(id);

  const visible = (e) => !e.closest('[aria-hidden="true"],[inert]') &&
    (e.checkVisibility ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : e.getClientRects().length > 0);
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const name = (e, seen = new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced = (e.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => name(document.getElementById(id), seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels || [])].map((l) => name(l, seen)).filter(Boolean).join(' ') ||
      (['button', 'submit', 'reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (e.tagName === 'INPUT' || e.tagName === 'SELECT' || e.tagName === 'TEXTAREA' ? '' :
        [...e.childNodes].map((n) => (n.nodeType === 3 ? n.textContent :
          n.nodeType === 1 && n.getAttribute('aria-hidden') !== 'true' ? name(n, seen) : '')).join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemradio', 'menuitemcheckbox',
    'option', 'gridcell', 'combobox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'treeitem'];
  const selector = 'a[href],button,input,textarea,select,summary,[contenteditable="true"],[contenteditable=""],' +
    roles.map((r) => `[role="${r}"]`).join(',');
  const role = (e) => {
    const explicit = e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName === 'BUTTON' || e.tagName === 'SUMMARY') return 'button';
    if (e.tagName === 'A') return 'link';
    if (e.tagName === 'SELECT') return 'combobox';
    if (e.tagName === 'TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName === 'INPUT') {
      if (['checkbox', 'radio'].includes(e.type)) return e.type;
      if (['button', 'submit', 'reset', 'image'].includes(e.type)) return 'button';
      if (e.type === 'search') return 'searchbox';
      if (e.type === 'number') return 'spinbutton';
      if (e.type === 'range') return 'slider';
      if (['text', 'email', 'url', 'tel', 'password', 'date', 'time', 'datetime-local', 'month', 'week', 'color', ''].includes(e.type)) return 'textbox';
    }
    return null;
  };

  const W = innerWidth, Hh = innerHeight;
  const elements = [];
  let omitted = 0, offscreen = 0, above = 0;
  const below = [], offs = [];
  const humanize = (s) => clean(String(s || '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'), 40);

  // Something covering the page (a modal <dialog>, or a large fixed overlay such as a cookie wall):
  // controls outside it cannot be clicked, so they are left out and the overlay is reported.
  let blocker = [...document.querySelectorAll('dialog[open]')].find((d) => d.matches(':modal')) || null;
  if (!blocker) {
    for (let n = document.elementFromPoint(W / 2, Hh / 2); n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).position !== 'fixed') continue;
      const r = n.getBoundingClientRect();
      if (r.width * r.height >= 0.4 * W * Hh) blocker = n;
    }
  }

  // Scrollable inner panels that hide some of their content (found from offscreen elements).
  const panels = new Set(), checked = new Set();
  const noteScroller = (e) => {
    for (let c = e.parentElement; c && c !== document.body && c !== document.documentElement && panels.size < 3; c = c.parentElement) {
      if (checked.has(c)) return;
      checked.add(c);
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(c).overflowY) || c.scrollHeight <= c.clientHeight + 4) continue;
      const r = c.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= Hh || r.right <= 0 || r.left >= W || r.height < 40) continue;
      panels.add(c);
      return;
    }
  };
  for (const e of document.querySelectorAll(selector)) {
    if (e.type === 'hidden' || e.type === 'file') continue;
    if (e.matches(':disabled') || e.closest('[aria-disabled="true"]') || !visible(e)) continue;
    const rname = role(e);
    if (!rname) continue;
    if (rname === 'gridcell' && e.querySelector('button,[role="button"]')) continue;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const inViewport = cx >= 0 && cy >= 0 && cx < W && cy < Hh;
    if (o.viewportOnly && blocker && !blocker.contains(e)) continue; // covered by the overlay: not clickable
    if (o.viewportOnly && !inViewport) {
      offscreen++;
      if (offs.length < 1500) offs.push({ e, cy, rname });
      continue;
    }
    if (elements.length >= o.maxElements) { omitted++; continue; }
    const el = { id: identity(e), role: rname, label: clean(name(e), 160) || humanize(e.getAttribute('name') || e.id) || rname,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, inViewport };
    for (const key of ['checked', 'selected', 'expanded']) {
      const v = e.getAttribute('aria-' + key);
      if (v !== null) el[key] = v;
    }
    if (['checkbox', 'radio'].includes(e.type)) el.checked = String(e.checked);
    if (e.tagName === 'A' && e.getAttribute('href')) el.href = e.href.slice(0, 200);
    if (e.tagName === 'A' && e.target === '_blank') el.newTab = true;
    const popup = e.getAttribute('aria-haspopup');
    const sub = e.nextElementSibling;
    if ((popup && popup !== 'false') || (sub && !visible(sub) && sub.querySelector('a[href],button'))) el.haspopup = true;
    if (e.tagName === 'INPUT' && ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range', 'number'].includes(e.type)) el.inputType = e.type;
    if (e.tagName === 'SELECT' && e.multiple) el.multiple = true;
    if (e.tagName === 'SELECT') {
      el.value = [...e.selectedOptions].map((op) => op.label).join(', ');
      el.options = [...e.options].slice(0, 80).filter((op) => !op.disabled && !op.closest('optgroup[disabled]'))
        .map((op) => ({ value: op.value, label: clean(op.label, 80), selected: op.selected }));
    } else {
      const editable = !e.readOnly && e.getAttribute('aria-readonly') !== 'true' &&
        (['textbox', 'searchbox', 'spinbutton'].includes(rname) || (rname === 'combobox' && ['INPUT', 'TEXTAREA'].includes(e.tagName)) || e.isContentEditable);
      if (editable) el.editable = true;
      if (e.type === 'password') { el.sensitive = true; el.value = e.value ? '••••' : ''; }
      else if (['checkbox', 'radio'].includes(e.type)) { /* state is reported as checked= */ }
      else el.value = clean('value' in e && e.tagName !== 'BUTTON' && e.tagName !== 'LI' ? e.value :
        e.isContentEditable || rname === 'combobox' ? e.innerText : '', 300);
      if (e.getAttribute('placeholder') && el.label !== e.getAttribute('placeholder')) el.placeholder = clean(e.getAttribute('placeholder'), 80);
    }
    elements.push(el);
  }

  // Inner panels: items scrolled out of sight inside a panel are hidden even when they lie inside
  // the window, and are reported per panel (with which way to scroll) instead of as page content.
  // o.light (the pre-action freshness check) needs only URL, form values and element keys: skip the extras.
  if (!o.light) for (const f of offs) { if (checked.size >= 3000 || panels.size >= 3) break; noteScroller(f.e); }
  const panelInfo = new Map([...panels].map((p) => [p, { r: p.getBoundingClientRect(), below: [], above: [] }]));
  const panelOf = (e) => { for (const [p, info] of panelInfo) if (p.contains(e)) return info; return null; };
  if (panelInfo.size) {
    for (let i = elements.length - 1; i >= 0; i--) {
      const info = panelOf(H.nodes.get(elements[i].id));
      if (!info) continue;
      const cy = elements[i].rect.y + elements[i].rect.h / 2;
      if (cy < info.r.top || cy > info.r.bottom) {
        (cy > info.r.bottom ? info.below : info.above).unshift(elements[i].label);
        elements.splice(i, 1);
      }
    }
  }
  for (const f of offs) {
    const info = panelOf(f.e);
    if (info) (f.cy > info.r.bottom ? info.below : info.above).push(f);
    else if (f.cy >= Hh) { if (below.length < 8) below.push(clean(name(f.e), 50) || f.rname); }
    else if (f.cy < 0) above++;
  }
  const itemLabel = (x) => (typeof x === 'string' ? x : clean(name(x.e), 40) || x.rname);
  const sample = (list) => (list.length <= 6 ? list : [...list.slice(0, 3), '…', ...list.slice(-3)]).map((x) => (x === '…' ? x : itemLabel(x)));

  // Context for ambiguous controls: the text of the smallest surrounding card/row/group
  // ("Add to cart" ×6 → "Sony WH-1000XM5 ₹26,990"), and the fieldset/group name for choices.
  const counts = new Map();
  for (const el of elements) counts.set(el.label, (counts.get(el.label) || 0) + 1);
  const around = (e, label) => {
    for (let c = e.parentElement, d = 0; c && c !== document.body && d < 6; c = c.parentElement, d++) {
      const t = clean(c.innerText, 300);
      if (t.length > label.length + 2) return t.length > 240 ? '' : clean(t.split(label).join(' '), 110);
    }
    return '';
  };
  for (const el of o.light ? [] : elements) {
    const e = H.nodes.get(el.id);
    const ambiguous = counts.get(el.label) > 1 || el.label.length <= 3 || el.label === el.role;
    const group = ['checkbox', 'radio', 'switch'].includes(el.role)
      ? clean(e.closest('fieldset')?.querySelector('legend')?.textContent || e.closest('[role=radiogroup],[role=group]')?.getAttribute('aria-label'), 40) : '';
    const ctx = [group, ambiguous ? around(e, el.label) : ''].filter(Boolean).join(' · ');
    if (ctx) el.ctx = clean(ctx, 120);
  }

  // Visible text in the viewport only, so offscreen footers don't fill model context.
  const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node, length = 0;
  while (!o.light && (node = walker.nextNode()) && length < o.maxText) {
    const value = node.textContent.trim(), parent = node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < Hh && r.right > 0 && r.left < W) {
      words.push(value);
      length += value.length;
    }
  }
  const formKey = JSON.stringify([...document.querySelectorAll('input,textarea,select')]
    .filter((e) => !['password', 'file', 'hidden'].includes(e.type))
    .map((e) => [identity(e), e.value, e.checked, e.selectedIndex]));
  return {
    url: location.href, title: document.title,
    viewport: { w: W, h: Hh, dpr: devicePixelRatio },
    scroll: { x: Math.round(scrollX), y: Math.round(scrollY), height: document.documentElement.scrollHeight, width: document.documentElement.scrollWidth },
    elements, omitted, offscreen, text: words.join('\n').slice(0, o.maxText), formKey,
    dialog: blocker ? { label: clean(blocker.getAttribute('aria-label') || blocker.querySelector('h1,h2,h3,[role=heading]')?.textContent || blocker.innerText, 80) || 'dialog' } : null,
    offscreenBelow: below, offscreenAbove: above,
    panels: [...panelInfo].map(([c, info]) => ({
      id: identity(c), label: clean(c.getAttribute('aria-label') || c.previousElementSibling?.textContent || c.innerText, 40),
      down: c.scrollTop + c.clientHeight < c.scrollHeight - 1, up: c.scrollTop > 0,
      below: sample(info.below), belowCount: info.below.length, above: sample(info.above), aboveCount: info.above.length,
    })),
  };
}

/** Current click point for an observed node, after scrolling it into view if needed. */
export function resolveNode(id) {
  const e = window.__hail?.nodes.get(id);
  if (!e || !e.isConnected) return { error: 'stale' };
  let r = e.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth || r.top < 0 || r.bottom > innerHeight) {
    e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = e.getBoundingClientRect();
  }
  if (r.width <= 0 || r.height <= 0) return { error: 'not visible' };
  const owns = (hit) => hit && (hit === e || e.contains(hit) || (e.labels && [...e.labels].some((l) => l.contains(hit))));
  const inset = Math.min(r.width, r.height) / 4;
  const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + inset, r.top + r.height / 2],
    [r.right - inset, r.top + r.height / 2], [r.left + r.width / 2, r.top + inset], [r.left + r.width / 2, r.bottom - inset]];
  // HailBrowser's own overlay never counts as covering the target; its pill steps aside if the click lands on it.
  const overlay = document.getElementById('__hailbrowser_indicator');
  const stepAside = (x, y) => {
    const b = overlay?.__pill?.getBoundingClientRect();
    if (!b || x < b.left - 6 || x > b.right + 6 || y < b.top - 6 || y > b.bottom + 6) return;
    overlay.style.visibility = 'hidden';
    clearTimeout(overlay.__aside);
    overlay.__aside = setTimeout(() => { overlay.style.visibility = ''; }, 1500);
  };
  let blocker = null;
  for (const [px, py] of points) {
    const x = Math.min(Math.max(px, 1), innerWidth - 2), y = Math.min(Math.max(py, 1), innerHeight - 2);
    const hit = document.elementsFromPoint(x, y).find((h) => h !== overlay);
    if (owns(hit) || (hit && hit.contains(e))) { stepAside(x, y); return { x, y, tag: e.tagName }; }
    blocker ||= hit;
  }
  const label = blocker ? (blocker.getAttribute('aria-label') || blocker.innerText || blocker.tagName).trim().replace(/\s+/g, ' ').slice(0, 80) : 'unknown';
  return { error: 'covered', coveredBy: label };
}

/** Semantic state of one node, for freshness checks before input. */
export function nodeState(id) {
  const e = window.__hail?.nodes.get(id);
  if (!e || !e.isConnected) return null;
  return JSON.stringify([location.href, e.tagName, e.getAttribute('role'), (e.getAttribute('aria-label') || e.innerText || '').slice(0, 200),
    e.value ?? null, e.checked ?? null, e.selectedIndex ?? null, e.matches(':disabled'),
    e.getAttribute('aria-expanded'), e.getAttribute('aria-checked'), e.getAttribute('aria-selected')]);
}

export function focusNode(id) {
  const e = window.__hail?.nodes.get(id);
  if (!e || !e.isConnected) return { error: 'stale' };
  e.focus({ preventScroll: false });
  if (e.isContentEditable) {
    const sel = getSelection();
    sel.selectAllChildren(e);
  } else if (typeof e.select === 'function') {
    try { e.select(); } catch { /* some input types refuse select() */ }
  }
  const special = ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(e.type);
  const autocomplete = e.getAttribute('role') === 'combobox' || e.type === 'search' ||
    (e.getAttribute('aria-autocomplete') || 'none') !== 'none' || !!e.getAttribute('list');
  return { ok: document.activeElement === e || e.contains(document.activeElement), special, autocomplete, kind: e.type || e.tagName.toLowerCase() };
}

/** Date/time/color/range inputs ignore typed text: set the value the way a picker would. */
export function setNativeValue(id, text) {
  const e = window.__hail?.nodes.get(id);
  if (!e || !e.isConnected) return { error: 'stale' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(e, text);
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: e.value };
}

/**
 * Choose options of a <select>. want is one value/label, or an array for <select multiple>
 * (sets exactly those). A single value on a multi-select is added to the current selection.
 */
export function selectOptionNode(id, want) {
  const e = window.__hail?.nodes.get(id);
  if (!e || !e.isConnected) return { error: 'stale' };
  if (e.tagName !== 'SELECT') return { error: 'not a <select>; click it and pick the option instead' };
  const norm = (s) => String(s).trim().toLowerCase();
  const usable = [...e.options].filter((op) => !op.disabled);
  const find = (w) => usable.find((op) => op.value === w) || usable.find((op) => norm(op.label) === norm(w)) ||
    usable.find((op) => norm(op.label).includes(norm(w)));
  const wants = Array.isArray(want) ? want : [want];
  if (wants.length > 1 && !e.multiple) return { error: 'this <select> allows only one option; pass a single option' };
  const picked = [];
  for (const w of wants) {
    const op = find(w);
    if (!op) return { error: `no option matching "${w}"`, options: [...e.options].map((x) => x.label).slice(0, 40) };
    picked.push(op);
  }
  e.focus();
  if (e.multiple) {
    if (Array.isArray(want)) for (const op of e.options) op.selected = picked.includes(op);
    else picked[0].selected = true;
  } else {
    e.value = picked[0].value;
  }
  e.dispatchEvent(new Event('input', { bubbles: true }));
  e.dispatchEvent(new Event('change', { bubbles: true }));
  return { selected: [...e.selectedOptions].map((op) => op.label) };
}

/** Value of an observed field after typing, for read-back checks. */
export function readValue(id) {
  const e = window.__hail?.nodes.get(id);
  if (!e || !e.isConnected) return null;
  const value = e.isContentEditable ? e.innerText : 'value' in e ? String(e.value) : e.textContent;
  return { value: value.slice(0, 2000), password: e.type === 'password' };
}

/** What has keyboard focus (role + name), so typing without a ref reports where text went. */
export function focusedInfo() {
  let e = document.activeElement;
  while (e?.shadowRoot?.activeElement) e = e.shadowRoot.activeElement;
  if (!e || e === document.body || e === document.documentElement) return null;
  const editable = e.isContentEditable || ['INPUT', 'TEXTAREA'].includes(e.tagName) || e.tagName === 'IFRAME';
  const label = (e.getAttribute('aria-label') || [...(e.labels || [])].map((l) => l.innerText).join(' ') ||
    e.getAttribute('placeholder') || e.getAttribute('name') || e.getAttribute('title') || e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { tag: e.tagName.toLowerCase(), type: e.type || '', label, editable };
}

/**
 * Find what a scroll should move: the nearest ancestor of the ref (or of the point) that can still
 * scroll in that direction, else the page. Remembers it and its position for scrollCheck.
 */
export function scrollProbe(id, x, y, dx, dy) {
  const H = (window.__hail ||= { ids: new WeakMap(), nodes: new Map(), next: (100 + Math.floor(Math.random() * 900)) * 10 });
  const start = id != null ? H.nodes.get(id) : document.elementFromPoint(x ?? innerWidth / 2, y ?? innerHeight / 2);
  if (id != null && (!start || !start.isConnected)) return { error: 'stale' };
  const page = document.scrollingElement || document.documentElement;
  const canScroll = (e) => {
    const cs = getComputedStyle(e);
    if (dy) {
      if (!/(auto|scroll|overlay)/.test(cs.overflowY) || e.scrollHeight <= e.clientHeight + 1) return false;
      return dy > 0 ? e.scrollTop + e.clientHeight < e.scrollHeight - 1 : e.scrollTop > 0;
    }
    if (!/(auto|scroll|overlay)/.test(cs.overflowX) || e.scrollWidth <= e.clientWidth + 1) return false;
    return dx > 0 ? e.scrollLeft + e.clientWidth < e.scrollWidth - 1 : e.scrollLeft > 0;
  };
  const innerScroller = (from) => {
    for (let e = from; e && e !== page && e !== document.body; e = e.parentElement || e.getRootNode?.().host) {
      if (e.nodeType === 1 && canScroll(e)) return e;
    }
    return null;
  };
  const pageCan = dy ? (dy > 0 ? page.scrollTop + innerHeight < page.scrollHeight - 1 : page.scrollTop > 0)
    : (dx > 0 ? page.scrollLeft + innerWidth < page.scrollWidth - 1 : page.scrollLeft > 0);
  let target, wheelAt = null;
  if (id == null && x == null && pageCan) {
    // No ref: "scroll" means the page. Remember a spot that isn't inside an inner scroll box (for wheel fallback).
    target = page;
    for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.2], [0.5, 0.8], [0.15, 0.5], [0.85, 0.5], [0.05, 0.5], [0.95, 0.5]]) {
      const px = innerWidth * fx, py = innerHeight * fy;
      if (!innerScroller(document.elementFromPoint(px, py))) { wheelAt = [px, py]; break; }
    }
  } else {
    target = innerScroller(start) || page;
  }
  H.scrollTarget = target;
  const isPage = target === page;
  const cls = typeof target.className === 'string' && target.className.trim() ? '.' + target.className.trim().split(/\s+/)[0] : '';
  const label = isPage ? 'the page' : (target.getAttribute('aria-label') || (target.id ? `#${target.id}` : `${target.tagName.toLowerCase()}${cls}`)).slice(0, 60);
  const r = isPage ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : target.getBoundingClientRect();
  const [cx, cy] = wheelAt || [Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2), Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2)];
  return { isPage, label, top: Math.round(target.scrollTop), left: Math.round(target.scrollLeft), x: cx, y: cy };
}

/**
 * Scroll the box found by scrollProbe. mode "direct" scrolls it instantly by (dx, dy): exact and
 * immune to the late, animated wheel handling of background tabs. mode "wheel" only measures, after
 * a trusted wheel event was sent (for sites that scroll with their own wheel handlers).
 */
export async function scrollCheck(before, dx, dy, mode) {
  const t = window.__hail?.scrollTarget;
  if (!t || !t.isConnected) return { error: 'stale' };
  const pos = () => [Math.round(t.scrollTop), Math.round(t.scrollLeft)];
  const tick = () => Promise.race([new Promise((r) => requestAnimationFrame(() => r())), new Promise((r) => setTimeout(r, 34))]);
  const startPos = `${before.top},${before.left}`;
  if (mode === 'direct') {
    t.scrollBy({ top: dy, left: dx, behavior: 'instant' });
    await tick(); // let scroll listeners (lazy loading) run
  } else {
    const waitFrom = performance.now();
    while (pos().join() === startPos && performance.now() - waitFrom < 300) await tick();
    const started = performance.now();
    let last = pos().join(), still = 0;
    while (still < 3 && performance.now() - started < 1000) {
      await tick();
      const now = pos().join();
      still = now === last ? still + 1 : 0;
      last = now;
    }
  }
  const [top, left] = pos();
  return { moved: `${top},${left}` !== startPos, top, left,
    maxTop: Math.max(0, t.scrollHeight - t.clientHeight), maxLeft: Math.max(0, t.scrollWidth - t.clientWidth) };
}

/** Wait for the page to react: visible autocomplete options (≤200ms) or two frames (≤50ms). */
export function waitSettled(autocomplete) {
  return new Promise((resolve) => {
    const started = performance.now();
    if (autocomplete) {
      const poll = () => {
        const options = document.querySelectorAll('[role="option"],[role="listbox"] li');
        const shown = [...options].some((x) => x.getClientRects().length > 0);
        if (shown || performance.now() - started > 200) resolve(Math.round(performance.now() - started));
        else setTimeout(poll, 16);
      };
      poll();
    } else {
      const done = () => resolve(Math.round(performance.now() - started));
      setTimeout(done, 50);
      requestAnimationFrame(() => requestAnimationFrame(done));
    }
  });
}

export function pageText(maxChars) {
  const main = document.querySelector('main,article,[role="main"]');
  const root = main && main.innerText.length > 400 ? main : document.body;
  const text = (root?.innerText || '').replace(/\n{3,}/g, '\n\n');
  return { url: location.href, title: document.title, text: text.slice(0, maxChars), truncated: text.length > maxChars, total: text.length };
}

/**
 * The "this tab is being driven" overlay: a flowing gradient border, a breathing glow, an agent
 * cursor, and a status pill with a Stop button. Lives in a closed shadow root, ignores the mouse
 * (except the pill), fades in and out, and respects prefers-reduced-motion.
 */
export function setIndicator(on, label) {
  const ID = '__hailbrowser_indicator';
  let host = document.getElementById(ID);
  if (!on) {
    if (host && !host.__leaving) {
      host.__leaving = true;
      host.__root?.querySelector('.wrap')?.classList.add('out');
      setTimeout(() => { if (host.__leaving) host.remove(); }, 280);
    }
    return true;
  }
  if (host?.__leaving) {
    host.__leaving = false;
    host.__root.querySelector('.wrap').classList.remove('out');
  }
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block;margin:0;padding:0;border:0;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{all:initial}
      .wrap{position:fixed;inset:0;animation:fade-in .35s ease-out both}
      .wrap.out{animation:fade-out .26s ease-in both}
      .ring{position:fixed;inset:0;padding:3px;background:linear-gradient(100deg,#8b5cf6,#38bdf8,#f0abfc,#8b5cf6);background-size:300% 100%;
        animation:flow 5s linear infinite;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude}
      .glow{position:fixed;inset:0;box-shadow:inset 0 0 44px 4px rgba(139,92,246,.30),inset 0 0 120px 10px rgba(56,189,248,.10);animation:breathe 2.6s ease-in-out infinite}
      .pill{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);display:flex;align-items:center;gap:9px;padding:5px 5px 5px 7px;
        border-radius:999px;font:600 12.5px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f5f3ff;white-space:nowrap;max-width:min(560px,92vw);
        background:rgba(20,16,40,.94);border:1px solid rgba(167,139,250,.5);
        box-shadow:0 10px 32px rgba(10,6,30,.45),0 0 0 4px rgba(139,92,246,.14);pointer-events:auto;animation:rise .45s cubic-bezier(.2,.9,.25,1.2) both}
      .bolt{position:relative;flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#38bdf8)}
      .bolt svg{width:12px;height:12px;fill:#fff}
      .bolt::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid rgba(167,139,250,.7);animation:ping 1.6s cubic-bezier(0,0,.2,1) infinite}
      .label{overflow:hidden;text-overflow:ellipsis;min-width:0}
      .dots{display:inline-flex;gap:3px;margin-right:2px}
      .dots i{width:4px;height:4px;border-radius:50%;background:#c4b5fd;animation:blink 1.2s infinite}
      .dots i:nth-child(2){animation-delay:.2s}.dots i:nth-child(3){animation-delay:.4s}
      .stop{all:unset;cursor:pointer;flex:none;padding:6px 11px;border-radius:999px;background:rgba(255,255,255,.1);color:#fff;font:600 11.5px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;transition:background .15s}
      .stop:hover{background:#ef4444}.stop:focus-visible{outline:2px solid #c4b5fd;outline-offset:2px}
      .pill.stopping .stop{display:none}.pill.stopping .dots{display:none}
      .cursor{position:fixed;left:0;top:0;width:22px;height:22px;opacity:0;transform:translate(50vw,60vh);
        transition:transform .32s cubic-bezier(.2,.8,.2,1),opacity .25s}
      .ripple{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #a78bfa;background:rgba(167,139,250,.28);animation:ripple .65s ease-out forwards}
      @keyframes flow{to{background-position:300% 0}}
      @keyframes breathe{50%{opacity:.5}}
      @keyframes blink{50%{opacity:.25}}
      @keyframes ping{75%,100%{transform:scale(1.7);opacity:0}}
      @keyframes ripple{to{transform:scale(4);opacity:0}}
      @keyframes rise{from{opacity:0;transform:translate(-50%,14px) scale(.96)}}
      @keyframes fade-in{from{opacity:0}}
      @keyframes fade-out{to{opacity:0}}
      @media (prefers-reduced-motion:reduce){*,*::after{animation:none!important;transition:none!important}}
    </style><div class="wrap"><div class="ring"></div><div class="glow"></div>
      <svg class="cursor" viewBox="0 0 24 24"><path d="M4 3l6.5 17.5 2.6-7.4L20.5 10.5z" fill="#8b5cf6" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>
      <div class="pill" role="status"><span class="bolt"><svg viewBox="0 0 24 24"><path d="M13 2 3 14h9l-1 8 10-12h-9z"/></svg></span>
        <span class="label"></span><span class="dots"><i></i><i></i><i></i></span><button class="stop" title="Stop HailBrowser on this tab">Stop</button></div></div>`;
    host.__root = root;
    host.__pill = root.querySelector('.pill');
    root.querySelector('.stop').addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      host.__pill.classList.add('stopping');
      root.querySelector('.label').textContent = 'Stopping…';
      try { chrome.runtime.sendMessage({ type: 'hail_stop' }); } catch {}
    });
    document.documentElement.appendChild(host);
  }
  if (!host.__pill.classList.contains('stopping')) host.__root.querySelector('.label').textContent = label || 'HailBrowser is working';
  return true;
}

/** Glide the agent cursor to a click point and ripple there (only while the overlay is shown). */
export function showClick(x, y) {
  const host = document.getElementById('__hailbrowser_indicator');
  const root = host?.__root;
  if (!root || host.__leaving) return false;
  const cursor = root.querySelector('.cursor');
  cursor.style.opacity = '1';
  cursor.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  root.querySelector('.wrap').appendChild(ripple);
  setTimeout(() => ripple.remove(), 700);
  return true;
}

/** Hide or show the overlay without removing it, e.g. so screenshots show the page as it is. */
export function overlayVisible(on) {
  const host = document.getElementById('__hailbrowser_indicator');
  if (host) host.style.visibility = on ? '' : 'hidden';
  return !!host;
}

/** Hide the overlay briefly if a click at x,y (from a screenshot) would land on its pill. */
export function yieldIndicator(x, y) {
  const host = document.getElementById('__hailbrowser_indicator');
  const b = host?.__pill?.getBoundingClientRect();
  if (!b || x < b.left - 6 || x > b.right + 6 || y < b.top - 6 || y > b.bottom + 6) return false;
  host.style.visibility = 'hidden';
  clearTimeout(host.__aside);
  host.__aside = setTimeout(() => { host.style.visibility = ''; }, 1500);
  return true;
}

/**
 * Organic results on a search results page (DuckDuckGo, Bing, Google or any engine that puts
 * result titles in headings). Redirect links are unwrapped; the engine's own pages are skipped.
 */
export function searchResults(max) {
  const here = location.hostname.replace(/^www\./, '');
  const unwrap = (href) => {
    try {
      let u = new URL(href, location.href);
      const ddg = u.searchParams.get('uddg');
      if (ddg) u = new URL(ddg);
      else if (/(^|\.)google\./.test(u.hostname) && u.pathname === '/url') u = new URL(u.searchParams.get('q') || u.searchParams.get('url'));
      else if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
        const p = u.searchParams.get('u') || '';
        if (p.startsWith('a1')) u = new URL(atob(p.slice(2).replace(/-/g, '+').replace(/_/g, '/')));
      }
      if (!/^https?:$/.test(u.protocol)) return null;
      const h = u.hostname.replace(/^www\./, '');
      if (h === here || h.endsWith(`.${here}`)) return null;
      u.hash = '';
      return u.href;
    } catch { return null; }
  };
  const text = (e) => (e?.innerText || e?.textContent || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const seen = new Set();
  const add = (a) => {
    if (out.length >= max || !a?.href) return;
    const url = unwrap(a.href);
    if (!url || seen.has(url)) return;
    const title = text(a.querySelector('h3,h2') || a).slice(0, 200);
    if (title.length < 3) return;
    // The snippet is the rest of the smallest block around the link that holds more than the title.
    let box = a.parentElement;
    for (let i = 0; box && i < 6 && text(box).length < title.length + 40; i++) box = box.parentElement;
    const all = box ? text(box) : '';
    const snippet = (all.length < 1500 ? all.replace(title, '') : '').trim().slice(0, 300);
    seen.add(url);
    out.push({ url, title, snippet });
  };
  for (const e of document.querySelectorAll('a.result__a, li.b_algo h2 a, #search a:has(h3), h2 a, h3 a, a h3, a h2')) add(e.closest('a') || e);
  if (out.length < 3) {
    for (const a of document.querySelectorAll('main a[href], #main a[href], body a[href]')) if (text(a).length > 25) add(a);
  }
  const head = text(document.body).slice(0, 3000);
  return { results: out, blocked: /unusual traffic|not a robot|captcha|are you a human|anomaly in your/i.test(head) && out.length === 0 };
}
