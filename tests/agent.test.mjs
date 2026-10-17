import test from 'node:test';
import assert from 'node:assert/strict';
import { actionSpace, buildActions, decide, validateChoice } from '../extension/src/agent/decision.js';
import { parseJsonObject, toAnthropicMessages, toOpenAIMessages } from '../extension/src/agent/providers.js';
import { parseChord } from '../extension/src/browser/cdp.js';
import { formatElement, parseRef } from '../extension/src/tools/execute.js';
import { DEFAULTS } from '../extension/src/settings.js';

const snap = {
  url: 'https://x.test/', title: 'Flights', text: 'Where to?',
  viewport: { w: 1000, h: 800 }, scroll: { y: 0, height: 2000 },
  elements: [
    { id: 4, role: 'combobox', label: 'Where from?', value: 'Zurich', editable: true, inViewport: true },
    { id: 9, role: 'button', label: 'Search', value: '', inViewport: true },
    { id: 11, role: 'checkbox', label: 'Nonstop', checked: 'false', inViewport: true },
    { id: 12, role: 'combobox', label: 'Class', value: 'Economy', inViewport: true,
      options: [{ value: 'e', label: 'Economy', selected: true }, { value: 'b', label: 'Business', selected: false }] },
    { id: 13, role: 'textbox', label: 'Password', sensitive: true, editable: true, inViewport: true },
    { id: 14, role: 'link', label: 'Footer', inViewport: false },
  ],
};

test('buildActions: one candidate per operation, skips sensitive and offscreen', () => {
  const { actions } = buildActions(snap);
  const kinds = actions.map((a) => `${a.kind}:${a.label}`);
  assert.deepEqual(kinds, ['fill:Where from?', 'click:Open Where from?', 'click:Search', 'click:Nonstop',
    'select:Class → Business', 'scroll:Scroll down', 'wait:Wait for the page to update']);
  const { elements, targets, controls } = actionSpace(actions);
  assert.equal(elements.length, 4);
  assert.deepEqual(elements[0].operations, ['TYPE_TEXT', 'CLICK']);
  assert.deepEqual(Object.keys(targets.SELECT), ['4:1']);
  assert.deepEqual(Object.keys(controls), ['SCROLL_DOWN', 'WAIT']);
});

test('validateChoice rejects malformed decisions', () => {
  const ok = { choice: 'A', confidence: 0.9, probabilities: { A: 0.8, B: 0.2 } };
  assert.equal(validateChoice(ok, ['A', 'B']), ok);
  assert.throws(() => validateChoice({ ...ok, choice: 'C' }, ['A', 'B']));
  assert.throws(() => validateChoice({ ...ok, probabilities: { A: 0.2, B: 0.8 } }, ['A', 'B']));
  assert.throws(() => validateChoice({ ...ok, probabilities: { A: 0.5 } }, ['A', 'B']));
});

function mockFetch(body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, text: async () => JSON.stringify(body(JSON.parse(init.body))) };
  };
  return calls;
}

test('systemone backend reads only the chosen operation target head', async () => {
  const { actions } = buildActions(snap);
  const settings = structuredClone(DEFAULTS);
  settings.ultrafast.systemoneKey = 'k';
  const calls = mockFetch(() => ({
    model: 'jev-latest',
    answers: {
      operation: { choice: 'CLICK', confidence: 0.9, probabilities: { CLICK: 0.9, TYPE_TEXT: 0.05, SELECT: 0.05, SCROLL_DOWN: 0, WAIT: 0, DONE: 0, BLOCKED: 0 } },
      click_target: { choice: '2', confidence: 0.8, probabilities: { 1: 0.1, 2: 0.8, 3: 0.1 } },
      type_text_target: { choice: 'garbage' }, // unused head: must not matter
    },
  }));
  const d = await decide({ snap, actions, goal: 'search', history: [], settings });
  assert.equal(d.operation, 'CLICK');
  assert.equal(actions.find((a) => a.id === d.choice).label, 'Search');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.authorization, 'Bearer k');
  assert.ok(calls[0].body.questions.select_target);
});

test('llm backend: one call returns operation, target and text', async () => {
  const { actions } = buildActions(snap);
  const settings = structuredClone(DEFAULTS);
  settings.ultrafast.backend = 'llm';
  const cfg = { id: 'groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' };
  mockFetch(() => ({ choices: [{ message: { content: '{"operation":"TYPE_TEXT","target":"1","text":"Zürich","reason":"fill origin"}' } }] }));
  const d = await decide({ snap, actions, goal: 'from Zürich', history: [], settings, decisionCfg: cfg });
  assert.equal(d.text, 'Zürich');
  assert.equal(actions.find((a) => a.id === d.choice).kind, 'fill');

  mockFetch(() => ({ choices: [{ message: { content: '{"operation":"CLICK","target":"99"}' } }] }));
  await assert.rejects(decide({ snap, actions, goal: 'x', history: [], settings, decisionCfg: cfg }), /not valid for CLICK/);
});

test('provider message conversion keeps tool calls and images', () => {
  const img = { type: 'image', data: 'AAA', mimeType: 'image/jpeg' };
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'screenshot', args: {} }] },
    { role: 'tool', results: [{ id: 't1', name: 'screenshot', content: [img] }] },
  ];
  const a = toAnthropicMessages(messages);
  assert.equal(a[1].content[0].type, 'tool_use');
  assert.equal(a[2].content[0].content[0].source.data, 'AAA');
  const o = toOpenAIMessages('sys', messages);
  assert.equal(o[2].tool_calls[0].function.name, 'screenshot');
  assert.equal(o[3].role, 'tool');
  assert.equal(o[4].content[1].image_url.url, 'data:image/jpeg;base64,AAA');
});

test('helpers', () => {
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Sure! {"text":"x"} done'), { text: 'x' });
  assert.equal(parseRef('ref_12'), 12);
  assert.equal(parseRef(7), 7);
  assert.throws(() => parseRef('button'));
  assert.equal(formatElement({ id: 3, role: 'link', label: 'Docs', href: 'https://d', inViewport: false }), '[ref_3] link "Docs" -> https://d (offscreen)');
  assert.deepEqual(parseChord('ctrl+a').commands, ['selectAll']);
  assert.equal(parseChord('Enter').keyCode, 13);
  assert.equal(parseChord('shift+x').key, 'X');
  assert.throws(() => parseChord('hyper+x'));
});

test('letter labels and parsing', async () => {
  const { letter, parseLetter } = await import('../extension/src/agent/decision.js');
  assert.deepEqual([0, 1, 25, 26, 27, 701].map(letter), ['A', 'B', 'Z', 'AA', 'AB', 'ZZ']);
  assert.equal(parseLetter(' b.', ['A', 'B']), 'B');
  assert.equal(parseLetter('(C)', ['A', 'B', 'C']), 'C');
  assert.equal(parseLetter('Answer: AB', ['A', 'AB']), 'AB');
  assert.throws(() => parseLetter('Z', ['A', 'B']), /not an offered option/);
});

test('choice backend (Together Tev1 format): parallel questions, letter answers', async () => {
  const { actions } = buildActions(snap);
  const settings = structuredClone(DEFAULTS);
  settings.ultrafast.backend = 'choice';
  const cfg = { id: 'together', api: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKey: 'k' };
  const calls = mockFetch((body) => {
    const task = JSON.parse(body.messages[1].content);
    const pick = /operation best advances/.test(task.question)
      ? task.options.find((o) => o.key === 'CLICK')
      : task.options.find((o) => /Search/.test(o.description)) || task.options[0];
    return { choices: [{ message: { content: pick.label } }] };
  });
  const d = await decide({ snap, actions, goal: 'search', history: [], settings, decisionCfg: cfg });
  assert.equal(d.operation, 'CLICK');
  assert.equal(actions.find((a) => a.id === d.choice).label, 'Search');
  // operation + one target question per available operation (CLICK, TYPE_TEXT, SELECT)
  assert.equal(calls.length, 4);
  const b = calls[0].body;
  assert.equal(b.model, 'together/Tev1-4B-experimental');
  assert.equal(b.temperature, 0);
  assert.equal(b.max_tokens, 8);
  assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
  assert.match(b.messages[0].content, /Return only its letter/);
  assert.equal(calls[0].url, 'https://api.together.xyz/v1/chat/completions');
});

test('values: label fast path, decision-model matching, NONE', async () => {
  const { chooseValue, matchValueByLabel } = await import('../extension/src/agent/decision.js');
  assert.equal(matchValueByLabel('Where to?', { From: 'Zurich', To: 'London' }), 'To');
  assert.equal(matchValueByLabel('Departure', { From: 'Zurich', To: 'London' }), null);
  assert.equal(matchValueByLabel('Email address', { email: 'a@b.c' }), 'email');

  const settings = structuredClone(DEFAULTS);
  settings.ultrafast.backend = 'choice';
  const cfg = { id: 'together', api: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKey: 'k' };
  const action = { kind: 'fill', role: 'textbox', label: 'Departure', value: '' };
  const values = { Date: '2026-09-20', To: 'London' };

  let calls = mockFetch((body) => {
    const task = JSON.parse(body.messages[1].content);
    assert.match(task.question, /^Which provided value/);
    return { choices: [{ message: { content: task.options.find((o) => o.key === 'Date').label } }] };
  });
  const picked = await chooseValue({ goal: 'g', action, snap, values, settings, decisionCfg: cfg });
  assert.deepEqual([picked.key, picked.text, calls.length], ['Date', '2026-09-20', 1]);

  mockFetch((body) => {
    const task = JSON.parse(body.messages[1].content);
    return { choices: [{ message: { content: task.options.at(-1).label } }] }; // NONE
  });
  assert.equal(await chooseValue({ goal: 'g', action, snap, values, settings, decisionCfg: cfg }), null);

  calls = mockFetch(() => { throw new Error('must not call the model'); });
  const fast = await chooseValue({ goal: 'g', action: { ...action, label: 'Where to?' }, snap, values, settings, decisionCfg: cfg });
  assert.equal(fast.text, 'London');
  assert.equal(await chooseValue({ goal: 'g', action, snap, values: null, settings, decisionCfg: cfg }), null);
});

test('tasks: plan normalization and answering a blocked subtask', async () => {
  const { normalizePlan, applyAnswer, newTask } = await import('../extension/src/agent/tasks.js');
  const plan = normalizePlan({ subtasks: [{ title: ' Open course ', detail: 'd' }, { title: '' }, { foo: 1 }, { title: 'Lesson 1' }] });
  assert.deepEqual(plan.map((s) => [s.title, s.status, s.attempts]), [['Open course', 'pending', 0], ['Lesson 1', 'pending', 0]]);
  assert.equal(normalizePlan({ subtasks: Array.from({ length: 50 }, (_, i) => ({ title: `t${i}` })) }).length, 30);

  const t = newTask('goal', 'tasks');
  assert.equal(t.mode, 'normal');
  t.subtasks = normalizePlan({ subtasks: [{ title: 'Quiz' }, { title: 'Next' }] });
  t.subtasks[0].attempts = 2;
  t.status = 'waiting_user';
  t.question = 'I could not finish "Quiz"';
  assert.equal(applyAnswer(t, ''), false);
  assert.equal(applyAnswer(t, 'skip'), true);
  assert.equal(t.subtasks[0].status, 'skipped');
  assert.equal(t.status, 'running');
  assert.match(t.notes[0], /skip/);
});
