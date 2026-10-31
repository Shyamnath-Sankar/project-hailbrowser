// Spawn the real MCP server over stdio, connect a fake extension, and call a tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';
import path from 'node:path';

// Never touch the user's real ~/.hailbrowser trust file from tests.
const TRUST_FILE = path.join(os.tmpdir(), `hail-trust-test-${process.pid}.json`);
import { WebSocket } from 'ws';

function connectExtension(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?role=extension`, { origin: 'chrome-extension://test' });
    ws.once('open', () => resolve(ws));
    ws.once('error', () => setTimeout(() => resolve(null), 100));
  });
}

test('MCP client -> server -> extension round trip', async () => {
  const port = 22316 + (process.pid % 500); // a leftover server from an interrupted run can't block this one
  const transport = new StdioClientTransport({ command: process.execPath, env: { ...process.env, HAILBROWSER_TRUST_FILE: TRUST_FILE }, args: ['mcp-server/src/index.js', '--port', String(port)], stderr: 'ignore' });
  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['tabs_context', 'navigate', 'read_page', 'click', 'type', 'screenshot', 'run_task']) assert.ok(names.includes(n), n);
  assert.ok(tools.every((t) => !('mcpOnly' in t)));

  let ext = null;
  for (let i = 0; i < 50 && !ext; i++) ext = await connectExtension(port);
  assert.ok(ext, 'extension could not connect');
  ext.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'call') ext.send(JSON.stringify({ type: 'result', id: msg.id, result: { content: [{ type: 'text', text: `ok ${msg.tool} from ${msg.client}` }] } }));
  });

  const res = await client.callTool({ name: 'tabs_context', arguments: {} });
  assert.equal(res.content[0].text, 'ok tabs_context from e2e-test');
  ext.close();
  await client.close();
});
