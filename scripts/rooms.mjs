#!/usr/bin/env node
// Stamp out one page per room from web/index.html:  web/<room>/index.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOMS } from '../web/js/rooms.js';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const shell = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
for (const r of ROOMS) {
  const html = shell
    .replace('<title>μεταμόρφωσις</title>', `<title>μεταμόρφωσις · ${r.gr}</title>`)
    .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="μεταμόρφωσις / ${r.id} — ${r.about}. In-browser tools for agents: window.M.call(name, args) and WebMCP.">`)
    .replace('<meta name="mu-root" content="./">', '<meta name="mu-root" content="../">')
    .replace('<meta name="mu-room" content="">', `<meta name="mu-room" content="${r.id}">`)
    .replace(/(href|src)="(css|js)\//g, '$1="../$2/')
    .replace(/href="(llms\.txt|tools\.json)"/g, 'href="../$1"')
    .replace('placeholder="sys.tools"', `placeholder="sys.tools"`);
  fs.mkdirSync(path.join(WEB, r.id), { recursive: true });
  fs.writeFileSync(path.join(WEB, r.id, 'index.html'), html);
}
console.log(`rooms: ${ROOMS.map((r) => r.id).join(' ')}`);
