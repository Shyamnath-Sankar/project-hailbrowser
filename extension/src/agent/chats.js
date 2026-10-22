// Saved side-panel chats: the model conversation (to continue it) and the display events
// (to redraw it when the panel reopens or the chat is picked from History).
import { collection, uid } from '../store.js';

const MAX_EVENTS = 400;
const MAX_TOOL_TEXT = 6000;

export const chatStore = collection('chats', {
  max: 60,
  summary: (c) => ({ title: c.title, updatedAt: c.updatedAt, turns: c.events.filter((e) => e.type === 'user').length }),
});

export function newChat() {
  const now = Date.now();
  return { id: uid('c'), title: '', createdAt: now, updatedAt: now, messages: [], events: [] };
}

export function chatTitle(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** A copy of the model messages without screenshots and with long tool output cut, for storage. */
export function storableMessages(messages) {
  const part = (p) => (p.type === 'image' ? { type: 'text', text: '[screenshot not kept]' }
    : p.type === 'text' && p.text.length > MAX_TOOL_TEXT ? { type: 'text', text: `${p.text.slice(0, MAX_TOOL_TEXT)}… [cut]` } : p);
  return messages.map((m) => {
    if (m.role === 'user') return { ...m, content: m.content.map(part) };
    if (m.role === 'tool') return { ...m, results: m.results.map((r) => ({ ...r, content: r.content.map(part) })) };
    return { ...m };
  });
}

/** Display events worth redrawing later; null for transient ones. */
export function storableEvent(e) {
  if (!e || e.type === 'thinking') return null;
  if (e.type === 'tool_result' && e.image) {
    const { image, ...rest } = e;
    return { ...rest, hadImage: true };
  }
  return { ...e };
}

export function pushEvent(chat, e) {
  const s = storableEvent(e);
  if (!s) return;
  chat.events.push({ ...s, t: Date.now() });
  if (chat.events.length > MAX_EVENTS) chat.events.splice(0, chat.events.length - MAX_EVENTS);
}

/** A readable Markdown transcript, for copying or downloading. */
export function chatMarkdown(chat) {
  const out = [`# ${chat.title || 'HailBrowser chat'}`, '', `_${new Date(chat.createdAt).toLocaleString()}_`, ''];
  for (const e of chat.events) {
    if (e.type === 'user') out.push(`**You:** ${e.text}`, '');
    else if (e.type === 'assistant') out.push(e.text, '');
    else if (e.type === 'tool') out.push(`- \`${e.name}\`${e.args?.url ? ` ${e.args.url}` : e.args?.query ? ` "${e.args.query}"` : ''}`);
    else if (e.type === 'decision') out.push(`- ⚡ ${e.operation} ${e.label || ''}${e.text ? ` ← "${e.text}"` : ''}`);
    else if (e.type === 'finish' && e.summary) out.push('', e.summary, '');
    else if (e.type === 'error') out.push('', `> ⚠ ${e.text}`, '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
