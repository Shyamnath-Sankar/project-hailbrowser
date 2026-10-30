// HailBrowser Tasks: long-horizon goals (e.g. "finish this course").
// plan -> run one subtask at a time with a fresh, focused context -> save progress after
// every step -> pause for the user when needed -> resume later, even after a restart.
import { providerConfig } from '../settings.js';
import { collection } from '../store.js';
import * as page from '../browser/page.js';
import { chat, completeJson } from './providers.js';
import { runNormal } from './normal.js';
import { runUltrafast } from './ultrafast.js';
import { NORMAL_SYSTEM, PLANNER_SYSTEM, TASK_FINAL, TASK_RULES } from './prompts.js';

const MAX_SUBTASKS = 30;
const MAX_ATTEMPTS = 2;
const MAX_TOTAL_SUBTASKS = 200; // add_subtasks can grow a plan, but not without end

export const TASK_TOOLS = [
  {
    name: 'task_complete',
    description: 'Call when the CURRENT subtask is finished. Give a one-sentence summary of what was done and anything the next subtasks need.',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
  {
    name: 'ask_user',
    description: 'Pause and ask the user something you cannot do or decide yourself: logging in, payment, CAPTCHA, a personal choice, or an answer you are unsure about. The task waits for their reply.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  },
  {
    name: 'save_note',
    description: 'Save a fact later subtasks will need (progress, a URL, a value you found). Notes survive across subtasks and restarts.',
    inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
  },
  {
    name: 'add_subtasks',
    description: 'Insert new subtasks right after the current one, when you discover more work (e.g. the course has more lessons than planned).',
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] } } }, required: ['items'] },
  },
];

let seq = 0;
const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

export const FINISHED = new Set(['done', 'stopped']);

/** All tasks ever started (newest first); unfinished ones are never dropped to make room. */
export const taskStore = collection('tasks', {
  max: 30,
  summary: (t) => ({ goal: t.goal, status: t.status, updatedAt: t.updatedAt }),
  protect: (t) => t && !FINISHED.has(t.status),
});

export function newTask(goal, mode, extra = {}) {
  const now = Date.now();
  return {
    id: `t${now.toString(36)}${(seq++).toString(36)}`, goal, mode: mode === 'ultrafast' ? 'ultrafast' : 'normal',
    status: 'planning', subtasks: [], notes: [], question: null, steps: 0,
    log: [], createdAt: now, updatedAt: now, summary: null, error: null, ...extra,
  };
}

export function progress(task) {
  const total = task.subtasks.length;
  const done = task.subtasks.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { done, total };
}

export function normalizePlan(out) {
  const items = Array.isArray(out?.subtasks) ? out.subtasks : [];
  return items.slice(0, MAX_SUBTASKS)
    .map((s) => ({ title: String(s.title || '').trim().slice(0, 120), detail: String(s.detail || '').trim().slice(0, 600) }))
    .filter((s) => s.title)
    .map((s) => ({ id: newId(), ...s, status: 'pending', summary: null, attempts: 0 }));
}

function planText(task, currentId) {
  return task.subtasks.map((s, i) => {
    const mark = s.id === currentId ? '→ CURRENT' : s.status === 'done' ? '✓ done' : s.status === 'skipped' ? '– skipped' : '· pending';
    return `${i + 1}. [${mark}] ${s.title}${s.summary ? ` — ${s.summary}` : ''}`;
  }).join('\n');
}

/**
 * Run (or resume) a task until it is done, needs the user, fails, or is stopped.
 * `save(task)` persists and broadcasts state; `emit` streams step events to the UI.
 */
export async function runTask({ task, settings, signal, emit, save, systemExtra = '' }) {
  const log = (text) => {
    task.log.push({ t: Date.now(), text });
    if (task.log.length > 200) task.log.splice(0, task.log.length - 200);
  };
  const update = (patch) => { Object.assign(task, patch, { updatedAt: Date.now() }); return save(task); };
  const cap = settings.tasks?.maxTotalSteps || 400;

  // A task keeps working in its own tab, even after a restart or when the user switched tabs.
  const own = task.tabId != null ? await chrome.tabs.get(task.tabId).catch(() => null) : null;
  const tab = own || await page.resolveTab(null, 'panel');
  page.setCurrentTab(tab.id, { lane: 'panel' });
  task.tabId = tab.id;

  if (!task.subtasks.length) {
    await update({ status: 'planning' });
    log('Planning…');
    const cfg = providerConfig(settings, settings.normal.provider);
    let excerpt = '';
    if (!page.isRestricted(tab.url)) {
      const snap = await page.observe(tab.id, { viewportOnly: true, maxElements: 60, maxText: 2500 }).catch(() => null);
      if (snap) excerpt = `\nVisible text (untrusted):\n${snap.text}`;
    }
    const out = await completeJson({
      cfg, model: settings.normal.model, system: PLANNER_SYSTEM, maxTokens: 2000, signal,
      user: `GOAL: ${task.goal}\n\nCURRENT TAB: ${tab.title} — ${tab.url}${excerpt}`,
    });
    const subtasks = normalizePlan(out);
    if (!subtasks.length) throw new Error('The model returned no plan. Try rephrasing the goal.');
    log(`Planned ${subtasks.length} subtasks.`);
    await update({ subtasks, status: 'running' });
  }

  await update({ status: 'running', question: null, error: null });

  for (;;) {
    if (signal.aborted) return update({ status: 'paused' });
    const current = task.subtasks.find((s) => s.status === 'pending' || s.status === 'active');
    if (!current) {
      const summary = task.subtasks.map((s) => `✓ ${s.title}${s.summary ? ` — ${s.summary}` : ''}`).join('\n');
      log('All subtasks finished. Writing the result…');
      await update({});
      let answer = null;
      try {
        answer = await finalAnswer(task, settings, signal);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        log(`Could not write the final result: ${e.message}`);
      }
      return update({ status: 'done', summary, answer });
    }
    if (task.steps >= cap) {
      log(`Reached the ${cap}-step budget.`);
      return update({ status: 'waiting_user', question: `I've used ${cap} steps. Continue for another ${cap}? (reply "yes" to continue)` });
    }
    if (current.attempts >= MAX_ATTEMPTS) {
      return update({ status: 'waiting_user', question: `I couldn't finish "${current.title}" after ${MAX_ATTEMPTS} tries.${current.lastIssue ? ` Last issue: ${current.lastIssue}` : ''} How should I continue? (reply "skip" to skip it)` });
    }

    current.status = 'active';
    if (page.currentTab('panel') != null) task.tabId = page.currentTab('panel'); // follows tabs the agent opened
    current.attempts++;
    log(`Started: ${current.title}`);
    await update({});
    emit({ type: 'subtask', title: current.title, index: task.subtasks.indexOf(current) + 1, total: task.subtasks.length });

    const brief = [
      `OVERALL GOAL: ${task.goal}`,
      `PLAN:\n${planText(task, current.id)}`,
      task.notes.length ? `NOTES (saved earlier):\n${task.notes.map((n) => `- ${n}`).join('\n')}` : '',
      `CURRENT SUBTASK: ${current.title}${current.detail ? `\n${current.detail}` : ''}`,
      current.attempts > 1 ? `This is retry #${current.attempts - 1}. Previous issue: ${current.lastIssue || 'unknown'}. Check the page state first.` : '',
    ].filter(Boolean).join('\n\n');

    let outcome;
    // A model or network error is a failed attempt (retried, then the user is asked), never the end of a long task.
    try {
      if (task.mode === 'ultrafast') {
        const r = await runUltrafast({ goal: `${current.title}. ${current.detail}\n(Part of: ${task.goal})`, tabId: (await page.resolveTab(null, 'panel')).id, settings, signal, emit, lane: 'panel' });
        task.steps += r.history?.length || 0;
        outcome = r.status === 'done' ? { kind: 'complete', summary: r.finalTitle ? `Ended on ${r.finalTitle}` : '' }
          : r.status === 'stopped' ? { kind: 'stopped' } : { kind: 'retry', issue: r.summary.split('\n')[1] || r.status };
      } else {
        let result = null;
        const r = await runNormal({
          goal: brief, messages: [], settings, signal, emit, lane: 'panel',
          system: `${NORMAL_SYSTEM}\n\n${TASK_RULES}${systemExtra}`,
          extraTools: TASK_TOOLS,
          maxSteps: settings.tasks?.stepsPerSubtask || 40,
          onStep: () => { task.steps++; },
          onExtraTool: async (call) => {
            const a = call.args || {};
            if (call.name === 'save_note' && a.note) {
              task.notes.push(String(a.note).slice(0, 500));
              if (task.notes.length > 50) task.notes.shift();
              log(`Note: ${a.note}`);
              await update({});
              return { text: 'Saved.' };
            }
            if (call.name === 'add_subtasks') {
              const room = MAX_TOTAL_SUBTASKS - task.subtasks.length;
              if (room <= 0) return { text: `This task already has ${MAX_TOTAL_SUBTASKS} subtasks; finish those first.`, isError: true };
              const items = normalizePlan({ subtasks: a.items }).slice(0, room);
              task.subtasks.splice(task.subtasks.indexOf(current) + 1, 0, ...items);
              log(`Added ${items.length} subtasks.`);
              await update({});
              return { text: `Added ${items.length} subtasks after the current one.` };
            }
            if (call.name === 'ask_user') { result = { kind: 'ask', question: String(a.question || '') }; return { text: 'Waiting for the user.', stop: 'ask' }; }
            if (call.name === 'task_complete') { result = { kind: 'complete', summary: String(a.summary || '') }; return { text: 'Subtask marked complete.', stop: 'complete' }; }
            return { text: 'Unknown task tool', isError: true };
          },
        });
        outcome = result
          || (r.status === 'stopped' ? { kind: 'stopped' }
            : r.status === 'done' ? { kind: 'complete', summary: r.summary.slice(0, 300) }
              : { kind: 'retry', issue: `ran out of steps (${r.summary.slice(-200)})` });
      }
    } catch (e) {
      if (e?.name === 'AbortError' || signal.aborted) throw e;
      outcome = { kind: 'retry', issue: `error: ${String(e?.message || e).slice(0, 200)}` };
    }

    if (outcome.kind === 'stopped') {
      current.status = 'pending';
      current.attempts = Math.max(0, current.attempts - 1);
      log('Paused.');
      return update({ status: 'paused' });
    }
    if (outcome.kind === 'ask') {
      current.status = 'pending';
      current.attempts = Math.max(0, current.attempts - 1);
      log(`Needs you: ${outcome.question}`);
      return update({ status: 'waiting_user', question: outcome.question });
    }
    if (outcome.kind === 'complete') {
      current.status = 'done';
      current.summary = outcome.summary;
      log(`Done: ${current.title}`);
      await update({});
      continue;
    }
    current.status = 'pending';
    current.lastIssue = outcome.issue;
    log(`Retrying "${current.title}": ${outcome.issue}`);
    await update({});
  }
}

/** The deliverable: what the user asked for, written from the notes and subtask results (not a list of steps). */
export async function finalAnswer(task, settings, signal) {
  const cfg = providerConfig(settings, settings.normal.provider);
  const brief = [
    `GOAL: ${task.goal}`,
    `SUBTASK RESULTS:\n${task.subtasks.map((s) => `- ${s.status === 'skipped' ? '(skipped) ' : ''}${s.title}${s.summary ? `: ${s.summary}` : ''}`).join('\n')}`,
    task.notes.length ? `NOTES SAVED DURING THE TASK:\n${task.notes.map((n) => `- ${n}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  const reply = await chat({ cfg, model: settings.normal.model, system: TASK_FINAL, messages: [{ role: 'user', content: [{ type: 'text', text: brief }] }], tools: [], maxTokens: 3000, signal });
  return reply.text?.trim() || null;
}

/** Apply the user's reply to a waiting task. Returns true if it should resume. */
export function applyAnswer(task, answer) {
  const text = String(answer || '').trim();
  if (!text) return false;
  const current = task.subtasks.find((s) => s.status === 'pending' || s.status === 'active');
  if (current && current.attempts >= MAX_ATTEMPTS) {
    if (/^skip\b/i.test(text)) {
      current.status = 'skipped';
    } else {
      current.attempts = 0;
      current.detail = `${current.detail}\nUser guidance: ${text}`.trim();
    }
  } else if (/budget|steps/i.test(task.question || '') && /^y(es)?\b/i.test(text)) {
    task.steps = 0;
  }
  task.notes.push(`User answered "${task.question}": ${text}`);
  task.question = null;
  task.status = 'running';
  return true;
}
