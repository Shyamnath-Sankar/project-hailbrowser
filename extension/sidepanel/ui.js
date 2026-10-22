// Small DOM and formatting helpers shared by the side panel.

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const ms = (n) => (n == null ? '' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);
export const card = (inner, cls = '') => `<div class="card ${cls}"><div class="card-in">${inner}</div></div>`;
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Chrome's cached favicon for a page (needs the "favicon" permission). */
export function favicon(url) {
  return `/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`;
}

export function ago(t, now = Date.now()) {
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(msTotal) {
  const s = Math.max(0, Math.round(msTotal / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Minimal, safe Markdown: headings, paragraphs, bullet and numbered lists, code, bold,
 * italics, links and [n] citations (linked when `cites` maps n -> {url, title}).
 */
export function markdown(src, cites = null) {
  const inline = (t) => {
    let h = esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    if (cites) {
      h = h.replace(/\[(\d+)\](?!\()/g, (all, n) => {
        const c = cites.get(Number(n));
        return c ? `<a class="cite" href="${esc(c.url)}" target="_blank" rel="noopener" title="${esc(c.title || c.url)}">${n}</a>` : '';
      });
    }
    return h;
  };
  const blocks = (text) => {
    const out = [];
    let para = [];
    let list = null;
    const flushPara = () => { if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; };
    const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; };
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line))) {
        flushPara(); flushList();
        const tag = m[1].length <= 2 ? 'h3' : 'h4';
        out.push(`<${tag}>${inline(m[2].replace(/\s*#+\s*$/, ''))}</${tag}>`);
        continue;
      }
      if ((m = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line))) {
        flushPara();
        const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[2]);
        continue;
      }
      if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out.join('');
  };
  return String(src ?? '').split(/```/).map((block, i) => (i % 2 ? `<pre><code>${esc(block.replace(/^\w*\n/, ''))}</code></pre>` : blocks(block))).join('');
}

export function download(name, text, type = 'text/markdown') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export const slug = (s) => String(s || 'hailbrowser').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'hailbrowser';

let toastTimer;
export function toast(text, kind = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 6000 : 3000);
}
