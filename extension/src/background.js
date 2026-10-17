// Service worker: wires the side panel, the MCP bridge and the two agents together.
import { Bridge } from './bridge.js';
import { getSettings } from './settings.js';
import { executeTool } from './tools/execute.js';
import { runNormal } from './agent/normal.js';
import { runUltrafast } from './agent/ultrafast.js';
import * as page from './browser/page.js';

const ports = new Set();
let bridgeConnected = false;
let run = null; // {controller, mode, source}
let conversation = []; // normal-mode chat history for the side panel
const activity = []; // recent external (MCP) tool calls

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

async function startRun({ goal, mode, url, tabId, source, values }) {
  if (run) throw new Error(`HailBrowser is already running a ${run.mode} task. Stop it first.`);
  const settings = await getSettings();
  const controller = new AbortController();
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

async function handleExternalCall(tool, args, client) {
  const settings = await getSettings();
  if (run && run.source === 'panel' && tool !== 'tabs_context') {
    return { isError: true, content: [{ type: 'text', text: 'The user is running a HailBrowser task in the side panel. Try again when it finishes.' }] };
  }
  const entry = { tool, args: summarizeArgs(args), client: client || 'mcp', at: Date.now() };
  activity.push(entry);
  if (activity.length > 50) activity.shift();
  broadcast({ type: 'external', entry });

  if (!READ_ONLY.has(tool) && tool !== 'run_task') {
    const tab = await page.resolveTab(args.tabId).catch(() => null);
    if (tab && !page.isRestricted(tab.url)) pulseIndicator(tab.id, `${client || 'Agent'} is using this tab`);
  }
  const started = Date.now();
  const result = await executeTool(tool, args, {
    settings,
    runTask: async ({ goal, mode, url, tabId, values }) => {
      const r = await startRun({ goal, mode: mode || settings.mode, url, tabId, source: 'mcp', values: cleanValues(values) });
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
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'run') {
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
