// Live check of the OpenRouter / Inception decision backends in a real browser: Chrome for Testing + the
// unpacked extension + the MCP server, driving a local fixture form with a real decision model.
// Makes real (free-tier) API calls, so it is not part of `npm test`.
//
//   OPENROUTER_API_KEY=sk-or-... [DECISION_MODEL=respan/span-01-lite:free] node scripts/live-openrouter.mjs
//   INCEPTION_API_KEY=sk_... node scripts/live-openrouter.mjs              (Inception direct, mercury-decide)
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const BACKEND = process.env.INCEPTION_API_KEY ? 'inception' : 'openrouter';
const KEY = process.env.INCEPTION_API_KEY || process.env.OPENROUTER_API_KEY;
if (!KEY) { console.error('Set OPENROUTER_API_KEY or INCEPTION_API_KEY.'); process.exit(2); }
const MODEL = process.env.DECISION_MODEL || (BACKEND === 'inception' ? 'mercury-decide' : 'respan/span-01-lite:free');
const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const BRIDGE_PORT = 22401;
const TRUST_FILE = path.join(os.tmpdir(), `hail-trust-live-${process.pid}.json`);

const FIXTURE = `<!doctype html><title>Fixture Search</title>
<h1>Fixture search</h1>
<form id="f">
  <label>Destination <input id="q" name="q"></label>
  <label><input type="checkbox" id="ns"> Nonstop</label>
  <button>Search</button>
</form>
<a href="#">Privacy policy</a>
<p id="out"></p>
<script>f.onsubmit = (e) => { e.preventDefault(); out.textContent = 'Searched: ' + q.value + ' / nonstop=' + ns.checked; };</script>`;

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(FIXTURE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [EXT], args: ['--no-first-run', '--no-default-browser-check'] });
let client;
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.chrome?.storage?.local)); i++) await new Promise((r) => setTimeout(r, 100));
  await sw.evaluate(async (port, key, model, backend) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    settings.bridge = { enabled: true, port };
    settings.providers = { [backend]: { apiKey: key, baseUrl: '' } };
    // Values are passed to run_task, so the text helper is never called.
    settings.ultrafast = { backend, [backend + 'Model']: model, textProvider: backend, textModel: backend === 'inception' ? 'mercury-2' : 'unused', maxActions: 8 };
    await chrome.storage.local.set({ settings });
  }, BRIDGE_PORT, KEY, MODEL, BACKEND);

  client = new Client({ name: 'live', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, env: { ...process.env, HAILBROWSER_TRUST_FILE: TRUST_FILE }, args: ['mcp-server/src/index.js', '--port', String(BRIDGE_PORT)], stderr: 'inherit' }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return text;
  };

  if (process.env.BLANK_TAB) {
    // From a Chrome page extensions cannot use, the run should open a search page and make progress.
    await call('tabs_create', { url: process.env.START_PAGE || 'chrome://newtab' }).catch(() => {});
    const run = await call('run_task', { goal: process.env.BLANK_TAB, mode: 'ultrafast' });
    console.log(run);
    console.log((await call('get_page_text')).slice(0, 700));
    assert.doesNotMatch(run, /blocks extensions/);
    console.log('✅ blank-tab run started without the blocked-page error');
    process.exit(0);
  }
  await call('tabs_create', { url: base });
  console.log(`backend: ${BACKEND}, model: ${MODEL}`);
  const run = await call('run_task', {
    goal: 'Search for Tokyo with the nonstop box ticked',
    mode: 'ultrafast',
    values: { Destination: 'Tokyo' },
  });
  console.log(run);
  const out = await call('get_page_text');
  console.log('page:', out.split('\n').find((l) => /Searched/.test(l)) || '(no result)');
  assert.match(out, /Searched: Tokyo \/ nonstop=true/);
  console.log('✅ live decision run passed');
} finally {
  await client?.close().catch(() => {});
  await browser.close();
  server.close();
}
