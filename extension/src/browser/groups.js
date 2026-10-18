// Keeps every tab HailBrowser controls in one "HailBrowser" tab group per window, so it's
// always visible in the tab strip which tabs (and which window) an agent is driving.
// Tabs the user already put in their own group are tracked but never moved.

const TITLE = 'HailBrowser';
const BUSY_TITLE = '⚡ HailBrowser';
const COLOR = 'purple';

const controlled = new Map(); // tabId -> { who, at }
let groups = {}; // windowId -> our groupId
let busy = null; // tabId being acted on right now
let listener = () => {};
const ready = globalThis.chrome?.storage?.session
  ? chrome.storage.session.get('hailGroups').then(({ hailGroups }) => {
    for (const [id, v] of hailGroups?.controlled || []) controlled.set(id, v);
    groups = hailGroups?.groups || {};
  }).catch(() => {})
  : Promise.resolve();

const AGENT_NAMES = { 'claude-code': 'Claude Code', opencode: 'OpenCode', cursor: 'Cursor', codex: 'Codex', windsurf: 'Windsurf', 'gemini-cli': 'Gemini CLI' };

/** "claude-code" -> "Claude Code"; unknown names are title-cased. */
export function agentName(client) {
  if (!client) return 'Agent';
  const key = String(client).toLowerCase();
  for (const [k, v] of Object.entries(AGENT_NAMES)) if (key.startsWith(k)) return v;
  return String(client).replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function onChange(fn) {
  listener = fn;
}

function save() {
  chrome.storage.session?.set({ hailGroups: { controlled: [...controlled], groups } }).catch(() => {});
  list().then((tabs) => listener(tabs)).catch(() => {});
}

async function retry(fn) {
  // Chrome refuses tab edits while the user is dragging a tab; try again shortly.
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 3 || !/user may be dragging|cannot be edited right now/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function ourGroup(windowId) {
  const id = groups[windowId];
  if (id == null) return null;
  const g = await chrome.tabGroups.get(id).catch(() => null);
  if (!g) delete groups[windowId];
  return g;
}

/** Mark a tab as controlled by `who` and put it in the window's HailBrowser group. */
export async function claim(tabId, who, { group = true } = {}) {
  await ready;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  controlled.set(tabId, { who, at: Date.now() });
  if (group && chrome.tabGroups && tab.groupId === -1 && !tab.pinned) {
    try {
      const g = await ourGroup(tab.windowId);
      if (g) {
        await retry(() => chrome.tabs.group({ groupId: g.id, tabIds: tabId }));
      } else {
        const id = await retry(() => chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: tab.windowId } }));
        groups[tab.windowId] = id;
        await chrome.tabGroups.update(id, { title: busy != null ? BUSY_TITLE : TITLE, color: COLOR, collapsed: false });
      }
    } catch { /* grouping is cosmetic: never fail the action over it */ }
  }
  save();
}

/** Show which tab is being acted on: the group title gets a ⚡ while work is happening. */
export async function setBusy(tabId) {
  await ready;
  if (busy === tabId) return;
  busy = tabId;
  for (const id of Object.values(groups)) chrome.tabGroups?.update(id, { title: TITLE }).catch(() => {});
  if (tabId != null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const g = tab && groups[tab.windowId];
    if (g != null && tab.groupId === g) chrome.tabGroups.update(g, { title: BUSY_TITLE }).catch(() => {});
  }
  save();
}

/** Stop controlling one tab (or all): take it out of our group, leave the tab open. */
export async function release(tabId) {
  await ready;
  const ids = tabId == null ? [...controlled.keys()] : [tabId];
  for (const id of ids) {
    controlled.delete(id);
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && Object.values(groups).includes(tab.groupId)) await retry(() => chrome.tabs.ungroup(id)).catch(() => {});
  }
  if (tabId == null || busy === tabId) busy = null;
  save();
}

/** Controlled tabs for the side panel, with window labels. */
export async function list() {
  await ready;
  const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])).map((w) => w.id).sort((a, b) => a - b);
  const out = [];
  for (const [id, v] of controlled) {
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab) { controlled.delete(id); continue; }
    out.push({
      id, who: v.who, at: v.at, busy: busy === id, title: tab.title || tab.pendingUrl || tab.url || 'New tab', url: tab.url || tab.pendingUrl || '',
      favIconUrl: tab.favIconUrl || '', windowId: tab.windowId, window: windows.indexOf(tab.windowId) + 1, windows: windows.length,
      grouped: tab.groupId !== -1 && tab.groupId === groups[tab.windowId],
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

if (globalThis.chrome?.tabs) {
  chrome.tabs.onRemoved.addListener((id) => { if (controlled.delete(id)) save(); });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (!controlled.has(id)) return;
    if ('groupId' in change) {
      // The user dragged the tab out of our group: treat that as releasing it.
      ready.then(async () => {
        const tab = await chrome.tabs.get(id).catch(() => null);
        if (tab && change.groupId === -1 && groups[tab.windowId] != null) controlled.delete(id);
        save();
      });
    } else if (change.title || change.favIconUrl || change.url) save();
  });
  chrome.tabGroups?.onRemoved.addListener((g) => {
    for (const [w, id] of Object.entries(groups)) if (id === g.id) delete groups[w];
    save();
  });
}
