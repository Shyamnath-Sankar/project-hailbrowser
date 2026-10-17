import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
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
  const host = new Hub({ port: PORT, client: 'claude-code' });
  assert.equal(await host.start(), 'host');
  const ext = await fakeExtension(PORT);
  const r1 = await host.call('navigate', { url: 'https://example.com' });
  assert.equal(r1.content[0].text, 'navigate:{"url":"https://example.com"}:claude-code');

  const peer = new Hub({ port: PORT, client: 'opencode' });
  assert.equal(await peer.start(), 'peer');
  const r2 = await peer.call('read_page', {});
  assert.equal(r2.content[0].text, 'read_page:{}:opencode');

  ext.close();
  await peer.close();
  await host.close();
});

test('web pages cannot connect to the hub', async () => {
  const host = new Hub({ port: PORT + 1 });
  await host.start();
  await assert.rejects(fakeExtension(PORT + 1, 'https://evil.example'));
  await host.close();
});

test('pinned extension id rejects other extensions', async () => {
  const host = new Hub({ port: PORT + 2, extensionId: 'good' });
  await host.start();
  await assert.rejects(fakeExtension(PORT + 2, 'chrome-extension://bad'));
  const ok = await fakeExtension(PORT + 2, 'chrome-extension://good');
  ok.close();
  await host.close();
});

test('a peer takes over when the host exits', async () => {
  const port = PORT + 3;
  const host = new Hub({ port });
  await host.start();
  const peer = new Hub({ port, client: 'peer' });
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
  const host = new Hub({ port: PORT + 4 });
  await host.start();
  host.waitForExtension = () => Promise.resolve(false);
  const r = await host.call('read_page', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /extension is not connected/);
  await host.close();
});
