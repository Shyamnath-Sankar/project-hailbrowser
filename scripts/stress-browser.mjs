// Stress and long-horizon test in a real browser (Chrome for Testing + the unpacked extension +
// the real MCP server). A scripted fake model drives everything, so no API keys or paid calls are
// used, but it misbehaves on purpose: random latency, HTTP 500s, 429s with Retry-After, and broken
// tool arguments. Pages misbehave too: slow, 404, never finishing, alert() on load, 2 MB of text.
//
//   node scripts/stress-browser.mjs            (about 3-5 minutes)
//
// Scenarios:
//   1. A 40-subtask long task (25 planned + 15 added on the way), ~200 model calls, under chaos.
//   2. The service worker is killed in the middle; the task comes back paused and resumes to the end.
//   3. While it runs: chat is refused politely, MCP actions are refused, a scheduled job queues and
//      runs automatically afterwards.
//   4. Deep research under chaos with bad pages, then the panel is reloaded mid-run.
//   5. Storage churn: 120 big chats are trimmed to the 60 newest; a 400-event chat redraws quickly.
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const TRUST_FILE = path.join(os.tmpdir(), `hail-trust-stress-${process.pid}.json`);
const BRIDGE_PORT = 22410;
const PLANNED = 25;
const ADDED = 15;
const TOTAL = PLANNED + ADDED;

// Deterministic chaos.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const stats = { calls: 0, err500: 0, err429: 0, broken: 0, byKind: {} };
const count = (k) => { stats.byKind[k] = (stats.byKind[k] || 0) + 1; };
let chaos = true;

const say = (content) => ({ choices: [{ message: { content } }] });
const toolCall = (name, args, broken = false) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `c${Math.floor(rand() * 1e9)}`, type: 'function', function: { name, arguments: broken ? '{"url": ' : JSON.stringify(args) } }] } }] });
const userText = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((p) => p.text || '').join(''));

let base;
let other; // same server via "localhost", so research sources are a different site than the search page

// A task agent that recovers from errors: it looks at what has succeeded so far, not at step counts.
function taskAgent(body) {
  const brief = userText(body.messages.find((m) => m.role === 'user'));
  const n = /CURRENT SUBTASK: Complete lesson (\d+)/.exec(brief)?.[1];
  if (!n) return toolCall('task_complete', { summary: 'nothing to do' });
  const results = body.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
  const ok = (re) => results.some((r) => !r.startsWith('ERROR') && re.test(r));
  const broken = chaos && rand() < 0.04;
  if (broken) stats.broken++;
  if (n === '5' && !/Added 15 subtasks/.test(results.join('\n')) && !/lesson 26/i.test(brief)) {
    return toolCall('add_subtasks', { items: Array.from({ length: ADDED }, (_, i) => ({ title: `Complete lesson ${PLANNED + 1 + i}`, detail: 'Open it and mark it complete' })) });
  }
  if (!ok(new RegExp(`Loaded .*Lesson ${n}\\b`))) return toolCall('navigate', { url: `${base}/course/${n}` }, broken);
  const found = results.filter((r) => /\[ref_\d+\] button "Mark lesson complete/.test(r)).at(-1);
  if (!found || !ok(new RegExp(`Loaded .*Lesson ${n}\\b`))) return toolCall('find', { query: 'Mark lesson complete' });
  if (!ok(/^Clicked/)) return toolCall('click', { ref: /\[(ref_\d+)\] button "Mark lesson complete/.exec(found)[1] }, broken);
  if (!ok(/^Saved\./)) return toolCall('save_note', { note: `Lesson ${n} completed` });
  return toolCall('task_complete', { summary: `Lesson ${n} marked complete` });
}

function fakeModel(body) {
  const system = typeof body.messages[0].content === 'string' ? body.messages[0].content : '';
  const user = userText(body.messages[1] || { content: '' });
  if (system.startsWith('You plan long browser tasks')) {
    count('plan');
    return say(JSON.stringify({ subtasks: Array.from({ length: PLANNED }, (_, i) => ({ title: `Complete lesson ${i + 1}`, detail: `Open lesson ${i + 1} and mark it complete` })) }));
  }
  if (system.includes('You are working on ONE subtask')) { count('task'); return taskAgent(body); }
  if (system.startsWith('You finish a long browser task')) {
    count('final');
    const done = (user.match(/Lesson \d+ completed/g) || []).length;
    return say(`All ${TOTAL} lessons are complete (${done} confirmed in notes).`);
  }
  if (system.startsWith('You plan web research')) { count('r-plan'); return say(JSON.stringify({ queries: ['set one', 'set two'], angle: 'Everything about beta.' })); }
  if (system.startsWith('You choose which search results')) {
    count('r-pick');
    const n = (user.match(/^\d+\. /gm) || []).length;
    return say(JSON.stringify({ picks: Array.from({ length: n }, (_, i) => i + 1) }));
  }
  if (system.startsWith('You read one web page')) {
    count('r-read');
    const n = /SOURCE: Beta source (\d+)/.exec(user)?.[1] || '?';
    if (chaos && rand() < 0.1) return say('Sorry, here is no JSON at all'); // the model ignores the format
    return say(JSON.stringify({ relevant: true, summary: `Beta source ${n} says something.`, facts: [{ claim: `Beta fact ${n}`, quote: 'beta' }] }));
  }
  if (system.startsWith('You review research notes')) {
    count('r-gaps');
    return say(/set three/.test(user) ? '{"enough": true, "queries": []}' : '{"enough": false, "missing": "more", "queries": ["set three"]}');
  }
  if (system.startsWith('You write a research report')) {
    count('r-write');
    const n = (user.match(/^\[\d+\] /gm) || []).length;
    return say(`Beta is covered by ${n} sources ${Array.from({ length: n }, (_, i) => `[${i + 1}]`).join('')}.\n\n## Details\n- Point [1]`);
  }
  count('chat');
  return say('ok');
}

const lessons = new Set();
const server = http.createServer((req, res) => {
  const html = (body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end(body); };
  let m;
  if ((m = /^\/course\/(\d+)$/.exec(req.url))) {
    return html(`<!doctype html><title>Lesson ${m[1]}</title><h1>Lesson ${m[1]}</h1><p>Content.</p>
      <button onclick="fetch('/done/${m[1]}').then(() => document.body.append(' Completed!'))">Mark lesson complete</button>`);
  }
  if ((m = /^\/done\/(\d+)$/.exec(req.url))) { lessons.add(Number(m[1])); res.writeHead(204); return res.end(); }
  if (req.url.startsWith('/search')) {
    const q = new URL(req.url, base).searchParams.get('q');
    const ids = q === 'set one' ? [1, 2, 3, 4, 5, 6] : q === 'set two' ? [4, 5, 6, 7, 8, 9] : [9, 10, 11, 12, 13, 14];
    return html(`<!doctype html><title>Search</title>${ids.map((i) => `<div><h3><a href="${other}/rs/${i}">Beta source ${i}</a></h3><p>About beta, part ${i}.</p></div>`).join('')}`);
  }
  if ((m = /^\/rs\/(\d+)$/.exec(req.url))) {
    const i = Number(m[1]);
    const page = (extra = '') => `<!doctype html><title>Beta source ${i}</title>${extra}<main><h1>Beta source ${i}</h1><p>${'Beta is a topic with many facts. '.repeat(30)}</p></main>`;
    if (i === 7) return setTimeout(() => html(page()), 4000); // slow
    if (i === 8) return html('<!doctype html><title>Not found</title>404', 404);
    if (i === 9) { res.writeHead(200, { 'content-type': 'text/html' }); res.write(`<!doctype html><title>Beta source 9</title><p>${'Partial. '.repeat(60)}`); return; } // never finishes
    if (i === 10) return html(page('<script>alert("Subscribe now!")</script>'));
    if (i === 11) return html(page(`<div>${'x'.repeat(2_000_000)}</div>`)); // 2 MB
    return html(page());
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      stats.calls++;
      const delay = chaos ? 20 + rand() * 230 : 5;
      setTimeout(() => {
        const roll = rand();
        if (chaos && roll < 0.12) { stats.err500++; res.writeHead(500); return res.end('{"error":"chaos 500"}'); }
        if (chaos && roll < 0.17) { stats.err429++; res.writeHead(429, { 'retry-after': '1' }); return res.end('{"error":"rate limited"}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fakeModel(JSON.parse(data))));
      }, delay);
    });
    return;
  }
  html('<!doctype html><title>Home</title><h1>Home</h1>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
base = `http://127.0.0.1:${server.address().port}`;
other = `http://localhost:${server.address().port}`;

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT], args: ['--no-first-run', '--no-default-browser-check'] });
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const step = (name) => console.log(`• [${elapsed()}] ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = {};
let client;

// Calls into a worker that died never settle, so every one gets a deadline.
const deadline = (p, ms, what) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);

/**
 * Evaluate in the extension's service worker over our own CDP session. After the worker is killed,
 * Chrome restarts it under the same target and holds it paused for the debugger, and puppeteer's
 * worker handle stays bound to the dead one; a fresh session (resumed) reaches the new worker.
 */
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'), { timeout: 20000 });
let swSession = null;
async function attachWorker() {
  swSession?.detach().catch(() => {});
  swSession = await deadline(swTarget.createCDPSession(), 10000, 'attaching to the worker');
  await swSession.send('Runtime.runIfWaitingForDebugger').catch(() => {});
  for (let i = 0; i < 100; i++) {
    const r = await deadline(swSession.send('Runtime.evaluate', { expression: 'typeof globalThis.hail' }), 3000, 'worker ping').catch(() => null);
    if (r?.result?.value === 'object') return;
    await sleep(100);
  }
  throw new Error('The service worker did not start');
}
const sw = {
  url: () => swTarget.url(),
  async evaluate(fn, ...args) {
    const r = await deadline(swSession.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
    }), 30000, 'worker evaluate');
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  },
};
await attachWorker();
const extId = new URL(sw.url()).host;
const store = (key) => deadline(sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key), 5000, 'storage read');
const waitFor = async (fn, label, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await sleep(250);
  }
};
const latestTask = async () => {
  const idx = (await store('tasks:index')) || [];
  return idx[0] ? store(`tasks:${idx[0].id}`) : null;
};

try {
  await sw.evaluate(async (port, base) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    Object.assign(settings, {
      bridge: { enabled: true, port },
      providers: { custom: { apiKey: '', baseUrl: `${base}/v1` } },
      normal: { provider: 'custom', model: 'fake', vision: false, maxSteps: 10 },
      tasks: { stepsPerSubtask: 15, maxTotalSteps: 2000 },
      research: { engine: 'custom', customUrl: `${base}/search?q=%s`, depth: 'deep' },
      notifications: false,
    });
    await chrome.storage.local.set({ settings });
  }, BRIDGE_PORT, base);

  client = new Client({ name: 'stress', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, env: { ...process.env, HAILBROWSER_TRUST_FILE: TRUST_FILE }, args: ['mcp-server/src/index.js', '--port', String(BRIDGE_PORT)], stderr: 'ignore' }));
  await waitFor(async () => !(await client.callTool({ name: 'tabs_context', arguments: {} })).isError, 'bridge');
  await client.callTool({ name: 'tabs_create', arguments: { url: base } });
  step('extension, MCP bridge and chaos model ready');

  const panel = await browser.newPage();
  await panel.setViewport({ width: 400, height: 760 });
  await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`);
  await panel.waitForSelector('#input');
  // Event-loop lag in the panel: the worst delay of a 50 ms timer while everything runs.
  let lagBefore = 0;
  const watchLag = () => panel.evaluate(() => {
    window.__lag = 0;
    let last = performance.now();
    setInterval(() => { const now = performance.now(); window.__lag = Math.max(window.__lag, now - last - 50); last = now; }, 50);
  });
  await watchLag();

  // ---- 1. Long-horizon task under chaos ----
  const taskStart = Date.now();
  await panel.click('[data-use="task"]');
  await panel.type('#input', `Complete all lessons of this course (there are ${TOTAL})`);
  await panel.keyboard.press('Enter');
  await waitFor(async () => (await latestTask())?.subtasks.filter((s) => s.status === 'done').length >= 10, '10 subtasks done', 120000);
  step('long task: 10 subtasks done under chaos');

  // ---- 2. Kill the service worker mid-task ----
  const cdp = await panel.createCDPSession();
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await sleep(1500);
  await attachWorker(); // the panel reconnects, which starts a fresh worker
  const paused = await waitFor(async () => { const t = await latestTask(); return t?.status === 'paused' && t; }, 'task paused after the worker restart', 20000);
  assert.match(paused.log.at(-1).text, /Chrome restarted the extension/);
  const doneAtKill = paused.subtasks.filter((s) => s.status === 'done').length;
  await panel.waitForSelector('#feed .task-slot [data-act="task_resume"]', { timeout: 15000 });
  await panel.click('#feed .task-slot [data-act="task_resume"]');
  await waitFor(async () => (await sw.evaluate(() => hail.state().run?.mode)) === 'tasks', 'task running again');
  step(`worker killed after ${doneAtKill} subtasks: task came back paused, resumed from the panel`);

  // ---- 3. Everything else while the task runs ----
  await panel.type('#input', 'hello?');
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => /Busy with a long task/.test(document.querySelector('#toast')?.textContent || ''));
  const mcpClick = await client.callTool({ name: 'click', arguments: { x: 5, y: 5 } });
  assert.ok(mcpClick.isError && /busy/.test(mcpClick.content[0].text), mcpClick.content[0].text);
  assert.ok(!(await client.callTool({ name: 'tabs_context', arguments: {} })).isError, 'read-only tabs_context still works');
  const sched = await sw.evaluate((base) => hail.saveSchedule({ goal: 'Read the home page', title: 'Queued job', mode: 'normal', url: base, frequency: 'daily', time: '23:59' }).then((s) => s.id), base);
  await sw.evaluate((id) => hail.runSchedule(id), sched);
  assert.equal((await sw.evaluate(() => hail.state().queue.length)), 1, 'the job waits in the queue');
  step('while busy: chat refused with a clear message, MCP actions refused, scheduled job queued');

  const finished = await waitFor(async () => { const t = await latestTask(); return ['done', 'waiting_user', 'failed'].includes(t?.status) && t; }, 'long task to finish', 300000);
  report.task = {
    status: finished.status, subtasks: finished.subtasks.length, done: finished.subtasks.filter((s) => s.status === 'done').length,
    steps: finished.steps, minutes: ((Date.now() - taskStart) / 60000).toFixed(1), lessonsOnServer: lessons.size,
    retried: finished.subtasks.filter((s) => s.attempts > 1).length, asked: finished.question,
  };
  assert.equal(finished.status, 'done', `task ended as ${finished.status}: ${finished.question || finished.error || ''}`);
  assert.equal(finished.subtasks.length, TOTAL);
  assert.equal(lessons.size, TOTAL, `server saw ${lessons.size}/${TOTAL} lessons`);
  assert.match(finished.answer || '', new RegExp(`All ${TOTAL} lessons are complete`));
  await panel.waitForFunction((n) => new RegExp(`All ${n} lessons are complete`).test(document.querySelector('#feed').textContent), {}, TOTAL);
  step(`long task done: ${TOTAL}/${TOTAL} subtasks, ${finished.steps} steps, ${report.task.retried} subtasks retried after errors, final answer written`);

  const run = await waitFor(async () => (await store('scheduleRuns'))?.find((r) => r.scheduleId === sched && r.status !== 'running'), 'queued job to run', 60000);
  assert.equal(run.status, 'done', JSON.stringify(run));
  assert.ok(run.delayedMs > 1000, 'it started late because HailBrowser was busy');
  step(`queued scheduled job ran by itself afterwards (${(run.delayedMs / 1000).toFixed(0)}s late)`);

  // ---- 4. Deep research under chaos, panel reloaded mid-run ----
  const rStart = Date.now();
  await panel.click('[data-use="research"]');
  await panel.click('#depth [data-depth="deep"]');
  await panel.type('#input', 'Tell me everything about beta');
  await panel.keyboard.press('Enter');
  await waitFor(async () => (await store('reports:index'))?.[0]?.status === 'reading', 'research reading');
  lagBefore = await panel.evaluate(() => window.__lag);
  await panel.reload();
  await panel.waitForSelector('#feed .report-slot .phases', { timeout: 15000 });
  await watchLag();
  step('panel reloaded during research: the live report card is back');
  const rIdx = await waitFor(async () => { const i = (await store('reports:index'))?.[0]; return ['done', 'failed'].includes(i?.status) && i; }, 'research to finish', 240000);
  const rep = await store(`reports:${rIdx.id}`);
  const by = (st) => rep.sources.filter((s) => s.status === st).length;
  report.research = { status: rep.status, seconds: ((Date.now() - rStart) / 1000).toFixed(0), rounds: rep.round, queries: rep.queries.length, ok: by('ok'), failed: by('failed'), skipped: by('skipped'), errors: rep.sources.filter((s) => s.error).map((s) => `${new URL(s.url).pathname}: ${s.error}`) };
  assert.equal(rep.status, 'done', rep.error);
  assert.ok(by('ok') >= 5, `only ${by('ok')} sources were usable`);
  // Whichever bad pages were picked (404, never-finishing, alert on load) must not end up as cited sources.
  for (const bad of ['/rs/8', '/rs/9', '/rs/10']) {
    const src = rep.sources.find((x) => x.url.endsWith(bad));
    if (src) assert.ok(!src.n, `${bad} was cited (${src.status})`);
  }
  await panel.waitForFunction(() => document.querySelectorAll('#feed .answer .cite').length >= 5);
  const leftover = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.filter((x) => /\/rs\/|\/search\?/.test(x.url)).length));
  assert.equal(leftover, 0, 'research closed every tab it opened (including the hanging and alert pages)');
  step(`deep research done in ${report.research.seconds}s: ${rep.round} rounds, ${by('ok')} sources used, ${by('failed')} bad pages handled, all tabs closed`);

  // ---- 5. Storage churn and big chats ----
  chaos = false;
  const churn = await sw.evaluate(async () => {
    const events = Array.from({ length: 400 }, (_, i) => (i % 4 === 0 ? { type: 'user', text: `Question ${i} ${'q'.repeat(200)}` }
      : i % 4 === 1 ? { type: 'tool', name: 'read_page', args: { url: 'https://x.test' } }
        : i % 4 === 2 ? { type: 'tool_result', name: 'read_page', isError: false, latencyMs: 5, text: 'r'.repeat(600) }
          : { type: 'assistant', text: `Answer ${i}\n\n- point one\n- point two ${'a'.repeat(400)}` }));
    const t = performance.now();
    for (let i = 0; i < 120; i++) {
      await hail.stores.chatStore.put({ id: `stress${i}`, title: `Stress chat ${i}`, createdAt: Date.now(), updatedAt: Date.now(), messages: [], events });
    }
    const index = await hail.stores.chatStore.index();
    return { ms: Math.round(performance.now() - t), kept: index.length, newest: index[0].id, bytes: await chrome.storage.local.getBytesInUse(null) };
  });
  assert.equal(churn.kept, 60);
  assert.equal(churn.newest, 'stress119');
  report.storage = { chatsWritten: 120, kept: churn.kept, writeMsPerChat: (churn.ms / 120).toFixed(1), totalMB: (churn.bytes / 1e6).toFixed(1) };
  step(`storage: 120 chats x 400 events written (${report.storage.writeMsPerChat} ms each), trimmed to 60, ${report.storage.totalMB} MB in use`);

  await panel.click('#open-history');
  await panel.waitForSelector('#history-list .hrow');
  const drawMs = await panel.evaluate(async () => {
    const t = performance.now();
    document.querySelector('#history-list .hrow [data-h="open"]').click();
    await new Promise((resolve) => {
      const check = () => (document.querySelectorAll('#feed .msg.user').length >= 100 ? resolve() : requestAnimationFrame(check));
      check();
    });
    return Math.round(performance.now() - t);
  });
  report.panel = { openBigChatMs: drawMs, maxEventLoopLagMs: Math.round(Math.max(lagBefore, await panel.evaluate(() => window.__lag))) };
  assert.ok(drawMs < 3000, `opening a 400-event chat took ${drawMs} ms`);
  step(`panel: a 400-event chat opens in ${drawMs} ms; worst event-loop stall during the whole run ${report.panel.maxEventLoopLagMs} ms`);

  const heap = await swSession.send('Runtime.getHeapUsage').catch(() => null);
  if (heap) report.worker = { heapMB: (heap.usedSize / 1e6).toFixed(1) };

  report.model = { calls: stats.calls, injected500: stats.err500, injected429: stats.err429, brokenToolArgs: stats.broken, byKind: stats.byKind };
  console.log('\nSTRESS REPORT');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nSTRESS PASSED in ${elapsed()}`);
} finally {
  await client?.close().catch(() => {});
  await browser.close();
  server.closeAllConnections?.();
  server.close();
}
