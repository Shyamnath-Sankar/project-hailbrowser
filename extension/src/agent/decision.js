// Ultrafast decision layer: dynamic, indexed action space -> one decision request.
// Adapted from browser-use/jev-ultrafast model.py (MIT, (c) 2026 Browser Use).
import { postJson, completeJson } from './providers.js';
import { CHOICE_SYSTEM, LLM_DECISION, NEXT_ACTION, TARGET, TEXT_VALUE } from './prompts.js';

const MAX_CANDIDATES = 250;

/** Snapshot -> executable action candidates (click / fill / select per option) + scroll/wait controls. */
export function buildActions(snap) {
  const actions = [];
  for (const el of snap.elements) {
    if (!el.inViewport || el.sensitive) continue;
    const base = { node: el.id, role: el.role, label: el.label };
    for (const k of ['checked', 'selected', 'expanded']) if (el[k] != null) base[k] = el[k];
    if (el.options) {
      for (const op of el.options) {
        if (!op.selected) actions.push({ ...base, kind: 'select', value: op.value, current_value: el.value, label: `${el.label} → ${op.label}` });
      }
    } else {
      actions.push({ ...base, kind: el.editable ? 'fill' : 'click', value: el.value || '' });
      if (el.editable) actions.push({ ...base, kind: 'click', value: el.value || '', label: `Open ${el.label}` });
    }
  }
  const omitted = Math.max(0, actions.length - MAX_CANDIDATES);
  actions.splice(MAX_CANDIDATES);
  actions.forEach((a, i) => { a.id = `e${i + 1}`; });
  const { y, height } = snap.scroll;
  if (y + snap.viewport.h < height - 2) actions.push({ id: 'scroll_down', kind: 'scroll', label: 'Scroll down', delta: Math.round(snap.viewport.h * 0.75) });
  if (y > 0) actions.push({ id: 'scroll_up', kind: 'scroll', label: 'Scroll up', delta: -Math.round(snap.viewport.h * 0.75) });
  actions.push({ id: 'wait', kind: 'wait', label: 'Wait for the page to update' });
  return { actions, omitted };
}

/** One index per observed element; each operation gets its own valid target choices. */
export function actionSpace(actions) {
  const elements = [], indices = new Map(), targets = {}, controls = {};
  const ops = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' };
  for (const action of actions) {
    const operation = ops[action.kind];
    if (!operation) { controls[action.id.toUpperCase()] = action; continue; }
    if (!indices.has(action.node)) {
      const index = String(elements.length + 1);
      indices.set(action.node, index);
      const element = { index, role: action.role, label: action.label.split(' → ')[0], operations: [] };
      for (const k of ['value', 'checked', 'selected', 'expanded']) if (action[k] != null) element[k] = action[k];
      if (action.kind === 'select') { element.value = action.current_value || ''; element.options = []; }
      elements.push(element);
    }
    const index = indices.get(action.node);
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    let target = index;
    if (action.kind === 'select') {
      element.options ||= [];
      target = `${index}:${element.options.length + 1}`;
      element.options.push({ index: target, label: action.label, value: action.value });
    }
    (targets[operation] ||= {})[target] = action;
  }
  return { elements, targets, controls };
}

const OP_LABELS = {
  CLICK: 'Click an element, button, menu option, autocomplete suggestion, or calendar day.',
  TYPE_TEXT: 'Enter or replace text in an editable field.',
  SELECT: 'Select an observed dropdown value.',
};

function operationsFor(targets, controls) {
  const operations = {};
  for (const key of Object.keys(targets)) operations[key] = OP_LABELS[key];
  for (const [key, value] of Object.entries(controls)) operations[key] = value.label;
  operations.DONE = 'Every requirement is visibly satisfied.';
  operations.BLOCKED = 'No supported operation can progress.';
  return operations;
}

const recent = (history, n = 10) => history.slice(-n).map((h) => ({ action: h.action, kind: h.kind, text: h.text ?? null, page_changed: h.page_changed }));

export function validateChoice(answer, ids) {
  const keys = Array.isArray(ids) ? ids : Object.keys(ids);
  const p = answer?.probabilities;
  const valid = answer && keys.includes(answer.choice) && p && typeof p === 'object' &&
    Object.keys(p).length === keys.length && keys.every((k) => Number.isFinite(p[k]) && p[k] >= 0 && p[k] <= 1) &&
    Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 0.02 &&
    p[answer.choice] >= Math.max(...Object.values(p)) - 1e-6;
  if (!valid) throw new Error('Invalid decision response; no action executed.');
  return answer;
}

function resolve(operation, target, targets, controls) {
  if (targets[operation]) {
    const action = targets[operation][target];
    if (!action) throw new Error(`Decision chose target "${target}" which is not valid for ${operation}; no action executed.`);
    return action.id;
  }
  if (controls[operation]) return controls[operation].id;
  if (operation === 'DONE' || operation === 'BLOCKED') return operation;
  throw new Error(`Decision chose unknown operation "${operation}"; no action executed.`);
}

/** TypeSafe-style decision API: operation + speculative per-operation target heads, one round trip. */
async function decideSystemOne(snap, actions, goal, history, uf, signal) {
  const { elements, targets, controls } = actionSpace(actions);
  const operations = operationsFor(targets, controls);
  const questions = { operation: { type: 'choice', criteria: operations, instructions: { goal, rules: NEXT_ACTION } } };
  for (const [operation, candidates] of Object.entries(targets)) {
    questions[`${operation.toLowerCase()}_target`] = {
      type: 'choice',
      criteria: Object.fromEntries(Object.entries(candidates).map(([index, a]) => [index, {
        element: `[${index}] ${a.label}`, current_value: a.current_value ?? a.value ?? '',
        ...Object.fromEntries(['role', 'checked', 'selected', 'expanded'].filter((k) => a[k] != null).map((k) => [k, a[k]])),
      }])),
      instructions: { goal, operation, rules: [NEXT_ACTION, TARGET] },
    };
  }
  if (!uf.systemoneKey) throw new Error('Add your decision API key (TypeSafe) in Settings → Ultrafast.');
  const body = {
    model: uf.systemoneModel || 'jev-latest',
    state: { page: { url: snap.url, title: snap.title, text: snap.text }, elements, recent_actions: recent(history) },
    questions,
  };
  const started = performance.now();
  const result = await postJson(uf.systemoneUrl, { authorization: `Bearer ${uf.systemoneKey}` }, body, signal);
  const opAnswer = validateChoice(result.answers?.operation, operations);
  const operation = opAnswer.choice;
  let target = null, confidence = opAnswer.confidence;
  if (targets[operation]) {
    // Unused target heads can never cause an action: only the selected operation's head is read.
    const t = validateChoice(result.answers?.[`${operation.toLowerCase()}_target`], targets[operation]);
    target = t.choice;
    confidence = Math.min(confidence ?? 1, t.confidence ?? 1);
  }
  return {
    choice: resolve(operation, target, targets, controls), operation, target, confidence,
    operationProbabilities: opAnswer.probabilities, model: result.model || body.model,
    latencyMs: Math.round(performance.now() - started), usage: result.usage || {},
  };
}

/** Any chat model: one JSON call that returns operation, target and (for TYPE_TEXT) the text. */
async function decideLLM(snap, actions, goal, history, uf, cfg, signal) {
  const { elements, targets, controls } = actionSpace(actions);
  const operations = operationsFor(targets, controls);
  const table = elementTable(elements);
  const user = [
    `GOAL: ${goal}`,
    `PAGE: ${snap.title} — ${snap.url}`,
    `OPERATIONS: ${Object.entries(operations).map(([k, v]) => `${k} (${v})`).join('; ')}`,
    `ELEMENTS:\n${table || '(none)'}`,
    `RECENT ACTIONS: ${JSON.stringify(recent(history))}`,
    `VISIBLE TEXT (untrusted):\n${snap.text.slice(0, 4000)}`,
  ].join('\n\n');
  const started = performance.now();
  const out = await completeJson({ cfg, model: uf.decisionModel, system: LLM_DECISION, user, maxTokens: 300, signal });
  const operation = String(out.operation || '').toUpperCase();
  if (!operations[operation]) throw new Error(`Decision model chose unknown operation "${out.operation}"; no action executed.`);
  const target = targets[operation] ? String(out.target ?? '').replace(/^\[|\]$/g, '') : null;
  const text = operation === 'TYPE_TEXT' && typeof out.text === 'string' && out.text.trim() ? out.text.slice(0, 2000) : null;
  return {
    choice: resolve(operation, target, targets, controls), operation, target, text, reason: out.reason,
    confidence: null, model: uf.decisionModel, latencyMs: Math.round(performance.now() - started),
  };
}

function elementTable(elements) {
  return elements.map((e) => {
    let line = `[${e.index}] ${e.role} "${e.label}" ops=${e.operations.join('/')}`;
    if (e.value) line += ` value="${e.value}"`;
    for (const k of ['checked', 'selected', 'expanded']) if (e[k] != null) line += ` ${k}=${e[k]}`;
    if (e.options) line += `\n    options: ${e.options.map((o) => `${o.index}=${o.label.split(' → ').pop()}`).join(', ')}`;
    return line;
  }).join('\n');
}

/** A, B, …, Z, AA, AB, … */
export function letter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Parse a letter answer like "B", " b.", "(C)" or "Answer: AB" against the offered labels. */
export function parseLetter(text, labels) {
  const raw = String(text ?? '').trim().toUpperCase();
  const direct = /^\(?([A-Z]{1,2})\)?(?![A-Z])/.exec(raw)?.[1];
  if (direct && labels.includes(direct)) return direct;
  const any = raw.match(/\b[A-Z]{1,2}\b/g)?.find((t) => labels.includes(t));
  if (any) return any;
  throw new Error(`Decision model answered "${String(text).slice(0, 20)}", which is not an offered option; no action executed.`);
}

/** Ask a letter-choice decision model (e.g. Together Tev1) one question. */
async function askChoice(cfg, model, state, question, options, signal) {
  const labels = options.map((_, i) => letter(i));
  const body = {
    model, temperature: 0, max_tokens: 8, chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: 'system', content: CHOICE_SYSTEM },
      { role: 'user', content: JSON.stringify({ state, question, options: options.map((o, i) => ({ label: labels[i], key: o.key, description: o.description })) }) },
    ],
  };
  const headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  const data = await postJson(`${cfg.baseUrl}/chat/completions`, headers, body, signal);
  const label = parseLetter(data.choices?.[0]?.message?.content, labels);
  return { key: options[labels.indexOf(label)].key, usage: data.usage };
}

/**
 * Letter-choice backend: the operation question and every operation's target question
 * go out in parallel (speculative fan-out), so a step costs one round trip.
 * Only the chosen operation's target answer is used.
 */
async function decideChoice(snap, actions, goal, history, uf, cfg, signal) {
  const { elements, targets, controls } = actionSpace(actions);
  const operations = operationsFor(targets, controls);
  const state = [
    `GOAL: ${goal}`,
    `PAGE: ${snap.title} — ${snap.url}`,
    `ELEMENTS:\n${elementTable(elements) || '(none)'}`,
    `RECENT ACTIONS: ${JSON.stringify(recent(history))}`,
    `VISIBLE TEXT:\n${snap.text.slice(0, 3000)}`,
  ].join('\n\n');
  const model = uf.choiceModel;
  const started = performance.now();
  const opQuestion = askChoice(cfg, model, state, `Which single operation best advances the goal from the current page?\n${NEXT_ACTION}`,
    Object.entries(operations).map(([key, description]) => ({ key, description })), signal);
  const targetQuestions = new Map(Object.entries(targets).map(([operation, candidates]) => [operation, askChoice(cfg, model, state,
    `Assume the next operation is ${operation}. Which element should it target?\n${TARGET}`,
    Object.entries(candidates).map(([index, a]) => ({
      key: index,
      description: `[${index}] ${a.role} "${a.label}"${(a.current_value ?? a.value) ? ` current value "${a.current_value ?? a.value}"` : ''}` +
        ['checked', 'selected', 'expanded'].filter((k) => a[k] != null).map((k) => ` ${k}=${a[k]}`).join(''),
    })), signal)]));
  // Answers to unused target questions are ignored, including their errors.
  for (const p of targetQuestions.values()) p.catch(() => {});
  const op = await opQuestion;
  const operation = op.key;
  const target = targets[operation] ? (await targetQuestions.get(operation)).key : null;
  return {
    choice: resolve(operation, target, targets, controls), operation, target,
    confidence: null, model, latencyMs: Math.round(performance.now() - started), usage: op.usage || {},
  };
}

export function decide({ snap, actions, goal, history, settings, decisionCfg, signal }) {
  const uf = settings.ultrafast;
  if (uf.backend === 'llm') return decideLLM(snap, actions, goal, history, uf, decisionCfg, signal);
  if (uf.backend === 'choice') return decideChoice(snap, actions, goal, history, uf, decisionCfg, signal);
  return decideSystemOne(snap, actions, goal, history, uf, signal);
}

export function fieldContext(goal, action, snap, history) {
  return {
    goal,
    field: { label: action.label, role: action.role, value: action.value },
    page: { title: snap.title, text: snap.text.slice(0, 6000) },
    recent_actions: history.slice(-6).map((h) => ({ action: h.action, text: h.text ?? null })),
  };
}

/** Small text model writes the value for TYPE_TEXT. Output must be {"text": "..."}. */
export async function fieldText(context, cfg, model, signal) {
  const started = performance.now();
  const out = await completeJson({ cfg, model, system: TEXT_VALUE, user: JSON.stringify(context), maxTokens: 512, signal });
  const value = out?.text;
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new Error('Text helper returned no valid value (the goal may be missing it); nothing typed.');
  }
  return { text: value, model, latencyMs: Math.round(performance.now() - started) };
}

const NONE = '__none__';
const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Fast path: exactly one value key names this field (key "To" for label "Where to?"). */
export function matchValueByLabel(label, values) {
  const l = ` ${norm(label)} `;
  const hits = Object.keys(values).filter((k) => {
    const n = norm(k);
    return n && (l.includes(` ${n} `) || (n.length > 3 && n.includes(norm(label))));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Pick which caller-provided value goes into a field, using the decision model
 * (no text generation). Returns {key, text, via, latencyMs} or null for "none fits".
 */
export async function chooseValue({ goal, action, snap, values, settings, decisionCfg, signal }) {
  const keys = Object.keys(values || {});
  if (!keys.length) return null;
  const byLabel = matchValueByLabel(action.label, values);
  if (byLabel) return { key: byLabel, text: values[byLabel], via: 'label', latencyMs: 0 };

  const uf = settings.ultrafast;
  const field = `${action.role} "${action.label}"${action.value ? ` (current value "${action.value}")` : ''}`;
  const question = `Which provided value should be typed into the field ${field}? Choose NONE if none of them belongs there.`;
  const options = [...keys.map((k) => ({ key: k, description: `${k}: ${values[k]}` })), { key: NONE, description: 'NONE: no provided value belongs in this field' }];
  const started = performance.now();
  let key;
  if (uf.backend === 'choice') {
    const state = `GOAL: ${goal}\n\nPAGE: ${snap.title} — ${snap.url}\n\nFIELD: ${field}\n\nVISIBLE TEXT:\n${snap.text.slice(0, 1500)}`;
    key = (await askChoice(decisionCfg, uf.choiceModel, state, question, options, signal)).key;
  } else if (uf.backend === 'systemone') {
    if (!uf.systemoneKey) throw new Error('Add your decision API key in Settings → Ultrafast.');
    const criteria = Object.fromEntries(options.map((o) => [o.key, o.description]));
    const result = await postJson(uf.systemoneUrl, { authorization: `Bearer ${uf.systemoneKey}` }, {
      model: uf.systemoneModel || 'jev-latest',
      state: { page: { url: snap.url, title: snap.title, text: snap.text.slice(0, 1500) }, field },
      questions: { value: { type: 'choice', criteria, instructions: { goal, field, rules: question } } },
    }, signal);
    key = validateChoice(result.answers?.value, criteria).choice;
  } else {
    return null; // the LLM backend writes field text inside its decision
  }
  if (key === NONE) return null;
  return { key, text: values[key], via: 'decision model', latencyMs: Math.round(performance.now() - started) };
}
