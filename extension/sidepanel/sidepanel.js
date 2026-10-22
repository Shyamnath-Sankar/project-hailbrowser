import { DEFAULTS, PROVIDERS, getSettings, saveSettings } from '../src/settings.js';
import { chatMarkdown } from '../src/agent/chats.js';
import { buildSchedule, describeWhen, MODES as JOB_MODES, relativeTime } from '../src/agent/schedule.js';
import { DEPTHS, reportMarkdown, RUNNING as RESEARCH_RUNNING } from '../src/agent/reports.js';
import { ago, card, download, duration, el, esc, favicon, hostOf, markdown, ms, slug, toast } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const feed = $('#feed');
const input = $('#input');
let settings = await getSettings();
if (!['normal', 'ultrafast'].includes(settings.mode)) { settings.mode = 'normal'; saveSettings(settings); } // Tasks/Research are now part of Chat
let running = null;
let port;
let thinkingEl = null;
let lastDecision = null;
const pendingTools = [];
const externalSteps = [];

// State mirrored from the service worker.
const tasks = new Map();
const reportCache = new Map(); // id -> full report
let reports = []; // index: [{id, question, status, updatedAt, sources}]
const slots = new Map(); // "task:<id>" | "report:<id>" -> Set of elements showing that card
const taskActivityLists = new Map(); // taskId -> live activity list
let chat = { id: null, title: '', events: [] };
let memory = [];
let schedules = [];
let runs = [];
let use = null; // composer toggle: 'research' | 'task' | null
let researchDepth = settings.research?.depth || 'standard';
const dismissedResume = new Set();

const MODE_HELP = {
  normal: 'Ask or give it a job. Turn on Research or Long task when you need them, or let it decide.',
  ultrafast: 'Speed-runs forms and searches with a decision model.',
};
const PLACEHOLDER = {
  normal: 'Ask or give a job…', ultrafast: 'What should it do on this page?',
  research: 'What should I research?', task: 'Describe the long job…',
};
const SUGGESTIONS = {
  normal: ['Summarize this page in 5 bullet points', 'Research the company behind this site: what they do, their products and contact info', 'Remember that I prefer prices in EUR'],
  ultrafast: ['Search this site for "wireless headphones" and sort by price', "Search Wikipedia for Gödel's incompleteness theorems and open the article"],
};

const chatView = el('section', 'view chat-view');
feed.append(chatView);
const scrollDown = () => { feed.scrollTop = feed.scrollHeight; };
const chatBusy = () => running && running.source === 'panel' && (running.mode === 'normal' || running.mode === 'ultrafast');
const send = (msg) => port.postMessage(msg);

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

// Card buttons live in the chat feed and in the detail sheet.
document.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-act]');
  const act = target?.dataset.act;
  if (!act || !target.closest('#feed, #detail')) return;
  const taskId = target.closest('[data-task]')?.dataset.task;
  const reportId = target.closest('[data-report]')?.dataset.report;
  const report = reportId && reportCache.get(reportId);
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
    const box = target.closest('[data-task]').querySelector('[data-answer]');
    if (!box.value.trim()) return box.focus();
    send({ type: 'task_answer', id: taskId, text: box.value });
  } else if (act === 'task_schedule') {
    const t = tasks.get(taskId);
    if (t) openScheduleForm({ goal: t.goal, mode: 'tasks', title: t.title });
  } else if (act === 'task_copy') {
    const t = tasks.get(taskId);
    await navigator.clipboard.writeText(t.answer || t.summary || '');
    toast('Copied');
  } else if (act.startsWith('task_')) {
    send({ type: act, id: taskId });
  } else if (act === 'proposal') {
    send({ type: 'proposal', pid: target.closest('[data-pid]').dataset.pid, accept: target.dataset.accept === '1' });
  } else if (act === 'report_stop') {
    send({ type: 'stop' });
  } else if (act === 'report_resume') {
    send({ type: 'research_resume', id: reportId });
  } else if (act === 'report_delete') {
    send({ type: 'report_delete', id: reportId });
  } else if (act === 'report_copy' && report) {
    await navigator.clipboard.writeText(reportMarkdown(report));
    toast('Report copied as Markdown');
  } else if (act === 'report_download' && report) {
    download(`${slug(report.question)}.md`, reportMarkdown(report));
  } else if (act === 'report_schedule' && report) {
    openScheduleForm({ goal: report.question, mode: 'research', title: report.question.slice(0, 60) });
  } else if (act === 'chat_export') {
    download(`${slug(chat.title || 'chat')}.md`, chatMarkdown({ ...chat, createdAt: chat.events[0]?.t || Date.now() }));
  }
});

// ---------- chat view ----------

function hero(mode) {
  const titles = { normal: 'What should I do?', ultrafast: 'Fast mode' };
  const sub = {
    normal: 'I can read, click and type in this tab, research the web with cited sources, run long multi-step jobs, remember things about you, and schedule work. Try:',
    ultrafast: 'Give one concrete goal with every value it needs. It acts on the current tab.',
  };
  return card(`<div class="hero"><h2>${titles[mode]}</h2><p>${sub[mode]}</p>
    <div class="suggestions">${SUGGESTIONS[mode].map((s) => `<button data-act="suggest">${esc(s)}</button>`).join('')}</div></div>`);
}

function renderChatIntro() {
  chatView.querySelector('.intro')?.remove();
  chatView.querySelector('.chat-tools')?.remove();
  if (chatView.querySelector('.msg, .step, .note, .proposal, .slot')) {
    const bar = el('div', 'chat-tools', `<span>${esc(chat.title || 'This chat')}</span><button class="link" data-act="chat_export" title="Download this chat as Markdown">Export</button>`);
    if (chat.events.length) chatView.prepend(bar);
    return;
  }
  const mode = settings.mode === 'ultrafast' ? 'ultrafast' : 'normal';
  const missing = missingSetup(mode);
  const intro = el('div', 'intro');
  intro.innerHTML = missing ? setupCard(missing) : hero(mode);
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
  for (const k of ['url', 'keys', 'direction', 'goal', 'note', 'summary', 'question', 'fact']) if (args[k]) return esc(args[k]);
  if (args.text != null) return esc(`"${args.text}"`);
  if (args.query) return esc(`"${args.query}"`);
  if (args.x != null) return esc(`(${args.x}, ${args.y})`);
  if (args.code) return esc(args.code.slice(0, 80));
  if (args.items) return esc(args.items.map((i) => i.title).join(', '));
  return '';
}

function clearThinking() { thinkingEl?.remove(); thinkingEl = null; }

function proposalCard(e) {
  const node = el('div', 'proposal');
  node.dataset.pid = e.pid;
  const body = e.kind === 'memory'
    ? `<div class="p-head">🧠 Remember this?</div><div class="p-body">“${esc(e.data.fact)}”${e.data.site ? ` <span class="chip">${esc(e.data.site)}</span>` : ''}</div>`
    : `<div class="p-head">⏰ Schedule this job?</div><div class="p-body"><b>${esc(e.data.title)}</b><br>${esc(e.data.goal)}</div>
       <div class="p-meta">${esc(JOB_MODES[e.data.mode] || 'Chat agent')} · ${esc(e.label || describeWhen(e.data.when))}${e.data.url ? ` · ${esc(hostOf(e.data.url))}` : ''}</div>`;
  node.innerHTML = `${body}<div class="p-actions"></div>`;
  setProposalState(node, e.state, e.error, e.kind);
  return node;
}

function setProposalState(node, state, error, kind = node.querySelector('.p-head').textContent.includes('Remember') ? 'memory' : 'schedule') {
  const actions = node.querySelector('.p-actions');
  node.classList.toggle('resolved', !!state);
  if (state === 'accepted') actions.innerHTML = `<span class="ok">${kind === 'memory' ? 'Saved to memory ✓' : 'Scheduled ✓'}</span>`;
  else if (state === 'dismissed') actions.innerHTML = '<span class="muted">Dismissed</span>';
  else actions.innerHTML = `${error ? `<span class="err">${esc(error)}</span>` : ''}<button class="btn small ghost" data-act="proposal" data-accept="0">Dismiss</button>
    <button class="btn small primary" data-act="proposal" data-accept="1">${kind === 'memory' ? 'Save' : 'Create'}</button>`;
}

const HIDDEN_TOOLS = new Set(['remember', 'schedule_task', 'start_research', 'start_task']);
const USE_TAG = { research: '🔍 Research', task: '📋 Long task' };

/** Render one agent event into a container (the chat feed or a task's activity list). */
function renderEvent(e, source, container = chatView) {
  if (e.type !== 'thinking') clearThinking();
  switch (e.type) {
    case 'user': {
      const m = el('div', 'msg user');
      m.innerHTML = `<span class="tag">${source === 'mcp' ? 'From your coding agent · ' : ''}${e.use ? USE_TAG[e.use] : e.mode === 'ultrafast' ? '⚡ Fast' : 'Chat'}</span>${esc(e.text)}`;
      put(chatView, m);
      break;
    }
    case 'thinking': clearThinking(); thinkingEl = put(container, el('div', 'typing', '<i></i><i></i><i></i>')); break;
    case 'assistant': put(container, el('div', 'msg assistant', markdown(e.text))); break;
    case 'tool': pendingTools.push(step(container, '⟳', esc(e.name), argSummary(e.args), '', 'pending')); break;
    case 'task_tool': if (!HIDDEN_TOOLS.has(e.name)) step(container, '★', esc(e.name.replace('_', ' ')), argSummary(e.args), ''); break;
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
    case 'proposal': put(container, proposalCard(e)); break;
    case 'memory_saved': step(container, '🧠', 'remembered', esc(e.fact) + (e.site ? ` <span class="chip">${esc(e.site)}</span>` : ''), ''); break;
    case 'task_ref': put(container, slot('task', e.id)); break;
    case 'report_ref': put(container, slot('report', e.id)); break;
  }
}

/** Redraw a saved chat (on panel open, New chat, or picking one from History). */
function showChat(c) {
  chat = c;
  chatView.innerHTML = '';
  pendingTools.length = 0;
  for (const e of c.events) renderEvent(e, 'panel', chatView);
  if (!chatBusy()) {
    for (const s of pendingTools.splice(0)) { s.classList.remove('pending'); s.querySelector('.ico').textContent = '·'; }
    clearThinking();
  }
  const missing = [...new Set(c.events.filter((e) => e.type === 'report_ref' && !reportCache.has(e.id)).map((e) => e.id))];
  if (missing.length) send({ type: 'report_get', ids: missing });
  renderChatIntro();
  renderResume();
  scrollDown();
}

// ---------- live cards (tasks and research reports, inline in chat or in the detail sheet) ----------

function slot(kind, id) {
  const node = el('div', `slot ${kind}-slot`);
  node.dataset[kind] = id;
  const key = `${kind}:${id}`;
  if (!slots.has(key)) slots.set(key, new Set());
  slots.get(key).add(node);
  fillSlot(node, kind, id);
  return node;
}

function fillSlot(node, kind, id) {
  if (kind === 'task') {
    const t = tasks.get(id);
    if (!t) { node.innerHTML = '<div class="note">This task was deleted.</div>'; return; }
    renderTaskCard(node, t);
  } else {
    const r = reportCache.get(id);
    if (!r) { node.innerHTML = card('<p class="hint">Loading report…</p>'); return; }
    node.replaceChildren(reportCard(r));
  }
}

function refreshSlots(kind, id) {
  const set = slots.get(`${kind}:${id}`);
  if (!set) return;
  for (const node of set) {
    if (!node.isConnected) { set.delete(node); continue; }
    fillSlot(node, kind, id);
  }
}

function refreshAllSlots() {
  for (const key of slots.keys()) {
    const [kind, id] = key.split(':');
    refreshSlots(kind, id);
  }
}

const visibleSlot = (kind, id) => [...(slots.get(`${kind}:${id}`) || [])].some((n) => n.isConnected && !n.closest('[hidden]'));

// ---------- tasks ----------

const STATUS_LABEL = { planning: 'Planning', running: 'Working', paused: 'Paused', waiting_user: 'Needs you', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
const ACTIVE_TASK = new Set(['planning', 'running', 'paused', 'waiting_user', 'failed']);
let clock = null;

function taskElapsed(t) {
  const end = ['running', 'planning'].includes(t.status) ? Date.now() : t.updatedAt;
  return duration(end - t.createdAt);
}

function taskProgress(t) {
  const done = t.subtasks.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { done, total: t.subtasks.length };
}

function sortedTasks() {
  return [...tasks.values()].sort((a, b) => (ACTIVE_TASK.has(b.status) - ACTIVE_TASK.has(a.status)) || b.updatedAt - a.updatedAt);
}

function activityFor(id) {
  if (!taskActivityLists.has(id)) taskActivityLists.set(id, el('div', 'list'));
  return taskActivityLists.get(id);
}

function renderTaskCard(node, task) {
  const answerDraft = node.querySelector('[data-answer]')?.value || '';
  const stepsOpen = node.querySelector('details.steps-box')?.open;
  const activityOpen = node.querySelector('details.activity')?.open;
  const { done, total } = taskProgress(task);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const finished = ['done', 'stopped'].includes(task.status);
  const items = task.subtasks.map((s) => {
    const icon = s.status === 'done' ? '✓' : s.status === 'skipped' ? '–' : s.status === 'active' ? '◌' : '○';
    return `<li class="${s.status}"><span class="st">${icon}</span><div>${esc(s.title)}${s.summary ? `<small>${esc(s.summary)}</small>` : ''}</div></li>`;
  }).join('');
  const isRunning = running?.mode === 'tasks' && running.id === task.id;
  const busyElse = running && !isRunning;
  const resumeBtn = `<button class="btn small primary" data-act="task_resume" ${busyElse ? 'disabled title="Something else is running"' : ''}>Resume</button>`;
  const buttons = isRunning
    ? '<button class="btn small" data-act="task_pause">Pause</button><button class="btn small ghost danger" data-act="task_stop">Stop</button>'
    : ['paused', 'failed'].includes(task.status)
      ? `<button class="btn small ghost danger" data-act="task_stop">Stop</button>${resumeBtn}`
      : finished
        ? `${task.answer || task.summary ? '<button class="btn small ghost" data-act="task_copy">Copy</button>' : ''}<button class="btn small ghost" data-act="task_schedule" title="Run this again on a schedule">⏰ Repeat</button><button class="btn small ghost danger" data-act="task_delete">Delete</button>`
        : '<button class="btn small ghost danger" data-act="task_stop">Stop</button>';
  const lastLog = task.log.at(-1)?.text;
  const result = task.status === 'done'
    ? task.answer ? `<div class="answer">${markdown(task.answer)}</div>` : task.summary ? `<div class="notes"><b>Summary</b><br>${esc(task.summary).replace(/\n/g, '<br>')}</div>` : ''
    : '';
  const plan = items ? `<ul class="subtasks">${items}</ul>` : `<p class="hint">${esc(lastLog || 'Planning the steps…')}</p>`;
  const notes = task.notes.length ? `<div class="notes"><b>Notes</b><br>${task.notes.slice(-4).map(esc).join('<br>')}</div>` : '';
  node.innerHTML = card(`
    <div class="task-head"><span class="pill ${task.status}">${STATUS_LABEL[task.status] || task.status}</span>
      <span class="chip">📋 Long task${task.mode === 'ultrafast' ? ' · ⚡' : ''}</span>
      ${task.scheduleId ? '<span class="chip">⏰</span>' : ''}
      <span class="task-meta" data-clock-task="${esc(task.id)}">${task.steps} steps · ${taskElapsed(task)}</span></div>
    <p class="task-goal">${esc(task.title || task.goal)}</p>
    ${total && !finished ? `<div class="progress"><span class="big">${done}</span><span class="of">of ${total} subtasks</span></div>` : ''}
    ${!finished ? `<div class="bar"><i style="width:${total ? pct : 6}%"></i></div>` : ''}
    ${!finished && isRunning && lastLog ? `<p class="hint live-line">${esc(lastLog)}</p>` : ''}
    ${result}
    ${finished ? `<details class="steps-box"><summary>${total} subtasks${task.notes.length ? ` · ${task.notes.length} notes` : ''}</summary>${plan}${notes}</details>` : `${plan}${notes}`}
    ${task.error ? `<div class="note error">${esc(task.error)}</div>` : ''}
    <div class="row end actions">${buttons}</div>`, 'task-card');
  if (task.status === 'waiting_user') {
    node.insertAdjacentHTML('beforeend', card(`<div class="ask"><h3>I need you</h3><p>${esc(task.question)}</p>
      <textarea data-answer placeholder="Type your answer, or do it in the tab and write “done”"></textarea>
      <div class="row end"><button class="btn small primary" data-act="task_answer" ${running ? 'disabled' : ''}>Send &amp; continue</button></div></div>`));
    node.querySelector('[data-answer]').value = answerDraft;
  }
  if (stepsOpen) node.querySelector('details.steps-box')?.setAttribute('open', '');
  const act = el('details', 'activity');
  act.open = activityOpen ?? false;
  act.innerHTML = '<summary>Live activity</summary>';
  const list = activityFor(task.id);
  if (!list.children.length && task.log.length) {
    for (const l of task.log.slice(-15)) step(list, '·', '', esc(l.text), new Date(l.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }), 'muted');
  }
  // One list element is shared by every card showing this task: show it in the newest one.
  act.appendChild(list);
  node.appendChild(act);
}

function taskActivity(e, taskId) {
  if (e.type === 'thinking') return; // the task card already shows that it's working
  const list = activityFor(taskId);
  renderEvent(e, 'task', list);
  while (list.children.length > 80) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

// ---------- resume banner ----------

function renderResume() {
  const box = $('#resume');
  const waiting = [...tasks.values()]
    .filter((t) => ['paused', 'waiting_user', 'failed'].includes(t.status) && !dismissedResume.has(`${t.id}:${t.status}`))
    .sort((a, b) => (b.status === 'waiting_user') - (a.status === 'waiting_user') || b.updatedAt - a.updatedAt);
  const t = waiting[0];
  if (!t || visibleSlot('task', t.id) || !$('#settings').hidden) { box.hidden = true; return; }
  const { done, total } = taskProgress(t);
  box.hidden = false;
  box.dataset.id = t.id;
  box.dataset.status = t.status;
  box.className = `resume ${t.status}`;
  box.querySelector('.r-ico').textContent = t.status === 'waiting_user' ? '!' : t.status === 'failed' ? '⚠' : '❚❚';
  box.querySelector('.r-title').textContent = t.status === 'waiting_user' ? `Needs you: ${t.question || t.goal}` : `${STATUS_LABEL[t.status]}: ${t.title || t.goal}`;
  box.querySelector('.r-meta').textContent = `${total ? `${done}/${total} subtasks · ` : ''}${ago(t.updatedAt)}${waiting.length > 1 ? ` · ${waiting.length - 1} more waiting` : ''}`;
  const btn = box.querySelector('[data-r="resume"]');
  btn.textContent = t.status === 'waiting_user' ? 'Answer' : 'Resume';
  btn.disabled = !!running && t.status !== 'waiting_user';
}

$('#resume').addEventListener('click', (e) => {
  const action = e.target.closest('[data-r]')?.dataset.r;
  const box = $('#resume');
  const id = box.dataset.id;
  if (!action || !id) return;
  if (action === 'dismiss') { dismissedResume.add(`${id}:${box.dataset.status}`); return renderResume(); }
  if (action === 'resume' && box.dataset.status !== 'waiting_user') send({ type: 'task_resume', id });
  openDetail('task', id);
});

// ---------- research ----------

const PHASES = [['planning', 'Plan'], ['searching', 'Search'], ['reading', 'Read'], ['writing', 'Write']];
const R_LABEL = { planning: 'Planning', searching: 'Searching', reading: 'Reading', writing: 'Writing', done: 'Done', stopped: 'Stopped', failed: 'Failed' };

function reportCard(r) {
  const live = RESEARCH_RUNNING.has(r.status);
  const usable = r.sources.filter((s) => s.n).sort((a, b) => a.n - b.n);
  const cites = new Map(usable.map((s) => [s.n, s]));
  const phaseIdx = PHASES.findIndex(([p]) => p === r.status);
  const phases = live ? `<ol class="phases">${PHASES.map(([p, label], i) => `<li class="${i < phaseIdx ? 'done' : i === phaseIdx ? 'active' : ''}">${label}</li>`).join('')}</ol>` : '';
  const queries = r.queries.length && (live || !r.answer) ? `<div class="chips">${r.queries.map((q) => `<span class="chip" title="${esc(q.engine)} · ${q.results} results">${esc(q.q)}</span>`).join('')}</div>` : '';
  const srcIcon = { queued: '○', reading: '◌', ok: '✓', skipped: '–', failed: '✕' };
  const sources = r.sources.length ? `<details class="sources-box" ${live || !r.answer ? 'open' : ''}><summary>Sources · ${usable.length} used${r.sources.length > usable.length ? ` of ${r.sources.length} read` : ''}</summary><ol class="sources">${r.sources.map((s) => `
    <li class="${s.status}" title="${esc(s.error || s.summary || '')}">
      <span class="s-n">${s.n || srcIcon[s.status] || '·'}</span>
      <img src="${esc(favicon(s.url))}" alt="" width="16" height="16">
      <span class="s-main"><a href="${esc(s.finalUrl || s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>
        <span class="s-meta">${esc(hostOf(s.url))}${s.date ? ` · ${esc(s.date)}` : ''}${s.status === 'failed' ? ` · ${esc(s.error || 'failed')}` : s.status === 'skipped' ? ' · not relevant' : s.status === 'reading' ? ' · reading…' : ''}</span></span>
    </li>`).join('')}</ol></details>` : '';
  const actions = live
    ? '<button class="btn small ghost danger" data-act="report_stop">Stop</button>'
    : r.status === 'done'
      ? `<button class="btn small ghost" data-act="report_copy">Copy</button><button class="btn small ghost" data-act="report_download">Download</button>
         <button class="btn small ghost" data-act="report_schedule" title="Re-run this research on a schedule">⏰ Repeat</button>`
      : `<button class="btn small ghost danger" data-act="report_delete">Delete</button><button class="btn small primary" data-act="report_resume" ${running ? 'disabled' : ''}>Resume</button>`;
  const lastLog = r.log.at(-1)?.text;
  const node = el('div', 'report-wrap');
  node.innerHTML = card(`
    <div class="task-head"><span class="pill ${live ? 'running' : r.status}">${R_LABEL[r.status] || r.status}</span>
      <span class="chip">🔍 ${esc(DEPTHS[r.depth]?.label || r.depth)} research</span>
      <span class="task-meta" data-clock-report="${esc(r.id)}">${usable.length ? `${usable.length} sources · ` : ''}${duration((r.finishedAt || (live ? Date.now() : r.updatedAt)) - r.createdAt)}</span></div>
    <p class="task-goal">${esc(r.question)}</p>
    ${phases}
    ${live && lastLog ? `<p class="hint live-line">${esc(lastLog)}</p>` : ''}
    ${queries}
    ${r.answer ? `<div class="answer">${markdown(r.answer, cites)}</div>` : live ? '<div class="skeleton"><i></i><i></i><i></i></div>' : ''}
    ${r.error ? `<div class="note error">${esc(r.error)}</div>` : ''}
    ${sources}
    <div class="row end actions">${actions}</div>`, 'report');
  for (const img of node.querySelectorAll('.sources img')) img.addEventListener('error', () => img.replaceWith(el('span', 'fav')));
  return node;
}

// ---------- detail sheet (a task or report opened from History, a notification or the banner) ----------

function openDetail(kind, id) {
  openSheet('detail');
  const body = $('#detail-body');
  body.innerHTML = '';
  $('#detail-title').textContent = kind === 'task' ? 'Long task' : 'Research';
  if (kind === 'report' && !reportCache.has(id)) send({ type: 'report_get', id });
  body.appendChild(slot(kind, id));
}

// ---------- messages from the service worker ----------

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}
connect();

function onMessage(msg) {
  switch (msg.type) {
    case 'status': return renderStatus(msg);
    case 'tasks':
      tasks.clear();
      for (const t of msg.tasks) tasks.set(t.id, t);
      refreshAllSlots();
      return renderResume();
    case 'task':
      tasks.set(msg.task.id, msg.task);
      refreshSlots('task', msg.task.id);
      renderResume();
      if (!$('#history').hidden) renderHistory();
      return;
    case 'task_removed':
      tasks.delete(msg.id);
      taskActivityLists.delete(msg.id);
      refreshSlots('task', msg.id);
      renderResume();
      if (!$('#history').hidden) renderHistory();
      return;
    case 'event':
      if (msg.source === 'task') return taskActivity(msg.event, msg.taskId);
      if (msg.source === 'schedule') return;
      return renderEvent(msg.event, msg.source);
    case 'chat': return showChat(msg.chat);
    case 'chat_list': return renderHistory(msg.items);
    case 'chat_full': return msg.chat && download(`${slug(msg.chat.title || 'chat')}.md`, chatMarkdown(msg.chat));
    case 'proposal_state': {
      const node = chatView.querySelector(`.proposal[data-pid="${CSS.escape(msg.pid)}"]`);
      const ev = chat.events.find((x) => x.pid === msg.pid);
      if (ev) Object.assign(ev, { state: msg.state, error: msg.error });
      if (node) setProposalState(node, msg.state, msg.error);
      if (msg.state === 'accepted') toast(ev?.kind === 'memory' ? 'Saved to memory' : 'Scheduled');
      return;
    }
    case 'memory': memory = msg.facts; return renderMemory();
    case 'schedules': schedules = msg.schedules; return renderSchedules();
    case 'runs': runs = msg.runs; return renderSchedules();
    case 'schedule_saved': $('#schedule-form').hidden = true; editingSchedule = null; return toast('Scheduled ✓');
    case 'schedule_error': return toast(msg.error, 'error');
    case 'reports':
      reports = msg.items;
      if (msg.removed) { reportCache.delete(msg.removed); refreshSlots('report', msg.removed); }
      if (!$('#history').hidden) renderHistory();
      return;
    case 'report': {
      const r = msg.report;
      if (!r) return;
      reportCache.set(r.id, r);
      const i = reports.findIndex((x) => x.id === r.id);
      const entry = { id: r.id, question: r.question, status: r.status, updatedAt: r.updatedAt, sources: r.sources.filter((s) => s.n).length };
      if (i >= 0) reports[i] = entry; else reports.unshift(entry);
      refreshSlots('report', r.id);
      return;
    }
    case 'focus': return applyFocus(msg.focus);
    case 'controlled': return renderControlled(msg.tabs);
    case 'external': return renderExternal(msg.entry);
    case 'external_result': return finishExternal(msg);
    case 'error': return toast(msg.text, 'error');
  }
}

function renderStatus({ bridge, running: r }) {
  const before = running;
  running = r;
  $('#bridge').classList.toggle('on', bridge);
  $('#bridge-label').textContent = bridge ? 'Coding agents connected' : settings.bridge.enabled ? 'Waiting for coding agents' : 'Coding agents off';
  $('#bridge').title = bridge ? 'Claude Code, OpenCode and other MCP clients can use this browser.' : 'Add hailbrowser-mcp to your coding agent (see Settings). Click to retry.';
  const busy = chatBusy();
  $('#send').hidden = !!busy;
  $('#stop').hidden = !busy;
  if (!busy) clearThinking();
  if (JSON.stringify(before) !== JSON.stringify(r)) {
    refreshAllSlots();
    renderResume();
  }
  clearInterval(clock);
  if (r && (r.mode === 'tasks' || r.mode === 'research')) clock = setInterval(tick, 1000);
}

function tick() {
  if (!running) return;
  if (running.mode === 'tasks') {
    const t = tasks.get(running.id);
    for (const c of document.querySelectorAll(`[data-clock-task="${CSS.escape(running.id)}"]`)) if (t) c.textContent = `${t.steps} steps · ${taskElapsed(t)}`;
  } else {
    const r = reportCache.get(running.id);
    if (!r || !RESEARCH_RUNNING.has(r.status)) return;
    const used = r.sources.filter((s) => s.n).length;
    for (const c of document.querySelectorAll(`[data-clock-report="${CSS.escape(running.id)}"]`)) c.textContent = `${used ? `${used} sources · ` : ''}${duration(Date.now() - r.createdAt)}`;
  }
}

function applyFocus(f) {
  if (!f || Date.now() - (f.at || 0) > 60000) return;
  chrome.storage.session.remove('panelFocus').catch(() => {});
  if (f.kind === 'task' && tasks.has(f.id)) openDetail('task', f.id);
  else if (f.kind === 'report') openDetail('report', f.id);
  else if (f.kind === 'run') openSchedules();
}
chrome.storage.session.get('panelFocus').then(({ panelFocus }) => applyFocus(panelFocus)).catch(() => {});

// ---------- which tabs are being controlled ----------

let myWindow = null; // no top-level await here: messages may arrive while the module is suspended
chrome.windows.getCurrent().then((w) => { myWindow = w.id; }).catch(() => {});
const AGENT_NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode', cursor: 'Cursor', codex: 'Codex' };
const agentName = (c) => {
  const k = String(c || '').toLowerCase();
  for (const [key, v] of Object.entries(AGENT_NAMES)) if (k.startsWith(key)) return v;
  return c ? String(c).replace(/[-_]+/g, ' ') : 'agent';
};

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
    li.querySelector('.t-x').onclick = () => send({ type: 'release', tabId: t.id });
    list.appendChild(li);
  }
  if (tabs.length > 4) list.appendChild(el('li', 'more', `+${tabs.length - 4} more`));
}
$('#release-all').onclick = () => send({ type: 'release' });

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

function sendGoal() {
  const goal = input.value.trim();
  if (!goal) return;
  const needs = use === 'research' ? 'normal' : settings.mode;
  if (missingSetup(needs) || (use && missingSetup('normal'))) { renderAll(); return toast('Connect a model first.', 'error'); }
  if (running) {
    return toast(chatBusy() ? 'Still working on your last message.' : `Busy with ${running.mode === 'research' ? 'research' : running.mode === 'tasks' ? 'a long task' : 'another job'}. Stop it or wait for it to finish.`, 'error');
  }
  send({ type: 'run', goal, mode: settings.mode, ...(use ? { use, depth: researchDepth } : {}) });
  input.value = '';
  setUse(null);
  autosize();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

function setUse(next) {
  use = next;
  for (const b of document.querySelectorAll('[data-use]')) b.setAttribute('aria-pressed', String(b.dataset.use === use));
  $('#depth').hidden = use !== 'research';
  for (const b of document.querySelectorAll('#depth button')) b.setAttribute('aria-checked', String(b.dataset.depth === researchDepth));
  input.placeholder = PLACEHOLDER[use || settings.mode] || '';
}
for (const b of document.querySelectorAll('[data-use]')) b.addEventListener('click', () => { setUse(use === b.dataset.use ? null : b.dataset.use); input.focus(); });
for (const b of document.querySelectorAll('#depth button')) b.addEventListener('click', () => { researchDepth = b.dataset.depth; setUse(use); });

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendGoal(); }
});
$('#send').addEventListener('click', sendGoal);
$('#stop').addEventListener('click', () => send({ type: 'stop' }));
$('#new-chat').addEventListener('click', () => { send({ type: 'reset' }); input.focus(); });
$('#bridge').addEventListener('click', () => send({ type: 'reconnect' }));

async function setMode(mode) {
  settings.mode = mode;
  await saveSettings(settings);
  renderAll();
}
for (const b of document.querySelectorAll('.modes button')) b.addEventListener('click', () => setMode(b.dataset.mode));

function caption() {
  const uf = settings.ultrafast;
  if (settings.mode === 'ultrafast') {
    return `Decides with ${uf.backend === 'llm' ? uf.decisionModel : uf.backend === 'choice' ? uf.choiceModel : uf.systemoneModel}`;
  }
  const base = `${settings.normal.model} · ${PROVIDERS[settings.normal.provider]?.label || ''}`;
  return memory.length && settings.memory?.enabled !== false ? `${base} · ${memory.length} memor${memory.length === 1 ? 'y' : 'ies'}` : base;
}

function renderAll() {
  const mode = settings.mode;
  for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  $('#mode-help').textContent = MODE_HELP[mode] || '';
  $('#model-caption').textContent = caption();
  renderChatIntro();
  setUse(use);
  renderResume();
}
renderAll();

// ---------- sheets ----------

function openSheet(id) {
  for (const s of document.querySelectorAll('.sheet, #settings')) s.hidden = s.id !== id;
  renderResume();
}
function closeSheets() {
  for (const s of document.querySelectorAll('.sheet, #settings')) s.hidden = true;
  renderAll();
}
for (const b of document.querySelectorAll('.sheet [data-close]')) b.addEventListener('click', closeSheets);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && [...document.querySelectorAll('.sheet, #settings')].some((s) => !s.hidden)) closeSheets();
});

// ---------- history ----------

let historyTab = 'chats';
let chatList = [];

function openHistory() {
  openSheet('history');
  send({ type: 'chat_list' });
  send({ type: 'reports_list' });
  renderHistory();
}

function renderHistory(items) {
  if (items) chatList = items;
  for (const b of document.querySelectorAll('[data-htab]')) b.setAttribute('aria-selected', String(b.dataset.htab === historyTab));
  const box = $('#history-list');
  const empty = (text) => `<p class="empty">${text}</p>`;
  const row = (id, title, meta, cls = '') => `<div class="hrow ${cls}" data-id="${esc(id)}">
      <button class="h-main" data-h="open"><span class="h-title">${esc(title)}</span><span class="h-meta">${meta}</span></button>
      ${historyTab === 'chats' ? '<button class="t-x" data-h="export" title="Download as Markdown"><svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg></button>' : ''}
      <button class="t-x" data-h="delete" title="Delete"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg></button></div>`;
  if (historyTab === 'chats') {
    box.innerHTML = chatList.length ? chatList.map((c) => row(c.id, c.title || 'Untitled chat',
      `${c.turns || 0} message${c.turns === 1 ? '' : 's'} · ${ago(c.updatedAt)}${c.id === chat.id ? ' · <b>open</b>' : ''}`, c.id === chat.id ? 'current' : '')).join('') : empty('No saved chats yet. Chats are saved automatically.');
  } else if (historyTab === 'reports') {
    box.innerHTML = reports.length ? reports.map((r) => row(r.id, r.question, `<span class="pill ${r.status}">${R_LABEL[r.status] || r.status}</span> ${r.sources ? `${r.sources} sources · ` : ''}${ago(r.updatedAt)}`)).join('')
      : empty('No research yet. Switch to Research mode and ask a question.');
  } else {
    const list = sortedTasks();
    box.innerHTML = list.length ? list.map((t) => {
      const { done, total } = taskProgress(t);
      return row(t.id, t.title || t.goal, `<span class="pill ${t.status}">${STATUS_LABEL[t.status] || t.status}</span> ${total ? `${done}/${total} · ` : ''}${ago(t.updatedAt)}`);
    }).join('') : empty('No tasks yet.');
  }
}

for (const b of document.querySelectorAll('[data-htab]')) b.addEventListener('click', () => { historyTab = b.dataset.htab; renderHistory(); });
$('#history-list').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-h]')?.dataset.h;
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (!action || !id) return;
  if (historyTab === 'chats') {
    if (action === 'open') { send({ type: 'chat_open', id }); closeSheets(); }
    else if (action === 'export') send({ type: 'chat_get', id });
    else if (action === 'delete') send({ type: 'chat_delete', id });
  } else if (historyTab === 'reports') {
    if (action === 'open') openDetail('report', id);
    else if (action === 'delete') send({ type: 'report_delete', id });
  } else if (action === 'open') openDetail('task', id);
  else if (action === 'delete') send({ type: 'task_delete', id });
});
$('#open-history').addEventListener('click', openHistory);

// ---------- schedules ----------

const sform = $('#schedule-form');
let editingSchedule = null;
const RUN_LABEL = { running: 'Running', done: 'Done', needs_you: 'Needs you', blocked: 'Blocked', failed: 'Failed', stopped: 'Stopped', error: 'Failed' };
const RUN_CLASS = { running: 'running', done: 'done', needs_you: 'waiting_user', blocked: 'waiting_user', failed: 'failed', stopped: 'stopped', error: 'failed' };

function openSchedules() {
  openSheet('schedules');
  renderSchedules();
}

function renderSchedules() {
  $('#sched-dot').hidden = !schedules.some((s) => s.enabled);
  if ($('#schedules').hidden) return;
  const list = [...schedules].sort((a, b) => (b.enabled - a.enabled) || (a.nextRunAt || Infinity) - (b.nextRunAt || Infinity));
  $('#schedule-list').innerHTML = list.length ? list.map((s) => `
    <div class="sched ${s.enabled ? '' : 'off'}" data-id="${esc(s.id)}">
      <div class="s-top"><span class="chip">${esc(JOB_MODES[s.mode] || s.mode)}</span><span class="s-title">${esc(s.title)}</span>
        <label class="switch" title="${s.enabled ? 'Pause' : 'Turn on'}"><input type="checkbox" data-s="toggle" ${s.enabled ? 'checked' : ''}><i></i></label></div>
      <div class="s-goal">${esc(s.goal)}</div>
      <div class="s-meta">${esc(describeWhen(s.when))} · ${s.enabled && s.nextRunAt ? `next ${esc(relativeTime(s.nextRunAt))}` : 'off'}${s.url ? ` · ${esc(hostOf(s.url))}` : ''}
        ${s.lastRun ? ` · last <span class="pill ${RUN_CLASS[s.lastRun.status] || ''}">${RUN_LABEL[s.lastRun.status] || s.lastRun.status}</span>` : ''}</div>
      <div class="row end"><button class="link" data-s="run">Run now</button><button class="link" data-s="edit">Edit</button><button class="link danger" data-s="delete">Delete</button></div>
    </div>`).join('') : card(`<h3>Nothing scheduled yet</h3>
      <p class="hint">Let HailBrowser do recurring work while you're away: it runs in a background tab and sends a notification with the result.</p>
      <ul class="examples"><li>Weekdays at 09:00 — <i>open my GitHub notifications and summarize what needs a reply</i></li>
      <li>Every 4 hours — <i>check this product page and tell me if the price drops below $200</i></li>
      <li>Mondays at 08:00 — <i>research this week's news about browser agents</i></li></ul>
      <p class="hint">Tip: in Chat, just say “every morning at 9, …”.</p>`);
  $('#run-list').innerHTML = runs.length ? runs.slice(0, 20).map((r) => `
    <div class="run" data-id="${esc(r.id)}">
      <div class="s-top"><span class="pill ${RUN_CLASS[r.status] || ''}">${RUN_LABEL[r.status] || r.status}</span><span class="s-title">${esc(r.title)}</span><span class="h-meta">${ago(r.at)}${r.finishedAt ? ` · ${duration(r.finishedAt - r.at)}` : ''}</span></div>
      ${r.summary ? `<div class="s-goal">${esc(r.summary)}</div>` : ''}
      <div class="row">${r.taskId ? `<button class="link" data-run="task" data-ref="${esc(r.taskId)}">Open task</button>` : ''}${r.reportId ? `<button class="link" data-run="report" data-ref="${esc(r.reportId)}">Open report</button>` : ''}${r.tabId ? `<button class="link" data-run="tab" data-ref="${r.tabId}">Show tab</button>` : ''}${r.delayedMs > 60000 ? `<span class="h-meta">started ${Math.round(r.delayedMs / 60000)} min late (busy)</span>` : ''}</div>
    </div>`).join('') : '<p class="empty">Runs appear here.</p>';
  $('#clear-runs').hidden = !runs.length;
}

$('#schedule-list').addEventListener('click', (e) => {
  const action = e.target.closest('[data-s]')?.dataset.s;
  const id = e.target.closest('[data-id]')?.dataset.id;
  if (!action || !id || action === 'toggle') return;
  const s = schedules.find((x) => x.id === id);
  if (action === 'run') { send({ type: 'schedule_run', id }); toast(`Running “${s.title}”…`); }
  else if (action === 'edit') openScheduleForm(s, s);
  else if (action === 'delete' && confirm(`Delete the scheduled job “${s.title}”?`)) send({ type: 'schedule_delete', id });
});
$('#schedule-list').addEventListener('change', (e) => {
  if (e.target.dataset.s !== 'toggle') return;
  send({ type: 'schedule_toggle', id: e.target.closest('[data-id]').dataset.id, enabled: e.target.checked });
});
$('#run-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-run]');
  if (!b) return;
  const ref = b.dataset.ref;
  if (b.dataset.run === 'task') openDetail('task', ref);
  else if (b.dataset.run === 'report') openDetail('report', ref);
  else if (b.dataset.run === 'tab') {
    const tab = await chrome.tabs.get(Number(ref)).catch(() => null);
    if (!tab) return toast('That tab was closed.');
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
});
$('#clear-runs').addEventListener('click', () => send({ type: 'runs_clear' }));
$('#open-schedules').addEventListener('click', openSchedules);
$('#new-schedule').addEventListener('click', () => openScheduleForm({}));

/** Open the form, empty, prefilled ({goal, mode, title, url}) or editing an existing schedule. */
function openScheduleForm(draft = {}, existing = null) {
  openSheet('schedules');
  renderSchedules();
  editingSchedule = existing?.id || null;
  const f = sform.elements;
  sform.querySelector('[data-form-title]').textContent = existing ? 'Edit scheduled job' : 'New scheduled job';
  f.goal.value = draft.goal || '';
  f.title.value = draft.title || '';
  f.mode.value = JOB_MODES[draft.mode] ? draft.mode : 'normal';
  f.url.value = draft.url || '';
  const w = draft.when;
  let freq = 'daily', time = '09:00', date = '', every = '60', days = [1, 3, 5];
  if (w?.type === 'once') {
    const d = new Date(w.at);
    freq = 'once';
    time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } else if (w?.type === 'interval') {
    freq = 'interval';
    every = String(w.minutes);
    if (![...f.everyMinutes.options].some((o) => o.value === every)) f.everyMinutes.add(new Option(`${w.minutes} minutes`, every));
  } else if (w?.type === 'daily') {
    time = w.time;
    freq = !w.days?.length ? 'daily' : w.days.join() === '1,2,3,4,5' ? 'weekdays' : 'weekly';
    if (w.days?.length) days = w.days;
  }
  f.frequency.value = freq;
  f.time.value = time;
  f.date.value = date || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  f.everyMinutes.value = every;
  for (const c of sform.querySelectorAll('[data-f="days"] input')) c.checked = days.includes(Number(c.value));
  sform.hidden = false;
  syncScheduleForm();
  sform.scrollIntoView({ block: 'start' });
  (draft.goal ? f.title : f.goal).focus();
}

function scheduleDraft() {
  const f = sform.elements;
  return {
    id: editingSchedule || undefined,
    goal: f.goal.value, title: f.title.value, mode: f.mode.value, url: f.url.value,
    frequency: f.frequency.value, time: f.time.value, date: f.date.value, everyMinutes: Number(f.everyMinutes.value),
    days: [...sform.querySelectorAll('[data-f="days"] input:checked')].map((c) => Number(c.value)),
    // Editing keeps a paused job paused, but a used-up one-off comes back on with its new time.
    enabled: (() => { const s = schedules.find((x) => x.id === editingSchedule); return !s || s.enabled || s.when.type === 'once'; })(),
  };
}

function syncScheduleForm() {
  const freq = sform.elements.frequency.value;
  sform.querySelector('[data-f="time"]').hidden = freq === 'interval';
  sform.querySelector('[data-f="date"]').hidden = freq !== 'once';
  sform.querySelector('[data-f="every"]').hidden = freq !== 'interval';
  sform.querySelector('[data-f="days"]').hidden = freq !== 'weekly';
  const preview = sform.querySelector('[data-preview]');
  try {
    const s = buildSchedule({ ...scheduleDraft(), goal: sform.elements.goal.value || 'x' });
    preview.textContent = `${describeWhen(s.when)} · first run ${relativeTime(s.nextRunAt)}${s.mode === 'tasks' ? ' · it will ask you (with a notification) if it gets stuck' : ''}`;
    preview.classList.remove('err');
  } catch (err) {
    preview.textContent = err.message;
    preview.classList.add('err');
  }
}
sform.addEventListener('input', syncScheduleForm);
sform.addEventListener('change', syncScheduleForm);
sform.querySelector('[data-cancel]').addEventListener('click', () => { sform.hidden = true; editingSchedule = null; });
sform.querySelector('[data-use-tab]').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
  if (tab?.url && /^https?:/.test(tab.url)) { sform.elements.url.value = tab.url; syncScheduleForm(); } else toast('The current tab has no web address to use.');
});
sform.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!sform.elements.goal.value.trim()) return sform.elements.goal.focus();
  send({ type: 'schedule_save', draft: scheduleDraft() });
});

// ---------- memory (in Settings) ----------

function renderMemory() {
  const ul = $('#memory-list');
  $('#model-caption').textContent = caption();
  if (!ul) return;
  ul.innerHTML = memory.length ? memory.map((f) => `<li data-id="${esc(f.id)}">
      <span class="m-text" title="Click to edit">${esc(f.text)}</span>${f.site ? `<span class="chip">${esc(f.site)}</span>` : ''}
      <button type="button" class="t-x" data-m="delete" title="Forget this"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></li>`).join('')
    : '<li class="empty">Nothing saved yet.</li>';
  $('#memory-clear').hidden = !memory.length;
}
$('#memory-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.closest('[data-m="delete"]')) return send({ type: 'memory_delete', id: li.dataset.id });
  const span = e.target.closest('.m-text');
  if (!span || li.querySelector('input')) return;
  const box = el('input', 'm-edit');
  box.value = span.textContent;
  span.replaceWith(box);
  box.focus();
  const done = (save) => {
    if (save && box.value.trim() !== span.textContent) send({ type: 'memory_update', id: li.dataset.id, text: box.value });
    else renderMemory();
  };
  box.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); done(true); } else if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } });
  box.addEventListener('blur', () => done(true), { once: true });
});
function addMemory() {
  const text = $('#memory-text');
  if (!text.value.trim()) return text.focus();
  send({ type: 'memory_add', text: text.value, site: $('#memory-site').value });
  text.value = '';
  $('#memory-site').value = '';
}
$('#memory-add').addEventListener('click', addMemory);
$('#memory-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addMemory(); } });
$('#memory-clear').addEventListener('click', () => { if (confirm('Forget everything HailBrowser remembers about you?')) send({ type: 'memory_clear' }); });

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
  renderMemory();
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
  if (f.closest('.mem-add, .mem-list')) return; // memory has its own controls
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
    if (f.name === 'research.depth') { researchDepth = f.value; setUse(use); }
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

function openSettings() { fillForm(); openSheet('settings'); }
buildSettingsForm();
$('#open-settings').addEventListener('click', openSettings);
$('#close-settings').addEventListener('click', closeSheets);
chrome.storage.onChanged.addListener(async (c) => {
  if (!c.settings) return;
  settings = await getSettings();
  if ($('#settings').hidden) renderAll();
});
