// Scheduled jobs: run a chat goal, a Fast goal, a long task or a research question later or
// on repeat. Times are the browser's local time. chrome.alarms wakes the service worker;
// the schedule itself lives in storage, so missed runs (Chrome was closed) catch up once.

export const MODES = { normal: 'Chat agent', ultrafast: 'Fast', tasks: 'Task', research: 'Research' };
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MIN_INTERVAL = 5;

export const SCHEDULE_TOOL = {
  name: 'schedule_task',
  description: 'Propose a job that HailBrowser runs later or on repeat, when the user asks for that ("every morning…", "tomorrow at 9…", "every 2 hours…"). ' +
    'The user confirms it in the panel before it is created. Times are the user\'s local time (see Now in the context).',
  inputSchema: { type: 'object', properties: {
    goal: { type: 'string', description: 'What to do each run, written as a complete instruction that makes sense on its own.' },
    title: { type: 'string', description: 'Short name, e.g. "GitHub notifications digest".' },
    mode: { type: 'string', enum: ['normal', 'tasks', 'research', 'ultrafast'], description: 'normal = chat agent (default), tasks = long multi-step job, research = web research report, ultrafast = quick form/search.' },
    url: { type: 'string', description: 'Page to start on, if any.' },
    frequency: { type: 'string', enum: ['once', 'daily', 'weekdays', 'weekly', 'interval'] },
    time: { type: 'string', description: '24-hour local time HH:MM (for once/daily/weekdays/weekly).' },
    date: { type: 'string', description: 'YYYY-MM-DD, only for once.' },
    days: { type: 'array', items: { type: 'string', enum: DAY_NAMES }, description: 'Only for weekly.' },
    everyMinutes: { type: 'number', description: 'Only for interval: minutes between runs (60 = hourly).' },
  }, required: ['goal', 'frequency'] },
};

const pad = (n) => String(n).padStart(2, '0');

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('Time must be HH:MM (24-hour), e.g. 09:30.');
  return `${pad(m[1])}:${m[2]}`;
}

/**
 * Normalize user/model input into a `when`:
 *   {type:'once', at} | {type:'interval', minutes} | {type:'daily', time:'HH:MM', days:[0-6]}  (days empty = every day)
 * Accepts {frequency, time, date, days, everyMinutes} (tool/form shape) or an existing `when`.
 */
export function normalizeWhen(input, now = Date.now()) {
  const i = input || {};
  const freq = i.type || i.frequency;
  if (freq === 'once') {
    if (i.at != null) {
      const at = Number(i.at);
      if (!Number.isFinite(at)) throw new Error('Invalid date.');
      return { type: 'once', at };
    }
    const time = parseTime(i.time || '09:00');
    const date = String(i.date || '').trim();
    let at;
    if (date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      if (!m) throw new Error('Date must be YYYY-MM-DD.');
      at = new Date(+m[1], +m[2] - 1, +m[3], +time.slice(0, 2), +time.slice(3)).getTime();
    } else {
      // No date: the next time the clock shows that time.
      const d = new Date(now);
      d.setHours(+time.slice(0, 2), +time.slice(3), 0, 0);
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      at = d.getTime();
    }
    if (at <= now) throw new Error('That time is in the past.');
    return { type: 'once', at };
  }
  if (freq === 'interval') {
    const minutes = Math.round(Number(i.minutes ?? i.everyMinutes));
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL) throw new Error(`Repeat at most every ${MIN_INTERVAL} minutes.`);
    return { type: 'interval', minutes: Math.min(minutes, 60 * 24 * 31) };
  }
  if (freq === 'hourly') return { type: 'interval', minutes: 60 };
  if (freq === 'daily' || freq === 'weekdays' || freq === 'weekly') {
    const time = parseTime(i.time || '09:00');
    let days = [];
    if (freq === 'weekdays') days = [1, 2, 3, 4, 5];
    else if (Array.isArray(i.days) && i.days.length) {
      days = [...new Set(i.days.map((d) => (typeof d === 'number' ? d : DAY_NAMES.indexOf(String(d).slice(0, 3).toLowerCase()))))]
        .filter((d) => d >= 0 && d <= 6).sort();
      if (!days.length) throw new Error('Pick at least one day.');
    } else if (freq === 'weekly') throw new Error('Pick the days of the week.');
    return { type: 'daily', time, days: days.length === 7 ? [] : days };
  }
  throw new Error('Frequency must be once, daily, weekdays, weekly or interval.');
}

/** The next run strictly after `from` (ms), or null when a one-off is used up. `prev` keeps intervals from drifting. */
export function nextRun(when, from = Date.now(), prev = null) {
  if (!when) return null;
  if (when.type === 'once') return when.at > from ? when.at : null;
  if (when.type === 'interval') {
    const step = when.minutes * 60000;
    if (prev && prev <= from) return prev + Math.ceil((from - prev + 1) / step) * step;
    return prev && prev > from ? prev : from + step;
  }
  if (when.type === 'daily') {
    const [h, m] = when.time.split(':').map(Number);
    const d = new Date(from);
    d.setSeconds(0, 0);
    for (let i = 0; i < 8; i++) {
      const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m, 0, 0);
      if (c.getTime() > from && (!when.days?.length || when.days.includes(c.getDay()))) return c.getTime();
    }
    return null;
  }
  return null;
}

export function describeWhen(when) {
  if (!when) return '';
  if (when.type === 'once') {
    return `Once, ${new Date(when.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  }
  if (when.type === 'interval') {
    const m = when.minutes;
    if (m % 1440 === 0) return m === 1440 ? 'Every day' : `Every ${m / 1440} days`;
    if (m % 60 === 0) return m === 60 ? 'Every hour' : `Every ${m / 60} hours`;
    return `Every ${m} minutes`;
  }
  const days = when.days || [];
  const which = !days.length ? 'Daily' : days.join() === '1,2,3,4,5' ? 'Weekdays' : days.join() === '0,6' ? 'Weekends' : days.map((d) => DAY_LABELS[d]).join(', ');
  return `${which} at ${when.time}`;
}

/** "in 5 min", "in 3 h", "tomorrow 09:00", "Oct 22, 09:00". */
export function relativeTime(at, now = Date.now()) {
  if (at == null) return '';
  const diff = at - now;
  const abs = Math.abs(diff);
  const clock = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (abs < 60000) return diff >= 0 ? 'in under a minute' : 'just now';
  if (abs < 3600000) return diff > 0 ? `in ${Math.round(abs / 60000)} min` : `${Math.round(abs / 60000)} min ago`;
  if (abs < 6 * 3600000) return diff > 0 ? `in ${Math.round(abs / 3600000)} h` : `${Math.round(abs / 3600000)} h ago`;
  const day = (t) => new Date(t).toDateString();
  if (day(at) === day(now)) return `today ${clock}`;
  if (day(at) === day(now + 86400000)) return `tomorrow ${clock}`;
  if (day(at) === day(now - 86400000)) return `yesterday ${clock}`;
  return new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Validate a draft from the panel or the schedule_task tool into a full schedule. */
export function buildSchedule(draft, now = Date.now(), existing = null) {
  const goal = String(draft.goal || '').trim();
  if (!goal) throw new Error('Describe what the job should do.');
  const mode = MODES[draft.mode] ? draft.mode : 'normal';
  let url = String(draft.url || '').trim();
  if (url && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
  if (url && !/^https?:/i.test(url)) throw new Error('The start page must be an http(s) URL.');
  const when = normalizeWhen(draft.when || draft, now);
  const title = String(draft.title || '').trim().slice(0, 80) || goal.split('\n')[0].slice(0, 60);
  const enabled = draft.enabled !== false;
  if (enabled && nextRun(when, now) == null) throw new Error('That time has already passed. Pick a new one.');
  return {
    id: existing?.id || draft.id,
    title, goal: goal.slice(0, 4000), mode, url: url || null, when,
    enabled,
    nextRunAt: enabled ? nextRun(when, now) : null,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    lastRun: existing?.lastRun || null,
  };
}

export function localNow(now = Date.now()) {
  const d = new Date(now);
  return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (local time)`;
}
