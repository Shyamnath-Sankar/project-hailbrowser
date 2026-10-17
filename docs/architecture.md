# Architecture

```
extension/                       Chrome MV3 extension (plain ES modules, no build)
  manifest.json
  src/background.js              service worker: runs, side-panel ports, MCP calls, indicator
  src/bridge.js                  WebSocket client to the local hub (auto-reconnect, keepalive)
  src/settings.js                providers, defaults, chrome.storage.local
  src/browser/cdp.js             chrome.debugger: trusted mouse/keyboard, focus emulation
  src/browser/inject.js          functions injected into pages: snapshot, geometry, freshness
  src/browser/page.js            tab resolution, navigation, screenshots, retries
  src/tools/schemas.js           canonical tool definitions (copied into mcp-server)
  src/tools/execute.js           tool implementations, shared by MCP and the Normal agent
  src/agent/providers.js         Anthropic + OpenAI-compatible adapters
  src/agent/normal.js            tool-calling loop
  src/agent/decision.js          Ultrafast action space + decision backends + text helper
  src/agent/ultrafast.js         Ultrafast loop
  sidepanel/                     chat UI and settings
mcp-server/
  src/index.js                   MCP stdio server (`hailbrowser-mcp`)
  src/hub.js                     127.0.0.1 WebSocket hub: host/peer election, relaying
  src/schemas.js                 generated copy of the tool schemas
```

## Page model

`pageSnapshot` runs in the extension's isolated world in one `executeScript` call. It assigns every interactive DOM node a stable numeric identity (a `WeakMap`), keeps live references in a `Map`, and returns role, accessible name, value, state, options, geometry and whether it is on screen, plus the visible text of the viewport. These ids become `ref_N` for external agents and element indexes for Ultrafast. Password values are masked and never offered to Ultrafast.

Before input, `resolveNode` reads fresh geometry, scrolls into view if needed, and hit-tests several points so a click never lands on an overlay by accident. Clicks and typing go through CDP (`Input.dispatchMouseEvent`, `Input.insertText`), which produces trusted events that real sites accept.

## Normal mode

A standard loop: the model gets the tool list (minus `run_task`), calls tools, sees results (including screenshots for vision models), and stops when it answers without tool calls. Only the two most recent screenshots are kept in context.

## Ultrafast mode

1. Observe on-screen elements → candidate actions (`click`, `fill`, `select` per option, `scroll`, `wait`).
2. Build an index table (one index per node; each operation has its own valid targets).
3. One decision request. With the Decision API, the operation head and every operation's target head are answered in parallel in the same round trip; only the chosen operation's head is read. With the LLM backend, one JSON reply carries operation, target and text.
4. `TYPE_TEXT` asks the text helper for `{"text": ...}` unless the decision already supplied it. A generated value is reused across a stale retry only if the helper input is identical.
5. Freshness guard: URL, form values and the target's semantics must match the observation; otherwise nothing is executed and the loop re-observes.
6. Execute, log the action, then observe. After typing into a combobox it waits ≤200 ms for suggestions; otherwise ≤2 frames/50 ms.
7. Stop on `DONE`/`BLOCKED` (re-checked against a fresh observation), on budget, or after three actions in a row that changed nothing.

## Bridge

The service worker holds a WebSocket to `ws://127.0.0.1:<port>/?role=extension` and pings every 20 s (which keeps an MV3 worker alive) with an alarm as backup. The hub rejects browser-page origins. Messages are `{type:'call', id, tool, args, client}` → `{type:'result', id, result}` where `result` is an MCP `CallToolResult`.
