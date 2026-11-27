// fs.* and sys.* — the agent's hands: move bytes in and out of the virtual file system, inspect the machine.
import { M, vfs, register, b64, human } from '../js/core.js';
import { DOMAIN_MODULE } from '../js/rooms.js';

const MAX_INLINE = 262144;

register({
  name: 'fs.list', readOnly: true,
  description: 'List files in the in-memory virtual file system (VFS). Every tool reads its inputs from and writes its outputs to the VFS by path.',
  schema: { properties: { prefix: { type: 'string', description: 'Only paths starting with this prefix', default: '' } } },
  run: ({ prefix }) => { const files = vfs.list(prefix); return { count: files.length, totalBytes: files.reduce((a, f) => a + f.bytes, 0), files }; },
});

register({
  name: 'fs.stat', readOnly: true,
  description: 'Size, mime type and known metadata (width/height/pages/duration…) of one VFS file.',
  schema: { properties: { path: { type: 'string', description: 'VFS path' } }, required: ['path'] },
  run: ({ path }) => vfs.stat(path),
});

register({
  name: 'fs.read', readOnly: true,
  description: 'Read a VFS file (or a byte range of it) back as text, base64, a data: URL, or a hex dump. Capped at 256 KiB per call — page through big files with offset/length.',
  schema: {
    properties: {
      path: { type: 'string', description: 'VFS path' },
      encoding: { type: 'string', enum: ['auto', 'text', 'base64', 'dataurl', 'hex'], default: 'auto', description: 'auto = text for textual mime types, base64 otherwise' },
      offset: { type: 'integer', default: 0, minimum: 0, description: 'First byte to read' },
      length: { type: 'integer', default: 65536, minimum: 1, maximum: MAX_INLINE, description: 'Max bytes to read' },
    },
    required: ['path'],
  },
  run({ path, encoding, offset, length }) {
    const st = vfs.stat(path); const all = vfs.read(path);
    const bytes = all.subarray(offset, Math.min(all.length, offset + length));
    if (encoding === 'auto') encoding = vfs.isTextMime(st.mime) ? 'text' : 'base64';
    const base = { path: st.path, mime: st.mime, totalBytes: all.length, offset, bytes: bytes.length, truncated: offset + bytes.length < all.length, encoding };
    if (encoding === 'text') return { ...base, text: new TextDecoder().decode(bytes) };
    if (encoding === 'base64') return { ...base, base64: b64.enc(bytes) };
    if (encoding === 'dataurl') return { ...base, dataurl: `data:${st.mime};base64,${b64.enc(bytes)}` };
    const lines = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const row = bytes.subarray(i, i + 16);
      const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47);
      const asc = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '.')).join('');
      lines.push(`${(offset + i).toString(16).padStart(8, '0')}  ${hex}  |${asc}|`);
    }
    return { ...base, hex: lines.join('\n') };
  },
});

register({
  name: 'fs.write',
  description: 'Create or overwrite a VFS file from inline content: plain text, base64, or a data: URL. Use append=true to upload a large file in several base64 chunks.',
  schema: {
    properties: {
      path: { type: 'string', description: 'VFS path to write; the extension decides the mime type' },
      text: { type: 'string', description: 'UTF-8 text content' },
      base64: { type: 'string', description: 'Base64 content (a data: URL prefix is tolerated)' },
      mime: { type: 'string', description: 'Override the mime type' },
      append: { type: 'boolean', default: false, description: 'Append to an existing file instead of replacing it' },
    },
    required: ['path'],
  },
  async run({ path, text, base64, mime, append }) {
    if ((text === undefined) === (base64 === undefined)) throw new Error('give exactly one of: text, base64');
    let bytes = text !== undefined ? new TextEncoder().encode(text) : b64.dec(base64);
    if (append && vfs.exists(path)) { const old = vfs.read(path); const j = new Uint8Array(old.length + bytes.length); j.set(old); j.set(bytes, old.length); bytes = j; }
    return { output: await vfs.write(path, bytes, mime ? { mime } : {}) };
  },
});

register({
  name: 'fs.fetch',
  description: 'Download a URL into the VFS. Subject to browser CORS: same-origin, data:/blob: URLs and CORS-enabled hosts work; others fail with a network error.',
  schema: {
    properties: {
      url: { type: 'string', description: 'http(s):, data: or blob: URL' },
      path: { type: 'string', description: 'VFS path to save as (default: derived from the URL and content type)' },
    },
    required: ['url'],
  },
  async run({ url, path }) {
    let res;
    try { res = await fetch(url); } catch (e) { throw new Error(`fetch failed (network or CORS): ${e.message}`); }
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    const blob = await res.blob();
    const mime = (blob.type || '').split(';')[0];
    if (!path) {
      let name = ''; try { name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || ''); } catch { /* data: */ }
      if (!name || url.startsWith('data:') || url.startsWith('blob:')) name = 'fetched';
      if (!vfs.extOf(name)) name += '.' + vfs.extForMime(mime);
      path = vfs.exists(name) ? vfs.unique(vfs.stemOf(name), vfs.extOf(name)) : name;
    }
    const known = vfs.mimeOf(path);
    return { output: await vfs.write(path, blob, { mime: known !== 'application/octet-stream' ? known : mime || known }) };
  },
});

register({
  name: 'fs.rm',
  description: 'Delete VFS files by exact path, or everything under a prefix with all=true.',
  schema: { properties: { path: { type: 'string', description: 'VFS path, or prefix when all=true' }, all: { type: 'boolean', default: false, description: 'Treat path as a prefix and delete every match ("" wipes the VFS)' } } },
  run({ path = '', all }) {
    if (!all && !path) throw new Error('missing required arg "path"');
    const targets = all ? vfs.list(path).map((f) => f.path) : [path];
    const removed = targets.filter((p) => vfs.rm(p));
    if (!all && !removed.length) throw new Error(`vfs: no such file "${path}"`);
    return { removed };
  },
});

register({
  name: 'fs.mv',
  description: 'Rename a VFS file. The mime type follows the new extension only if you also convert it — this is a pure rename.',
  schema: { properties: { from: { type: 'string', description: 'Existing path' }, to: { type: 'string', description: 'New path' } }, required: ['from', 'to'] },
  run: ({ from, to }) => ({ output: vfs.mv(from, to) }),
});

register({
  name: 'fs.cp',
  description: 'Copy a VFS file to a new path.',
  schema: { properties: { from: { type: 'string', description: 'Existing path' }, to: { type: 'string', description: 'New path' } }, required: ['from', 'to'] },
  async run({ from, to }) { const st = vfs.stat(from); const { path, mime, bytes, ...meta } = st; return { output: await vfs.write(to, vfs.read(from).slice(), { mime, meta }) }; },
});

register({
  name: 'fs.preview', readOnly: true,
  description: 'Show a VFS file in the page viewport (image, PDF page, video, audio, map, text, or hex) so a human or a screenshotting agent can look at it.',
  schema: { properties: { path: { type: 'string', description: 'VFS path' } }, required: ['path'] },
  run: ({ path }) => ({ previewing: M.preview(path) }),
});

register({
  name: 'fs.download',
  description: 'Save a VFS file to the user\'s disk through a browser download.',
  schema: { properties: { path: { type: 'string', description: 'VFS path' }, filename: { type: 'string', description: 'Suggested file name (default: the VFS name)' } }, required: ['path'] },
  run({ path, filename }) {
    const st = vfs.stat(path);
    const a = document.createElement('a'); a.href = vfs.url(path); a.download = filename || st.path.split('/').pop();
    document.body.appendChild(a); a.click(); a.remove();
    return { downloaded: st.path, bytes: st.bytes };
  },
});

// ─────────────────────────────────────────────────────────────── sys ──
register({
  name: 'sys.env', readOnly: true,
  description: 'Capabilities of this browser: WebGPU adapter and accelerated kernels, WebAssembly features, WebCodecs, threads, memory. Check this to know whether work runs on GPU or CPU.',
  schema: { properties: {} },
  async run() {
    const simd = (() => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } })();
    return {
      version: M.version,
      gpu: await M.gpu.info(),
      wasm: { supported: typeof WebAssembly === 'object', simd, threads: typeof SharedArrayBuffer !== 'undefined' && !!globalThis.crossOriginIsolated },
      webcodecs: { video: typeof VideoEncoder !== 'undefined', audio: typeof AudioEncoder !== 'undefined', imageDecoder: typeof ImageDecoder !== 'undefined' },
      webmcp: { native: !!M.webmcp?.native, registered: M.webmcp?.count || 0, api: M.webmcp?.api || null },
      cores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null,
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined', userAgent: navigator.userAgent,
      room: M.room?.id, tools: [...M.tools.values()].filter((t) => M.exposed(t)).length, files: vfs.list().length,
    };
  },
});

register({
  name: 'sys.tools', readOnly: true,
  description: 'List the tools of the room this page is showing (each room/page exposes one family, plus fs.* and sys.*). Without arguments: domains with their tool names. With domain or query: matching tools with one-line descriptions. sys.help gives one tool\'s full schema; sys.rooms lists the other rooms.',
  schema: { properties: { domain: { type: 'string', description: 'Only this domain, e.g. "image", "pdf"' }, query: { type: 'string', description: 'Case-insensitive substring to search in names and descriptions' } } },
  run({ domain, query }) {
    let list = [...M.tools.values()].filter((t) => M.exposed(t));
    if (domain) list = list.filter((t) => t.domain === domain);
    if (query) { const q = query.toLowerCase(); list = list.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)); }
    list.sort((a, b) => a.name.localeCompare(b.name));
    const room = M.room?.id || 'all';
    if (!domain && !query) {
      const domains = {}; for (const t of list) (domains[t.domain] ||= []).push(t.name.split('.')[1]);
      return { room, count: list.length, domains, elsewhere: 'other tool families live in other rooms — sys.rooms' };
    }
    return { room, count: list.length, tools: list.map((t) => ({ name: t.name, gpu: t.gpu || undefined, description: t.description })) };
  },
});

register({
  name: 'sys.rooms', readOnly: true,
  description: 'List the rooms (pages) of this site. Each room exposes one tool family so its tool list stays small; navigate to a room\'s URL to get its tools. Files in the VFS persist across rooms.',
  schema: { properties: {} },
  run() {
    return {
      here: M.room.id,
      note: 'open a room URL to load its tools; files written to the VFS are kept when you move between rooms',
      rooms: M.rooms.map((r) => ({ id: r.id, url: M.room.url(r.id), domains: r.domains, about: r.about, here: M.room.ids.includes(r.id) || undefined })),
      hub: M.room.url(''),
    };
  },
});

register({
  name: 'sys.help', readOnly: true,
  description: 'Full description and input schema of one tool, plus a usage line for the terminal.',
  schema: { properties: { tool: { type: 'string', description: 'Tool name, e.g. "image.dither"' } }, required: ['tool'] },
  async run({ tool }) {
    let t = M.tools.get(tool);
    if (!t) { const mod = DOMAIN_MODULE[tool.split('.')[0]]; if (mod) { await M.summon(mod); t = M.tools.get(tool); } }
    if (!t) throw new Error(`unknown tool "${tool}" — try sys.tools`);
    const req = new Set(t.schema.required || []);
    const usage = `${t.name} ` + Object.entries(t.schema.properties).map(([k, s]) => (req.has(k) ? `${k}=<${s.type || 'any'}>` : `[${k}=${s.default !== undefined ? JSON.stringify(s.default) : s.type || 'any'}]`)).join(' ');
    return { name: t.name, room: M.exposed(t) ? undefined : `not listed in this room — it belongs to another one (sys.rooms); it still runs when called by name`, description: t.description, gpu: t.gpu, readOnly: t.readOnly, usage, inputSchema: t.schema, examples: t.examples };
  },
});

export { human };
