// Local relay between MCP server processes and the HailBrowser extension.
//
// Every MCP client (Claude Code, OpenCode, Cursor...) spawns its own
// hailbrowser-mcp process. The first one to bind 127.0.0.1:<port> becomes the
// "host"; the extension connects to it. Later processes connect to the host as
// "peers" and their calls are forwarded. If the host exits, a peer takes over.
import { WebSocketServer, WebSocket } from 'ws';

const EXTENSION_WAIT_MS = 10000;

export class Hub {
  constructor({ port = 12306, client = 'mcp', log = () => {}, extensionId = process.env.HAILBROWSER_EXTENSION_ID } = {}) {
    this.port = port;
    this.client = client;
    this.log = log;
    this.extensionId = extensionId;
    this.role = null; // 'host' | 'peer'
    this.wss = null;
    this.extension = null; // host: extension socket
    this.upstream = null; // peer: socket to host
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.forwarded = new Map(); // host: forwarded id -> {peer, id}
    this.extensionWaiters = new Set();
    this.seq = 0;
    this.starting = null;
  }

  /** Become host or peer (idempotent). */
  async start() {
    if (this.closed) throw new Error('hub closed');
    if (this.role) return this.role;
    this.starting ||= (async () => {
      try {
        await this.listen();
        this.role = 'host';
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        await this.connectUpstream();
        this.role = 'peer';
      }
      this.log(`hub: ${this.role} on 127.0.0.1:${this.port}`);
      return this.role;
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  listen() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: '127.0.0.1',
        port: this.port,
        maxPayload: 64 * 1024 * 1024,
        // Web pages can open sockets to localhost too: only accept the extension
        // (chrome-extension:// origin) and local processes (no Origin header).
        verifyClient: ({ origin }) => {
          if (!origin) return true;
          if (!origin.startsWith('chrome-extension://')) return false;
          return !this.extensionId || origin === `chrome-extension://${this.extensionId}`;
        },
      });
      wss.once('listening', () => { this.wss = wss; resolve(); });
      wss.once('error', reject);
      wss.on('connection', (ws, req) => this.onConnection(ws, req));
    });
  }

  onConnection(ws, req) {
    const role = new URL(req.url, 'http://x').searchParams.get('role');
    if (role === 'extension') {
      if (!req.headers.origin) return ws.close(1008, 'extension must connect from Chrome');
      if (this.extension && this.extension !== ws) this.extension.close(1000, 'replaced');
      this.extension = ws;
      this.log('hub: extension connected');
      for (const w of this.extensionWaiters) w();
      this.extensionWaiters.clear();
      ws.on('message', (data) => this.onExtensionMessage(data));
      ws.on('close', () => {
        if (this.extension === ws) this.extension = null;
        this.log('hub: extension disconnected');
        this.failAll('The HailBrowser extension disconnected.');
      });
    } else {
      ws.on('message', (data) => this.onPeerMessage(ws, data));
    }
  }

  onExtensionMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'ping') return this.extension?.send(JSON.stringify({ type: 'pong' }));
    if (msg.type !== 'result') return;
    const fwd = this.forwarded.get(msg.id);
    if (fwd) {
      this.forwarded.delete(msg.id);
      if (fwd.peer.readyState === WebSocket.OPEN) fwd.peer.send(JSON.stringify({ type: 'result', id: fwd.id, result: msg.result }));
      return;
    }
    this.settle(msg.id, msg.result);
  }

  async onPeerMessage(peer, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type !== 'call') return;
    const reply = (result) => peer.readyState === WebSocket.OPEN && peer.send(JSON.stringify({ type: 'result', id: msg.id, result }));
    if (!(await this.waitForExtension())) return reply(notConnected(this.port));
    const id = `f${++this.seq}`;
    this.forwarded.set(id, { peer, id: msg.id });
    this.extension.send(JSON.stringify({ type: 'call', id, tool: msg.tool, args: msg.args, client: msg.client }));
  }

  connectUpstream() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/?role=mcp`);
      ws.once('open', () => { this.upstream = ws; resolve(); });
      ws.once('error', reject);
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.type === 'result') this.settle(msg.id, msg.result);
      });
      ws.on('close', () => {
        if (this.upstream === ws) {
          this.upstream = null;
          this.role = null;
          this.failAll('Lost connection to the HailBrowser hub; retry the call.');
          // Re-elect right away so the extension finds a host again without waiting for a call.
          if (!this.closed) setTimeout(() => !this.closed && this.start().catch(() => {}), 50 + Math.random() * 200);
        }
      });
    });
  }

  waitForExtension(ms = EXTENSION_WAIT_MS) {
    if (this.extension?.readyState === WebSocket.OPEN) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { this.extensionWaiters.delete(done); resolve(false); }, ms);
      this.extensionWaiters.add(done);
    });
  }

  settle(id, result) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(result);
  }

  failAll(message) {
    for (const [id, fwd] of this.forwarded) {
      if (fwd.peer.readyState === WebSocket.OPEN) fwd.peer.send(JSON.stringify({ type: 'result', id: fwd.id, result: errorResult(message) }));
      this.forwarded.delete(id);
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(errorResult(message));
      this.pending.delete(id);
    }
  }

  /** Call a browser tool. Always resolves to an MCP CallToolResult. */
  async call(tool, args, { timeoutMs = 120000 } = {}) {
    try {
      await this.start();
    } catch (e) {
      return errorResult(`Could not start the HailBrowser hub on port ${this.port}: ${e.message}`);
    }
    let target;
    if (this.role === 'host') {
      if (!(await this.waitForExtension())) return notConnected(this.port);
      target = this.extension;
    } else {
      target = this.upstream;
      if (!target || target.readyState !== WebSocket.OPEN) {
        this.role = null;
        return this.call(tool, args, { timeoutMs });
      }
    }
    const id = `c${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(errorResult(`HailBrowser did not answer "${tool}" within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      target.send(JSON.stringify({ type: 'call', id, tool, args, client: this.client }));
    });
  }

  async close() {
    this.closed = true;
    this.failAll('Shutting down');
    this.upstream?.close();
    if (this.wss) {
      for (const c of this.wss.clients) c.terminate();
      await new Promise((r) => this.wss.close(r));
    }
    this.role = null;
  }
}

export function errorResult(text) {
  return { isError: true, content: [{ type: 'text', text }] };
}

function notConnected(port) {
  return errorResult(
    `The HailBrowser extension is not connected (waited ${EXTENSION_WAIT_MS / 1000}s on 127.0.0.1:${port}). ` +
    'Ask the user to open Chrome with the HailBrowser extension installed and "Allow external agents" enabled in its settings ' +
    '(the side panel header shows "MCP connected" when ready).',
  );
}
