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

const seen = { unattended: false, memoryInPrompt: false };

// Text of the newest user message, and the tool results that came after it (this turn only).
function turn(body) {
  let i = body.messages.length - 1;
  while (i > 0 && body.messages[i].role !== 'user') i--;
  const m = body.messages[i];
  const text = typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join('');
  return { text, tools: body.messages.slice(i + 1).filter((x) => x.role === 'tool') };
}
const toolCall = (name, args) => ({ choices: [{ message: { content: '', tool_calls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const say = (content) => ({ choices: [{ message: { content } }] });

// Research: planner -> extract per source -> writer (the picker and gap check are not needed for 3 results at depth Quick).
function fakeResearch(system, user) {
  if (system.startsWith('You plan web research')) return say(JSON.stringify({ queries: ['alpha facts', 'alpha history'], angle: 'What alpha is.' }));
  if (system.startsWith('You read one web page')) {
    const n = /SOURCE: Source (\d)/.exec(user)?.[1];
    return say(JSON.stringify({ relevant: true, summary: `Source ${n} explains alpha.`, facts: [{ claim: `Alpha fact number ${n}`, quote: 'alpha' }], date: null }));
  }
  if (system.startsWith('You review research notes')) return say('{"enough": true, "queries": []}');
  if (system.startsWith('You choose which search results')) return say('{"picks": [1, 2, 3]}');
  if (system.startsWith('You write a research report')) {
    assert.match(user, /\[3\] Source 3/);
    return say('Alpha is well documented [1][2], and its history is covered too [3]. A made-up claim [9].\n\n## Details\n- First point [1]\n- Second point [2]');
  }
  return null;
}

// Scripted model: ultrafast decisions + a two-step normal tool loop.
function fakeModel(body) {
  const system = body.messages[0].content;
  const research = fakeResearch(system, body.messages[1]?.content?.[0]?.text || body.messages[1]?.content || '');
  if (research) return research;
  if (system.startsWith('You plan long browser tasks')) {
    return { choices: [{ message: { content: JSON.stringify({ subtasks: [1, 2, 3].map((n) => ({ title: `Complete lesson ${n}`, detail: `Open lesson ${n} and mark it complete` })) }) } }] };
  }
  if (system.includes('You are working on ONE subtask')) return fakeTaskAgent(body);
  if (system.startsWith('You finish a long browser task')) return say('All 3 lessons are complete. The lesson 2 quiz was answered with 4.');
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
  if (/This is a SCHEDULED run/.test(system)) seen.unattended = true;
  const t = turn(body);
  if (/Remember that/.test(t.text)) {
    return t.tools.length ? say('Noted, I will remember that.') : toolCall('remember', { fact: 'Favourite city is Lisbon' });
  }
  if (/What is my favourite city/.test(t.text)) {
    seen.memoryInPrompt = /MEMORY[\s\S]*Favourite city is Lisbon/.test(system);
    return say(seen.memoryInPrompt ? 'Your favourite city is Lisbon.' : 'I do not know.');
  }
  if (/Find everything about alpha/.test(t.text)) return toolCall('start_research', { question: 'What is alpha?', depth: 'quick' });
  if (/What did the research find/.test(t.text)) {
    const seenReport = body.messages.some((m) => m.role === 'assistant' && /Alpha is well documented/.test(m.content || ''));
    return say(seenReport ? 'The research says alpha is well documented.' : 'I have no research results.');
  }
  if (/Every weekday/.test(t.text)) {
    return t.tools.length ? say('I proposed the schedule.')
      : toolCall('schedule_task', { goal: 'Read this page and report what it says', title: 'Fixture check', frequency: 'weekdays', time: '09:00', url: base });
  }
  const toolMsgs = t.tools;
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
  if (req.url.startsWith('/search')) {
    const other = `http://localhost:${server.address().port}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><title>Search</title><h1>Results</h1>${[1, 2, 3].map((n) => `
      <div class="r"><h3><a href="${other}/src/${n}">Source ${n}: all about alpha</a></h3><p>Snippet ${n} about alpha and its history.</p></div>`).join('')}
      <a href="/search?q=next">Next page</a>`);
  }
  const src = /^\/src\/(\d)$/.exec(req.url);
  if (src) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><title>Source ${src[1]}</title><main><h1>Source ${src[1]}</h1><p>${'Alpha is a thing worth reading about. '.repeat(20)}</p></main>`);
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
  const agentTab = Number(/Opened and selected Tab (\d+)/.exec(opened.text)[1]);
  await call('tabs_select', { tabId: agentTab });

  // Controlled tabs live in one purple "HailBrowser" tab group, mirrored in the panel.
  const groupOf = () => sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    return t.groupId === -1 ? null : chrome.tabGroups.get(t.groupId).then((g) => ({ title: g.title, color: g.color }));
  }, agentTab);
  const grouped = await groupOf();
  assert.ok(grouped && /HailBrowser/.test(grouped.title) && grouped.color === 'purple', JSON.stringify(grouped));
  await panel.waitForSelector('#control:not([hidden]) .tab-row');
  assert.match(await panel.$eval('#control', (e) => e.textContent), /e2e/i);
  await panel.click('#release-all');
  for (let i = 0; i < 30 && (await groupOf()); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await groupOf(), null, 'Release takes the tab out of the group');
  await panel.waitForSelector('#control[hidden]');
  step(`controlled tabs grouped as "${grouped.title}" (${grouped.color}), listed in the panel, released on demand`);

  await call('navigate', { url: base });
  const fast =await call('run_task', { goal: 'Search for London', mode: 'ultrafast' });
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

  // Custom OpenAI-compatible endpoints need a Base URL right next to the provider choice.
  const urlLabel = 'label[data-url-for="normal.provider"]';
  await panel.select('select[name="normal.provider"]', 'openai');
  assert.equal(await panel.$eval(urlLabel, (l) => l.hidden), true, 'no Base URL for hosted providers');
  await panel.select('select[name="normal.provider"]', 'custom');
  assert.equal(await panel.$eval(urlLabel, (l) => l.hidden), false, 'Base URL shown for custom');
  await panel.$eval(`${urlLabel} input`, (i) => { i.value = ''; });
  await panel.type(`${urlLabel} input`, `${base}/v1/`);
  for (let i = 0; i < 30; i++) {
    const saved = await sw.evaluate(() => chrome.storage.local.get('settings').then((r) => r.settings.providers.custom.baseUrl));
    if (saved === `${base}/v1`) break;
    if (i === 29) throw new Error(`Base URL not saved: ${saved}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  await panel.screenshot({ path: 'docs/settings.png' });
  step('Custom (OpenAI-compatible) shows a Base URL field and saves it');

  // ---- Long task (composer toggle in Chat): long-horizon run driven through the real side panel ----
  await panel.evaluate(() => document.querySelector('#close-settings').click());
  const readTask = () => sw.evaluate(async () => {
    const idx = (await chrome.storage.local.get('tasks:index'))['tasks:index'] || [];
    if (!idx[0]) return null;
    const key = `tasks:${idx[0].id}`;
    return (await chrome.storage.local.get(key))[key];
  });
  const waitTask = async (pred, label, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const t = await readTask();
      if (pred(t)) return t;
      if (Date.now() > end) throw new Error(`Timed out waiting for task to be ${label}: ${JSON.stringify(t && { status: t.status, log: t.log.slice(-3) })}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await panel.evaluate(() => document.querySelector('[data-mode="normal"]').click());
  await panel.click('[data-use="task"]');
  assert.equal(await panel.$eval('[data-use="task"]', (b) => b.getAttribute('aria-pressed')), 'true');
  await panel.type('#input', 'Complete all 3 lessons of this course');
  await panel.keyboard.press('Enter');
  const asking = await waitTask((t) => t?.status === 'waiting_user', 'waiting for the user');
  assert.match(asking.question, /2 \+ 2/);
  assert.equal(asking.subtasks.filter((x) => x.status === 'done').length, 1);
  await panel.waitForSelector('#feed .task-slot [data-answer]');
  assert.equal(await panel.$eval('[data-use="task"]', (b) => b.getAttribute('aria-pressed')), 'false', 'the toggle turns off after sending');
  assert.match(await panel.$$eval('#feed .msg.user', (e) => e.at(-1).textContent), /Long task/);
  await panel.screenshot({ path: 'docs/tasks-ask.png' });
  step('Long task toggle: task card inline in the chat, planned 3 subtasks, finished lesson 1, paused to ask the user');

  // In a new chat the task card is gone, so the resume banner appears and opens it.
  await panel.click('#new-chat');
  await panel.waitForSelector('#resume:not([hidden])');
  assert.match(await panel.$eval('#resume', (e) => e.textContent), /Needs you: Lesson 2 has a quiz/);
  await panel.click('#resume [data-r="resume"]');
  await panel.waitForSelector('#detail:not([hidden]) [data-answer]');
  step('resume banner shows the waiting task from another chat and opens it');

  await panel.type('#detail [data-answer]', '4');
  await panel.click('#detail [data-act="task_answer"]');
  const finished = await waitTask((t) => t?.status === 'done', 'done');
  assert.deepEqual([...completed].sort(), ['1', '2', '3']);
  assert.equal(finished.notes.filter((x) => /Lesson \d completed/.test(x)).length, 3);
  assert.match(finished.answer, /All 3 lessons are complete/, 'a finished task writes a real result, not a list of steps');
  await panel.waitForFunction(() => /All 3 lessons are complete/.test(document.querySelector('#detail .answer')?.textContent || ''));
  await new Promise((r) => setTimeout(r, 300));
  await panel.screenshot({ path: 'docs/tasks.png' });
  await panel.click('#detail [data-close]');
  step(`task finished: ${finished.subtasks.length}/${finished.subtasks.length} subtasks, ${finished.steps} steps, lessons ${[...completed].sort().join(',')} completed on the server`);

  // ---- Memory + saved chats ----
  const store = (key) => sw.evaluate((k) => chrome.storage.local.get(k).then((r) => r[k]), key);
  const waitFor = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const chatSend = async (text) => {
    await panel.waitForSelector('#composer:not([hidden]) #send:not([hidden])');
    await panel.type('#input', text);
    await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => !document.querySelector('#stop:not([hidden])') && !document.querySelector('.typing'), { timeout: 20000 });
  };
  await panel.evaluate(() => document.querySelector('[data-mode="normal"]').click());
  await chatSend('Remember that my favourite city is Lisbon');
  const mem = await waitFor(async () => (await store('memory'))?.facts?.find((f) => /Lisbon/.test(f.text)), 'memory');
  assert.equal(mem.source, 'chat');
  await panel.waitForFunction(() => /remembered/.test(document.querySelector('#feed').textContent));
  await chatSend('What is my favourite city?');
  assert.ok(seen.memoryInPrompt, 'the saved fact is in the next prompt');
  await panel.waitForFunction(() => /Your favourite city is Lisbon/.test(document.querySelector('#feed').textContent));
  step('chat "remember…" saves to memory automatically, and later prompts include it');

  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll('.msg.user').length === 2 && /Your favourite city is Lisbon/.test(document.querySelector('#feed').textContent));
  const chats = await store('chats:index');
  assert.equal(chats[0].turns, 2);
  step('chat is saved and redrawn after the panel reloads');

  // ---- Schedules: proposed in chat, confirmed by the user, run in a background tab ----
  await chatSend('Every weekday at 09:00 check the fixture page for me');
  await panel.waitForSelector('.proposal [data-accept="1"]');
  assert.match(await panel.$eval('.proposal', (e) => e.textContent), /Fixture check[\s\S]*Weekdays at 09:00/);
  assert.equal(((await store('schedules:index')) || []).length, 0, 'nothing is scheduled before the user confirms');
  await panel.click('.proposal [data-accept="1"]');
  await panel.waitForFunction(() => /Scheduled ✓/.test(document.querySelector('.proposal').textContent));
  await panel.screenshot({ path: 'docs/chat.png' });
  const [sched] = await waitFor(() => store('schedules:index'), 'schedule saved');
  const saved = await store(`schedules:${sched.id}`);
  assert.equal(saved.when.type, 'daily');
  assert.deepEqual(saved.when.days, [1, 2, 3, 4, 5]);
  assert.ok(saved.nextRunAt > Date.now());
  const alarm = await sw.evaluate((id) => chrome.alarms.get(`sched:${id}`), sched.id);
  assert.equal(alarm.scheduledTime, saved.nextRunAt);
  step(`schedule_task proposal confirmed: "${saved.title}", next run ${new Date(saved.nextRunAt).toLocaleString()}, alarm set`);

  const tabsBefore = await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length));
  await panel.click('#open-schedules');
  await panel.waitForSelector(`.sched[data-id="${sched.id}"] [data-s="run"]`);
  await panel.click(`.sched[data-id="${sched.id}"] [data-s="run"]`);
  const runEntry = await waitFor(async () => (await store('scheduleRuns'))?.find((r) => r.scheduleId === sched.id && r.status !== 'running'), 'scheduled run');
  assert.equal(runEntry.status, 'done', JSON.stringify(runEntry));
  assert.match(runEntry.summary, /Page says: Fixture Search/);
  assert.ok(seen.unattended, 'scheduled runs use the unattended rules');
  assert.equal(await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.length)), tabsBefore, 'the job tab is closed after a successful run');
  await panel.waitForSelector('.run .pill.done');
  assert.equal((await store(`schedules:${sched.id}`)).nextRunAt, saved.nextRunAt, 'a manual run does not move the schedule');
  await panel.screenshot({ path: 'docs/schedules.png' });
  await panel.click('#schedules [data-close]');
  step(`"Run now" ran the job unattended in a background tab: ${runEntry.summary.split('\n')[0]}`);

  // ---- Research: search, read sources in tabs, cited report ----
  await sw.evaluate(async (base) => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.research = { engine: 'custom', customUrl: `${base}/search?q=%s`, depth: 'quick' };
    await chrome.storage.local.set({ settings });
  }, base);
  // No toggle: the chat agent decides this needs research and hands it over.
  await chatSend('Find everything about alpha on the web');
  const reportIdx = await waitFor(async () => (await store('reports:index'))?.find((r) => ['done', 'failed'].includes(r.status)), 'research report', 40000);
  const rep = await store(`reports:${reportIdx.id}`);
  assert.equal(rep.status, 'done', rep.error || JSON.stringify(rep.log.slice(-3)));
  assert.equal(rep.sources.filter((x) => x.status === 'ok').length, 3);
  assert.deepEqual(rep.queries.map((q) => q.q), ['alpha facts', 'alpha history']);
  assert.doesNotMatch(rep.answer, /\[9\]/, 'citations to missing sources are dropped');
  await panel.waitForFunction(() => document.querySelectorAll('.answer .cite').length >= 4);
  assert.equal(await panel.$$eval('.answer .cite', (a) => a[0].getAttribute('href')), `http://localhost:${server.address().port}/src/1`);
  assert.equal(await sw.evaluate(() => chrome.tabs.query({}).then((t) => t.filter((x) => /\/src\/|\/search\?/.test(x.url)).length)), 0, 'research tabs are closed');
  await new Promise((r) => setTimeout(r, 200));
  await panel.screenshot({ path: 'docs/research.png' });
  step(`chat handed off to research: ${rep.queries.length} searches, ${rep.sources.length} sources read, cited report inline; tabs cleaned up`);

  await chatSend('What did the research find?');
  await panel.waitForFunction(() => /The research says alpha is well documented/.test(document.querySelector('#feed').textContent));
  step('follow-up questions in the chat can use the research report');

  // ---- History lists chats and reports ----
  await panel.click('#open-history');
  await panel.waitForSelector('#history-list .hrow');
  await panel.click('[data-htab="reports"]');
  await panel.waitForFunction(() => /What is alpha\?/.test(document.querySelector('#history-list').textContent));
  await panel.click('#history [data-close]');
  step('history lists saved chats and research reports');

  console.log('\nE2E PASSED');
} finally {
  await client?.close().catch(() => {});
  await browser.close();
  server.close();
}
