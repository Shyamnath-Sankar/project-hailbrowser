# HailBrowser — notes for coding agents

Read README.md and docs/architecture.md first.

- The extension is plain ES modules with no build step. Functions in `extension/src/browser/inject.js` are serialized into pages: keep each self-contained.
- Tool schemas live in `extension/src/tools/schemas.js`. After editing, run `npm run sync-schemas` (the MCP copy is checked by `npm test`).
- Ultrafast: the model chooses an operation and an observed element index only. Never let model output become selectors, coordinates or code. Never retry a browser mutation; re-observe and re-decide instead.
- Keep API keys in chrome.storage.local; tests must not call paid APIs.
- Checks: `npm test` (offline), `node scripts/e2e-browser.mjs` (real Chrome via puppeteer, fake model) and `node scripts/stress-browser.mjs` (long-horizon + chaos, ~2 min). For Fast-mode quality changes, run `node scripts/bench-fast.mjs` with a decision-model key in the environment (real calls, not part of `npm test`) and keep it at 26/26.
- `chrome.scripting.executeScript` rejects `undefined` in `args`: always pass concrete values.
