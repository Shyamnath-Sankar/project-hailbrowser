// HailBrowser Normal: a tool-calling agent loop with any configured model.
import { providerConfig } from '../settings.js';
import { TOOL_SCHEMAS } from '../tools/schemas.js';
import { executeTool } from '../tools/execute.js';
import { resolveTab } from '../browser/page.js';
import { chat } from './providers.js';
import { NORMAL_SYSTEM } from './prompts.js';

const KEEP_IMAGES = 2;

function agentTools(settings) {
  return TOOL_SCHEMAS.filter((t) => !t.mcpOnly &&
    !(t.name === 'screenshot' && !settings.normal.vision) &&
    !(t.name === 'javascript' && !settings.tools.allowJavascript));
}

/** Replace all but the newest screenshots with a placeholder to bound context size. */
function pruneImages(messages) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const lists = m.role === 'tool' ? m.results.map((r) => r.content) : m.role === 'user' ? [m.content] : [];
    for (const parts of lists) {
      for (let j = 0; j < parts.length; j++) {
        if (parts[j].type !== 'image') continue;
        if (++seen > KEEP_IMAGES) parts[j] = { type: 'text', text: '[older screenshot removed]' };
      }
    }
  }
}

/**
 * Continue a conversation. `messages` is mutated (the side panel keeps it across turns).
 * Returns {status, summary}.
 */
export async function runNormal({ goal, messages, settings, signal, emit, tabId }) {
  const cfg = providerConfig(settings, settings.normal.provider);
  const tools = agentTools(settings);
  const tab = await resolveTab(tabId).catch(() => null);
  const context = tab ? `\n\n[Current tab ${tab.id}: ${tab.title} — ${tab.url}]` : '';
  // A previous turn interrupted mid-tool-call leaves calls without results; close them out.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.toolCalls?.length) {
    messages.push({ role: 'tool', results: last.toolCalls.map((c) => ({ id: c.id, name: c.name, isError: true, content: [{ type: 'text', text: 'Interrupted by user.' }] })) });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: goal + context }] });

  let finalText = '';
  for (let step = 0; step < settings.normal.maxSteps; step++) {
    if (signal.aborted) return { status: 'stopped', summary: finalText || 'Stopped.' };
    pruneImages(messages);
    emit({ type: 'thinking' });
    const t0 = performance.now();
    const reply = await chat({ cfg, model: settings.normal.model, system: NORMAL_SYSTEM, messages, tools, signal });
    messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
    if (reply.text) {
      finalText = reply.text;
      emit({ type: 'assistant', text: reply.text, latencyMs: Math.round(performance.now() - t0) });
    }
    if (!reply.toolCalls.length) return { status: 'done', summary: finalText };

    const results = [];
    for (const call of reply.toolCalls) {
      if (signal.aborted) {
        results.push({ id: call.id, name: call.name, isError: true, content: [{ type: 'text', text: 'Stopped by user.' }] });
        continue;
      }
      emit({ type: 'tool', name: call.name, args: call.args });
      const started = performance.now();
      const res = await executeTool(call.name, call.args, { settings });
      emit({
        type: 'tool_result', name: call.name, isError: !!res.isError, latencyMs: Math.round(performance.now() - started),
        text: res.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n').slice(0, 600),
        image: res.content.find((p) => p.type === 'image'),
      });
      results.push({ id: call.id, name: call.name, isError: !!res.isError, content: res.content });
    }
    messages.push({ role: 'tool', results });
  }
  return { status: 'blocked', summary: `${finalText}\n\nStopped after ${settings.normal.maxSteps} steps.`.trim() };
}
