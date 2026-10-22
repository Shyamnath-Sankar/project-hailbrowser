# Architecture

```
extension/                       Chrome MV3 extension (plain ES modules, no build)
  manifest.json
  src/background.js              service worker: runs, queue, schedules, saved state, side-panel ports, MCP calls
  src/store.js                   chrome.storage.local collections (an index + one key per item)
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
  src/agent/tasks.js             Tasks: planner, subtask loop, task library
  src/agent/research.js          Research loop: search, read sources in tabs, gap check, write
  src/agent/reports.js           report data, storage and Markdown export (pure: the panel imports it)
  src/agent/memory.js            user-approved facts and the prompt section built from them
  src/agent/schedule.js          schedule times (once / daily / weekdays / interval), pure
  src/agent/chats.js             saved side-panel chats and transcript export
  sidepanel/                     chat, tasks, research, history, schedules and settings UI
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
The hub sends `{type:'cancel', id}` when a call times out or the MCP client cancels it (peers forward it to the host); the extension aborts that call, including a `run_task`. Only the trusted extension ID may connect (see README → Security).

## Dialogs, scrolling and pop-ups

- Every attached tab has the CDP `Page` domain enabled. `alert()` is accepted at once and reported in the next tool result. `confirm`/`prompt`/`beforeunload` stay open: in-flight input returns, page reads fail with a message naming the dialog, and the agent calls `handle_dialog`. `page.run` also has a 20 s timeout, so nothing waits forever on a frozen page.
- `scroll` finds the nearest box that can still scroll in that direction (from the ref/point, or the page when none is given) and scrolls it directly, which is exact and unaffected by background tabs' late wheel animations. It falls back to a trusted vertical wheel event for sites that scroll in their own wheel handlers. Horizontal wheels are never sent, since at the page edge Chrome treats them as back/forward swipes.
- Click, Enter and key presses report tabs opened during the action; the agent tab does not change.

## Saved state

The service worker owns all state and is the only writer. Collections in `chrome.storage.local` (`tasks:*`, `chats:*`, `reports:*`, `schedules:*`) keep an index of summaries plus one key per item, so a step in a long task rewrites only that task. The `unlimitedStorage` permission removes the 10 MB cap. Screenshots are never saved; long tool output is cut.

When Chrome stops the worker mid-run, running tasks and reports become *paused*/*stopped* on the next start and can be resumed, never restarted silently.

## Schedules and the run queue

Only one agent run happens at a time (they share the debugger connection and the "current tab"). Scheduled jobs that come due while something runs wait in a queue and start when it finishes. `syncSchedules()` re-creates alarms on every worker start (Chrome may drop them on restart) and queues jobs whose time passed while Chrome was closed. Before a job runs, its next time is computed and saved, so a crash can't repeat it in a loop.

A scheduled job opens its own background tab, runs with `UNATTENDED_RULES`, records a run entry, closes the tab on success (keeps it otherwise), and sends a notification. External MCP calls are refused while a scheduled or panel run is in progress.

## Research

`runResearch` mutates a report object and saves it after every step (the panel renders it live): plan queries → search in one reused background tab (`searchResults` in `inject.js` unwraps DuckDuckGo/Google/Bing redirect links and skips the engine's own pages) → pick sources (model choice, or one per site) → read up to 3 at a time in background tabs → condense each with `RESEARCH_EXTRACT` → optional gap check and another round → number the useful sources and write with `RESEARCH_WRITER`. `citeCheck` drops citations to sources that don't exist. All tabs it opened are closed in `finally`.
