// Service worker: wires the side panel, the MCP bridge and the agents (chat, fast, tasks,
// research, schedules) together, and owns all saved state (chats, tasks, reports, memory).
import { Bridge } from './bridge.js';
import { getSettings } from './settings.js';
import { collection, uid } from './store.js';
import { executeTool } from './tools/execute.js';
import { runNormal } from './agent/normal.js';
import { runUltrafast } from './agent/ultrafast.js';
import { applyAnswer, newTask, runTask, taskStore } from './agent/tasks.js';
import { chatStore, chatTitle, newChat, pushEvent, storableMessages } from './agent/chats.js';
import { addFact, cleanFact, cleanSite, clearMemory, getMemory, memoryPrompt, REMEMBER_TOOL, rememberIntent, removeFact, updateFact } from './agent/memory.js';
import { buildSchedule, describeWhen, nextRun, SCHEDULE_TOOL } from './agent/schedule.js';
import { runResearch } from './agent/research.js';
import { newReport, reportStore, RUNNING as RESEARCH_RUNNING } from './agent/reports.js';
import { CHAT_HANDOFF_RULE, CHAT_MEMORY_RULE, CHAT_SCHEDULE_RULE, NORMAL_SYSTEM, TASK_UNATTENDED, UNATTENDED_RULES } from './agent/prompts.js';
import * as page from './browser/page.js';
import * as groups from './browser/groups.js';

const ports = new Set();
let bridgeConnected = false;
let run = null; // {controller, mode, source, id?}: only one agent run at a time
const activity = []; // recent external (MCP) tool calls

// ---------- saved state ----------

const tasks = new Map(); // id -> task (all saved tasks, kept in memory: at most 30)
const schedules = new Map(); // id -> schedule
const scheduleStore = collection('schedules', { max: 50, summary: (s) => ({ title: s.title }) });
let runs = []; // recent scheduled runs, newest first
let chat = newChat(); // the side-panel conversation
let memoryFacts = [];
const MAX_RUNS = 50;

// Work that was running when Chrome stopped the worker is paused, never resumed silently.
const ready = (async () => {
  const saved = await chrome.storage.local.get(['task', 'currentChat', 'scheduleRuns']);
  if (saved.task) { // one-task storage from earlier versions
    await taskStore.put(saved.task);
    await chrome.storage.local.remove('task');
  }
  for (const t of (await taskStore.all()).reverse()) {
    if (['running', 'planning'].includes(t.status)) {
      t.status = 'paused';
      t.log.push({ t: Date.now(), text: 'Paused because Chrome restarted the extension. Press Resume to continue.' });
      await taskStore.put(t);
    }
    tasks.set(t.id, t);
  }
  for (const r of await reportStore.all()) {
    if (RESEARCH_RUNNING.has(r.status)) {
      r.status = 'stopped';
      r.log.push({ t: Date.now(), text: 'Interrupted because Chrome restarted the extension. Press Resume to continue.' });
      await reportStore.put(r);
    }
  }
  for (const s of await scheduleStore.all()) schedules.set(s.id, s);
  runs = Array.isArray(saved.scheduleRuns) ? saved.scheduleRuns : [];
  for (const r of runs) if (r.status === 'running') r.status = 'stopped';
  if (saved.currentChat) chat = (await chatStore.get(saved.currentChat)) || chat;
  memoryFacts = (await getMemory()).facts;
})();

function broadcast(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch { ports.delete(p); }
  }
}

function status() {
  return { type: 'status', bridge: bridgeConnected, running: run ? { mode: run.mode, source: run.source, id: run.id || null } : null, port: bridge.port };
}

function memorySection(settings, url) {
  return settings.memory?.enabled === false ? '' : memoryPrompt(memoryFacts, url);
}

// ---------- notifications ----------

async function notify(id, title, message) {
  const s = await getSettings();
  if (s.notifications === false || !chrome.notifications) return;
  chrome.notifications.create(id, {
    type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: title.slice(0, 120), message: String(message || ' ').replace(/\s+/g, ' ').slice(0, 300) || ' ', priority: 1,
  }, () => void chrome.runtime.lastError);
}

chrome.notifications?.onClicked.addListener(async (nid) => {
  const [kind, id] = nid.split(':');
  const focus = { kind, id, at: Date.now() };
  await chrome.storage.session.set({ panelFocus: focus }).catch(() => {});
  broadcast({ type: 'focus', focus });
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (win) {
    chrome.windows.update(win.id, { focused: true }).catch(() => {});
    chrome.sidePanel.open({ windowId: win.id }).catch(() => {});
  }
  chrome.notifications.clear(nid);
});

// ---------- tasks ----------

function saveTask(t) {
  const before = tasks.get(t.id)?._notified;
  tasks.set(t.id, t);
  broadcast({ type: 'task', task: t });
  // Tell the user when a task needs them or ends while the panel is closed.
  if (['waiting_user', 'done', 'failed'].includes(t.status) && before !== `${t.status}:${t.question || ''}`) {
    t._notified = `${t.status}:${t.question || ''}`;
    if (!ports.size && !(t.scheduleId && run?.source === 'schedule')) {
      const label = t.status === 'waiting_user' ? 'HailBrowser needs you' : t.status === 'done' ? 'Task finished' : 'Task failed';
      notify(`task:${t.id}`, `${label}: ${t.title || t.goal}`, t.status === 'waiting_user' ? t.question : t.summary || t.error);
    }
  }
  return taskStore.put(t);
}

async function executeTask(id, { unattended = false } = {}) {
  const task = tasks.get(id);
  if (!task) throw new Error('That task no longer exists.');
  if (run) throw new Error(`HailBrowser is already running ${describeRun()}. Stop it first.`);
  const settings = await getSettings();
  const controller = new AbortController();
  run = { controller, mode: 'tasks', source: unattended ? 'schedule' : 'panel', id };
  broadcast(status());
  const emit = (event) => broadcast({ type: 'event', source: 'task', taskId: id, event });
  try {
    driver = unattended ? 'Scheduled task' : 'Tasks';
    const tab = await page.resolveTab();
    pulseIndicator(tab.id, 'HailBrowser is working on your task', 0);
    const systemExtra = memorySection(settings, tab.url) + (unattended || task.scheduleId ? `\n${TASK_UNATTENDED}` : '');
    await runTask({ task, settings, signal: controller.signal, emit, save: saveTask, systemExtra });
  } catch (e) {
    if (e?.name === 'AbortError') {
      task.status = run?.stopping ? 'stopped' : 'paused';
      for (const s of task.subtasks) if (s.status === 'active') { s.status = 'pending'; s.attempts = Math.max(0, s.attempts - 1); }
    } else {
      task.status = 'failed';
      task.error = e?.message || String(e);
      task.log.push({ t: Date.now(), text: `Error: ${task.error}` });
    }
    await saveTask(task);
  } finally {
    if (run?.stopping) { task.status = 'stopped'; await saveTask(task); }
    if (task.status === 'done' && task.chatId && !task.inChat) {
      task.inChat = true;
      await resultToChat(task.chatId, task.asked, `Result of the long task "${task.goal}":\n\n${task.answer || task.summary}`);
      await taskStore.put(task);
    }
    run = null;
    clearIndicator();
    broadcast(status());
    setTimeout(drainQueue, 0);
  }
}

async function handleTaskMessage(msg, port) {
  await ready;
  if (msg.type === 'task_start') {
    if (run) throw new Error(`HailBrowser is already running ${describeRun()}. Stop it first.`);
    const goal = String(msg.goal || '').trim();
    if (!goal) return;
    const t = newTask(goal, msg.mode);
    await saveTask(t);
    port?.postMessage({ type: 'task_created', id: t.id });
    return executeTask(t.id);
  }
  const t = tasks.get(msg.id);
  if (!t) return;
  const mine = run?.mode === 'tasks' && run.id === t.id;
  if (msg.type === 'task_pause' && mine) run.controller.abort();
  else if (msg.type === 'task_stop') {
    if (mine) { run.stopping = true; run.controller.abort(); } else { t.status = 'stopped'; await saveTask(t); }
  } else if (msg.type === 'task_resume' && !run && ['paused', 'failed'].includes(t.status)) {
    return executeTask(t.id);
  } else if (msg.type === 'task_answer' && !run && t.status === 'waiting_user') {
    if (applyAnswer(t, msg.text)) { await saveTask(t); return executeTask(t.id); }
  } else if (msg.type === 'task_delete' && !mine) {
    tasks.delete(t.id);
    await taskStore.remove(t.id);
    broadcast({ type: 'task_removed', id: t.id });
  }
}

function describeRun() {
  if (!run) return 'nothing';
  if (run.source === 'schedule') return 'a scheduled job';
  return { tasks: 'a task', research: 'research', ultrafast: 'a Fast run', normal: 'a chat' }[run.mode] || 'a run';
}

// ---------- chat history ----------

let chatTimer = null;
function chatInfo() {
  return { id: chat.id, title: chat.title, events: chat.events };
}
function saveChatSoon() {
  clearTimeout(chatTimer);
  chatTimer = setTimeout(saveChatNow, 800);
}
async function saveChatNow() {
  clearTimeout(chatTimer);
  if (!chat.events.length) return;
  chat.updatedAt = Date.now();
  await chatStore.put({ ...chat, messages: storableMessages(chat.messages) });
  await chrome.storage.local.set({ currentChat: chat.id });
}

async function switchChat(next) {
  await saveChatNow();
  chat = next;
  await chrome.storage.local.set({ currentChat: chat.id });
  broadcast({ type: 'chat', chat: chatInfo() });
}

/** remember + schedule_task for side-panel chats. Both only *propose* unless the user asked. */
const START_RESEARCH_TOOL = {
  name: 'start_research',
  description: 'Hand the question to HailBrowser Research: it searches the web, reads several sources in background tabs and writes a cited report in this chat. Use it for questions that need more than one or two pages.',
  inputSchema: { type: 'object', properties: {
    question: { type: 'string', description: 'The full research question, self-contained.' },
    depth: { type: 'string', enum: ['quick', 'standard', 'deep'], description: 'quick ~4 sources, standard ~6 (default), deep ~10.' },
  }, required: ['question'] },
};
const START_TASK_TOOL = {
  name: 'start_task',
  description: 'Hand a long job to HailBrowser Tasks: it plans subtasks, works through them in this browser, saves progress, and asks the user when it needs them. Use it for jobs of many steps across pages.',
  inputSchema: { type: 'object', properties: { goal: { type: 'string', description: 'The complete job, self-contained, including what result to report back.' } }, required: ['goal'] },
};

function chatTools(settings, goal, emit) {
  const extraTools = [START_RESEARCH_TOOL, START_TASK_TOOL, SCHEDULE_TOOL];
  if (settings.memory?.enabled !== false) extraTools.unshift(REMEMBER_TOOL);
  const onExtraTool = async ({ name, args = {} }) => {
    if (name === 'remember') {
      const fact = cleanFact(args.fact);
      if (!fact) return { text: 'Nothing to remember.', isError: true };
      const site = cleanSite(args.site);
      if (rememberIntent(goal)) {
        const r = await addFact(fact, { site, source: 'chat' });
        memoryFacts = r.memory.facts;
        broadcast({ type: 'memory', facts: memoryFacts });
        emit({ type: 'memory_saved', fact: r.fact.text, site: r.fact.site });
        return { text: r.duplicate ? 'That is already in memory.' : 'Saved to memory.' };
      }
      emit({ type: 'proposal', pid: uid('p'), kind: 'memory', data: { fact, site }, state: null });
      return { text: 'Suggested it to the user; it is saved only if they approve. Carry on without waiting.' };
    }
    if (name === 'start_research' || name === 'start_task') {
      const text = String(args.question || args.goal || '').trim();
      if (!text) return { text: 'Give the question or goal.', isError: true };
      return { text: name === 'start_research' ? 'Research started; the report appears in this chat.' : 'Task started; progress appears in this chat.', stop: name === 'start_research' ? 'research' : 'task' };
    }
    if (name === 'schedule_task') {
      let s;
      try { s = buildSchedule(args); } catch (e) { return { text: `Could not schedule that: ${e.message}`, isError: true }; }
      const data = { title: s.title, goal: s.goal, mode: s.mode, url: s.url, when: s.when };
      const first = new Date(s.nextRunAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      emit({ type: 'proposal', pid: uid('p'), kind: 'schedule', data, label: `${describeWhen(s.when)} · first run ${first}`, state: null });
      return { text: `Proposed "${s.title}" (${describeWhen(s.when)}, first run ${first}). The user confirms it in the panel.` };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  };
  return { extraTools, onExtraTool };
}

async function resolveProposal(pid, accept) {
  const e = chat.events.find((x) => x.type === 'proposal' && x.pid === pid);
  if (!e || e.state) return;
  try {
    if (accept && e.kind === 'memory') {
      const r = await addFact(e.data.fact, { site: e.data.site, source: 'chat' });
      memoryFacts = r.memory.facts;
      broadcast({ type: 'memory', facts: memoryFacts });
    } else if (accept && e.kind === 'schedule') {
      await saveScheduleDraft(e.data);
    }
    e.state = accept ? 'accepted' : 'dismissed';
  } catch (err) {
    e.error = err.message;
  }
  broadcast({ type: 'proposal_state', pid, state: e.state, error: e.error || null });
  saveChatSoon();
}

// ---------- bridge ----------

const bridge = new Bridge({
  onStatus(connected) {
    bridgeConnected = connected;
    broadcast(status());
  },
  onCall: handleExternalCall,
});

async function applySettings() {
  const s = await getSettings();
  bridge.configure(s.bridge);
  return s;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(applySettings);
chrome.storage.onChanged.addListener((changes) => { if (changes.settings) applySettings(); });
chrome.alarms.create('hail-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'hail-keepalive') bridge.ensure();
  else if (a.name.startsWith('sched:')) enqueue(a.name.slice(6));
});
applySettings();

// ---------- indicator ----------

// Who is driving right now ("Claude Code", "Chat"...), for the tab group and the panel.
let driver = 'HailBrowser';
groups.onChange((tabs) => broadcast({ type: 'controlled', tabs }));
page.onCurrentTab((tabId) => claimTab(tabId));

async function claimTab(tabId, who = driver) {
  if (tabId == null) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.pendingUrl || tab?.url || '';
  if (!tab || (page.isRestricted(url) && !url.startsWith('about:blank'))) return; // new agent tabs start blank
  const s = await getSettings();
  await groups.claim(tabId, who, { group: s.tools.groupTabs !== false });
}

const indicator = { tabId: null, timer: null };
async function pulseIndicator(tabId, label, holdMs = 2500) {
  if (tabId == null) return;
  claimTab(tabId);
  groups.setBusy(tabId);
  const s = await getSettings();
  if (!s.tools.showIndicator) {
    clearTimeout(indicator.timer);
    if (holdMs) indicator.timer = setTimeout(() => groups.setBusy(null), holdMs);
    return;
  }
  if (indicator.tabId !== null && indicator.tabId !== tabId) page.setIndicator(indicator.tabId, false);
  indicator.tabId = tabId;
  page.setIndicator(tabId, true, label);
  clearTimeout(indicator.timer);
  if (holdMs) indicator.timer = setTimeout(() => clearIndicator(), holdMs);
}
function clearIndicator() {
  clearTimeout(indicator.timer);
  groups.setBusy(null);
  if (indicator.tabId !== null) page.setIndicator(indicator.tabId, false);
  indicator.tabId = null;
}

// ---------- chat & fast runs ----------

async function startRun({ goal, mode, url, tabId, source, values, signal, who }) {
  await ready;
  if (run) throw new Error(`HailBrowser is already running ${describeRun()}. Stop it first.`);
  const settings = await getSettings();
  const controller = new AbortController();
  // An external agent that cancels its call (or times out) stops the run it started.
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  run = { controller, mode, source };
  driver = who || (mode === 'ultrafast' ? 'Fast' : 'Chat');
  broadcast(status());
  const inChat = source === 'panel';
  let handoff = null; // the chat agent passed the job to Research or Tasks
  const events = [];
  const emit = (event) => {
    events.push(event);
    if (inChat) { pushEvent(chat, event); saveChatSoon(); }
    broadcast({ type: 'event', source, event });
  };
  try {
    const tab = await page.resolveTab(tabId);
    page.setCurrentTab(tab.id);
    if (url) await page.navigate(tab.id, url);
    pulseIndicator(tab.id, mode === 'ultrafast' ? 'HailBrowser Ultrafast is working' : 'HailBrowser is working', 0);
    emit({ type: 'user', text: goal, mode });
    if (inChat && !chat.title) chat.title = chatTitle(goal);
    let result;
    if (mode === 'ultrafast') {
      result = await runUltrafast({ goal, values, tabId: tab.id, settings, signal: controller.signal, emit });
    } else {
      // External agents get no memory: it holds the user's personal facts.
      let system = NORMAL_SYSTEM;
      if (inChat) system += `\n\nResearch, long tasks, memory and schedules:${CHAT_HANDOFF_RULE}${settings.memory?.enabled !== false ? CHAT_MEMORY_RULE : ''}${CHAT_SCHEDULE_RULE}`;
      if (source === 'schedule') system += `\n\n${UNATTENDED_RULES}`;
      if (source !== 'mcp') system += memorySection(settings, tab.url);
      result = await runNormal({
        goal: withValues(goal, values), messages: inChat ? chat.messages : [], settings, signal: controller.signal, emit, tabId: tab.id, system,
        ...(inChat ? chatTools(settings, goal, emit) : {}),
      });
      emit({ type: 'finish', status: result.status, summary: null });
      if (inChat && (result.stopReason === 'research' || result.stopReason === 'task')) handoff = { kind: result.stopReason, args: result.stopArgs || {} };
    }
    return { ...result, events, tabId: tab.id };
  } catch (e) {
    const message = e?.name === 'AbortError' ? 'Stopped.' : e?.message || String(e);
    emit({ type: 'error', text: message });
    return { status: e?.name === 'AbortError' ? 'stopped' : 'error', summary: message, events };
  } finally {
    run = null;
    clearIndicator();
    broadcast(status());
    if (inChat) saveChatNow();
    if (handoff) {
      const { kind, args } = handoff;
      startInChat(kind, { goal: args.question || args.goal, mode, depth: args.depth, fromAgent: true })
        .catch((e) => broadcast({ type: 'error', text: e.message }));
    } else setTimeout(drainQueue, 0);
  }
}

// ---------- research & tasks inside the chat ----------

function chatEvent(e) {
  pushEvent(chat, e);
  broadcast({ type: 'event', source: 'panel', event: e });
  saveChatSoon();
}

/** Start Research or a long task as part of the current chat: the card appears inline. */
async function startInChat(kind, { goal, mode, depth, fromAgent = false }) {
  await ready;
  const text = String(goal || '').trim();
  if (!text) return;
  if (run) throw new Error(`HailBrowser is already running ${describeRun()}. Stop it first.`);
  if (!fromAgent) {
    chatEvent({ type: 'user', text, mode, use: kind });
    if (!chat.title) chat.title = chatTitle(text);
  }
  const chatId = chat.id;
  if (kind === 'research') {
    const settings = await getSettings();
    const r = newReport(text, depth || settings.research?.depth, { chatId, asked: fromAgent ? null : text });
    await saveReport(r);
    chatEvent({ type: 'report_ref', id: r.id });
    return startResearch({ id: r.id });
  }
  const t = newTask(text, mode, { chatId, asked: fromAgent ? null : text });
  await saveTask(t);
  chatEvent({ type: 'task_ref', id: t.id });
  return executeTask(t.id);
}

/** Put a finished research/task result into its chat's model context, so follow-up questions can use it. */
async function resultToChat(chatId, asked, answer) {
  if (!chatId || !answer) return;
  const target = chat.id === chatId ? chat : await chatStore.get(chatId);
  if (!target) return;
  if (asked) target.messages.push({ role: 'user', content: [{ type: 'text', text: asked }] });
  target.messages.push({ role: 'assistant', text: answer, toolCalls: [] });
  if (target === chat) await saveChatNow();
  else await chatStore.put({ ...target, messages: storableMessages(target.messages), updatedAt: Date.now() });
}

// ---------- research ----------

function saveReport(r) {
  broadcast({ type: 'report', report: r });
  return reportStore.put(r);
}

async function startResearch({ question, depth, id, source = 'panel', scheduleId = null }) {
  await ready;
  if (run) throw new Error(`HailBrowser is already running ${describeRun()}. Stop it first.`);
  const settings = await getSettings();
  const report = id ? await reportStore.get(id) : newReport(question, depth || settings.research?.depth, { scheduleId });
  if (!report) throw new Error('That report no longer exists.');
  if (!report.question) throw new Error('Ask a research question first.');
  const controller = new AbortController();
  run = { controller, mode: 'research', source, id: report.id };
  driver = 'Research';
  broadcast(status());
  try {
    report.error = null;
    await runResearch({ report, settings, signal: controller.signal, save: saveReport, onTab: (tabId) => claimTab(tabId, 'Research') });
  } catch (e) {
    const stopped = e?.name === 'AbortError';
    report.status = stopped ? 'stopped' : 'failed';
    report.error = stopped ? null : e?.message || String(e);
    report.log.push({ t: Date.now(), text: stopped ? 'Stopped.' : `Error: ${report.error}` });
    await saveReport(report);
  } finally {
    run = null;
    broadcast(status());
    setTimeout(drainQueue, 0);
  }
  if (report.status === 'done' && report.chatId && !report.inChat) {
    report.inChat = true;
    const sources = report.sources.filter((x) => x.n).sort((a, b) => a.n - b.n).map((x) => `[${x.n}] ${x.title} — ${x.url}`).join('\n');
    await resultToChat(report.chatId, report.asked, `Research report for "${report.question}":\n\n${report.answer}\n\nSources:\n${sources}`);
    await reportStore.put(report);
  }
  if (source !== 'schedule' && !ports.size && ['done', 'failed'].includes(report.status)) {
    notify(`report:${report.id}`, report.status === 'done' ? 'Research ready' : 'Research failed', report.question);
  }
  return report;
}

// ---------- schedules ----------

const queue = []; // [{id, manual}] waiting for HailBrowser to be free
let draining = false;

function broadcastSchedules() {
  broadcast({ type: 'schedules', schedules: [...schedules.values()] });
}

function setAlarm(s) {
  const name = `sched:${s.id}`;
  if (s.enabled && s.nextRunAt) chrome.alarms.create(name, { when: Math.max(s.nextRunAt, Date.now() + 1000) });
  else chrome.alarms.clear(name);
}

async function saveSchedule(s) {
  schedules.set(s.id, s);
  await scheduleStore.put(s);
  setAlarm(s);
  broadcastSchedules();
  return s;
}

async function saveScheduleDraft(draft) {
  await ready;
  const existing = draft.id ? schedules.get(draft.id) : null;
  const s = buildSchedule(draft, Date.now(), existing);
  s.id ||= uid('s');
  return saveSchedule(s);
}

async function recordRun(entry) {
  runs = [entry, ...runs.filter((r) => r.id !== entry.id)].slice(0, MAX_RUNS);
  await chrome.storage.local.set({ scheduleRuns: runs });
  broadcast({ type: 'runs', runs });
}

/** Re-create alarms (Chrome may drop them on restart) and catch up on runs missed while it was closed. */
async function syncSchedules() {
  await ready;
  const alarms = await chrome.alarms.getAll();
  for (const a of alarms) if (a.name.startsWith('sched:') && !schedules.has(a.name.slice(6))) chrome.alarms.clear(a.name);
  for (const s of schedules.values()) {
    if (s.enabled && s.nextRunAt && s.nextRunAt <= Date.now()) enqueue(s.id);
    else setAlarm(s);
  }
}

function enqueue(id, manual = false) {
  if (!queue.some((q) => q.id === id)) queue.push({ id, manual, at: Date.now() });
  setTimeout(drainQueue, 0);
}

async function drainQueue() {
  if (run || draining || !queue.length) return;
  draining = true;
  const job = queue.shift();
  try {
    await runSchedule(job);
  } catch (e) {
    console.warn('HailBrowser: scheduled run failed', e);
  } finally {
    draining = false;
    if (queue.length) setTimeout(drainQueue, 300);
  }
}

async function openJobTab(url) {
  const tab = await chrome.tabs.create({ url: url || 'about:blank', active: false });
  if (url) await page.waitForLoad(tab.id, 20000).catch(() => {});
  return tab;
}

const firstLine = (text) => String(text || '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';

async function runSchedule({ id, manual, at }) {
  await ready;
  const s = schedules.get(id);
  if (!s || (!manual && (!s.enabled || !s.nextRunAt || s.nextRunAt > Date.now() + 1000))) return;
  const firedAt = Date.now();
  // Move to the next time first, so a crash mid-run can never repeat a run in a loop.
  if (!manual) {
    s.nextRunAt = nextRun(s.when, firedAt, s.nextRunAt);
    if (s.nextRunAt == null) s.enabled = false;
  }
  const entry = { id: uid('x'), scheduleId: s.id, title: s.title, mode: s.mode, at: firedAt, status: 'running', summary: '', manual: !!manual, delayedMs: at ? firedAt - at : 0 };
  s.lastRun = entry;
  await saveSchedule(s);
  await recordRun(entry);
  const prevTab = page.currentTab();
  let tab = null;
  try {
    if (s.mode === 'research') {
      const r = await startResearch({ question: s.goal, source: 'schedule', scheduleId: s.id });
      entry.reportId = r.id;
      entry.status = r.status === 'done' ? 'done' : r.status;
      entry.summary = r.status === 'done' ? firstLine(r.answer) : r.error || r.status;
    } else if (s.mode === 'tasks') {
      tab = await openJobTab(s.url);
      page.setCurrentTab(tab.id);
      const t = newTask(s.goal, 'normal', { scheduleId: s.id, title: s.title });
      await saveTask(t);
      entry.taskId = t.id;
      await executeTask(t.id, { unattended: true });
      const done = tasks.get(t.id);
      entry.status = done.status === 'waiting_user' ? 'needs_you' : done.status;
      entry.summary = done.status === 'waiting_user' ? done.question : done.summary || done.error || '';
    } else {
      tab = await openJobTab(s.url);
      const r = await startRun({ goal: s.goal, mode: s.mode, tabId: tab.id, source: 'schedule', who: 'Scheduled' });
      entry.status = r.status;
      entry.summary = r.summary || '';
    }
  } catch (e) {
    entry.status = 'failed';
    entry.summary = e?.message || String(e);
  } finally {
    if (prevTab != null && prevTab !== tab?.id) page.setCurrentTab(prevTab, { quiet: true });
  }
  // Successful jobs clean up their tab; anything else is left open to look at.
  if (tab && entry.status === 'done') await chrome.tabs.remove(tab.id).catch(() => {});
  else if (tab) entry.tabId = tab.id;
  entry.finishedAt = Date.now();
  await recordRun(entry);
  const cur = schedules.get(s.id);
  if (cur) { cur.lastRun = entry; await saveSchedule(cur); }
  const head = { done: '✓', needs_you: 'Needs you', blocked: 'Blocked', stopped: 'Stopped' }[entry.status] || 'Failed';
  notify(`run:${entry.id}`, `${head}: ${s.title}`, entry.summary || describeWhen(s.when));
}

async function handleScheduleMessage(msg, port) {
  await ready;
  const reply = (m) => port?.postMessage(m);
  try {
    if (msg.type === 'schedule_save') {
      const s = await saveScheduleDraft(msg.draft || {});
      reply({ type: 'schedule_saved', id: s.id });
    } else if (msg.type === 'schedule_toggle') {
      const s = schedules.get(msg.id);
      if (!s) return;
      s.enabled = !!msg.enabled;
      if (s.enabled) {
        s.nextRunAt = nextRun(s.when, Date.now());
        if (!s.nextRunAt) throw new Error('That one-off time has passed. Edit it to pick a new time.');
      }
      await saveSchedule(s);
    } else if (msg.type === 'schedule_delete') {
      schedules.delete(msg.id);
      await scheduleStore.remove(msg.id);
      chrome.alarms.clear(`sched:${msg.id}`);
      broadcastSchedules();
    } else if (msg.type === 'schedule_run') {
      if (!schedules.has(msg.id)) return;
      enqueue(msg.id, true);
      if (run) reply({ type: 'schedule_error', error: `Queued: it starts when ${describeRun()} finishes.` });
    } else if (msg.type === 'runs_clear') {
      runs = runs.filter((r) => r.status === 'running');
      await chrome.storage.local.set({ scheduleRuns: runs });
      broadcast({ type: 'runs', runs });
    }
  } catch (e) {
    reply({ type: 'schedule_error', error: e.message });
  }
}

syncSchedules();

// ---------- external agents (MCP) ----------

const READ_ONLY = new Set(['tabs_context', 'read_page', 'find', 'get_page_text', 'screenshot', 'wait']);

async function handleExternalCall(tool, args, client, signal) {
  const settings = await getSettings();
  if (run && run.source !== 'mcp' && !['tabs_context', 'stop_task'].includes(tool)) {
    const what = run.source === 'schedule' ? 'a scheduled HailBrowser job' : `${describeRun()} the user started in the side panel`;
    return { isError: true, content: [{ type: 'text', text: `The browser is busy with ${what}. Try again when it finishes.` }] };
  }
  const entry = { tool, args: summarizeArgs(args), client: client || 'mcp', at: Date.now() };
  activity.push(entry);
  if (activity.length > 50) activity.shift();
  broadcast({ type: 'external', entry });

  if (!run) driver = groups.agentName(client);
  // Tab management acts on another tab than the current one; those tabs are claimed when selected.
  if (!READ_ONLY.has(tool) && !['run_task', 'stop_task', 'tabs_create', 'tabs_select', 'tabs_close'].includes(tool)) {
    const tab = await page.resolveTab(args.tabId).catch(() => null);
    if (tab && !page.isRestricted(tab.url)) pulseIndicator(tab.id, `${groups.agentName(client)} is using this tab`);
  }
  const started = Date.now();
  const result = await executeTool(tool, args, {
    settings,
    signal,
    stopTask: async () => {
      if (!run) return 'Nothing is running.';
      if (run.source !== 'mcp') return `The user started ${describeRun()} in HailBrowser; only they can stop it.`;
      run.controller.abort();
      return `Stopping the ${run.mode} run_task.`;
    },
    runTask: async ({ goal, mode, url, tabId, values }) => {
      if (typeof goal !== 'string' || !goal.trim()) throw new Error('run_task needs a goal.');
      if (mode != null && !['normal', 'ultrafast'].includes(mode)) throw new Error('mode must be "normal" or "ultrafast".');
      const r = await startRun({ goal, mode: mode || (settings.mode === 'ultrafast' ? 'ultrafast' : 'normal'), url, tabId, source: 'mcp', values: cleanValues(values), signal, who: groups.agentName(client) });
      const steps = r.history?.map((h) => `${h.step}. ${h.operation || h.kind} ${h.action}${h.text ? ` = ${JSON.stringify(h.text)}` : ''}`).join('\n');
      return { isError: r.status === 'error', content: [{ type: 'text', text: `${r.summary || r.status}${steps ? `\n\nSteps:\n${steps}` : ''}` }] };
    },
  });
  broadcast({ type: 'external_result', entry, isError: !!result.isError, ms: Date.now() - started });
  return result;
}

/** Accept {name: string|number} only, at most 50 entries. */
function cleanValues(values) {
  if (!values || typeof values !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(values).slice(0, 50)) {
    if (k.trim() && (typeof v === 'string' || typeof v === 'number')) out[k.trim()] = String(v);
  }
  return Object.keys(out).length ? out : null;
}

function withValues(goal, values) {
  return values ? `${goal}\n\nValues to use: ${JSON.stringify(values)}` : goal;
}

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) out[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
  return out;
}

// ---------- side panel ----------

async function sendInitial(port) {
  port.postMessage(status());
  port.postMessage({ type: 'activity', entries: activity });
  groups.list().then((tabs) => port.postMessage({ type: 'controlled', tabs }));
  await ready;
  port.postMessage({ type: 'tasks', tasks: [...tasks.values()] });
  port.postMessage({ type: 'chat', chat: chatInfo() });
  port.postMessage({ type: 'memory', facts: memoryFacts });
  port.postMessage({ type: 'schedules', schedules: [...schedules.values()] });
  port.postMessage({ type: 'runs', runs });
  const reports = await reportStore.index();
  port.postMessage({ type: 'reports', items: reports });
  // Reports shown in the open chat (the panel asks for others when it needs them).
  const ids = [...new Set(chat.events.filter((e) => e.type === 'report_ref').map((e) => e.id))].slice(-20);
  if (run?.mode === 'research' && !ids.includes(run.id)) ids.push(run.id);
  for (const id of ids) port.postMessage({ type: 'report', report: await reportStore.get(id) });
}

async function handlePanelMessage(msg, port) {
  await ready;
  const t = msg.type;
  if (t.startsWith('task_')) return handleTaskMessage(msg, port);
  if (t.startsWith('schedule_') || t === 'runs_clear') return handleScheduleMessage(msg, port);
  if (t === 'run') {
    if (msg.use === 'research' || msg.use === 'task') return startInChat(msg.use, { goal: msg.goal, mode: msg.mode, depth: msg.depth });
    return startRun({ goal: msg.goal, mode: msg.mode, source: 'panel' });
  }
  if (t === 'stop') return run?.controller.abort();
  if (t === 'release') return groups.release(msg.tabId);
  if (t === 'reconnect') {
    bridge.close();
    await applySettings();
    return bridge.ensure();
  }
  // chats
  const chatBusy = run?.source === 'panel' && (run.mode === 'normal' || run.mode === 'ultrafast');
  if (t === 'reset') { if (!chatBusy) await switchChat(newChat()); return; }
  if (t === 'chat_list') return port.postMessage({ type: 'chat_list', items: await chatStore.index() });
  if (t === 'chat_get') return port.postMessage({ type: 'chat_full', chat: msg.id === chat.id ? chat : await chatStore.get(msg.id) });
  if (t === 'chat_open') {
    if (chatBusy) throw new Error('Wait for the current chat run to finish.');
    const c = await chatStore.get(msg.id);
    if (c) await switchChat(c);
    return;
  }
  if (t === 'chat_delete') {
    await chatStore.remove(msg.id);
    if (msg.id === chat.id) { chat = newChat(); broadcast({ type: 'chat', chat: chatInfo() }); }
    return port.postMessage({ type: 'chat_list', items: await chatStore.index() });
  }
  if (t === 'proposal') return resolveProposal(msg.pid, !!msg.accept);
  // memory
  if (t.startsWith('memory_')) {
    if (t === 'memory_add') memoryFacts = (await addFact(msg.text, { site: msg.site, source: 'user' })).memory.facts;
    else if (t === 'memory_update') memoryFacts = (await updateFact(msg.id, msg.text, msg.site)).facts;
    else if (t === 'memory_delete') memoryFacts = (await removeFact(msg.id)).facts;
    else if (t === 'memory_clear') memoryFacts = (await clearMemory()).facts;
    return broadcast({ type: 'memory', facts: memoryFacts });
  }
  // research
  if (t === 'research_start') return startResearch({ question: msg.question, depth: msg.depth });
  if (t === 'research_resume') return startResearch({ id: msg.id });
  if (t === 'reports_list') return port.postMessage({ type: 'reports', items: await reportStore.index() });
  if (t === 'report_get') {
    for (const id of [].concat(msg.ids || msg.id || []).slice(0, 40)) port.postMessage({ type: 'report', report: await reportStore.get(id) });
    return;
  }
  if (t === 'report_delete') {
    if (run?.mode === 'research' && run.id === msg.id) throw new Error('Stop the research first.');
    await reportStore.remove(msg.id);
    return broadcast({ type: 'reports', items: await reportStore.index(), removed: msg.id });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  ports.add(port);
  sendInitial(port).catch(() => {});
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    handlePanelMessage(msg, port).catch((e) => {
      try { port.postMessage({ type: 'error', text: e?.message || String(e), about: msg.type }); } catch {}
    });
  });
});

// For tests and debugging from the service worker console.
globalThis.hail = {
  runSchedule: (id) => enqueue(id, true),
  saveSchedule: (draft) => saveScheduleDraft(draft),
  stores: { chatStore, taskStore, reportStore },
  state: () => ({ run: run && { mode: run.mode, source: run.source, id: run.id }, queue, tasks: [...tasks.keys()], schedules: [...schedules.keys()] }),
};
