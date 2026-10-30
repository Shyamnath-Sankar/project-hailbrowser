// HailBrowser Normal: a tool-calling agent loop with any configured model.
import { providerConfig } from '../settings.js';
import { TOOL_SCHEMAS } from '../tools/schemas.js';
import { executeTool } from '../tools/execute.js';
import { resolveTab } from '../browser/page.js';
import { chat } from './providers.js';
import { NORMAL_SYSTEM } from './prompts.js';
import { localNow } from './schedule.js';

const KEEP_IMAGES = 2;
const KEEP_FULL_RESULTS = 12;

function agentTools(settings) {
  return TOOL_SCHEMAS.filter((t) => !t.mcpOnly &&
    !(t.name === 'screenshot' && !settings.normal.vision) &&
    !(t.name === 'javascript' && !settings.tools.allowJavascript));
}

/** Bound context size: keep the newest screenshots and tool outputs, shorten older ones. */
export function pruneContext(messages) {
  let images = 0, results = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool') results++;
    const lists = m.role === 'tool' ? m.results.map((r) => r.content) : m.role === 'user' ? [m.content] : [];
    for (const parts of lists) {
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j];
        if (p.type === 'image' && ++images > KEEP_IMAGES) parts[j] = { type: 'text', text: '[older screenshot removed]' };
        else if (m.role === 'tool' && p.type === 'text' && results > KEEP_FULL_RESULTS && p.text.length > 400) {
          parts[j] = { type: 'text', text: `${p.text.slice(0, 400)}… [older output shortened]` };
        }
      }
    }
  }
}

/**
 * Continue a conversation. `messages` is mutated (the side panel keeps it across turns).
 * Optional: `system` prompt, `extraTools` (schemas) handled by `onExtraTool(call)` which
 * returns {text, stop?} — a truthy stop ends the loop with stopReason = stop.
 * Returns {status, summary, stopReason, stopArgs, steps}.
 */
export async function runNormal({ goal, messages, settings, signal, emit, tabId, system = NORMAL_SYSTEM, extraTools = [], onExtraTool, maxSteps, onStep, lane = 'agent' }) {
  const cfg = providerConfig(settings, settings.normal.provider);
  const tools = [...agentTools(settings), ...extraTools];
  const extraNames = new Set(extraTools.map((t) => t.name));
  const limit = maxSteps || settings.normal.maxSteps;
  const tab = await resolveTab(tabId, lane).catch(() => null);
  const context = `${tab ? `\n\n[Current tab ${tab.id}: ${tab.title} — ${tab.url}]` : '\n'}\n[Now: ${localNow()}]`;
  // A previous turn interrupted mid-tool-call leaves calls without results; close them out.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.toolCalls?.length) {
    messages.push({ role: 'tool', results: last.toolCalls.map((c) => ({ id: c.id, name: c.name, isError: true, content: [{ type: 'text', text: 'Interrupted by user.' }] })) });
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: goal + context }] });

  let finalText = '';
  for (let step = 0; step < limit; step++) {
    if (signal.aborted) return { status: 'stopped', summary: finalText || 'Stopped.', steps: step };
    pruneContext(messages);
    emit({ type: 'thinking' });
    const t0 = performance.now();
    const reply = await chat({ cfg, model: settings.normal.model, system, messages, tools, signal });
    onStep?.();
    messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
    if (reply.text) {
      finalText = reply.text;
      emit({ type: 'assistant', text: reply.text, latencyMs: Math.round(performance.now() - t0) });
    }
    if (!reply.toolCalls.length) return { status: 'done', summary: finalText, steps: step + 1 };

    const results = [];
    let stop = null;
    for (const call of reply.toolCalls) {
      if (signal.aborted || stop) {
        results.push({ id: call.id, name: call.name, isError: true, content: [{ type: 'text', text: signal.aborted ? 'Stopped by user.' : 'Skipped.' }] });
        continue;
      }
      if (extraNames.has(call.name)) {
        const out = await onExtraTool(call);
        emit({ type: 'task_tool', name: call.name, args: call.args });
        results.push({ id: call.id, name: call.name, isError: !!out.isError, content: [{ type: 'text', text: out.text || 'ok' }] });
        if (out.stop) stop = { reason: out.stop, args: call.args };
        continue;
      }
      emit({ type: 'tool', name: call.name, args: call.args });
      const started = performance.now();
      const res = await executeTool(call.name, call.args, { settings, lane });
      emit({
        type: 'tool_result', name: call.name, isError: !!res.isError, latencyMs: Math.round(performance.now() - started),
        text: res.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n').slice(0, 600),
        image: res.content.find((p) => p.type === 'image'),
      });
      results.push({ id: call.id, name: call.name, isError: !!res.isError, content: res.content });
    }
    messages.push({ role: 'tool', results });
    if (stop) return { status: 'done', summary: finalText, stopReason: stop.reason, stopArgs: stop.args, steps: step + 1 };
  }
  return { status: 'blocked', summary: `${finalText}\n\nStopped after ${limit} steps.`.trim(), steps: limit };
}
