// Fast mode on REAL websites (not fixtures): public sites that tolerate automation, each task scored by
// checking the end state in the page (URL, DOM, or the answer run_task returns). Runs in a headless test
// browser, never the user's Chrome. Real model calls (keys from the environment), not part of `npm test`.
//
//   INCEPTION_API_KEY=sk_... node scripts/bench-real.mjs
//   REAL_HANDOFF=0        → Fast mode alone (no chat-model takeover when stuck)
//   REAL_ONLY=wiki-open,gh-repo  REAL_VERBOSE=1  REAL_OUT=file.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const KEY = process.env.INCEPTION_API_KEY;
if (!KEY) { console.error('Set INCEPTION_API_KEY (Mercury Decide for Fast, Mercury 2 as the chat model).'); process.exit(2); }
const HANDOFF = process.env.REAL_HANDOFF !== '0';
const ONLY = process.env.REAL_ONLY ? new Set(process.env.REAL_ONLY.split(',')) : null;
const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const PORT = Number(process.env.REAL_PORT) || 22420 + (process.pid % 50);
const TRUST_FILE = path.join(os.tmpdir(), `hail-trust-real-${process.pid}.json`);

// npm and DuckDuckGo are left out: they show bot checks to headless browsers.
// check(page) runs in the final tab and returns true/false; answer tests the Answer text.
const TASKS = [
  { name: 'wiki-open', start: 'https://en.wikipedia.org/wiki/Main_Page', goal: 'Search Wikipedia for Ada Lovelace and open her article',
    check: () => /\/wiki\/Ada_Lovelace/.test(location.href) },
  { name: 'wiki-q', start: 'https://en.wikipedia.org/wiki/Main_Page', goal: 'In which year was Alan Turing born? Find out on Wikipedia.', answer: /1912/ },
  { name: 'wiki-everest', start: 'https://en.wikipedia.org/wiki/Main_Page', goal: 'Open the Wikipedia article on Mount Everest and tell me its elevation in metres', answer: /8,?84[89]/ },
  { name: 'gh-repo', start: 'https://github.com/search', goal: 'Search GitHub repositories for puppeteer and open the puppeteer/puppeteer repository',
    check: () => /github\.com\/puppeteer\/puppeteer\/?$/.test(location.href.split(/[?#]/)[0]) },
  { name: 'yt-search', start: 'https://www.youtube.com/', goal: 'Search YouTube for lofi hip hop radio',
    check: () => /results\?search_query=lofi/i.test(location.href) },
  { name: 'mdn-map', start: 'https://developer.mozilla.org/en-US/', goal: 'Search MDN for Array.prototype.map and open its reference page',
    check: () => /Global_Objects\/Array\/map/.test(location.href) },
  { name: 'hn-top', start: 'https://news.ycombinator.com/', goal: 'What is the title of the top story on Hacker News right now?',
    answer: (a, ctx) => ctx.topStory && a.toLowerCase().includes(ctx.topStory.toLowerCase().slice(0, 25)),
    before: () => document.querySelector('.titleline a')?.textContent || '' },
  { name: 'books-price', start: 'https://books.toscrape.com/', goal: 'What is the price of the book "A Light in the Attic"?', answer: /51\.77/ },
  { name: 'books-cat', start: 'https://books.toscrape.com/', goal: 'Open the Poetry category and open the book "Olio"',
    check: () => /olio_984/.test(location.href) },
  { name: 'demoqa-textbox', start: 'https://demoqa.com/text-box', goal: 'Fill in Full Name "Asha Rao", Email "asha@example.com", Current Address "MG Road, Bengaluru" and submit',
    check: () => /Asha Rao/.test(document.querySelector('#output')?.innerText || '') && /asha@example\.com/.test(document.querySelector('#output')?.innerText || '') },
  { name: 'demoqa-radio', start: 'https://demoqa.com/radio-button', goal: 'Select the "Impressive" option',
    check: () => /Impressive/.test(document.querySelector('.text-success')?.textContent || '') },
  { name: 'demoqa-checkbox', start: 'https://demoqa.com/checkbox', goal: 'Expand the Home folder and tick Desktop',
    check: () => /desktop/i.test(document.querySelector('#result')?.innerText || '') },
  { name: 'internet-dropdown', start: 'https://the-internet.herokuapp.com/dropdown', goal: 'Choose Option 2 in the dropdown',
    check: () => document.querySelector('#dropdown')?.value === '2' },
  { name: 'internet-checkbox', start: 'https://the-internet.herokuapp.com/checkboxes', goal: 'Make sure both checkboxes are ticked',
    check: () => [...document.querySelectorAll('#checkboxes input')].every((c) => c.checked) },
  { name: 'internet-add', start: 'https://the-internet.herokuapp.com/add_remove_elements/', goal: 'Add three elements',
    check: () => document.querySelectorAll('#elements button').length === 3 },
  { name: 'todomvc', start: 'https://todomvc.com/examples/javascript-es6/dist/', goal: 'Add the todos "buy milk" and "call mom", then mark "buy milk" as completed',
    check: () => { const items = [...document.querySelectorAll('.todo-list li')]; const m = items.find((li) => /buy milk/.test(li.innerText)); return items.some((li) => /call mom/.test(li.innerText)) && !!m && m.classList.contains('completed'); } },
];

const answerOf = (text) => /\n\nAnswer:\n([\s\S]*?)(\n\nSteps:|\n\n\(Fast mode got stuck first|$)/.exec(text)?.[1]?.trim()
  // After a chat-model takeover the reply itself is the answer.
  ?? (/Fast mode got stuck first/.test(text) ? text.split('\n\n(Fast mode got stuck first')[0].trim() : null);

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT], args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900', '--lang=en-US'] });
let client;
const rows = [];
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.chrome?.storage?.local)); i++) await new Promise((r) => setTimeout(r, 100));
  await sw.evaluate(async (port, key, handoff) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    settings.bridge = { enabled: true, port, ownWindow: false };
    settings.providers = { inception: { apiKey: key, baseUrl: '' } };
    settings.normal = { provider: 'inception', model: 'mercury-2', vision: false, maxSteps: 25 };
    settings.ultrafast = { backend: 'inception', inceptionModel: 'mercury-decide', textProvider: 'inception', textModel: 'mercury-2', maxActions: 20, handoff };
    await chrome.storage.local.set({ settings });
  }, PORT, KEY, HANDOFF);

  client = new Client({ name: 'bench-real', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp-server/src/index.js', '--port', String(PORT)], env: { ...process.env, HAILBROWSER_TRUST_FILE: TRUST_FILE }, stderr: 'ignore' }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 300000 });
    return { text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: r.isError };
  };
  const evalIn = async (fn) => {
    const r = await call('javascript', { code: `(${fn.toString()})()` });
    try { return JSON.parse(r.text); } catch { return r.text; }
  };

  console.log(`Fast mode on real sites · decision: mercury-decide · chat model: mercury-2 · takeover when stuck: ${HANDOFF ? 'on' : 'off'}\n`);
  for (const task of TASKS) {
    if (ONLY && !ONLY.has(task.name)) continue;
    const opened = await call('tabs_create', { url: task.start });
    const tabId = Number(/Tab (\d+)/.exec(opened.text)?.[1]);
    const ctx = task.before ? { topStory: await evalIn(task.before) } : {};
    const t0 = Date.now();
    const r = await call('run_task', { goal: task.goal, mode: 'ultrafast' });
    const secs = (Date.now() - t0) / 1000;
    let ok = false, detail = '';
    if (task.answer) {
      const a = answerOf(r.text) || '';
      ok = typeof task.answer === 'function' ? !!task.answer(a, ctx) : task.answer.test(a);
      detail = `answer: ${a.replace(/\s+/g, ' ').slice(0, 80) || '(none)'}`;
    } else {
      ok = (await evalIn(task.check)) === true;
      detail = (await evalIn(() => location.href)).toString().slice(0, 90);
    }
    const head = r.text.split('\n')[0];
    const tookOver = /Fast mode got stuck first/.test(r.text);
    const status = r.isError ? 'error' : tookOver ? 'takeover' : /✅|Done/.test(head) ? 'done' : /Blocked|⚠️/.test(head) ? 'stuck' : 'other';
    const actions = Number(/(\d+) actions/.exec(r.text)?.[1] ?? NaN);
    rows.push({ task: task.name, pass: ok, status, secs, actions, detail, summary: r.text.slice(0, 600) });
    if (process.env.REAL_VERBOSE) console.log(r.text, '\n');
    console.log(`${ok ? '✅' : '❌'} ${task.name.padEnd(18)} ${status.padEnd(9)} ${String(actions).padStart(3)} actions ${secs.toFixed(1).padStart(6)}s  ${detail}${r.isError ? `  ${r.text.slice(0, 120)}` : ''}`);
    if (tabId) await call('tabs_close', { tabId }).catch(() => {});
  }
} finally {
  await client?.close().catch(() => {});
  await browser.close();
}
const pass = rows.filter((r) => r.pass).length;
const avg = rows.reduce((a, r) => a + r.secs, 0) / (rows.length || 1);
console.log(`\nReal sites: ${pass}/${rows.length} passed · ${rows.filter((r) => r.status === 'stuck').length} stuck · ${rows.filter((r) => r.status === 'takeover').length} chat takeovers · avg ${avg.toFixed(1)}s`);
if (process.env.REAL_OUT) fs.writeFileSync(process.env.REAL_OUT, JSON.stringify({ handoff: HANDOFF, rows }, null, 2));
