// GENERATED from extension/src/tools/schemas.js by `npm run sync-schemas`. Do not edit.
// Canonical tool definitions. Shared by the side-panel agent and the MCP server
// (mcp-server/src/schemas.js is a generated copy: run `npm run sync-schemas`).

const tabId = { type: 'number', description: 'Tab to act on. Defaults to the current agent tab (see tabs_context).' };
const ref = { type: 'string', description: 'Element ref from read_page/find, e.g. "ref_12".' };

export const TOOL_SCHEMAS = [
  {
    name: 'tabs_context',
    description: 'List open tabs (id, title, url) and show which tab the tools act on by default. Call this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs_create',
    description: 'Open a new background tab (does not steal focus) and make it the current agent tab.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to open (default about:blank).' }, activate: { type: 'boolean', description: 'Bring the tab to the front. Default false.' } } },
  },
  {
    name: 'tabs_select',
    description: 'Make a tab the current agent tab. Set activate=true only if the user wants to see it.',
    inputSchema: { type: 'object', properties: { tabId, activate: { type: 'boolean' } }, required: ['tabId'] },
  },
  {
    name: 'tabs_close',
    description: 'Close a tab you opened.',
    inputSchema: { type: 'object', properties: { tabId }, required: ['tabId'] },
  },
  {
    name: 'navigate',
    description: 'Load a URL in the tab and wait for it. Also accepts "back", "forward" or "reload".',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, tabId }, required: ['url'] },
  },
  {
    name: 'read_page',
    description: 'Read the page as an indexed list of interactive elements ([ref_N] role "name" value=...) plus the visible text. Use refs with click/type/select_option. Cheaper and more precise than a screenshot.',
    inputSchema: { type: 'object', properties: {
      tabId,
      viewportOnly: { type: 'boolean', description: 'Only elements currently on screen. Default false.' },
      maxElements: { type: 'number', description: 'Default 300.' },
    } },
  },
  {
    name: 'find',
    description: 'Find interactive elements whose role, name, value or placeholder contains the query (case-insensitive). Returns refs.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, tabId }, required: ['query'] },
  },
  {
    name: 'get_page_text',
    description: 'Get the readable text of the page (main/article content first). Use for reading articles, results and data.',
    inputSchema: { type: 'object', properties: { tabId, maxChars: { type: 'number', description: 'Default 20000.' } } },
  },
  {
    name: 'screenshot',
    description: 'Capture the visible part of the tab as an image. Coordinates in the image can be passed to click/scroll/hover.',
    inputSchema: { type: 'object', properties: { tabId } },
  },
  {
    name: 'click',
    description: 'Click an element by ref (preferred) or at screenshot coordinates x,y. Uses real (trusted) mouse events.',
    inputSchema: { type: 'object', properties: {
      ref, x: { type: 'number' }, y: { type: 'number' }, tabId,
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clickCount: { type: 'number', description: '2 for double click.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["ctrl"] or ["shift"].' },
    } },
  },
  {
    name: 'type',
    description: 'Type text. With ref, focuses that field and replaces its content (set clear=false to append). Without ref, types into the focused element. submit=true presses Enter afterwards.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string' }, ref, tabId,
      clear: { type: 'boolean', description: 'Replace existing content. Default true when ref is given.' },
      submit: { type: 'boolean' },
    }, required: ['text'] },
  },
  {
    name: 'press_key',
    description: 'Press keys or chords, space-separated, e.g. "Enter", "Tab Tab", "ctrl+a Backspace", "Escape", "ArrowDown".',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' }, tabId, repeat: { type: 'number' } }, required: ['keys'] },
  },
  {
    name: 'scroll',
    description: 'Scroll the page (or the area under ref / x,y) in a direction. amount is in wheel ticks of ~120px (default 5).',
    inputSchema: { type: 'object', properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number' }, ref, x: { type: 'number' }, y: { type: 'number' }, tabId,
    }, required: ['direction'] },
  },
  {
    name: 'select_option',
    description: 'Choose an option of a native <select> element by value or visible label.',
    inputSchema: { type: 'object', properties: { ref, option: { type: 'string' }, tabId }, required: ['ref', 'option'] },
  },
  {
    name: 'hover',
    description: 'Move the mouse over an element (ref) or point (x,y) to reveal menus or tooltips.',
    inputSchema: { type: 'object', properties: { ref, x: { type: 'number' }, y: { type: 'number' }, tabId } },
  },
  {
    name: 'wait',
    description: 'Wait for a number of seconds (max 10), e.g. for results to load.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
  },
  {
    name: 'javascript',
    description: 'Evaluate a JavaScript expression in the page and return its JSON result. Top-level await works. For inspection and data extraction; prefer click/type for interaction.',
    inputSchema: { type: 'object', properties: { code: { type: 'string' }, tabId }, required: ['code'] },
  },
  {
    name: 'run_task',
    description: 'Hand a whole browser goal to HailBrowser\'s own agent, using the models configured in the extension. mode "ultrafast" uses the one-request-per-step decision loop (best for forms/search flows); "normal" uses the full tool-calling agent. Returns a summary and the step log.',
    mcpOnly: true,
    inputSchema: { type: 'object', properties: {
      goal: { type: 'string', description: 'Natural-language goal, with every value the agent needs.' },
      mode: { type: 'string', enum: ['normal', 'ultrafast'] },
      url: { type: 'string', description: 'Optional start URL (opens in the current agent tab).' },
      values: {
        type: 'object', additionalProperties: { type: 'string' },
        description: 'Text to type into fields, keyed by a short field name, e.g. {"From": "Zurich", "To": "London", "Date": "2026-09-20"}. In ultrafast mode the decision model matches each value to its field, so no text-generation model is needed. Never include passwords or payment details.',
      },
      tabId,
    }, required: ['goal'] },
  },
];
