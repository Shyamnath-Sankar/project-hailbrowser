// `hailbrowser-mcp setup`: print ready-to-paste config for popular agents.

export function printSetup({ port, entry }) {
  const extra = port === 12306 ? [] : ['--port', String(port)];
  const local = ['node', entry.replace(/\\/g, '/'), ...extra];
  const npx = ['npx', '-y', 'hailbrowser-mcp', ...extra];
  const win = process.platform === 'win32';
  const npxWin = ['cmd', '/c', ...npx];
  const q = (parts) => parts.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ');

  const out = `
HailBrowser MCP setup
=====================
1. Load the extension (chrome://extensions → Developer mode → Load unpacked → hailbrowser/extension)
   and keep "Allow external agents" on in its Settings. The side panel shows "MCP connected" once an
   agent below has started the server.

2. Add the server to your agent. From this checkout (works today):

Claude Code
  claude mcp add hailbrowser --scope user -- ${q(local)}

OpenCode  (~/.config/opencode/opencode.json or ./opencode.json)
${JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { hailbrowser: { type: 'local', command: local, enabled: true } } }, null, 2)}

Codex CLI  (~/.codex/config.toml)
  [mcp_servers.hailbrowser]
  command = "${local[0]}"
  args = ${JSON.stringify(local.slice(1))}

Cursor / Windsurf / Claude Desktop / Gemini CLI / any MCP client
${JSON.stringify({ mcpServers: { hailbrowser: { command: local[0], args: local.slice(1) } } }, null, 2)}

Once published to npm you can use: ${q(win ? npxWin : npx)}
`;
  console.log(out);
}
