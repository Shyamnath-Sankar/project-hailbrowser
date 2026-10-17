// WebSocket link to the local hailbrowser-mcp hub (ws://127.0.0.1:<port>).
// The hub is started by any MCP client (Claude Code, OpenCode, Cursor, ...).
// Chrome 116+ keeps the service worker alive while this socket exchanges messages.

export class Bridge {
  constructor({ onCall, onStatus }) {
    this.onCall = onCall;
    this.onStatus = onStatus;
    this.ws = null;
    this.port = 12306;
    this.enabled = false;
    this.connected = false;
    this.retryMs = 1000;
    this.timer = null;
    this.ping = null;
    this.inflight = new Map(); // call id -> AbortController (the hub may cancel a call)
  }

  configure({ enabled, port }) {
    const changed = enabled !== this.enabled || port !== this.port;
    this.enabled = enabled;
    this.port = port;
    if (changed) {
      this.close();
      if (enabled) this.connect();
    }
  }

  ensure() {
    if (this.enabled && !this.ws) this.connect();
  }

  connect() {
    clearTimeout(this.timer);
    if (!this.enabled || this.ws) return;
    let ws;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${this.port}/?role=extension`);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retryMs = 1000;
      ws.send(JSON.stringify({ type: 'hello', role: 'extension', version: chrome.runtime.getManifest().version }));
      this.ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'ping' })), 20000);
      this.onStatus(true);
    };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'cancel') return this.inflight.get(msg.id)?.abort();
      if (msg.type !== 'call') return;
      const controller = new AbortController();
      this.inflight.set(msg.id, controller);
      let result;
      try {
        result = await this.onCall(msg.tool, msg.args || {}, msg.client, controller.signal);
      } catch (e) {
        result = { isError: true, content: [{ type: 'text', text: e?.message || String(e) }] };
      } finally {
        this.inflight.delete(msg.id);
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'result', id: msg.id, result }));
    };
    ws.onclose = () => {
      const was = this.connected;
      this.cleanup();
      if (was) this.onStatus(false);
      this.retry();
    };
    ws.onerror = () => {}; // onclose follows
  }

  retry() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 1.6, 10000);
  }

  cleanup() {
    clearInterval(this.ping);
    for (const c of this.inflight.values()) c.abort(); // the agent that asked is gone
    this.inflight.clear();
    this.ws = null;
    this.connected = false;
  }

  close() {
    clearTimeout(this.timer);
    const ws = this.ws;
    this.cleanup();
    if (ws) { ws.onclose = null; ws.close(); }
    this.onStatus(false);
  }
}
