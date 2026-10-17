// Service worker: wires the side panel, the MCP bridge and the agents (chat, fast, tasks) together.
import { Bridge } from './bridge.js';
import { getSettings } from './settings.js';
import { executeTool } from './tools/execute.js';
import { runNormal } from './agent/normal.js';
import { runUltrafast } from './agent/ultrafast.js';
import { applyAnswer, newTask, runTask } from './agent/tasks.js';
import * as page from './browser/page.js';

const ports = new Set();
let bridgeConnected = false;
let run = null; // {controller, mode, source}
let conversation = []; // normal-mode chat history for the side panel
const activity = []; // recent external (MCP) tool calls
let task = null; // the long-horizon task (persisted in chrome.storage.local)

// A task that was running when the worker stopped is paused, never resumed silently.
const taskLoaded = chrome.storage.local.get('task').then(({ task: saved }) => {
  if (saved && ['running', 'planning'].includes(saved.status)) {
    saved.status = 'paused';
    saved.log.push({ t: Date.now(), text: 'Paused because Chrome restarted the extension. Press Resume to continue.' });
    chrome.storage.local.set({ task: saved });
  }
  task = saved || null;
});

function saveTask(t) {
  broadcast({ type: 'task', task: t });
  return chrome.storage.local.set({ task: t });
}

async function executeTask() {
  if (run) throw new Error(`HailBrowser is already running a ${run.mode} task. Stop it first.`);
  const settings = await getSettings();
  const controller = new AbortController();
  run = { controller, mode: 'tasks', source: 'panel' };
  broadcast(status());
  const emit = (event) => broadcast({ type: 'event', source: 'task', event });
  try {
    const tab = await page.resolveTab();
    pulseIndicator(tab.id, 'HailBrowser is working on your task', 0);
    await runTask({ task, settings, signal: controller.signal, emit, save: saveTask });
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
    if (run?.stopping && task) { task.status = 'stopped'; await saveTask(task); }
    run = null;
    clearIndicator();
    broadcast(status());
  }
}

async function handleTaskMessage(msg) {
  await taskLoaded;
  if (msg.type === 'task_start') {
    if (run) throw new Error('Something is already running. Stop it first.');
    task = newTask(msg.goal, msg.mode);
    await saveTask(task);
    return executeTask();
  }
  if (!task) return;
  if (msg.type === 'task_pause' && run?.mode === 'tasks') run.controller.abort();
  else if (msg.type === 'task_stop') {
    if (run?.mode === 'tasks') { run.stopping = true; run.controller.abort(); } else { task.status = 'stopped'; await saveTask(task); }
  } else if (msg.type === 'task_resume' && !run && ['paused', 'failed'].includes(task.status)) {
    return executeTask();
  } else if (msg.type === 'task_answer' && !run && task.status === 'waiting_user') {
    if (applyAnswer(task, msg.text)) { await saveTask(task); return executeTask(); }
  } else if (msg.type === 'task_clear' && !(run?.mode === 'tasks')) {
    task = null;
    await chrome.storage.local.remove('task');
    broadcast({ type: 'task', task: null });
  }
}

function broadcast(msg) {
  for (const p of ports) {
    try { p.postMessage(msg); } catch { ports.delete(p); }
  }
}

function status() {
  return { type: 'status', bridge: bridgeConnected, running: run ? { mode: run.mode, source: run.source } : null, port: bridge.port };
}

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
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'hail-keepalive') bridge.ensure(); });
applySettings();

// ---------- indicator ----------

const indicator = { tabId: null, timer: null };
async function pulseIndicator(tabId, label, holdMs = 2500) {
  const s = await getSettings();
  if (!s.tools.showIndicator || tabId == null) return;
  if (indicator.tabId !== null && indicator.tabId !== tabId) page.setIndicator(indicator.tabId, false);
  indicator.tabId = tabId;
  page.setIndicator(tabId, true, label);
  clearTimeout(indicator.timer);
  if (holdMs) indicator.timer = setTimeout(() => clearIndicator(), holdMs);
}
function clearIndicator() {
  clearTimeout(indicator.timer);
  if (indicator.tabId !== null) page.setIndicator(indicator.tabId, false);
  indicator.tabId = null;
}

// ---------- runs ----------

async function startRun({ goal, mode, url, tabId, source, values, signal }) {
  if (run) throw new Error(`HailBrowser is already running a ${run.mode} task. Stop it first.`);
  const settings = await getSettings();
  const controller = new AbortController();
  // An external agent that cancels its call (or times out) stops the run it started.
  signal?.addEventListener('abort', () => controller.abort(), { once: true });
  run = { controller, mode, source };
  broadcast(status());
  const events = [];
  const emit = (event) => {
    events.push(event);
    broadcast({ type: 'event', source, event });
  };
  try {
    const tab = await page.resolveTab(tabId);
    page.setCurrentTab(tab.id);
    if (url) await page.navigate(tab.id, url);
    pulseIndicator(tab.id, mode === 'ultrafast' ? 'HailBrowser Ultrafast is working' : 'HailBrowser is working', 0);
    if (source === 'mcp') emit({ type: 'user', text: goal, mode });
    const result = mode === 'ultrafast'
      ? await runUltrafast({ goal, values, tabId: tab.id, settings, signal: controller.signal, emit })
      : await runNormal({ goal: withValues(goal, values), messages: source === 'panel' ? conversation : [], settings, signal: controller.signal, emit, tabId: tab.id });
    if (mode === 'normal') emit({ type: 'finish', status: result.status, summary: null });
    return { ...result, events };
  } catch (e) {
    const message = e?.name === 'AbortError' ? 'Stopped.' : e?.message || String(e);
    emit({ type: 'error', text: message });
    return { status: e?.name === 'AbortError' ? 'stopped' : 'error', summary: message, events };
  } finally {
    run = null;
    clearIndicator();
    broadcast(status());
  }
}

// ---------- external agents (MCP) ----------

const READ_ONLY = new Set(['tabs_context', 'read_page', 'find', 'get_page_text', 'screenshot', 'wait']);

async function handleExternalCall(tool, args, client, signal) {
  const settings = await getSettings();
  if (run && run.source === 'panel' && !['tabs_context', 'stop_task'].includes(tool)) {
    return { isError: true, content: [{ type: 'text', text: 'The user is running a HailBrowser task in the side panel. Try again when it finishes.' }] };
  }
  const entry = { tool, args: summarizeArgs(args), client: client || 'mcp', at: Date.now() };
  activity.push(entry);
  if (activity.length > 50) activity.shift();
  broadcast({ type: 'external', entry });

  if (!READ_ONLY.has(tool) && !['run_task', 'stop_task'].includes(tool)) {
    const tab = await page.resolveTab(args.tabId).catch(() => null);
    if (tab && !page.isRestricted(tab.url)) pulseIndicator(tab.id, `${client || 'Agent'} is using this tab`);
  }
  const started = Date.now();
  const result = await executeTool(tool, args, {
    settings,
    signal,
    stopTask: async () => {
      if (!run) return 'Nothing is running.';
      if (run.source !== 'mcp') return `The user started this ${run.mode} task in the side panel; only they can stop it.`;
      run.controller.abort();
      return `Stopping the ${run.mode} run_task.`;
    },
    runTask: async ({ goal, mode, url, tabId, values }) => {
      if (typeof goal !== 'string' || !goal.trim()) throw new Error('run_task needs a goal.');
      if (mode != null && !['normal', 'ultrafast'].includes(mode)) throw new Error('mode must be "normal" or "ultrafast".');
      const r = await startRun({ goal, mode: mode || (settings.mode === 'ultrafast' ? 'ultrafast' : 'normal'), url, tabId, source: 'mcp', values: cleanValues(values), signal });
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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;
  ports.add(port);
  port.postMessage(status());
  port.postMessage({ type: 'activity', entries: activity });
  taskLoaded.then(() => port.postMessage({ type: 'task', task }));
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (msg) => {
    if (msg.type.startsWith('task_')) {
      handleTaskMessage(msg).catch((e) => port.postMessage({ type: 'event', source: 'task', event: { type: 'error', text: e.message } }));
    } else if (msg.type === 'run') {
      startRun({ goal: msg.goal, mode: msg.mode, source: 'panel' }).catch((e) => broadcast({ type: 'event', source: 'panel', event: { type: 'error', text: e.message } }));
    } else if (msg.type === 'stop') {
      run?.controller.abort();
    } else if (msg.type === 'reset') {
      if (!run) conversation = [];
      port.postMessage({ type: 'reset_done' });
    } else if (msg.type === 'reconnect') {
      bridge.close();
      await applySettings();
      bridge.ensure();
    }
  });
});
