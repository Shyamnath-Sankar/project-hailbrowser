// Research reports: data shape, storage and formatting. Pure (no browser automation), so the
// side panel can import it.
import { collection, uid } from '../store.js';

export const SEARCH_ENGINES = {
  duckduckgo: { label: 'DuckDuckGo', url: 'https://html.duckduckgo.com/html/?q=%s' },
  bing: { label: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  google: { label: 'Google', url: 'https://www.google.com/search?q=%s&hl=en' },
  custom: { label: 'Custom URL' },
};

export const DEPTHS = {
  quick: { label: 'Quick', rounds: 1, sources: 4, queries: 2 },
  standard: { label: 'Standard', rounds: 2, sources: 6, queries: 3 },
  deep: { label: 'Deep', rounds: 3, sources: 10, queries: 4 },
};

export const reportStore = collection('reports', {
  max: 40,
  summary: (r) => ({ question: r.question, status: r.status, updatedAt: r.updatedAt, sources: r.sources.filter((s) => s.n).length }),
  protect: (r) => r && ['planning', 'searching', 'reading', 'writing'].includes(r.status),
});

export function newReport(question, depth = 'standard', extra = {}) {
  const now = Date.now();
  return {
    id: uid('r'), question: String(question).trim(), depth: DEPTHS[depth] ? depth : 'standard', status: 'planning',
    createdAt: now, updatedAt: now, finishedAt: null, angle: null, round: 0,
    queries: [], sources: [], log: [], answer: null, error: null, ...extra,
  };
}

export const RUNNING = new Set(['planning', 'searching', 'reading', 'writing']);

export function searchUrl(settings, engine, query) {
  const template = engine === 'custom' ? settings.research?.customUrl : SEARCH_ENGINES[engine]?.url;
  if (!template || !template.includes('%s')) throw new Error('Set a search URL containing %s in Settings → Research.');
  return template.replace('%s', encodeURIComponent(query));
}

export const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Drop citations to sources that don't exist ([7] with 5 sources), keep the rest. */
export function citeCheck(markdown, count) {
  return String(markdown || '').replace(/(\s*)\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (all, space, nums) => {
    const ok = nums.split(',').map((n) => Number(n.trim())).filter((n) => n >= 1 && n <= count);
    return ok.length ? space + ok.map((n) => `[${n}]`).join('') : '';
  });
}

/** Report + numbered source list, for copying or downloading. */
export function reportMarkdown(r) {
  const cited = r.sources.filter((s) => s.n).sort((a, b) => a.n - b.n);
  return [
    `# ${r.question}`, '',
    `_Researched ${new Date(r.finishedAt || r.updatedAt).toLocaleString()} · ${cited.length} sources_`, '',
    r.answer || '_No answer yet._', '',
    cited.length ? '## Sources' : '',
    ...cited.map((s) => `${s.n}. [${s.title || s.url}](${s.url}) — ${hostOf(s.url)}${s.date ? ` (${s.date})` : ''}`),
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** One result per site first, then the rest: a cheap stand-in when the model can't pick. */
export function diverse(candidates, n) {
  const hosts = new Set();
  const first = [], rest = [];
  for (const c of candidates) {
    const h = hostOf(c.url);
    (hosts.has(h) ? rest : first).push(c);
    hosts.add(h);
  }
  return [...first, ...rest].slice(0, n);
}

