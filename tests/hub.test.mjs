import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../mcp-server/src/hub.js';

const PORT = 22306;

function fakeExtension(port, origin = 'chrome-extension://abcdef') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?role=extension`, { origin });
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'call') {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, result: { content: [{ type: 'text', text: `${msg.tool}:${JSON.stringify(msg.args)}:${msg.client}` }] } }));
      }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('host relays calls to the extension, peers are forwarded', async () => {
  const host = new Hub({ port: PORT, client: 'claude-code', trustFile: null });
  assert.equal(await host.start(), 'host');
  const ext = await fakeExtension(PORT);
  const r1 = await host.call('navigate', { url: 'https://example.com' });
  assert.equal(r1.content[0].text, 'navigate:{"url":"https://example.com"}:claude-code');

  const peer = new Hub({ port: PORT, client: 'opencode', trustFile: null });
  assert.equal(await peer.start(), 'peer');
  const r2 = await peer.call('read_page', {});
  assert.equal(r2.content[0].text, 'read_page:{}:opencode');

  ext.close();
  await peer.close();
  await host.close();
});

test('web pages cannot connect to the hub', async () => {
  const host = new Hub({ port: PORT + 1, trustFile: null });
  await host.start();
  await assert.rejects(fakeExtension(PORT + 1, 'https://evil.example'));
  await host.close();
});

test('pinned extension id rejects other extensions', async () => {
  const host = new Hub({ port: PORT + 2, extensionId: 'good', trustFile: null });
  await host.start();
  await assert.rejects(fakeExtension(PORT + 2, 'chrome-extension://bad'));
  const ok = await fakeExtension(PORT + 2, 'chrome-extension://good');
  ok.close();
  await host.close();
});

test('a peer takes over when the host exits', async () => {
  const port = PORT + 3;
  const host = new Hub({ port, trustFile: null });
  await host.start();
  const peer = new Hub({ port, client: 'peer', trustFile: null });
  assert.equal(await peer.start(), 'peer');
  await host.close();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(peer.role, 'host');
  const ext = await fakeExtension(port);
  const r = await peer.call('tabs_context', {});
  assert.match(r.content[0].text, /^tabs_context/);
  ext.close();
  await peer.close();
});

test('calls fail with guidance when the extension is absent', async () => {
  const host = new Hub({ port: PORT + 4, trustFile: null });
  await host.start();
  host.waitForExtension = () => Promise.resolve(false);
  const r = await host.call('read_page', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /extension is not connected/);
  await host.close();
});

test('the first extension is trusted; others are rejected and named in the error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hail-trust-'));
  const trustFile = path.join(dir, 'trusted.json');
  const host = new Hub({ port: PORT + 5, trustFile });
  await host.start();
  const first = await fakeExtension(PORT + 5, 'chrome-extension://first');
  assert.equal(JSON.parse(fs.readFileSync(trustFile, 'utf8')).extensionId, 'first');
  first.close();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(fakeExtension(PORT + 5, 'chrome-extension://intruder'));
  host.waitForExtension = () => Promise.resolve(false);
  const r = await host.call('read_page', {});
  assert.match(r.content[0].text, /intruder.*only first is trusted.*hailbrowser-mcp trust intruder/s);
  await host.close();

  // A new process reads the remembered id.
  const next = new Hub({ port: PORT + 5, trustFile });
  await next.start();
  await assert.rejects(fakeExtension(PORT + 5, 'chrome-extension://intruder'));
  (await fakeExtension(PORT + 5, 'chrome-extension://first')).close();
  await next.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('timeouts and aborts tell the extension to cancel, also through peers', async () => {
  const port = PORT + 6;
  const host = new Hub({ port, trustFile: null });
  await host.start();
  const cancels = [];
  const ext = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?role=extension`, { origin: 'chrome-extension://abc' });
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'cancel') cancels.push(m.id); });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
  const r1 = await host.call('click', { ref: 'ref_1' }, { timeoutMs: 100 });
  assert.match(r1.content[0].text, /did not answer "click".*cancelled/s);

  const peer = new Hub({ port, client: 'peer', trustFile: null });
  await peer.start();
  const ac = new AbortController();
  const pending = peer.call('run_task', { goal: 'x' }, { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  assert.match((await pending).content[0].text, /Cancelled "run_task"/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cancels.length, 2);
  assert.equal(cancels[0], 'c1');
  assert.match(cancels[1], /^f\d+$/);
  ext.close();
  await peer.close();
  await host.close();
});

test('a second browser cannot take over a live extension connection', async () => {
  const port = PORT + 9;
  const host = new Hub({ port, client: 'opencode', trustFile: null });
  await host.start();
  const first = await fakeExtension(port);
  await new Promise((r) => setTimeout(r, 50));
  // Same extension id from another Chrome (second profile, a test browser): refused while the first is alive.
  const second = await fakeExtension(port);
  const code = await new Promise((r) => second.once('close', (c) => r(c)));
  assert.equal(code, 1013);
  const r = await host.call('read_page', {});
  assert.equal(r.content[0].text, 'read_page:{}:opencode', 'calls still reach the first browser');
  // Once the first one is gone, another browser may connect.
  first.close();
  await new Promise((r) => setTimeout(r, 50));
  const third = await fakeExtension(port);
  assert.equal((await host.call('find', {})).content[0].text, 'find:{}:opencode');
  third.close();
  await host.close();
});
