import { DEFAULTS, PROVIDERS, getSettings, saveSettings } from '../src/settings.js';

const $ = (sel) => document.querySelector(sel);
const feed = $('#feed');
const input = $('#input');
let settings = await getSettings();
let running = null;
let port;
let thinkingEl = null;
const pendingTools = []; // step elements awaiting tool_result, in order
let lastDecision = null;

// ---------- connection to the service worker ----------

function connect() {
  port = chrome.runtime.connect({ name: 'sidepanel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}
connect();

function onMessage(msg) {
  if (msg.type === 'status') return renderStatus(msg);
  if (msg.type === 'event') return renderEvent(msg.event, msg.source);
  if (msg.type === 'external') return renderExternal(msg.entry);
  if (msg.type === 'external_result') return finishExternal(msg);
  if (msg.type === 'reset_done') {
    feed.querySelectorAll(':scope > :not(#empty)').forEach((n) => n.remove());
    $('#empty').hidden = false;
  }
}

function renderStatus({ bridge, running: r, port: p }) {
  running = r;
  const pill = $('#bridge');
  pill.classList.toggle('on', bridge);
  $('#bridge-label').textContent = bridge ? 'MCP connected' : settings.bridge.enabled ? 'MCP waiting' : 'MCP off';
  pill.title = bridge
    ? `Connected to hailbrowser-mcp on 127.0.0.1:${p}. Claude Code, OpenCode and other agents can use this browser.`
    : 'Start an MCP client with hailbrowser-mcp configured (see Settings) to connect. Click to retry.';
  $('#send').hidden = !!r;
  $('#stop').hidden = !r;
  if (!r) clearThinking();
}

// ---------- feed rendering ----------

function add(el) {
  $('#empty').hidden = true;
  feed.appendChild(el);
  feed.scrollTop = feed.scrollHeight;
  return el;
}

function h(tag, cls, html) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html != null) el.innerHTML = html;
  return el;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function markdown(src) {
  const blocks = String(src).split(/```/);
  return blocks.map((block, i) => {
    if (i % 2) return `<pre><code>${esc(block.replace(/^\w*\n/, ''))}</code></pre>`;
    return block.trim().split(/\n{2,}/).map((para) => {
      const lines = para.split('\n');
      const inline = (t) => esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      if (lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''))}</li>`).join('')}</ul>`;
      }
      return `<p>${lines.map(inline).join('<br>')}</p>`;
    }).join('');
  }).join('');
}

function step(icon, what, arg, meta, cls = '') {
  const el = h('div', `step ${cls}`);
  el.innerHTML = `<span class="ico">${icon}</span><div class="body"><span class="what">${what}</span> <span class="arg">${arg || ''}</span></div><span class="meta">${meta || ''}</span>`;
  return add(el);
}

function showThinking() {
  clearThinking();
  thinkingEl = add(h('div', 'typing', '<i></i><i></i><i></i>'));
}
function clearThinking() {
  thinkingEl?.remove();
  thinkingEl = null;
}

const ms = (n) => (n == null ? '' : n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`);

function argSummary(name, args) {
  if (!args) return '';
  if (args.ref) return esc(args.ref + (args.text != null ? ` ← "${args.text}"` : args.option ? ` → ${args.option}` : ''));
  if (args.url) return esc(args.url);
  if (args.text != null) return esc(`"${args.text}"`);
  if (args.keys) return esc(args.keys);
  if (args.query) return esc(`"${args.query}"`);
  if (args.direction) return esc(args.direction);
  if (args.x != null) return esc(`(${args.x}, ${args.y})`);
  if (args.goal) return esc(args.goal);
  if (args.code) return esc(args.code.slice(0, 80));
  return '';
}

function renderEvent(e, source) {
  if (e.type !== 'thinking') clearThinking();
  switch (e.type) {
    case 'user': {
      const el = add(h('div', 'msg user'));
      el.innerHTML = `<span class="tag">${source === 'mcp' ? 'From external agent' : ''} · ${e.mode === 'ultrafast' ? '⚡ Ultrafast' : 'Normal'}</span>${esc(e.text)}`;
      break;
    }
    case 'thinking': showThinking(); break;
    case 'assistant': add(h('div', 'msg assistant', markdown(e.text))); break;
    case 'tool': pendingTools.push(step('⟳', esc(e.name), argSummary(e.name, e.args), '', 'pending')); break;
    case 'tool_result': {
      const el = pendingTools.shift();
      if (!el) break;
      el.classList.remove('pending');
      if (e.isError) el.classList.add('err');
      el.querySelector('.ico').textContent = e.isError ? '✕' : '✓';
      el.querySelector('.meta').textContent = ms(e.latencyMs);
      if (e.text || e.image) {
        const d = h('details');
        d.innerHTML = `<summary>${e.isError ? 'error' : 'result'}</summary>${e.text ? `<pre>${esc(e.text)}</pre>` : ''}`;
        if (e.image) {
          const img = new Image();
          img.src = `data:${e.image.mimeType};base64,${e.image.data}`;
          d.appendChild(img);
        }
        el.querySelector('.body').appendChild(d);
        if (e.isError) d.open = true;
      }
      break;
    }
    case 'status': step('·', '', esc(e.text), '', 'muted'); break;
    case 'decision': {
      const conf = e.confidence != null ? ` ${Math.round(e.confidence * 100)}%` : '';
      const cls = e.operation === 'DONE' ? 'done' : e.operation === 'BLOCKED' ? 'blocked' : '';
      lastDecision = step('⚡', `<span class="badge ${cls}">${esc(e.operation)}</span>`, esc(e.label) + (e.text ? esc(` ← "${e.text}"`) : '') + (e.reason ? ` <span class="muted">— ${esc(e.reason)}</span>` : ''), `${ms(e.latencyMs)}${conf}`);
      break;
    }
    case 'text': step('✎', 'text', esc(`"${e.text}"`), `${ms(e.latencyMs)}`, 'muted'); break;
    case 'action': {
      const el = lastDecision;
      if (el) el.querySelector('.meta').textContent += ` · ${ms(e.elapsedMs)}${e.page_changed ? '' : ' · no change'}`;
      break;
    }
    case 'stale': step('↻', 'page changed', 're-observing', '', 'muted'); break;
    case 'finish': if (e.summary) add(h('div', 'card', esc(e.summary))); break;
    case 'error': add(h('div', 'card error', esc(e.text))); break;
  }
  feed.scrollTop = feed.scrollHeight;
}

const externalSteps = [];
function renderExternal(entry) {
  if (entry.tool === 'run_task') return; // its own events are rendered as a task
  externalSteps.push(step('⟳', `<span class="badge">MCP</span>${esc(entry.tool)}`, argSummary(entry.tool, entry.args), '', 'ext pending'));
}
function finishExternal({ entry, isError, ms: took }) {
  if (entry.tool === 'run_task') return;
  const el = externalSteps.shift();
  if (!el) return;
  el.classList.remove('pending');
  if (isError) el.classList.add('err');
  el.querySelector('.ico').textContent = isError ? '✕' : '✓';
  el.querySelector('.meta').textContent = ms(took);
}

// ---------- composer ----------

function currentMode() {
  return document.querySelector('.segmented [aria-selected="true"]').dataset.mode;
}

function send(text) {
  const goal = (text ?? input.value).trim();
  if (!goal || running) return;
  input.value = '';
  autosize();
  renderEvent({ type: 'user', text: goal, mode: currentMode() }, 'panel');
  port.postMessage({ type: 'run', goal, mode: currentMode() });
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}

input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('#send').addEventListener('click', () => send());
$('#stop').addEventListener('click', () => port.postMessage({ type: 'stop' }));
$('#new-chat').addEventListener('click', () => port.postMessage({ type: 'reset' }));
$('#bridge').addEventListener('click', () => port.postMessage({ type: 'reconnect' }));
document.querySelectorAll('.suggestions button').forEach((b) => b.addEventListener('click', () => send(b.textContent)));

for (const b of document.querySelectorAll('.segmented button')) {
  b.addEventListener('click', async () => {
    settings.mode = b.dataset.mode;
    await saveSettings(settings);
    renderMode();
  });
}

function renderMode() {
  for (const b of document.querySelectorAll('.segmented button')) b.setAttribute('aria-selected', String(b.dataset.mode === settings.mode));
  const uf = settings.ultrafast;
  $('#model-caption').textContent = settings.mode === 'ultrafast'
    ? uf.backend === 'llm'
      ? `Decision: ${uf.decisionModel} (${PROVIDERS[uf.decisionProvider]?.label})`
      : uf.backend === 'choice'
      ? `Decision: ${uf.choiceModel} · Text: ${uf.textModel}`
      : `Decision: ${uf.systemoneModel} · Text: ${uf.textModel}`
    : `${settings.normal.model} · ${PROVIDERS[settings.normal.provider]?.label}`;
}
renderMode();

// ---------- settings ----------

const form = $('#settings-form');

function get(obj, path) { return path.split('.').reduce((o, k) => o?.[k], obj); }
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
    <label>${esc(p.label)}${p.keyless ? ' <span class="hint">(optional)</span>' : ''}
      <input type="password" name="providers.${id}.apiKey" placeholder="API key" spellcheck="false" />
      ${p.keyless || id === 'custom' || id === 'openrouter' ? `<input name="providers.${id}.baseUrl" placeholder="${esc(p.baseUrl || 'https://your-endpoint/v1')}" spellcheck="false" />` : ''}
    </label>`).join('');
  // Model suggestions follow the chosen provider.
  for (const input of form.querySelectorAll('input[list]')) {
    const dl = document.createElement('datalist');
    dl.id = input.getAttribute('list');
    form.appendChild(dl);
  }
}

function refreshDatalists() {
  for (const input of form.querySelectorAll('input[list]')) {
    const providerField = input.getAttribute('list').replace(/^models-/, '');
    const provider = form.elements[providerField]?.value;
    document.getElementById(input.getAttribute('list')).innerHTML =
      (PROVIDERS[provider]?.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('');
  }
  for (const block of form.querySelectorAll('[data-show]')) {
    const [field, value] = block.dataset.show.split('=');
    block.hidden = form.elements[field]?.value !== value;
  }
}

function fillForm() {
  for (const el of form.elements) {
    if (!el.name) continue;
    const v = get(settings, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  refreshDatalists();
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
  const el = e.target;
  if (!el.name) return;
  let value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
  if (el.name.endsWith('.model') || el.name.endsWith('Model')) value = el.value.trim();
  set(settings, el.name, value);
  if (el.tagName === 'SELECT' && el.name.endsWith('Provider') || el.name === 'normal.provider') {
    // Switching provider: suggest its first model.
    const modelField = el.name === 'normal.provider' ? 'normal.model' : el.name.replace('Provider', 'Model');
    const first = PROVIDERS[el.value]?.models?.[0];
    if (first) { set(settings, modelField, first); form.elements[modelField].value = first; }
  }
  refreshDatalists();
  renderSnippets();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await saveSettings(settings);
    renderMode();
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

buildSettingsForm();
$('#open-settings').addEventListener('click', () => { fillForm(); $('#settings').hidden = false; });
$('#close-settings').addEventListener('click', () => { $('#settings').hidden = true; });
