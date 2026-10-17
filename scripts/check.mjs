// Syntax-check every JS file and make sure the MCP schema copy is in sync.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['extension', 'mcp-server/src', 'scripts', 'tests'];
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(name)) files.push(p);
  }
};
roots.forEach(walk);
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });

const canonical = readFileSync('extension/src/tools/schemas.js', 'utf8');
const copy = readFileSync('mcp-server/src/schemas.js', 'utf8');
if (!copy.endsWith(canonical)) {
  console.error('mcp-server/src/schemas.js is out of date: run `npm run sync-schemas`.');
  process.exit(1);
}
JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
console.log(`checked ${files.length} files`);
