import { DEFAULTS, PROVIDERS, getSettings, saveSettings } from '../src/settings.js';

const $ = (sel) => document.querySelector(sel);
const feed = $('#feed');
const input = $('#input');
let settings = await getSettings();
let running = null;
let task = null;
let port;
let thinkingEl = null;
let lastDecision = null;
const pendingTools = [];
const externalSteps = [];

const MODE_HELP = {
  normal: 'Ask about this page or give it a quick job.',
  ultrafast: 'Speed-runs forms and searches with a decision model.',
  tasks: 'Long jobs, split into steps. Pause and resume anytime.',
};
const PLACEHOLDER = { normal: 'Ask or give a job…', ultrafast: 'What should it do on this page?', tasks: 'Describe a long task…' };
const SUGGESTIONS = {
  normal: ['Summarize this page in 5 bullet points', 'Find the pricing page and compare the plans', 'What are the main points in the comments here?'],
  ultrafast: ['Search this site for "wireless headphones" and sort by price', "Search Wikipedia for Gödel's incompleteness theorems and open the article"],
  tasks: ['Finish the next 3 lessons of the course open in this tab', 'Open each article in my reading list and write a one-line summary of each', 'Go through every page of these search results and collect the product names and prices'],
};

// ---------- helpers ----------

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (n) => (n == null ? '' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);
const card = (inner, cls = '') => `<div class="card ${cls}"><div class="card-in">${inner}</div></div>`;
const scrollDown = () => { feed.scrollTop = feed.scrollHeight; };

const chatView = el('section', 'view chat-view');
const taskView = el('section', 'view task-view');
chatView.style.cssText = taskView.style.cssText = 'display:flex;flex-direction:column;gap:10px';
feed.append(chatView, taskView);

function markdown(src) {
  return String(src).split(/```/).map((block, i) => {
    if (i % 2) return `<pre><code>${esc(block.replace(/^\w*\n/, ''))}</code></pre>`;
    return block.trim().split(/\n{2,}/).map((para) => {
      const lines = para.split('\n');
      const inline = (t) => esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

// ---------- setup state ----------

// Providers whose address is the user's own (an OpenAI-compatible endpoint or a local server).
const URL_PROVIDERS = new Set(['custom', 'ollama', 'lmstudio']);
const urlFor = (provider) => settings.providers?.[provider]?.baseUrl || '';

function keyFor(provider) {
  const p = PROVIDERS[provider];
  if (p && !p.baseUrl && !urlFor(provider)) return false; // custom endpoint without an address
  return !p || p.keyless || !!settings.providers?.[provider]?.apiKey;
}

function missingSetup(mode) {
  if (mode === 'ultrafast') {
    const uf = settings.ultrafast;
    if (uf.backend === 'systemone' && !uf.systemoneKey) return 'fast';
    if (uf.backend === 'choice' && !keyFor(uf.choiceProvider)) return 'fast';
    if (uf.backend === 'llm' && !keyFor(uf.decisionProvider)) return 'fast';
    return null;
  }
  return keyFor(settings.normal.provider) ? null : 'model';
}

function setupCard(kind) {
  if (kind === 'fast') {
    return card(`<h3>Set up Fast mode</h3>
      <p class="hint">Fast mode needs a decision model: TypeSafe Jev, a letter-choice model like Together Tev1, or any fast chat model.</p>
      <div class="row"><button class="btn primary" data-act="open-settings">Open settings</button></div>`, 'setup');
  }
  const options = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}" ${id === settings.normal.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
  return card(`<h3>Connect a model to start</h3>
    <p class="hint">Pick a provider and paste your API key. It's stored only in this browser.</p>
    <label>Provider <select data-setup="provider">${options}</select></label>
    <label>API key <input type="password" data-setup="key" placeholder="Paste your API key" spellcheck="false" /></label>
    <label data-setup-url ${URL_PROVIDERS.has(settings.normal.provider) ? '' : 'hidden'}>Base URL
      <input data-setup="url" value="${esc(urlFor(settings.normal.provider))}" placeholder="${esc(PROVIDERS[settings.normal.provider]?.baseUrl || 'https://your-endpoint/v1')}" spellcheck="false" /></label>
    <label>Model <input data-setup="model" value="${esc(settings.normal.model)}" spellcheck="false" /></label>
    <div class="row"><button class="btn primary" data-act="save-setup">Save &amp; start</button></div>`, 'setup');
}

feed.addEventListener('change', (e) => {
  if (e.target.matches('[data-setup="provider"]')) {
    const id = e.target.value;
    const first = PROVIDERS[id]?.models?.[0];
    if (first) feed.querySelector('[data-setup="model"]').value = first;
    feed.querySelector('[data-setup-url]').hidden = !URL_PROVIDERS.has(id);
    const url = feed.querySelector('[data-setup="url"]');
    url.value = urlFor(id);
    url.placeholder = PROVIDERS[id]?.baseUrl || 'https://your-endpoint/v1';
    feed.querySelector('[data-setup="key"]').placeholder = PROVIDERS[id]?.keyless ? 'API key (only if your endpoint needs one)' : 'Paste your API key';
  }
});

feed.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-act]');
  const act = target?.dataset.act;
  if (!act) return;
  if (act === 'open-settings') openSettings();
  else if (act === 'save-setup') {
    const provider = feed.querySelector('[data-setup="provider"]').value;
    const keyBox = feed.querySelector('[data-setup="key"]');
    const model = feed.querySelector('[data-setup="model"]').value.trim();
    const urlBox = feed.querySelector('[data-setup="url"]');
    if (!keyBox.value.trim() && !PROVIDERS[provider].keyless) return keyBox.focus();
    if (!PROVIDERS[provider].baseUrl && !urlBox.value.trim()) return urlBox.focus();
    settings.normal.provider = provider;
    settings.normal.model = model || PROVIDERS[provider].models[0] || '';
    settings.providers[provider] = { ...settings.providers[provider], apiKey: keyBox.value.trim(),
      ...(URL_PROVIDERS.has(provider) ? { baseUrl: urlBox.value.trim().replace(/\/+$/, '') } : {}) };
    await saveSettings(settings);
    renderAll();
  } else if (act === 'suggest') {
    input.value = target.textContent;
    input.focus();
    autosize();
  } else if (act === 'task_answer') {
    const box = taskView.querySelector('[data-answer]');
    if (!box.value.trim()) return box.focus();
    port.postMessage({ type: 'task_answer', text: box.value });
  } else if (act.startsWith('task_')) {
    port.postMessage({ type: act });
  }
});

// ---------- chat view ----------

function renderChatIntro() {
  chatView.querySelector('.intro')?.remove();
  if (chatView.querySelector('.msg, .step, .note')) return;
  const mode = settings.mode === 'ultrafast' ? 'ultrafast' : 'normal';
  const missing = missingSetup(mode);
  const intro = el('div', 'intro');
  intro.innerHTML = missing ? setupCard(missing) : card(`<div class="hero">
      <h2>${mode === 'ultrafast' ? 'Fast mode' : 'What should I do?'}</h2>
      <p>${mode === 'ultrafast' ? 'Give one concrete goal with every value it needs. It acts on the current tab.' : 'I can read, click and type in this tab. Try:'}</p>
      <div class="suggestions">${SUGGESTIONS[mode].map((s) => `<button data-act="suggest">${esc(s)}</button>`).join('')}</div>
    </div>`);
  chatView.prepend(intro);
}

function put(container, node) {
  if (container === chatView) {
    chatView.querySelector('.intro')?.remove();
    chatView.appendChild(node);
    scrollDown();
  } else {
    container.appendChild(node);
  }
  return node;
}

function step(container, icon, what, arg, meta, cls = '') {
  const s = el('div', `step ${cls}`);
  s.innerHTML = `<span class="ico">${icon}</span><div class="body"><span class="what">${what}</span> <span class="arg">${arg || ''}</span></div><span class="meta">${meta || ''}</span>`;
  return put(container, s);
}

function argSummary(args) {
  if (!args) return '';
  if (args.ref) return esc(args.ref + (args.text != null ? ` ← "${args.text}"` : args.option ? ` → ${args.option}` : ''));
  for (const k of ['url', 'keys', 'direction', 'goal', 'note', 'summary', 'question']) if (args[k]) return esc(args[k]);
  if (args.text != null) return esc(`"${args.text}"`);
  if (args.query) return esc(`"${args.query}"`);
  if (args.x != null) return esc(`(${args.x}, ${args.y})`);
  if (args.code) return esc(args.code.slice(0, 80));
  if (args.items) return esc(args.items.map((i) => i.title).join(', '));
  return '';
}

function clearThinking() { thinkingEl?.remove(); thinkingEl = null; }

/** Render one agent event into a container (the chat feed or the task activity list). */
function renderEvent(e, source, container = chatView) {
  if (e.type !== 'thinking') clearThinking();
  switch (e.type) {
    case 'user': {
      const m = el('div', 'msg user');
      m.innerHTML = `<span class="tag">${source === 'mcp' ? 'From your coding agent · ' : ''}${e.mode === 'ultrafast' ? '⚡ Fast' : 'Chat'}</span>${esc(e.text)}`;
      put(chatView, m);
      break;
    }
    case 'thinking': clearThinking(); thinkingEl = put(container, el('div', 'typing', '<i></i><i></i><i></i>')); break;
    case 'assistant': put(container, el('div', 'msg assistant', markdown(e.text))); break;
    case 'tool': pendingTools.push(step(container, '⟳', esc(e.name), argSummary(e.args), '', 'pending')); break;
    case 'task_tool': step(container, '★', esc(e.name.replace('_', ' ')), argSummary(e.args), ''); break;
    case 'tool_result': {
      const s = pendingTools.shift();
      if (!s) break;
      s.classList.remove('pending');
      if (e.isError) s.classList.add('err');
      s.querySelector('.ico').textContent = e.isError ? '✕' : '✓';
      s.querySelector('.meta').textContent = ms(e.latencyMs);
      if (e.text || e.image) {
        const d = el('details');
        d.innerHTML = `<summary>${e.isError ? 'error' : 'result'}</summary>${e.text ? `<pre>${esc(e.text)}</pre>` : ''}`;
        if (e.image) { const img = new Image(); img.src = `data:${e.image.mimeType};base64,${e.image.data}`; d.appendChild(img); }
        s.querySelector('.body').appendChild(d);
        if (e.isError) d.open = true;
      }
      break;
    }
    case 'status': step(container, '·', '', esc(e.text), '', 'muted'); break;
    case 'subtask': step(container, '▸', `Subtask ${e.index}/${e.total}`, esc(e.title), ''); break;
    case 'decision': {
      const conf = e.confidence != null ? ` · ${Math.round(e.confidence * 100)}%` : '';
      const cls = e.operation === 'DONE' ? 'done' : e.operation === 'BLOCKED' ? 'blocked' : '';
      lastDecision = step(container, '⚡', `<span class="badge ${cls}">${esc(e.operation)}</span>`,
        esc(e.label) + (e.text ? esc(` ← "${e.text}"`) : '') + (e.reason ? ` — ${esc(e.reason)}` : ''), `${ms(e.latencyMs)}${conf}`);
      break;
    }
    case 'text': step(container, '✎', 'text', esc(`"${e.text}"`), ms(e.latencyMs), 'muted'); break;
    case 'action': if (lastDecision) lastDecision.querySelector('.meta').textContent += ` · ${ms(e.elapsedMs)}${e.page_changed ? '' : ' · no change'}`; break;
    case 'stale': step(container, '↻', 'page changed', 're-checking', '', 'muted'); break;
    case 'finish': if (e.summary) put(container, el('div', 'note', esc(e.summary))); break;
    case 'error': put(container, el('div', 'note error', esc(e.text))); break;
  }
}

// ---------- task view ----------

const STATUS_LABEL = { planning: 'Planning', running: 'Working', paused: 'Paused', waiting_user: 'Needs you', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
let activityList = el('div', 'list');
let taskClock = null;

function elapsed(t) {
  const end = ['running', 'planning'].includes(t.status) ? Date.now() : t.updatedAt;
  const s = Math.max(0, Math.round((end - t.createdAt) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function renderTask() {
  const active = task && !['done', 'stopped'].includes(task.status);
  if (settings.mode === 'tasks') $('#composer').hidden = !!active;
  if (settings.mode !== 'tasks') return;
  const answerDraft = taskView.querySelector('[data-answer]')?.value || '';
  taskView.innerHTML = '';
  if (!task) {
    const missing = missingSetup('tasks');
    taskView.innerHTML = missing ? setupCard(missing) : card(`<div class="hero">
        <h2>What's the big job?</h2>
        <p>Describe a long goal. I'll split it into subtasks, work through them one by one, save progress as I go, and ask you when I need something, like a login.</p>
        <div class="suggestions">${SUGGESTIONS.tasks.map((s) => `<button data-act="suggest">${esc(s)}</button>`).join('')}</div>
      </div>`);
    activityList = el('div', 'list');
    return;
  }
  const done = task.subtasks.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const total = task.subtasks.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const items = task.subtasks.map((s) => {
    const icon = s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : s.status === 'active' ? '◌' : '○';
    return `<li class="${s.status}"><span class="st">${icon}</span><div>${esc(s.title)}${s.summary ? `<small>${esc(s.summary)}</small>` : ''}</div></li>`;
  }).join('');
  const isRunning = running?.mode === 'tasks';
  const buttons = isRunning
    ? '<button class="btn" data-act="task_pause">Pause</button><button class="btn ghost danger" data-act="task_stop">Stop</button>'
    : ['paused', 'failed'].includes(task.status)
      ? '<button class="btn ghost danger" data-act="task_stop">Stop</button><button class="btn primary" data-act="task_resume">Resume</button>'
      : ['done', 'stopped'].includes(task.status)
        ? '<button class="btn primary" data-act="task_clear">New task</button>'
        : '<button class="btn ghost danger" data-act="task_stop">Stop</button>';
  const lastLog = task.log.at(-1)?.text;
  taskView.innerHTML = card(`
    <div class="task-head"><span class="pill ${task.status}">${STATUS_LABEL[task.status] || task.status}</span>
      <span class="task-meta" data-clock>${task.steps} steps · ${elapsed(task)}</span></div>
    <p class="task-goal">${esc(task.goal)}</p>
    ${total ? `<div class="progress"><span class="big">${done}</span><span class="of">of ${total} subtasks</span></div>` : ''}
    <div class="bar"><i style="width:${total ? pct : 6}%"></i></div>
    ${items ? `<ul class="subtasks">${items}</ul>` : `<p class="hint">${esc(lastLog || 'Planning the steps…')}</p>`}
    ${task.notes.length ? `<div class="notes"><b>Notes</b><br>${task.notes.slice(-4).map(esc).join('<br>')}</div>` : ''}
    ${task.error ? `<div class="note error">${esc(task.error)}</div><br>` : ''}
    ${task.status === 'done' && task.summary ? `<div class="notes"><b>Summary</b><br>${esc(task.summary).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="row end">${buttons}</div>`);
  if (task.status === 'waiting_user') {
    taskView.insertAdjacentHTML('beforeend', card(`<div class="ask"><h3>I need you</h3><p>${esc(task.question)}</p>
      <textarea data-answer placeholder="Type your answer, or do it in the tab and write “done”"></textarea>
      <div class="row end"><button class="btn primary" data-act="task_answer">Send &amp; continue</button></div></div>`));
    taskView.querySelector('[data-answer]').value = answerDraft;
  }
  const act = el('details', 'activity');
  act.open = !['done', 'stopped'].includes(task.status);
  act.innerHTML = '<summary>Live activity</summary>';
  act.appendChild(activityList);
  taskView.appendChild(act);
}

function taskActivity(e) {
  if (e.type === 'thinking') return; // the task card already shows that it's working
  renderEvent(e, 'task', activityList);
  while (activityList.children.length > 60) activityList.firstChild.remove();
  activityList.scrollTop = activityList.scrollHeight;
}

// ---------- messages from the service worker ----------

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}
connect();

function onMessage(msg) {
  if (msg.type === 'status') return renderStatus(msg);
  if (msg.type === 'task') {
    const statusChanged = task?.status !== msg.task?.status;
    task = msg.task;
    renderTask();
    if (statusChanged) feed.scrollTop = 0; // keep the task card (and any question) in view
    return;
  }
  if (msg.type === 'event') return msg.source === 'task' ? taskActivity(msg.event) : renderEvent(msg.event, msg.source);
  if (msg.type === 'controlled') return renderControlled(msg.tabs);
  if (msg.type === 'external') return renderExternal(msg.entry);
  if (msg.type === 'external_result') return finishExternal(msg);
  if (msg.type === 'reset_done') { chatView.innerHTML = ''; renderChatIntro(); }
}

function renderStatus({ bridge, running: r }) {
  const tasksBefore = running?.mode === 'tasks';
  running = r;
  $('#bridge').classList.toggle('on', bridge);
  $('#bridge-label').textContent = bridge ? 'Coding agents connected' : settings.bridge.enabled ? 'Waiting for coding agents' : 'Coding agents off';
  $('#bridge').title = bridge ? 'Claude Code, OpenCode and other MCP clients can use this browser.' : 'Add hailbrowser-mcp to your coding agent (see Settings). Click to retry.';
  const chatBusy = r && r.mode !== 'tasks';
  $('#send').hidden = !!chatBusy;
  $('#stop').hidden = !chatBusy;
  if (!r) clearThinking();
  if (tasksBefore !== (r?.mode === 'tasks')) renderTask();
  clearInterval(taskClock);
  if (r?.mode === 'tasks') {
    taskClock = setInterval(() => {
      const c = taskView.querySelector('[data-clock]');
      if (c && task) c.textContent = `${task.steps} steps · ${elapsed(task)}`;
    }, 1000);
  }
}

// ---------- which tabs are being controlled ----------

let myWindow = null; // no top-level await here: messages may arrive while the module is suspended
chrome.windows.getCurrent().then((w) => { myWindow = w.id; }).catch(() => {});
const AGENT_NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode', cursor: 'Cursor', codex: 'Codex' };
const agentName = (c) => {
  const k = String(c || '').toLowerCase();
  for (const [key, v] of Object.entries(AGENT_NAMES)) if (k.startsWith(key)) return v;
  return c ? String(c).replace(/[-_]+/g, ' ') : 'agent';
};
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

function renderControlled(tabs = []) {
  const box = $('#control');
  box.hidden = !tabs.length;
  if (!tabs.length) return;
  const busy = tabs.some((t) => t.busy);
  box.classList.toggle('busy', busy);
  $('#control-label').textContent = busy ? `${tabs.find((t) => t.busy).who} is working` : `Controlling ${tabs.length} tab${tabs.length > 1 ? 's' : ''}`;
  const list = $('#control-tabs');
  list.innerHTML = '';
  for (const t of tabs.slice(0, 4)) {
    const where = t.windowId === myWindow ? 'this window' : t.windows > 1 ? `window ${t.window}` : '';
    const li = el('li', t.busy ? 'busy' : '');
    li.innerHTML = `<button class="tab-row" title="Show this tab">
        ${t.favIconUrl ? `<img src="${esc(t.favIconUrl)}" alt="" width="16" height="16">` : '<span class="fav"></span>'}
        <span class="t-main"><span class="t-title">${esc(t.title)}</span>
        <span class="t-meta">${esc(t.who)} · ${esc(hostOf(t.url) || 'new tab')}${where ? ` · ${where}` : ''}</span></span>
      </button>
      <button class="t-x" title="Release this tab" aria-label="Release this tab"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
    li.querySelector('img')?.addEventListener('error', (ev) => ev.target.replaceWith(el('span', 'fav')));
    li.querySelector('.tab-row').onclick = async () => {
      await chrome.tabs.update(t.id, { active: true }).catch(() => {});
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
    };
    li.querySelector('.t-x').onclick = () => port.postMessage({ type: 'release', tabId: t.id });
    list.appendChild(li);
  }
  if (tabs.length > 4) list.appendChild(el('li', 'more', `+${tabs.length - 4} more`));
}
$('#release-all').onclick = () => port.postMessage({ type: 'release' });

function renderExternal(entry) {
  if (entry.tool === 'run_task') return;
  externalSteps.push(step(chatView, '⟳', `<span class="badge ext">${esc(agentName(entry.client))}</span>${esc(entry.tool)}`, argSummary(entry.args), '', 'ext pending'));
}
function finishExternal({ entry, isError, ms: took }) {
  if (entry.tool === 'run_task') return;
  const s = externalSteps.shift();
  if (!s) return;
  s.classList.remove('pending');
  if (isError) s.classList.add('err');
  s.querySelector('.ico').textContent = isError ? '✕' : '✓';
  s.querySelector('.meta').textContent = ms(took);
}

// ---------- composer & modes ----------

function send() {
  const goal = input.value.trim();
  if (!goal || running) return;
  if (missingSetup(settings.mode)) { renderAll(); return; }
  input.value = '';
  autosize();
  if (settings.mode === 'tasks') {
    activityList = el('div', 'list');
    port.postMessage({ type: 'task_start', goal, mode: 'normal' });
    return;
  }
  renderEvent({ type: 'user', text: goal, mode: settings.mode }, 'panel');
  port.postMessage({ type: 'run', goal, mode: settings.mode });
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$('#send').addEventListener('click', send);
$('#stop').addEventListener('click', () => port.postMessage({ type: 'stop' }));
$('#new-chat').addEventListener('click', () => port.postMessage({ type: 'reset' }));
$('#bridge').addEventListener('click', () => port.postMessage({ type: 'reconnect' }));

for (const b of document.querySelectorAll('.modes button')) {
  b.addEventListener('click', async () => {
    settings.mode = b.dataset.mode;
    await saveSettings(settings);
    renderAll();
  });
}

function caption() {
  const uf = settings.ultrafast;
  if (settings.mode === 'ultrafast') {
    return `Decides with ${uf.backend === 'llm' ? uf.decisionModel : uf.backend === 'choice' ? uf.choiceModel : uf.systemoneModel}`;
  }
  return `${settings.normal.model} · ${PROVIDERS[settings.normal.provider]?.label || ''}`;
}

function renderAll() {
  const mode = settings.mode;
  for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('#mode-help').textContent = MODE_HELP[mode];
  input.placeholder = PLACEHOLDER[mode];
  $('#model-caption').textContent = caption();
  chatView.hidden = mode === 'tasks';
  taskView.hidden = mode !== 'tasks';
  $('#new-chat').hidden = mode === 'tasks';
  $('#composer').hidden = false;
  renderChatIntro();
  renderTask();
}
renderAll();

// ---------- settings ----------

const form = $('#settings-form');
const get = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
function set(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ||= {}), obj)[last] = value;
}

function buildSettingsForm() {
  for (const sel of form.querySelectorAll('select[data-providers]')) {
    sel.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join('');
  }
  $('#keys').innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `
    <label>${esc(p.label)}${p.keyless ? ' (optional)' : ''}
      <input type="password" name="providers.${id}.apiKey" placeholder="API key" spellcheck="false" />
      ${p.keyless || ['custom', 'openrouter', 'together'].includes(id) ? `<input name="providers.${id}.baseUrl" placeholder="${esc(p.baseUrl || 'https://your-endpoint/v1')}" spellcheck="false" />` : ''}
    </label>`).join('');
  for (const inp of form.querySelectorAll('input[list]')) {
    const dl = document.createElement('datalist');
    dl.id = inp.getAttribute('list');
    form.appendChild(dl);
  }
}

function refreshDerived() {
  for (const inp of form.querySelectorAll('input[list]')) {
    const provider = form.elements[inp.getAttribute('list').replace(/^models-/, '')]?.value;
    document.getElementById(inp.getAttribute('list')).innerHTML = (PROVIDERS[provider]?.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
  }
  for (const block of form.querySelectorAll('[data-show]')) {
    const [field, value] = block.dataset.show.split('=');
    block.hidden = form.elements[field]?.value !== value;
  }
  // Inline key fields follow their provider select.
  for (const keyInput of form.querySelectorAll('[data-key-input]')) {
    const provider = form.elements[keyInput.dataset.keyInput]?.value;
    if (document.activeElement !== keyInput) keyInput.value = settings.providers?.[provider]?.apiKey || '';
    keyInput.placeholder = provider === 'custom' ? 'Only if your endpoint needs one'
      : PROVIDERS[provider]?.keyless ? 'Not needed for local models' : `Paste your ${PROVIDERS[provider]?.label} API key`;
  }
  // Base URL fields appear for OpenAI-compatible endpoints and local servers.
  for (const urlInput of form.querySelectorAll('[data-url-input]')) {
    const provider = form.elements[urlInput.dataset.urlInput]?.value;
    urlInput.closest('label').hidden = !URL_PROVIDERS.has(provider);
    if (document.activeElement !== urlInput) urlInput.value = urlFor(provider);
    urlInput.placeholder = PROVIDERS[provider]?.baseUrl || 'https://your-endpoint/v1 (e.g. https://api.example.com/v1)';
  }
}

function fillForm() {
  for (const f of form.elements) {
    if (!f.name) continue;
    const v = get(settings, f.name);
    if (f.type === 'checkbox') f.checked = !!v; else f.value = v ?? '';
  }
  refreshDerived();
  renderSnippets();
}

function renderSnippets() {
  const p = Number(settings.bridge.port) || DEFAULTS.bridge.port;
  const portArgs = p === DEFAULTS.bridge.port ? [] : ['--port', String(p)];
  $('#snip-claude').textContent = `claude mcp add hailbrowser -- npx -y hailbrowser-mcp${portArgs.length ? ' ' + portArgs.join(' ') : ''}`;
  $('#snip-opencode').textContent = JSON.stringify({ mcp: { hailbrowser: { type: 'local', command: ['npx', '-y', 'hailbrowser-mcp', ...portArgs], enabled: true } } }, null, 2);
  $('#snip-generic').textContent = JSON.stringify({ mcpServers: { hailbrowser: { command: 'npx', args: ['-y', 'hailbrowser-mcp', ...portArgs] } } }, null, 2);
}

let saveTimer;
form.addEventListener('input', (e) => {
  const f = e.target;
  if (f.dataset.keyInput) {
    set(settings, `providers.${form.elements[f.dataset.keyInput].value}.apiKey`, f.value.trim());
  } else if (f.dataset.urlInput) {
    set(settings, `providers.${form.elements[f.dataset.urlInput].value}.baseUrl`, f.value.trim().replace(/\/+$/, ''));
  } else if (f.name) {
    set(settings, f.name, f.type === 'checkbox' ? f.checked : f.type === 'number' ? Number(f.value) : f.value.trim());
    if (f.tagName === 'SELECT' && /(^normal\.provider$|Provider$)/.test(f.name)) {
      const modelField = f.name === 'normal.provider' ? 'normal.model' : f.name.replace('Provider', 'Model');
      const first = PROVIDERS[f.value]?.models?.[0];
      if (first && form.elements[modelField]) { set(settings, modelField, first); form.elements[modelField].value = first; }
    }
  } else return;
  refreshDerived();
  renderSnippets();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(settings);
    $('#saved').hidden = false;
    setTimeout(() => { $('#saved').hidden = true; }, 1200);
  }, 300);
});

for (const b of document.querySelectorAll('[data-copy]')) {
  b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent);
    b.textContent = 'Copied';
    setTimeout(() => { b.textContent = 'Copy'; }, 1200);
  });
}

function openSettings() { fillForm(); $('#settings').hidden = false; }
buildSettingsForm();
$('#open-settings').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', () => { $('#settings').hidden = true; renderAll(); });
chrome.storage.onChanged.addListener(async (c) => {
  if (!c.settings) return;
  settings = await getSettings();
  if ($('#settings').hidden) renderAll();
});
