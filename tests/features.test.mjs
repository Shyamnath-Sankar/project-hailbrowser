import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedule, describeWhen, nextRun, normalizeWhen, relativeTime } from '../extension/src/agent/schedule.js';
import { cleanSite, memoryPrompt, rememberIntent } from '../extension/src/agent/memory.js';
import { citeCheck, diverse, newReport, reportMarkdown, searchUrl } from '../extension/src/agent/reports.js';
import { chatMarkdown, pushEvent, storableMessages } from '../extension/src/agent/chats.js';
import { markdown } from '../extension/sidepanel/ui.js';

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('schedule: daily, weekdays and weekly times land on the next matching local day', () => {
  const wed10 = at(2026, 10, 21, 10, 0); // a Wednesday
  assert.equal(new Date(wed10).getDay(), 3);
  const daily9 = normalizeWhen({ frequency: 'daily', time: '9:00' });
  assert.deepEqual(daily9, { type: 'daily', time: '09:00', days: [] });
  assert.equal(nextRun(daily9, wed10), at(2026, 10, 22, 9, 0)); // already past 09:00 today
  assert.equal(nextRun(normalizeWhen({ frequency: 'daily', time: '18:30' }), wed10), at(2026, 10, 21, 18, 30));

  const weekdays = normalizeWhen({ frequency: 'weekdays', time: '08:00' });
  const fri = at(2026, 10, 23, 9, 0);
  assert.equal(nextRun(weekdays, fri), at(2026, 10, 26, 8, 0)); // skips the weekend to Monday

  const weekly = normalizeWhen({ frequency: 'weekly', time: '07:15', days: ['sun', 'tue'] });
  assert.deepEqual(weekly.days, [0, 2]);
  assert.equal(nextRun(weekly, wed10), at(2026, 10, 25, 7, 15)); // Sunday
  assert.equal(normalizeWhen({ frequency: 'weekly', time: '07:00', days: [0, 1, 2, 3, 4, 5, 6] }).days.length, 0, 'all 7 days = daily');
  assert.throws(() => normalizeWhen({ frequency: 'weekly', time: '07:00' }), /days/);
  assert.throws(() => normalizeWhen({ frequency: 'daily', time: '25:00' }), /HH:MM/);
});

test('schedule: once and interval', () => {
  const now = at(2026, 10, 21, 10, 0);
  const once = normalizeWhen({ frequency: 'once', date: '2026-10-22', time: '09:30' }, now);
  assert.equal(once.at, at(2026, 10, 22, 9, 30));
  assert.equal(nextRun(once, now), once.at);
  assert.equal(nextRun(once, once.at), null, 'a one-off is used up after it runs');
  assert.throws(() => normalizeWhen({ frequency: 'once', date: '2026-10-20', time: '09:00' }, now), /past/);
  assert.equal(normalizeWhen({ frequency: 'once', time: '08:00' }, now).at, at(2026, 10, 22, 8, 0), 'no date: next time the clock shows it');

  const every2h = normalizeWhen({ frequency: 'interval', everyMinutes: 120 });
  assert.equal(nextRun(every2h, now), now + 2 * 3600000);
  // A run that fired late keeps the original rhythm instead of drifting.
  const prev = at(2026, 10, 21, 8, 0);
  assert.equal(nextRun(every2h, at(2026, 10, 21, 10, 5), prev), at(2026, 10, 21, 12, 0));
  assert.throws(() => normalizeWhen({ frequency: 'interval', everyMinutes: 1 }), /every 5 minutes/);
});

test('schedule: descriptions, relative times and building from a draft', () => {
  assert.equal(describeWhen({ type: 'daily', time: '09:00', days: [] }), 'Daily at 09:00');
  assert.equal(describeWhen({ type: 'daily', time: '09:00', days: [1, 2, 3, 4, 5] }), 'Weekdays at 09:00');
  assert.equal(describeWhen({ type: 'daily', time: '09:00', days: [1, 3] }), 'Mon, Wed at 09:00');
  assert.equal(describeWhen({ type: 'interval', minutes: 60 }), 'Every hour');
  assert.equal(describeWhen({ type: 'interval', minutes: 240 }), 'Every 4 hours');
  const now = at(2026, 10, 21, 10, 0);
  assert.equal(relativeTime(now + 5 * 60000, now), 'in 5 min');
  assert.equal(relativeTime(now - 2 * 3600000, now), '2 h ago');
  assert.match(relativeTime(at(2026, 10, 22, 9, 0), now), /^tomorrow /);

  const s = buildSchedule({ goal: '  Summarize my GitHub notifications  ', mode: 'bogus', url: 'github.com/notifications', frequency: 'weekdays', time: '09:00' }, now);
  assert.equal(s.goal, 'Summarize my GitHub notifications');
  assert.equal(s.mode, 'normal');
  assert.equal(s.url, 'https://github.com/notifications');
  assert.equal(s.title, 'Summarize my GitHub notifications');
  assert.equal(s.nextRunAt, at(2026, 10, 22, 9, 0));
  assert.throws(() => buildSchedule({ goal: '', frequency: 'daily' }), /Describe/);
  assert.throws(() => buildSchedule({ goal: 'x', when: { type: 'once', at: now - 1000 } }, now), /already passed/);
  assert.throws(() => buildSchedule({ goal: 'x', url: 'javascript:alert(1)', frequency: 'daily' }), /http/);
});

test('memory: intent, sites and the prompt section', () => {
  assert.ok(rememberIntent('Please remember that I live in Zurich'));
  assert.ok(rememberIntent("from now on use metric units"));
  assert.ok(rememberIntent("Don't forget my team is called Hail"));
  assert.ok(!rememberIntent('Summarize this page'));
  assert.equal(cleanSite('https://www.GitHub.com/notifications'), 'github.com');
  assert.equal(cleanSite('docs.python.org'), 'docs.python.org');
  assert.equal(cleanSite(''), null);
  const facts = [
    { text: 'Name is Sam', site: null },
    { text: 'Use the work account', site: 'github.com' },
    { text: 'Ship to Bern', site: 'amazon.de' },
  ];
  const p = memoryPrompt(facts, 'https://gist.github.com/x');
  assert.match(p, /Name is Sam/);
  assert.match(p, /\(on github\.com\) Use the work account/);
  assert.doesNotMatch(p, /Bern/);
  assert.equal(memoryPrompt([], 'https://x.test'), '');
});

test('research: citations, source list, search URLs and diverse picks', () => {
  assert.equal(citeCheck('A [1]. B [7]. C [2, 3]. D [link](https://x.test).', 3), 'A [1]. B. C [2][3]. D [link](https://x.test).');
  const r = newReport('What is X?', 'deep');
  assert.equal(r.depth, 'deep');
  assert.equal(newReport('q', 'silly').depth, 'standard');
  r.answer = 'X is Y [1].';
  r.sources = [{ n: 1, url: 'https://a.test/p', title: 'A page' }, { n: null, url: 'https://b.test', title: 'Failed', status: 'failed' }];
  const md = reportMarkdown(r);
  assert.match(md, /^# What is X\?/);
  assert.match(md, /## Sources\n1\. \[A page\]\(https:\/\/a\.test\/p\) — a\.test/);
  assert.doesNotMatch(md, /Failed/);
  assert.equal(searchUrl({}, 'duckduckgo', 'a b&c'), 'https://html.duckduckgo.com/html/?q=a%20b%26c');
  assert.equal(searchUrl({ research: { customUrl: 'https://s.test/?q=%s' } }, 'custom', 'x'), 'https://s.test/?q=x');
  assert.throws(() => searchUrl({ research: { customUrl: 'https://s.test/' } }, 'custom', 'x'), /%s/);
  const picks = diverse([{ url: 'https://a.test/1' }, { url: 'https://a.test/2' }, { url: 'https://b.test/1' }, { url: 'https://c.test/1' }], 3);
  assert.deepEqual(picks.map((p) => p.url), ['https://a.test/1', 'https://b.test/1', 'https://c.test/1']);
});

test('chats: storage drops screenshots and transient events; transcript export', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'tool', results: [{ id: 't', name: 'screenshot', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }, { type: 'text', text: 'x'.repeat(9000) }] }] },
  ];
  const stored = storableMessages(messages);
  assert.equal(stored[1].results[0].content[0].text, '[screenshot not kept]');
  assert.ok(stored[1].results[0].content[1].text.length < 6100);
  assert.equal(messages[1].results[0].content[0].type, 'image', 'the live conversation is untouched');

  const chat = { title: 'Test', createdAt: 0, events: [] };
  pushEvent(chat, { type: 'thinking' });
  pushEvent(chat, { type: 'user', text: 'Find the docs' });
  pushEvent(chat, { type: 'tool', name: 'navigate', args: { url: 'https://docs.test' } });
  pushEvent(chat, { type: 'tool_result', name: 'screenshot', image: { data: 'AAAA' } });
  pushEvent(chat, { type: 'assistant', text: 'Here they are.' });
  assert.equal(chat.events.length, 4);
  assert.equal(chat.events[2].image, undefined);
  assert.equal(chat.events[2].hadImage, true);
  const md = chatMarkdown(chat);
  assert.match(md, /\*\*You:\*\* Find the docs/);
  assert.match(md, /- `navigate` https:\/\/docs\.test/);
  assert.match(md, /Here they are\./);
});

test('markdown: headings, mixed lists, citations and escaping', () => {
  const cites = new Map([[1, { url: 'https://a.test', title: 'A' }]]);
  const html = markdown('## Summary\n- one [1]\n- two [9]\n1. first\n2. second\n\nText with <b>tag</b> and **bold**.', cites);
  assert.match(html, /<h3>Summary<\/h3><ul><li>one <a class="cite" href="https:\/\/a\.test"[^>]*>1<\/a><\/li><li>two <\/li><\/ul><ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /&lt;b&gt;tag&lt;\/b&gt; and <b>bold<\/b>/);
  assert.match(markdown('```js\nconst a = "<x>";\n```'), /<pre><code>const a = &quot;&lt;x&gt;&quot;;\n<\/code><\/pre>/);
});
