// Smoke test against YOUR real Chrome: starts the MCP server exactly as Claude Code would, waits for
// the HailBrowser extension to connect, then calls the main tools in a new tab it opens and closes.
// Needs Chrome open with the extension installed and "Let coding agents use this browser" on.
// Fast mode uses the decision model already set up in the extension's settings.
//
//   node scripts/mcp-smoke.mjs            (SMOKE_FAST=0 skips the Fast-mode task)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['mcp-server/src/index.js'], stderr: 'inherit' }));

let failures = 0;
const call = async (name, args = {}, timeout = 120000) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { ...r, text, ms: Date.now() - t0 };
};
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const tools = (await client.listTools()).tools.map((t) => t.name);
check('MCP server lists tools', tools.includes('run_task') && tools.includes('read_page'), `${tools.length} tools`);

// The extension reconnects every few seconds: wait for it.
let ctx;
for (let i = 0; i < 30; i++) {
  ctx = await call('tabs_context');
  if (!ctx.isError) break;
  await new Promise((r) => setTimeout(r, 1000));
}
check('extension connected (tabs_context)', !ctx.isError, ctx.isError ? ctx.text.slice(0, 200) : ctx.text.split('\n')[0]);
if (ctx.isError) { await client.close(); process.exit(1); }

let tabId = null;
try {
  const opened = await call('tabs_create', { url: 'https://en.wikipedia.org/wiki/Alan_Turing' });
  tabId = Number(/tab (\d+)/i.exec(opened.text)?.[1]) || null;
  check('tabs_create opens a tab', !opened.isError, opened.text.split('\n')[0]);

  const page = await call('read_page');
  check('read_page lists elements with refs', /\[ref_\d+\]/.test(page.text), `${(page.text.match(/\[ref_\d+\]/g) || []).length} refs`);

  const text = await call('get_page_text');
  check('get_page_text reads the article', /Turing/.test(text.text), `${text.text.length} chars`);

  const found = await call('find', { query: 'search' });
  check('find locates the search box', /ref_\d+/.test(found.text), found.text.split('\n')[0]?.slice(0, 80));

  const shot = await call('screenshot');
  check('screenshot returns an image', shot.content.some((c) => c.type === 'image'));

  const scrolled = await call('scroll', { direction: 'down' });
  check('scroll', !scrolled.isError, scrolled.text.split('\n')[0]?.slice(0, 80));

  const js = await call('javascript', { code: 'document.title' });
  check('javascript', /Turing/.test(js.text) || js.isError, js.isError ? `(disabled in settings) ${js.text.slice(0, 60)}` : js.text);

  if (process.env.SMOKE_FAST !== '0') {
    const fast = await call('run_task', { goal: 'Search Wikipedia for Ada Lovelace and open the article, then tell me in which year she was born', mode: 'ultrafast' }, 300000);
    console.log(`\n${fast.text}\n`);
    check('run_task (Fast mode) finishes', !fast.isError && /Done/.test(fast.text), `${(fast.ms / 1000).toFixed(1)}s`);
    check('Fast mode answer mentions 1815', /1815/.test(fast.text));
  }
} finally {
  if (tabId) await call('tabs_close', { tabId }).catch(() => {});
  await client.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll MCP checks passed against your Chrome.');
process.exit(failures ? 1 : 0);
