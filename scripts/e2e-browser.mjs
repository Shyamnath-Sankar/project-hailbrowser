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
  <label>Departure time <input type="time" id="tm"></label>
  <button>Search</button>
</form>
<p id="out"></p>
<script>
  f.onsubmit = (e) => { e.preventDefault(); out.textContent = 'Searched: ' + q.value + ' / ' + cls.value + ' / nonstop=' + ns.checked; };
</script>`;

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
