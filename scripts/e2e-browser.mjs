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
import os from 'node:os';
import path from 'node:path';

// Never touch the user's real ~/.hailbrowser trust file from tests.
const TRUST_FILE = path.join(os.tmpdir(), `hail-trust-test-${process.pid}.json`);

const EXT = fileURLToPath(new URL('../extension', import.meta.url));
const BRIDGE_PORT = 22400;

const FIXTURE = `<!doctype html><title>Fixture Search</title>
<h1>Fixture search</h1>
<form id="f">
  <label>Destination <input id="q" name="q"></label>
  <label>Class <select id="cls"><option>Economy</option><option>Business</option></select></label>
  <label><input type="checkbox" id="ns"> Nonstop</label>
  <label>Departure time <input type="time" id="tm"></label>
  <button>Search</button>
</form>
<p id="out"></p>
<script>
  f.onsubmit = (e) => { e.preventDefault(); out.textContent = 'Searched: ' + q.value + ' / ' + cls.value + ' / nonstop=' + ns.checked; };
</script>`;

// Edge cases from review: dialogs, nested scrolling, pop-ups, multi-select, color, masks.
const LAB = `<!doctype html><title>Lab</title>
<h1>Lab</h1>
<p id="out">idle</p>
<button onclick="alert('Saved!')">Show alert</button>
<button onclick="out.textContent = 'confirm=' + confirm('Really delete?')">Delete item</button>
<button onclick="out.textContent = 'name=' + prompt('New name?', 'old')">Rename</button>
<a href="/course/9" target="_blank">Open help</a>
<div id="sc" style="height:150px;overflow:auto;border:1px solid #999">
  ${Array.from({ length: 40 }, (_, i) => `<button style="display:block">Item ${i + 1}</button>`).join('')}
</div>
<label>Colors <select id="ms" multiple><option>Red</option><option>Green</option><option>Blue</option></select></label>
<label>Accent <input type="color" id="col"></label>
<label>Volume <input type="range" id="vol" min="0" max="10" step="1"></label>
<label>Phone <input id="ph" oninput="this.value = this.value.replace(/[^0-9]/g, '')"></label>
<div style="height:2500px"></div>
<button>Footer button</button>`;

// Scripted long-horizon agent: plans 3 lessons, asks the user once (lesson 2 quiz),
// then for each lesson: navigate -> find -> click -> save_note -> task_complete.
function fakeTaskAgent(body) {
  const brief = body.messages.find((m) => m.role === 'user').content.map((p) => p.text || '').join('');
  const n = /CURRENT SUBTASK: Complete lesson (\d)/.exec(brief)[1];
  const tools = body.messages.filter((m) => m.role === 'tool');
  const call = (name, args) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `c${tools.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  if (n === '2' && !/User answered/.test(brief) && !tools.length) return call('ask_user', { question: 'Lesson 2 has a quiz: what is 2 + 2?' });
  if (tools.length === 0) return call('navigate', { url: `${base}/course/${n}` });
  if (tools.length === 1) return call('find', { query: 'Mark lesson complete' });
  if (tools.length === 2) return call('click', { ref: /\[(ref_\d+)\]/.exec(tools[1].content)[1] });
  if (tools.length === 3) return call('save_note', { note: `Lesson ${n} completed` });
  return call('task_complete', { summary: `Lesson ${n} marked complete` });
}

// Scripted model: ultrafast decisions + a two-step normal tool loop.
function fakeModel(body) {
  const system = body.messages[0].content;
  if (system.startsWith('You plan long browser tasks')) {
    return { choices: [{ message: { content: JSON.stringify({ subtasks: [1, 2, 3].map((n) => ({ title: `Complete lesson ${n}`, detail: `Open lesson ${n} and mark it complete` })) }) } }] };
  }
  if (system.includes('You are working on ONE subtask')) return fakeTaskAgent(body);
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

const completed = new Set();
const server = http.createServer((req, res) => {
  const lesson = /^\/course\/(\d)$/.exec(req.url);
  if (lesson) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><title>Lesson ${lesson[1]}</title><h1>Lesson ${lesson[1]}</h1><p>Some lesson content.</p>
      <button onclick="fetch('/done/${lesson[1]}').then(() => document.body.append(' Completed!'))">Mark lesson complete</button>`);
  }
  if (req.url.startsWith('/lab')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(LAB);
  }
  const done = /^\/done\/(\d)$/.exec(req.url);
  if (done) { completed.add(done[1]); res.writeHead(204); return res.end(); }
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
  await client.connect(new StdioClientTransport({ command: process.execPath, env: { ...process.env, HAILBROWSER_TRUST_FILE: TRUST_FILE }, args: ['mcp-server/src/index.js', '--port', String(BRIDGE_PORT)], stderr: 'inherit' }));
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
  await call('type', { ref: ref('Departure time'), text: '19:30' });
  assert.equal((await call('javascript', { code: 'tm.value' })).text, '19:30');
  await assert.rejects(call('type', { ref: ref('Departure time'), text: 'tonight' }), /rejected/);
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

  // ---- review fixes: dialogs, scrolling, pop-ups, inputs, argument checks ----
  await call('navigate', { url: `${base}/lab?q=${'x'.repeat(3000)}` });
  const tabsLong = await call('tabs_context');
  assert.ok(tabsLong.text.split('\n').every((l) => l.length < 400), 'tabs_context lines are shortened');
  const lab = await call('read_page');
  const labRef = (label) => new RegExp(`\\[(ref_\\d+)\\] \\w+ "${label}`).exec(lab.text)[1];
  const js2 = async (code) => (await call('javascript', { code })).text;

  const alerted = await call('click', { ref: labRef('Show alert') });
  assert.match(alerted.text, /alert \(closed automatically\): "Saved!"/);
  const confirmed = await call('click', { ref: labRef('Delete item') });
  assert.match(confirmed.text, /confirm dialog is open: "Really delete\?"/);
  await assert.rejects(call('read_page'), /confirm dialog is open.*handle_dialog/s);
  assert.match((await call('handle_dialog', { accept: false })).text, /Dismissed the confirm dialog "Really delete\?"/);
  assert.equal(await js2('out.textContent'), 'confirm=false');
  await call('click', { ref: labRef('Rename') });
  assert.match((await call('handle_dialog', { accept: true, text: 'Zed' })).text, /Accepted the prompt/);
  assert.equal(await js2('out.textContent'), 'name=Zed');
  assert.match((await call('handle_dialog', {})).text, /No dialog is open/);
  step('dialogs: alert auto-closed and reported, confirm/prompt block until handle_dialog');

  const inner = await call('scroll', { direction: 'down', ref: labRef('Item 1'), amount: 2 });
  assert.match(inner.text, /Scrolled down inside #sc: now at \d+\/\d+px/);
  assert.ok(Number(await js2('sc.scrollTop')) > 0);
  assert.match((await call('scroll', { direction: 'left' })).text, /Nothing scrolled: the page is already at the left edge/);
  assert.match((await call('scroll', { direction: 'down', amount: 1 })).text, /Scrolled down the page/);
  assert.match((await call('scroll', { direction: 'up', amount: 50 })).text, /Scrolled up the page: now at 0\//);
  await assert.rejects(call('scroll', { direction: 'sideways' }), /direction must be/);
  await assert.rejects(call('hover', {}), /hover needs a ref/);
  await assert.rejects(call('click', { x: 'a' }), /click needs a ref/);
  step('scroll moves the right box and says when nothing moved; bad arguments get clear errors');

  const popup = await call('click', { ref: labRef('Open help') });
  const popupId = Number(/Opened new tab (\d+)/.exec(popup.text)?.[1]);
  assert.ok(popupId, popup.text);
  assert.match((await call('tabs_context')).text, /→ \[\d+\].*Lab/); // still acting on the lab tab
  await call('tabs_close', { tabId: popupId });
  step('target=_blank pop-up reported, agent tab unchanged');

  await call('select_option', { ref: labRef('Colors'), option: 'Red' });
  assert.match((await call('select_option', { ref: labRef('Colors'), option: 'Blue' })).text, /"Red", "Blue"/);
  assert.equal(await js2('[...ms.selectedOptions].map(o => o.label).join()'), 'Red,Blue');
  await call('select_option', { ref: labRef('Colors'), options: ['Green'] });
  assert.equal(await js2('[...ms.selectedOptions].map(o => o.label).join()'), 'Green');
  assert.match(lab.text, /"Accent" type=color/);
  await call('type', { ref: labRef('Accent'), text: '#00ff00' });
  assert.equal(await js2('col.value'), '#00ff00');
  assert.match((await call('type', { ref: labRef('Volume'), text: '7.4' })).text, /stored "7"/);
  assert.match((await call('type', { ref: labRef('Phone'), text: 'abc123' })).text, /field now shows "123"/);
  await call('javascript', { code: 'document.activeElement.blur(), 1' });
  await assert.rejects(call('type', { text: 'lost' }), /Nothing on the page has keyboard focus/);
  await call('click', { ref: labRef('Phone') });
  assert.match((await call('type', { text: '9', clear: false })).text, /into the focused input\[text\] "Phone"/);
  const compact = await call('read_page', { compact: true });
  assert.match(compact.text, /more off-screen/);
  assert.ok(compact.text.length < lab.text.length);
  step('multi-select, color, range, input masks, focus checks and compact read_page');

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

  // ---- Tasks mode: long-horizon run driven through the real side panel ----
  await panel.evaluate(() => document.querySelector('#close-settings').click());
  const readTask = () => sw.evaluate(() => chrome.storage.local.get('task').then((r) => r.task || null));
  const waitTask = async (pred, label, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = await readTask();
      if (pred(t)) return t;
      if (Date.now() > end) throw new Error(`Timed out waiting for task to be ${label}: ${JSON.stringify(t && { status: t.status, log: t.log.slice(-3) })}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await panel.evaluate(() => document.querySelector('[data-mode="tasks"]').click());
  await panel.waitForSelector('#input');
  await panel.screenshot({ path: 'docs/tasks-empty.png' });
  await panel.type('#input', 'Complete all 3 lessons of this course');
  await panel.keyboard.press('Enter');
  const asking = await waitTask((t) => t?.status === 'waiting_user', 'waiting for the user');
  assert.match(asking.question, /2 \+ 2/);
  assert.equal(asking.subtasks.filter((x) => x.status === 'done').length, 1);
  await panel.waitForSelector('[data-answer]');
  await panel.screenshot({ path: 'docs/tasks-ask.png' });
  step('task planned 3 subtasks, finished lesson 1, paused to ask the user');

  await panel.type('[data-answer]', '4');
  await panel.click('[data-act="task_answer"]');
  const finished = await waitTask((t) => t?.status === 'done', 'done');
  assert.deepEqual([...completed].sort(), ['1', '2', '3']);
  assert.equal(finished.notes.filter((x) => /Lesson \d completed/.test(x)).length, 3);
  await new Promise((r) => setTimeout(r, 300));
  await panel.screenshot({ path: 'docs/tasks.png' });
  step(`task finished: ${finished.subtasks.length}/${finished.subtasks.length} subtasks, ${finished.steps} steps, lessons ${[...completed].sort().join(',')} completed on the server`);

  console.log('\nE2E PASSED');
} finally {
  await client?.close().catch(() => {});
  await browser.close();
  server.close();
}
