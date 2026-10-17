# Connect an agent to HailBrowser

Any MCP client can use HailBrowser. The client starts `hailbrowser-mcp` over stdio; that process opens a local hub on `127.0.0.1:12306` which the extension connects to.

**Before you start:** load the extension and keep **Settings → Allow external agents** on. Run `npm run setup` in your checkout to print every snippet below with your real path filled in.

In the examples, replace `/path/to/hailbrowser` with your checkout. On Windows use forward slashes (`D:/code/hailbrowser/...`) or escaped backslashes in JSON.

## Claude Code

```bash
claude mcp add hailbrowser --scope user -- node /path/to/hailbrowser/mcp-server/src/index.js
```

Check with `claude mcp list`. Then ask: *"use hailbrowser to …"*. Optionally copy [`SKILL.md`](../SKILL.md) to `~/.claude/skills/hailbrowser/SKILL.md` so Claude knows the workflow.

## OpenCode

`~/.config/opencode/opencode.json` (global) or `opencode.json` in a project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "hailbrowser": {
      "type": "local",
      "command": ["node", "/path/to/hailbrowser/mcp-server/src/index.js"],
      "enabled": true
    }
  }
}
```

### OpenCode + a decision model (recommended)

Configure the decision model in the extension (Settings → Ultrafast → Decision API or Letter-choice model) and leave the text helper empty. Then ask OpenCode, e.g.:

> Use hailbrowser run_task in ultrafast mode to search Google Flights one-way, 1 adult, with values From=Zurich, To=London, Date=2026-09-20.

OpenCode's model turns your request into `run_task {goal, values}`; the decision model executes it. OpenCode can also use the individual tools (`read_page`, `click`, `type`…) itself for anything open-ended.

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.hailbrowser]
command = "node"
args = ["/path/to/hailbrowser/mcp-server/src/index.js"]
```

## Cursor, Windsurf, Claude Desktop, Gemini CLI, Cline, …

```json
{
  "mcpServers": {
    "hailbrowser": {
      "command": "node",
      "args": ["/path/to/hailbrowser/mcp-server/src/index.js"]
    }
  }
}
```

(Cursor: `~/.cursor/mcp.json` · Claude Desktop: `claude_desktop_config.json` · Gemini CLI: `~/.gemini/settings.json` · Windsurf: `~/.codeium/windsurf/mcp_config.json`.)

## After publishing to npm

Swap the command for `npx -y hailbrowser-mcp` (on Windows: `cmd /c npx -y hailbrowser-mcp`).

## Options

| Flag / env | Default | Meaning |
|---|---|---|
| `--port N` / `HAILBROWSER_PORT` | `12306` | Hub port. Set the same port in the extension's Settings. |
| `HAILBROWSER_EXTENSION_ID` | unset | Only accept this extension ID (find it on `chrome://extensions`). Without it, the first extension that connects is trusted. |
| `HAILBROWSER_TRUST_FILE` | `~/.hailbrowser/trusted-extension.json` | Where the trusted extension ID is remembered. Manage it with `hailbrowser-mcp trust [<id> \| --reset]`. |

## Several agents at once

Every client spawns its own `hailbrowser-mcp`. The first binds the port and becomes the hub; the others relay through it. If the hub's client exits, another process takes over within a second and the extension reconnects automatically.

## Troubleshooting

- **"The HailBrowser extension is not connected"** — open Chrome, check the side panel says *MCP connected*; click the pill to retry. Make sure the ports match.
- **Port already in use by something else** — pick another port in both places.
- **Ollama returns 403** — start Ollama with `OLLAMA_ORIGINS=chrome-extension://*`.
- **"Chrome blocks extensions on this page"** — `chrome://` pages and the Web Store can't be automated; navigate to a normal site.
- **A yellow "started debugging this browser" bar** — that's Chrome showing that `chrome.debugger` is attached (needed for trusted input). It disappears when the tab is closed or the extension is reloaded.
