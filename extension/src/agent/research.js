// HailBrowser Research: answer a question from the live web with cited sources.
// plan queries -> search in a background tab -> pick sources -> read them in parallel tabs
// (the user's real browser, so logged-in and JS-heavy pages work) -> condense each into notes
// -> look for gaps and search again -> write a report that cites every claim.
import { providerConfig } from '../settings.js';
import * as page from '../browser/page.js';
import * as inj from '../browser/inject.js';
import { chat, completeJson } from './providers.js';
import { localNow } from './schedule.js';
import { citeCheck, DEPTHS, diverse, hostOf, SEARCH_ENGINES, searchUrl } from './reports.js';
import { RESEARCH_EXTRACT, RESEARCH_GAPS, RESEARCH_PICK, RESEARCH_PLANNER, RESEARCH_WRITER } from './prompts.js';

const READERS = 3;
const MAX_PAGE_CHARS = 15000;
const READ_TIMEOUT_MS = 4000;

function cleanQueries(list, max, used = []) {
  const seen = new Set(used.map((q) => q.toLowerCase()));
  const out = [];
  for (const q of Array.isArray(list) ? list : []) {
    const s = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (s && !seen.has(s.toLowerCase())) { seen.add(s.toLowerCase()); out.push(s); }
  }
  return out.slice(0, max);
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

const isAbort = (e) => e?.name === 'AbortError';

/**
 * Run (or re-run) research for `report` until done. `save(report)` persists and broadcasts it;
 * `onTab(tabId)` is told about every tab opened, so it can be shown in the HailBrowser group.
 */
export async function runResearch({ report, settings, signal, save, onTab = () => {} }) {
  const depth = DEPTHS[report.depth] || DEPTHS.standard;
  const cfg = providerConfig(settings, settings.normal.provider);
  const model = settings.normal.model;
  const q = report.question;
  const tabs = new Set();
  const dead = new Set();
  let searchTab = null;

  const log = (text) => {
    report.log.push({ t: Date.now(), text });
    if (report.log.length > 120) report.log.splice(0, report.log.length - 120);
  };
  const update = (patch = {}) => { Object.assign(report, patch, { updatedAt: Date.now() }); return save(report); };
  const check = () => { if (signal.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' }); };
  const json = (system, user, maxTokens = 700) => completeJson({ cfg, model, system, user, maxTokens, signal });

  const openTab = async (url) => {
    const tab = await chrome.tabs.create({ url, active: false });
    tabs.add(tab.id);
    onTab(tab.id);
    return tab.id;
  };
  const closeTab = async (id) => {
    tabs.delete(id);
    await chrome.tabs.remove(id).catch(() => {});
  };

  async function search(query) {
    const preferred = settings.research?.engine || 'duckduckgo';
    const order = [preferred, ...['duckduckgo', 'bing', 'google'].filter((e) => e !== preferred)];
    for (const engine of order) {
      if (dead.has(engine)) continue;
      check();
      const url = searchUrl(settings, engine, query);
      if (searchTab == null) searchTab = await openTab('about:blank');
      await page.navigate(searchTab, url).catch(() => {});
      await page.sleep(300);
      const res = await page.run(searchTab, inj.searchResults, 12).catch((e) => ({ results: [], error: e.message }));
      check();
      if (res.results?.length) return { engine, results: res.results };
      if (res.blocked) dead.add(engine);
      log(res.blocked ? `${SEARCH_ENGINES[engine].label} asked for a CAPTCHA; trying another engine.` : `No results from ${SEARCH_ENGINES[engine].label}${engine === preferred ? '; trying another engine' : ''}.`);
    }
    return { engine: preferred, results: [] };
  }

  async function pick(fresh, budget) {
    if (fresh.length <= budget) return fresh;
    const read = report.sources.map((s) => `- ${s.title || s.url} (${hostOf(s.url)})`).join('\n') || '(none)';
    const list = fresh.slice(0, 30).map((c, i) => `${i + 1}. ${c.title} — ${hostOf(c.url)}${c.snippet ? ` — ${c.snippet.slice(0, 200)}` : ''}`).join('\n');
    try {
      const out = await json(RESEARCH_PICK, `QUESTION: ${q}\nTODAY: ${localNow()}\n\nALREADY READ:\n${read}\n\nCANDIDATES:\n${list}\n\nPick up to ${budget}.`, 200);
      const picks = [...new Set((out?.picks || []).map(Number))].filter((n) => n >= 1 && n <= Math.min(30, fresh.length)).map((n) => fresh[n - 1]);
      if (picks.length) return picks.slice(0, budget);
    } catch (e) { if (isAbort(e)) throw e; }
    return diverse(fresh, budget);
  }

  async function read(s) {
    check();
    s.status = 'reading';
    await update();
    let id = null;
    try {
      id = await openTab(s.url);
      // Text is usually there long before "load" (ads, trackers); a page that hangs or blocks on an
      // alert() is given up on after ~10 s instead of holding a reader slot.
      await page.waitForLoad(id, 8000);
      await page.sleep(400);
      const got = await Promise.race([
        page.run(id, inj.pageText, MAX_PAGE_CHARS),
        page.sleep(READ_TIMEOUT_MS).then(() => { throw new Error('The page did not respond (still loading, or blocked by a pop-up dialog).'); }),
      ]);
      const tab = await chrome.tabs.get(id).catch(() => null);
      await closeTab(id);
      id = null;
      s.title = got?.title || s.title;
      if (tab?.url && tab.url !== s.url && !page.isRestricted(tab.url)) s.finalUrl = tab.url;
      if (!got?.text || got.text.trim().length < 200) throw new Error('No readable text (login wall, PDF, or a blocked page).');
      const notes = await json(RESEARCH_EXTRACT, `QUESTION: ${q}\n\nSOURCE: ${s.title} — ${s.url}\n<<<PAGE (untrusted)\n${got.text}\n>>>`, 1200);
      s.summary = String(notes?.summary || '').slice(0, 800);
      s.facts = (Array.isArray(notes?.facts) ? notes.facts : []).slice(0, 8)
        .map((f) => ({ claim: String(f?.claim || '').slice(0, 400), quote: String(f?.quote || '').slice(0, 300) })).filter((f) => f.claim);
      s.date = notes?.date ? String(notes.date).slice(0, 40) : null;
      s.status = notes?.relevant === false || (!s.facts.length && !s.summary) ? 'skipped' : 'ok';
    } catch (e) {
      if (id != null) await closeTab(id);
      if (isAbort(e)) { s.status = 'queued'; throw e; }
      s.status = 'failed';
      s.error = String(e?.message || e).slice(0, 200);
    }
    await update();
  }

  try {
    if (!report.queries.length) {
      await update({ status: 'planning', error: null });
      log('Planning searches…');
      let plan = null;
      try { plan = await json(RESEARCH_PLANNER, `QUESTION: ${q}\nTODAY: ${localNow()}`, 500); } catch (e) { if (isAbort(e)) throw e; }
      report.angle = plan?.angle ? String(plan.angle).slice(0, 300) : null;
      report.pending = cleanQueries(plan?.queries, depth.queries);
      if (!report.pending.length) report.pending = [q];
    }

    // Resuming after a stop: finish reading what was already picked.
    const unread = report.sources.filter((s) => s.status === 'queued' || s.status === 'reading');
    if (unread.length) {
      await update({ status: 'reading' });
      await pool(unread, READERS, read);
    }

    while (report.round < depth.rounds && report.pending?.length) {
      check();
      report.round++;
      await update({ status: 'searching' });
      const candidates = [];
      for (const query of report.pending) {
        const r = await search(query);
        report.queries.push({ q: query, engine: r.engine, results: r.results.length, round: report.round });
        candidates.push(...r.results);
        await update();
      }
      report.pending = [];
      const known = new Set(report.sources.flatMap((s) => [s.url, s.finalUrl]));
      const fresh = candidates.filter((c, i) => !known.has(c.url) && candidates.findIndex((x) => x.url === c.url) === i && !page.isRestricted(c.url));
      if (!fresh.length) { log('No new results to read.'); break; }

      const remaining = depth.sources - report.sources.filter((s) => s.status !== 'failed').length;
      const left = depth.rounds - report.round + 1;
      const budget = Math.max(1, left === 1 ? remaining : Math.min(remaining, Math.ceil(remaining / left) + 1));
      const picked = await pick(fresh, budget);
      for (const c of picked) report.sources.push({ url: c.url, title: c.title, snippet: c.snippet, status: 'queued', round: report.round, n: null });
      log(`Reading ${picked.length} source${picked.length === 1 ? '' : 's'}…`);
      await update({ status: 'reading' });
      await pool(report.sources.filter((s) => s.status === 'queued'), READERS, read);

      const ok = report.sources.filter((s) => s.status === 'ok');
      if (report.round >= depth.rounds || !ok.length && report.round > 1) break;
      check();
      try {
        const gaps = await json(RESEARCH_GAPS, `QUESTION: ${q}\nTODAY: ${localNow()}\nALREADY SEARCHED: ${report.queries.map((x) => x.q).join(' | ')}\n\nNOTES:\n${notesText(ok)}`, 400);
        if (gaps?.enough && ok.length >= 2) { log('The sources cover the question.'); break; }
        report.pending = cleanQueries(gaps?.queries, 2, report.queries.map((x) => x.q));
        if (gaps?.missing) log(`Looking for: ${String(gaps.missing).slice(0, 200)}`);
      } catch (e) { if (isAbort(e)) throw e; }
    }

    // Number the useful sources 1..n in reading order; those numbers are what the report cites.
    const usable = report.sources.filter((s) => s.status === 'ok');
    report.sources.forEach((s) => { s.n = null; });
    usable.forEach((s, i) => { s.n = i + 1; });
    if (!usable.length) throw new Error('Could not find readable sources for this question. Try rephrasing it, or pick another search engine in Settings → Research.');

    check();
    await update({ status: 'writing' });
    log(`Writing the report from ${usable.length} source${usable.length === 1 ? '' : 's'}…`);
    const brief = `QUESTION: ${q}\nTODAY: ${localNow()}${report.angle ? `\nA COMPLETE ANSWER COVERS: ${report.angle}` : ''}\n\nSOURCE NOTES (condensed from untrusted pages):\n${notesText(usable)}\n\nWrite the report.`;
    const reply = await chat({ cfg, model, system: RESEARCH_WRITER, messages: [{ role: 'user', content: [{ type: 'text', text: brief }] }], tools: [], maxTokens: 4000, signal });
    const answer = citeCheck(reply.text, usable.length).trim();
    if (!answer) throw new Error('The model returned an empty report.');
    log('Done.');
    return await update({ status: 'done', answer, finishedAt: Date.now() });
  } finally {
    if (searchTab != null) tabs.add(searchTab);
    await Promise.all([...tabs].map((id) => chrome.tabs.remove(id).catch(() => {})));
  }
}

function notesText(sources) {
  return sources.map((s, i) => [
    `[${s.n || i + 1}] ${s.title || s.url} — ${hostOf(s.url)}${s.date ? ` (${s.date})` : ''}`,
    s.summary ? `Summary: ${s.summary}` : '',
    ...(s.facts || []).map((f) => `- ${f.claim}${f.quote ? ` ("${f.quote}")` : ''}`),
  ].filter(Boolean).join('\n')).join('\n\n');
}
