// Copy the canonical tool schemas from the extension into the MCP server package.
import { readFileSync, writeFileSync } from 'node:fs';

const src = new URL('../extension/src/tools/schemas.js', import.meta.url);
const dest = new URL('../mcp-server/src/schemas.js', import.meta.url);
const header = '// GENERATED from extension/src/tools/schemas.js by `npm run sync-schemas`. Do not edit.\n';
writeFileSync(dest, header + readFileSync(src, 'utf8'));
console.log('synced mcp-server/src/schemas.js');
