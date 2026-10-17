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
  let omitted = 0, offscreen = 0;
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
    if (o.viewportOnly && !inViewport) { offscreen++; continue; }
    if (elements.length >= o.maxElements) { omitted++; continue; }
    const el = { id: identity(e), role: rname, label: clean(name(e), 160) || rname,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, inViewport };
    for (const key of ['checked', 'selected', 'expanded']) {
      const v = e.getAttribute('aria-' + key);
      if (v !== null) el[key] = v;
    }
    if (['checkbox', 'radio'].includes(e.type)) el.checked = String(e.checked);
    if (e.tagName === 'A' && e.getAttribute('href')) el.href = e.href.slice(0, 200);
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

  // Visible text in the viewport only, so offscreen footers don't fill model context.
  const words = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let node, length = 0;
  while ((node = walker.nextNode()) && length < o.maxText) {
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
  let blocker = null;
  for (const [px, py] of points) {
    const x = Math.min(Math.max(px, 1), innerWidth - 2), y = Math.min(Math.max(py, 1), innerHeight - 2);
    const hit = document.elementFromPoint(x, y);
    if (owns(hit) || (hit && hit.contains(e))) return { x, y, tag: e.tagName };
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

/** A soft glow + pill showing the tab is being driven by an agent. Lives in a closed shadow root. */
export function setIndicator(on, label) {
  const ID = '__hailbrowser_indicator';
  let host = document.getElementById(ID);
  if (!on) { host?.remove(); return true; }
  if (!host) {
    host = document.createElement('div');
    host.id = ID;
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .glow{position:fixed;inset:0;box-shadow:inset 0 0 0 2px rgba(91,141,255,.9),inset 0 0 28px rgba(91,141,255,.45);animation:p 1.6s ease-in-out infinite;border-radius:2px}
      .pill{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);font:600 12px/1 system-ui,sans-serif;color:#fff;
        background:linear-gradient(90deg,#3b6cff,#8b5cf6);padding:8px 12px;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.25)}
      @keyframes p{50%{opacity:.55}}</style><div class="glow"></div><div class="pill"></div>`;
    host.__pill = root.querySelector('.pill');
    (document.body || document.documentElement).appendChild(host);
  }
  if (host.__pill) host.__pill.textContent = `⚡ ${label || 'HailBrowser is working'}`;
  return true;
}
