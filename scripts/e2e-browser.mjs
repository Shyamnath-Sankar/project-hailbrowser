// End-to-end check in a real browser: Chrome for Testing + the unpacked extension +
// the real MCP server, against a local fixture page. A scripted fake
// OpenAI-compatible model drives run_task, so no API keys or paid calls are used.
//
//   npx puppeteer browsers install chrome   (once)
//   node scripts/e2e-browser.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const BRIDGE_PORT = 22400;

const FIXTURE = `<!doctype html><title>Fixture Search</title>
<h1>Fixture search</h1>
<form id="f">
  <label>Destination <input id="q" name="q"></label>
  <label>Class <select id="cls"><option>Economy</option><option>Business</option></select></label>
  <label><input type="checkbox" id="ns"> Nonstop</label>
  <button>Search</button>
</form>
<p id="out"></p>
<script>
  f.onsubmit = (e) => { e.preventDefault(); out.textContent = 'Searched: ' + q.value + ' / ' + cls.value + ' / nonstop=' + ns.checked; };
</script>`;

// Scripted model: ultrafast decisions + a two-step normal tool loop.
function fakeModel(body) {
  const system = body.messages[0].content;
  if (/Return only its letter/.test(system)) {
    // Stand-in for a letter-choice decision model (Together Tev1 request/response format).
    assert.equal(body.max_tokens, 8);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    const task = JSON.parse(body.messages[1].content);
    const opt = (re) => task.options.find((o) => re.test(o.key) || re.test(o.description));
    const city = /"City":"(\w+)"/.exec(task.state)?.[1] || /GOAL: Search for (\w+)/.exec(task.state)?.[1];
    let pick;
    if (/^Which provided value/.test(task.question)) {
      pick = opt(/^City$/);
    } else if (/operation best advances/.test(task.question)) {
      pick = new RegExp(`Searched: ${city}`).test(task.state) ? opt(/^DONE$/)
        : new RegExp(`value="${city}"`).test(task.state) ? opt(/^CLICK$/) : opt(/^TYPE_TEXT$/);
    } else if (/TYPE_TEXT/.test(task.question)) pick = opt(/Destination/);
    else if (/CLICK/.test(task.question)) pick = opt(/"Search"/);
    return { choices: [{ message: { content: (pick || task.options[0]).label } }] };
  }
  if (system.startsWith('Return a JSON object with exactly one key, text')) {
    return { choices: [{ message: { content: '{"text":"Berlin"}' } }] };
  }
  if (system.startsWith('You are the decision head')) {
    const user = body.messages[1].content;
    const line = (label) => user.split('\n').find((l) => l.includes(`"${label}"`)) || '';
    const index = (l) => /^\[(\d+)\]/.exec(l)?.[1];
    let decision;
    if (/Searched: London/.test(user)) decision = { operation: 'DONE' };
    else if (!/value="London"/.test(line('Destination'))) decision = { operation: 'TYPE_TEXT', target: index(line('Destination')), text: 'London' };
    else decision = { operation: 'CLICK', target: index(line('Search')) };
    return { choices: [{ message: { content: JSON.stringify(decision) } }] };
  }
  const toolMsgs = body.messages.filter((m) => m.role === 'tool');
  if (!toolMsgs.length) {
    return { choices: [{ message: { content: 'Reading the page.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_page_text', arguments: '{}' } }] } }] };
  }
  return { choices: [{ message: { content: `Page says: ${toolMsgs[0].content.split('\n')[0]}` } }] };
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fakeModel(JSON.parse(data))));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-first-run', '--no-default-browser-check'],
});
let client;
const step = (name) => console.log(`• ${name}`);
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!globalThis.chrome?.storage?.local)); i++) await new Promise((r) => setTimeout(r, 100));
  await sw.evaluate(async (port, base) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    settings.bridge = { enabled: true, port };
    settings.providers = { custom: { apiKey: '', baseUrl: `${base}/v1` } };
    settings.normal = { provider: 'custom', model: 'fake', vision: true, maxSteps: 5 };
    settings.ultrafast = { backend: 'llm', decisionProvider: 'custom', decisionModel: 'fake', textProvider: 'custom', textModel: 'fake', maxActions: 10 };
    await chrome.storage.local.set({ settings });
  }, BRIDGE_PORT, base);
  step('extension loaded and configured');

  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp-server/src/index.js', '--port', String(BRIDGE_PORT)], stderr: 'inherit' }));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return { ...r, text };
  };

  const ctx = await call('tabs_context');
  assert.match(ctx.text, /Current agent tab/);
  step('MCP → extension connected (tabs_context)');

  const opened = await call('tabs_create', { url: base });
  const page = await call('read_page');
  assert.match(page.text, /Fixture search/);
  const ref = (label) => new RegExp(`\\[(ref_\\d+)\\] \\w+ "${label}`).exec(page.text)[1];
  step('read_page lists refs');

  await call('type', { ref: ref('Destination'), text: 'Paris' });
  await call('type', { ref: ref('Destination'), text: 'Tokyo' }); // replaces, not appends
  await call('select_option', { ref: ref('Class'), option: 'Business' });
  await call('click', { ref: ref('Nonstop') });
  await call('click', { ref: ref('Search') });
  const out = await call('get_page_text');
  assert.match(out.text, /Searched: Tokyo \/ Business \/ nonstop=true/);
  step('type / select_option / click work with trusted input');

  const found = await call('find', { query: 'search' });
  assert.match(found.text, /button "Search"/);
  const js = await call('javascript', { code: 'document.title' });
  assert.equal(js.text, 'Fixture Search');
  assert.equal((await call('javascript', { code: 'const a = 2;\na * 21' })).text, '42');
  const shot = await client.callTool({ name: 'screenshot', arguments: {} });
  assert.equal(shot.content[0].type, 'image');
  assert.ok(shot.content[0].data.length > 1000);
  await call('press_key', { keys: 'Tab ctrl+a' });
  await call('scroll', { direction: 'down' });
  step('find / javascript / screenshot / press_key / scroll');

  // Open the side panel UI in a tab so it renders the run_task events below.
  const extId = new URL(swTarget.url()).host;
  const panel = await browser.newPage();
  await panel.setViewport({ width: 400, height: 720 });
  await panel.goto(`chrome-extension://${extId}/sidepanel/index.html`);
  await call('tabs_select', { tabId: Number(/Opened and selected Tab (\d+)/.exec(opened.text)[1]) });

  await call('navigate', { url: base });
  const fast = await call('run_task', { goal: 'Search for London', mode: 'ultrafast' });
  assert.match(fast.text, /Done/);
  assert.match((await call('get_page_text')).text, /Searched: London/);
  step(`ultrafast run_task: ${fast.text.split('\n')[0]}`);

  const normal = await call('run_task', { goal: 'What does this page say?', mode: 'normal' });
  assert.match(normal.text, /Page says: Fixture Search/);
  step('normal run_task (tool-calling loop)');

  await sw.evaluate(async (base) => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.providers.together = { apiKey: 'test-key', baseUrl: `${base}/v1` };
    Object.assign(settings.ultrafast, { backend: 'choice', choiceProvider: 'together', choiceModel: 'together/Tev1-4B-experimental' });
    await chrome.storage.local.set({ settings });
  }, base);
  await call('navigate', { url: base });
  const choice = await call('run_task', { goal: 'Search for Berlin', mode: 'ultrafast' });
  assert.match(choice.text, /Done/);
  assert.match((await call('get_page_text')).text, /Searched: Berlin/);
  step(`ultrafast with Together provider + letter-choice decisions: ${choice.text.split('\n')[0]}`);

  // OpenCode/Claude Code style: the caller passes values, the decision model maps them to fields,
  // and no text-helper model is configured at all.
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    Object.assign(settings.ultrafast, { textProvider: 'anthropic', textModel: 'unused' });
    settings.providers.anthropic = { apiKey: '', baseUrl: '' };
    await chrome.storage.local.set({ settings });
  });
  await call('navigate', { url: base });
  const withValues = await call('run_task', { goal: 'Search for the destination city I gave you', mode: 'ultrafast', values: { City: 'Paris' } });
  assert.match(withValues.text, /Done/);
  assert.match(withValues.text, /0 text calls/);
  assert.match((await call('get_page_text')).text, /Searched: Paris/);
  step(`run_task with values, no text model: ${withValues.text.split('\n')[0]}`);
  await new Promise((r) => setTimeout(r, 300));
  await panel.screenshot({ path: 'docs/sidepanel.png' });
  await panel.evaluate(() => document.querySelector('#open-settings').click());
  await panel.screenshot({ path: 'docs/settings.png' });
  step('side panel screenshots saved to docs/');

  console.log('\nE2E PASSED');
} finally {
  await client?.close().catch(() => {});
  await browser.close();
  server.close();
}
