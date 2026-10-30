// Local relay between MCP server processes and the HailBrowser extension.
//
// Every MCP client (Claude Code, OpenCode, Cursor...) spawns its own
// hailbrowser-mcp process. The first one to bind 127.0.0.1:<port> becomes the
// "host"; the extension connects to it. Later processes connect to the host as
// "peers" and their calls are forwarded. If the host exits, a peer takes over.
//
// Only one Chrome extension may drive the browser. Unless HAILBROWSER_EXTENSION_ID
// pins it, the first extension that connects is trusted and remembered in
// ~/.hailbrowser/trusted-extension.json (trust on first use); others are rejected.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const EXTENSION_WAIT_MS = 10000;
const STALE_EXTENSION_MS = 45000; // the extension pings every 20 s

export function defaultTrustFile() {
  return process.env.HAILBROWSER_TRUST_FILE || path.join(os.homedir(), '.hailbrowser', 'trusted-extension.json');
}

export function readTrusted(file) {
  try {
    const id = JSON.parse(fs.readFileSync(file, 'utf8')).extensionId;
    return typeof id === 'string' && /^[a-z0-9]{1,64}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function writeTrusted(file, extensionId) {
  if (extensionId == null) return fs.rmSync(file, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ extensionId, trustedAt: new Date().toISOString() }, null, 2));
}

export class Hub {
  constructor({ port = 12306, client = 'mcp', log = () => {}, extensionId = process.env.HAILBROWSER_EXTENSION_ID, trustFile = defaultTrustFile() } = {}) {
    this.port = port;
    this.client = client;
    this.log = log;
    this.extensionId = extensionId; // explicit pin (env/option) always wins
    this.trustFile = trustFile; // null = remember the first extension in memory only
    this.trusted = null; // extension id trusted on first use
    this.rejected = null; // last extension id we turned away, for the error message
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
          const id = origin.slice('chrome-extension://'.length);
          const pinned = this.pinnedId();
          if (pinned && id !== pinned) {
            if (this.rejected !== id) this.log(`hub: rejected extension ${id} (trusted: ${pinned})`);
            this.rejected = id;
            return false;
          }
          return true;
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
      const id = req.headers.origin.slice('chrome-extension://'.length);
      if (!this.pinnedId()) {
        this.trusted = id;
        if (this.trustFile) {
          try { writeTrusted(this.trustFile, id); } catch (e) { this.log(`hub: could not save trusted extension: ${e.message}`); }
        }
        this.log(`hub: trusting extension ${id} from now on`);
      }
      // Another Chrome (a second profile, or a test browser with the same unpacked extension) must not
      // take over a live connection mid-session: keep the first browser while it is alive (it pings
      // every 20 s). A connection silent for 45 s is treated as dead and replaced.
      if (this.extension && this.extension !== ws) {
        if (this.extension.readyState === WebSocket.OPEN && Date.now() - this.extensionSeen < STALE_EXTENSION_MS) {
          if (!this.warnedBusy) this.log('hub: another browser tried to connect; keeping the one already connected');
          this.warnedBusy = true;
          return ws.close(1013, 'another browser is already connected');
        }
        this.extension.close(1000, 'replaced');
      }
      this.warnedBusy = false;
      this.extensionSeen = Date.now();
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
    this.extensionSeen = Date.now();
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

  /** The only extension id allowed to connect, or null if none is trusted yet. */
  pinnedId() {
    if (this.extensionId) return this.extensionId;
    if (!this.trusted && this.trustFile) this.trusted = readTrusted(this.trustFile);
    return this.trusted;
  }

  async onPeerMessage(peer, data) {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'cancel') {
      for (const [fid, fwd] of this.forwarded) {
        if (fwd.peer === peer && fwd.id === msg.id) {
          this.forwarded.delete(fid);
          this.extension?.send(JSON.stringify({ type: 'cancel', id: fid }));
        }
      }
      return;
    }
    if (msg.type !== 'call') return;
    const reply = (result) => peer.readyState === WebSocket.OPEN && peer.send(JSON.stringify({ type: 'result', id: msg.id, result }));
    if (!(await this.waitForExtension())) return reply(this.notConnected());
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

  notConnected() {
    const pinned = this.pinnedId();
    const rejected = this.rejected && this.rejected !== pinned ? this.rejected : null;
    return notConnected(this.port, rejected && { rejected, pinned, file: this.trustFile });
  }

  /**
   * Call a browser tool. Always resolves to an MCP CallToolResult. On timeout or when
   * signal aborts, the extension is told to cancel so a late action can't run twice.
   */
  async call(tool, args, { timeoutMs = 120000, signal } = {}) {
    if (signal?.aborted) return errorResult('Cancelled.');
    try {
      await this.start();
    } catch (e) {
      return errorResult(`Could not start the HailBrowser hub on port ${this.port}: ${e.message}`);
    }
    let target;
    if (this.role === 'host') {
      if (!(await this.waitForExtension())) return this.notConnected();
      target = this.extension;
    } else {
      target = this.upstream;
      if (!target || target.readyState !== WebSocket.OPEN) {
        this.role = null;
        return this.call(tool, args, { timeoutMs, signal });
      }
    }
    const id = `c${++this.seq}`;
    return new Promise((resolve) => {
      const giveUp = (message) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify({ type: 'cancel', id }));
        resolve(errorResult(message));
      };
      const onAbort = () => giveUp(`Cancelled "${tool}"; HailBrowser was told to stop it.`);
      const timer = setTimeout(() => giveUp(`HailBrowser did not answer "${tool}" within ${Math.round(timeoutMs / 1000)}s, so it was cancelled. ` +
        'Check the page with read_page before retrying: the action may have partly happened.'), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve: (r) => { signal?.removeEventListener('abort', onAbort); resolve(r); }, timer });
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

function notConnected(port, trust) {
  const why = trust
    ? ` A different extension (${trust.rejected}) tried to connect, but only ${trust.pinned} is trusted. ` +
      `If the user reinstalled HailBrowser, they can trust the new copy with: hailbrowser-mcp trust ${trust.rejected}` +
      (trust.file ? ` (or delete ${trust.file}).` : '.')
    : '';
  return errorResult(
    `The HailBrowser extension is not connected (waited ${EXTENSION_WAIT_MS / 1000}s on 127.0.0.1:${port}). ` +
    'Ask the user to open Chrome with the HailBrowser extension installed and "Let coding agents use this browser" enabled in its settings ' +
    `(the side panel header shows "Coding agents connected" when ready).${why}`,
  );
}
