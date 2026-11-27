#!/usr/bin/env node
// Headless harness: serve web/, open it in the installed Chrome, run tools for real, move files in and out.
//
//   node scripts/mu.mjs call <tool> [--args '{"k":"v"}' | --args-file a.json] [--put local[:vfs]]... [--get vfs[:local]]...
//   node scripts/mu.mjs script <file.js> [--put ...] [--get ...]     file body runs in the page as: async (M) => { <body> }
//   node scripts/mu.mjs manifest                                     writes web/tools.json
//   node scripts/mu.mjs serve [--port 8787]                          just the static server
// Flags: --browser chrome|edge|firefox  --room <id> (open that room's page instead of loading every family)  --port N (default: random free port)  --cpu (disable WebGPU)  --timeout ms (default 180000)  --quiet
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flag = (n) => { const i = argv.indexOf(`--${n}`); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const bool = (n) => { const i = argv.indexOf(`--${n}`); if (i < 0) return false; argv.splice(i, 1); return true; };
const multi = (n) => { const out = []; let v; while ((v = flag(n)) !== undefined) out.push(v); return out; };

const TYPES = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf', woff2: 'font/woff2', gz: 'application/gzip', traineddata: 'application/octet-stream' };

function serve(port = 0) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(WEB, p);
    if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file).slice(1).toLowerCase();
    const stat = fs.statSync(file);
    const head = { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? +range[1] : 0; const end = range[2] ? Math.min(+range[2], stat.size - 1) : stat.size - 1;
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res); return;
    }
    res.writeHead(200, { ...head, 'content-length': stat.size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

function findBrowser() {
  const c = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const hit = c.find((p) => p && fs.existsSync(p));
  if (!hit) throw new Error('no Chrome found; set CHROME_PATH');
  return hit;
}

async function main() {
  const port = Number(flag('port') || 0);
  if (cmd === 'serve') { const s = await serve(port || 8787); console.log(`serving web/ on http://127.0.0.1:${s.address().port}/`); return; }
  if (!['call', 'script', 'manifest'].includes(cmd)) { console.error(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n')); process.exit(2); }

  const room = flag('room');
  const which = flag('browser') || 'chrome';
  const cpu = bool('cpu'); const quiet = bool('quiet'); const timeout = Number(flag('timeout') || 180000);
  const puts = multi('put'); const gets = multi('get');
  const argsInline = flag('args'); const argsFile = flag('args-file');
  const { default: puppeteer } = await import('puppeteer-core');
  const server = await serve(port);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const EXE = { chrome: findBrowser(), edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', firefox: process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe' };
  const browser = await puppeteer.launch(which === 'firefox'
    ? { browser: 'firefox', executablePath: EXE.firefox, headless: true, protocolTimeout: timeout + 30000, extraPrefsFirefox: cpu ? { 'dom.webgpu.enabled': false } : {} }
    : { executablePath: EXE[which] || EXE.chrome, headless: true, protocolTimeout: timeout + 30000,
      args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required', ...(cpu ? ['--disable-gpu'] : ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'])] });
  // hard stop: a spinning worker must not keep the process alive past the timeout
  setTimeout(() => { console.error(`[harness] hard stop after ${timeout + 60000} ms`); try { browser.process()?.kill(); } catch { /* gone */ } process.exit(1); }, timeout + 60000).unref();
  let code = 0;
  try {
    const page = await browser.newPage();
    if (!quiet) {
      page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning' || t === 'warn') console.error(`[page ${t}] ${m.text()}`); });
      page.on('pageerror', (e) => console.error(`[page exception] ${e.message}`));
    }
    await page.goto(base + (room ? `${room}/` : '?rooms=all'), { waitUntil: 'load' });
    await page.evaluate(() => M.ready);

    for (const spec of puts) {
      const [local, name] = spec.split(/:(?!\\|\/)/);
      const b64 = fs.readFileSync(local).toString('base64');
      await page.evaluate(async (n, b) => { await M.vfs.write(n, M.b64.dec(b)); }, name || path.basename(local), b64);
    }

    let result;
    if (cmd === 'manifest') {
      result = await page.evaluate(() => M.manifest(true));
      fs.writeFileSync(path.join(WEB, 'tools.json'), JSON.stringify(result, null, 1) + '\n');
      const modules = await page.evaluate(() => M.modules);
      console.log(JSON.stringify({ wrote: 'web/tools.json', tools: result.tools.length, modules }, null, 1));
    } else if (cmd === 'call') {
      const tool = argv.shift();
      const args = argsFile ? JSON.parse(fs.readFileSync(argsFile, 'utf8')) : argsInline ? JSON.parse(argsInline) : {};
      result = await Promise.race([
        page.evaluate((t, a) => M.call(t, a), tool, args),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeout}ms`)), timeout)),
      ]);
      console.log(JSON.stringify(result, null, 1));
      if (!result.ok) code = 1;
    } else {
      const body = fs.readFileSync(argv.shift(), 'utf8');
      result = await Promise.race([
        page.evaluate(`(async (M) => { ${body}\n })(window.M)`),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${timeout}ms`)), timeout)),
      ]);
      console.log(JSON.stringify(result === undefined ? null : result, null, 1));
    }

    for (const spec of gets) {
      const [name, local] = spec.split(/:(?!\\|\/)/);
      const b64 = await page.evaluate((n) => M.b64.enc(M.vfs.read(n)), name);
      const dest = local || path.basename(name);
      fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(b64, 'base64'));
      console.error(`[get] ${name} → ${dest} (${Buffer.from(b64, 'base64').length} bytes)`);
    }
  } catch (e) { console.error(`[harness] ${e.message}`); code = 1; } finally { await browser.close(); server.close(); }
  process.exit(code);
}
main();
