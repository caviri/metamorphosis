// μεταμόρφωσις :: core — registry, virtual file system, call envelope, events.
// Everything an agent needs hangs off one global: window.M  (aliases: window.metamorphosis, window.μ)

import { DOMAIN_MODULE, roomOfDomain } from './rooms.js';

const VERSION = '0.1.0';
const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

// ───────────────────────────────────────────────────────────── mime ──
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  pbm: 'image/x-portable-bitmap', pgm: 'image/x-portable-graymap', ppm: 'image/x-portable-pixmap',
  pdf: 'application/pdf',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', weba: 'audio/webm',
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html', css: 'text/css', csv: 'text/csv', tsv: 'text/tab-separated-values',
  xml: 'application/xml', json: 'application/json', jsonl: 'application/x-ndjson', ndjson: 'application/x-ndjson',
  yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml',
  js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm',
  geojson: 'application/geo+json', topojson: 'application/json', kml: 'application/vnd.google-earth.kml+xml', gpx: 'application/gpx+xml', wkt: 'text/plain',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  kmz: 'application/vnd.google-earth.kmz', shp: 'application/x-shapefile', dbf: 'application/x-dbf', prj: 'text/plain', polyline: 'text/plain',
  tgz: 'application/gzip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', bz2: 'application/x-bzip2', xz: 'application/x-xz', sqlite: 'application/vnd.sqlite3',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', ods: 'application/vnd.oasis.opendocument.spreadsheet', odt: 'application/vnd.oasis.opendocument.text', epub: 'application/epub+zip', ipynb: 'application/x-ipynb+json', eml: 'message/rfc822', rtf: 'application/rtf', mbox: 'application/mbox', odp: 'application/vnd.oasis.opendocument.presentation', diff: 'text/x-diff', patch: 'text/x-diff',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  srt: 'application/x-subrip', vtt: 'text/vtt', bin: 'application/octet-stream',
};
const extOf = (p) => { const m = /\.([A-Za-z0-9]+)$/.exec(p || ''); return m ? m[1].toLowerCase() : ''; };
const stemOf = (p) => (p || 'out').replace(/^.*\//, '').replace(/\.[A-Za-z0-9]+$/, '') || 'out';
const mimeOf = (p) => MIME[extOf(p)] || 'application/octet-stream';
const extForMime = (mime) => {
  const pref = { 'image/jpeg': 'jpg', 'audio/mpeg': 'mp3', 'text/plain': 'txt', 'application/json': 'json', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'image/tiff': 'tif', 'text/html': 'html', 'application/yaml': 'yaml', 'text/javascript': 'js' };
  const base = (mime || '').split(';')[0].trim();
  return pref[base] || Object.keys(MIME).find((k) => MIME[k] === base) || 'bin';
};
const isTextMime = (m) => /^text\/|json|xml|yaml|toml|javascript|subrip|svg|rfc822|rtf|mbox/.test(m || '');

// ────────────────────────────────────────────────────────────── vfs ──
// Flat in-memory file system. Paths are plain names ("cat.png", "out/page-1.png"). No leading slash needed.
const files = new Map();
const norm = (p) => {
  if (typeof p !== 'string' || !p.trim()) throw new Error('vfs: path must be a non-empty string');
  return p.trim().replace(/^vfs:\/\//, '').replace(/^\/+/, '');
};
async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  throw new Error('vfs: unsupported data type');
}

// Files survive navigation between rooms: every write is mirrored to IndexedDB and restored at boot.
// Best effort — if storage is unavailable or full the VFS simply stays in memory for this page.
const persist = (() => {
  let dbp = null, off = false;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('metamorphosis', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('vfs');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    if (off) return null;
    try {
      const db = await open();
      return await new Promise((res, rej) => { const t = db.transaction('vfs', mode); const out = fn(t.objectStore('vfs')); t.oncomplete = () => res(out?.result); t.onerror = t.onabort = () => rej(t.error); });
    } catch (e) { console.warn('[μ] vfs: a file was not persisted (it stays in memory for this page):', e?.message || e); return null; }
  };
  return {
    // very large files stay memory-only: IndexedDB rejects or crawls on them
    put: (path, f) => (f.bytes.byteLength > 64 * 1024 * 1024 ? tx('readwrite', (s) => s.delete(path)) : tx('readwrite', (s) => s.put({ bytes: f.bytes, mime: f.mime, meta: f.meta, mtime: f.mtime }, path))),
    del: (path) => tx('readwrite', (s) => s.delete(path)),
    async restore() {
      if (typeof indexedDB === 'undefined') { off = true; return 0; }
      const keys = await tx('readonly', (s) => s.getAllKeys()); const vals = await tx('readonly', (s) => s.getAll());
      if (!keys || !vals) return 0;
      keys.forEach((k, i) => { if (!files.has(k) && vals[i]?.bytes) files.set(k, { bytes: vals[i].bytes, mime: vals[i].mime, meta: vals[i].meta || {}, mtime: vals[i].mtime || 0 }); });
      if (keys.length) emit('vfs', { op: 'restore' });
      return keys.length;
    },
  };
})();
const statOf = (path, f) => ({ path, mime: f.mime, bytes: f.bytes.byteLength, ...f.meta });

const vfs = {
  /** write(path, data, {mime?, meta?}) → stat. data: Uint8Array | ArrayBuffer | Blob | string */
  async write(path, data, opts = {}) {
    path = norm(path);
    const bytes = await toBytes(data);
    const mime = opts.mime || (data instanceof Blob && data.type) || mimeOf(path);
    const old = files.get(path);
    if (old?.url) URL.revokeObjectURL(old.url);
    const f = { bytes, mime, meta: opts.meta || {}, mtime: Date.now() };
    files.set(path, f);
    persist.put(path, f);
    emit('vfs', { op: 'write', path });
    return statOf(path, f);
  },
  /** read(path) → Uint8Array (the stored buffer — do not mutate it; copy first) */
  read(path) {
    const f = files.get(norm(path));
    if (!f) throw new Error(`vfs: no such file "${path}" — have: ${[...files.keys()].slice(0, 12).join(', ') || '(empty)'}`);
    return f.bytes;
  },
  text(path) { return new TextDecoder().decode(vfs.read(path)); },
  json(path) { return JSON.parse(vfs.text(path)); },
  blob(path) { const f = files.get(norm(path)); if (!f) vfs.read(path); return new Blob([f.bytes], { type: f.mime }); },
  /** object URL for <img>/<video>; cached per file, revoked on overwrite/rm */
  url(path) { const f = files.get(norm(path)); if (!f) vfs.read(path); return (f.url ||= URL.createObjectURL(new Blob([f.bytes], { type: f.mime }))); },
  exists(path) { return files.has(norm(path)); },
  stat(path) { path = norm(path); const f = files.get(path); if (!f) vfs.read(path); return statOf(path, f); },
  setMeta(path, meta) { path = norm(path); const f = files.get(path); if (f) { Object.assign(f.meta, meta); persist.put(path, f); } },
  list(prefix = '') { return [...files.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, f]) => statOf(p, f)); },
  rm(path) { path = norm(path); const f = files.get(path); if (!f) return false; if (f.url) URL.revokeObjectURL(f.url); files.delete(path); persist.del(path); emit('vfs', { op: 'rm', path }); return true; },
  mv(from, to) { from = norm(from); to = norm(to); const f = files.get(from); if (!f) vfs.read(from); files.delete(from); files.set(to, f); persist.del(from); persist.put(to, f); emit('vfs', { op: 'mv', path: to }); return statOf(to, f); },
  /** a path that does not exist yet: unique('cat.dither', 'png') → "cat.dither.png" | "cat.dither-2.png" */
  unique(base, ext) {
    let p = ext ? `${base}.${ext}` : base, i = 1;
    while (files.has(p)) p = ext ? `${base}-${++i}.${ext}` : `${base}-${++i}`;
    return p;
  },
  /** output path helper: explicit `output` arg wins, else derived from the input name. out(args.output, args.input, 'blur', 'png') */
  out(explicit, input, tag, ext) {
    if (explicit) return norm(explicit);
    const stem = stemOf(Array.isArray(input) ? input[0] : input);
    return vfs.unique(tag ? `${stem}.${tag}` : stem, ext);
  },
  extOf, stemOf, mimeOf, extForMime, isTextMime,
  restore: () => persist.restore(),
};

// ───────────────────────────────────────────────────────── registry ──
const tools = new Map();

function register(def) {
  if (!def || typeof def.name !== 'string' || !/^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9_]*$/.test(def.name)) throw new Error(`register: bad tool name "${def?.name}" (want domain.verb)`);
  if (typeof def.run !== 'function') throw new Error(`register: ${def.name} has no run()`);
  if (!def.description) throw new Error(`register: ${def.name} has no description`);
  const schema = def.schema || { type: 'object', properties: {} };
  schema.type = 'object'; schema.properties ||= {};
  const tool = { gpu: false, readOnly: false, ...def, schema, domain: def.name.split('.')[0] };
  tools.set(tool.name, tool);
  emit('register', { name: tool.name });
  return tool;
}

// Minimal JSON-schema-ish normaliser: defaults, required, type coercion (terminal args arrive as strings), enum.
// "a, f(x, 1) as y, c" → ['a', 'f(x, 1) as y', 'c'] : commas inside brackets or quotes do not split
function splitTop(str) {
  const out = []; let cur = '', depth = 0, q = null;
  for (const c of str) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
    if (c === ',' && depth <= 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
function coerce(v, s, key) {
  if (v === undefined || v === null || !s) return v;
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  if ((t === 'number' || t === 'integer') && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
  if (t === 'boolean' && typeof v === 'string') v = v === 'true' || v === '1' || v === 'yes';
  if (t === 'string' && typeof v !== 'string' && typeof v !== 'object') v = String(v);
  if ((t === 'object' || t === 'array') && typeof v === 'string' && /^\s*[[{]/.test(v)) { try { v = JSON.parse(v); } catch { throw new Error(`arg "${key}" is not valid JSON`); } }
  if (t === 'array' && !Array.isArray(v)) v = typeof v === 'string' ? splitTop(v) : [v];
  if (t === 'array' && s.items) v = v.map((x) => coerce(x, s.items, key));
  if (t === 'integer' && typeof v === 'number') v = Math.round(v);
  if ((t === 'number' || t === 'integer')) {
    if (typeof v !== 'number' || Number.isNaN(v)) throw new Error(`arg "${key}" must be a number`);
    if (s.minimum !== undefined && v < s.minimum) throw new Error(`arg "${key}" must be ≥ ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) throw new Error(`arg "${key}" must be ≤ ${s.maximum}`);
  }
  if (s.enum && !s.enum.includes(v)) throw new Error(`arg "${key}" must be one of: ${s.enum.join(' | ')} (got ${JSON.stringify(v)})`);
  return v;
}
function normaliseArgs(tool, args) {
  const out = {}; const props = tool.schema.properties;
  for (const [k, v] of Object.entries(args || {})) {
    if (!(k in props)) throw new Error(`unknown arg "${k}" for ${tool.name} — accepts: ${Object.keys(props).join(', ') || '(none)'}`);
    out[k] = coerce(v, props[k], k);
  }
  for (const [k, s] of Object.entries(props)) if (out[k] === undefined && s.default !== undefined) out[k] = structuredClone(s.default);
  for (const k of tool.schema.required || []) if (out[k] === undefined || out[k] === '') throw new Error(`missing required arg "${k}" for ${tool.name}`);
  return out;
}


// Tool modules load on demand. A room loads its own families at boot; any other family is summoned the
// first time one of its tools is called (so cross-family calls like claude.* → pdf.* work from any room).
const summoned = new Map();
function summon(module) {
  if (!summoned.has(module)) summoned.set(module, import(`../tools/${module}.js`).then(() => 'ok', (e) => { console.warn(`[μ] module ${module} not loaded:`, e); return `failed: ${e?.message || e}`; }));
  return summoned.get(module);
}
const moduleOf = (toolName) => DOMAIN_MODULE[String(toolName).split('.')[0]];
/** is this tool part of the room the page is showing? (others still run when called by name, but are not listed) */
const exposed = (tool) => !M.room || M.room.all || M.room.domains.has(tool.domain);

/** run(name, args) → raw tool result; throws on failure. Use from inside other tools. */
async function run(name, args = {}, parent) {
  let tool = tools.get(name);
  if (!tool && moduleOf(name)) { await summon(moduleOf(name)); tool = tools.get(name); }
  if (!tool) {
    const near = [...tools.keys()].filter((n) => n.includes(name.split('.').pop()) || n.startsWith(name.split('.')[0] + '.')).slice(0, 8);
    const room = roomOfDomain(String(name).split('.')[0]);
    throw new Error(`unknown tool "${name}"${near.length ? ` — did you mean: ${near.join(', ')}` : ''}${!near.length && !room ? ' — sys.rooms lists the rooms and their tool families' : ''}`);
  }
  const a = normaliseArgs(tool, args);
  const ctx = {
    tool: name,
    log: (msg) => emit('log', { level: 'info', tool: name, msg: String(msg) }),
    warn: (msg) => emit('log', { level: 'warn', tool: name, msg: String(msg) }),
    progress: (fraction, note) => emit('progress', { tool: name, fraction, note }),
    nested: !!parent,
  };
  return tool.run(a, ctx);
}

let seq = 0;
/**
 * call(name, args) → envelope {ok, tool, ms, result} | {ok:false, tool, ms, error}. Never throws. This is the agent entry point.
 * opts.via says who is calling: 'webmcp' (an agent through document.modelContext), 'terminal' (the prompt), default 'api' (script on the page).
 */
async function call(name, args = {}, opts = {}) {
  const via = opts.via || 'api';
  const id = ++seq; const t0 = performance.now();
  emit('call:start', { id, tool: name, args, via });
  let env;
  try {
    const result = await run(name, args);
    env = { ok: true, tool: name, ms: Math.round(performance.now() - t0), result: result === undefined ? null : result };
  } catch (e) {
    console.debug(`[μ] ${name} failed`, e);
    env = { ok: false, tool: name, ms: Math.round(performance.now() - t0), error: e?.message || String(e) };
  }
  M.last = env;
  emit('call:end', { id, via, ...env });
  return env;
}

/** output stats found in a tool result (result.output / result.outputs) */
function outputsOf(result) {
  if (!result || typeof result !== 'object') return [];
  const o = [];
  if (result.output?.path) o.push(result.output);
  if (Array.isArray(result.outputs)) for (const x of result.outputs) if (x?.path) o.push(x);
  return o;
}

function manifest(all = false) {
  return {
    name: 'metamorphosis', title: 'μεταμόρφωσις', version: VERSION,
    entry: 'window.M.call(name, args) → Promise<{ok, tool, ms, result|error}>',
    tools: [...tools.values()].filter((t) => all || exposed(t)).sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({
      name: t.name, room: roomOfDomain(t.domain) || '*', description: t.description, inputSchema: t.schema, gpu: t.gpu, readOnly: t.readOnly,
    })),
  };
}

// ────────────────────────────────────────────────────────────── gpu ──
// WebGPU device (lazy) + a registry of accelerated image kernels. CPU/WASM is always the fallback.
const gpuOps = new Map();
let gpuProbe = null;
let gpuState; // undefined = not probed, null = unavailable, {adapter, device, info}
const gpu = {
  ops: gpuOps,
  /** register an accelerated op: fn(img:{width,height,data:Uint8ClampedArray}, params, device) → Promise<img> */
  register(op, fn) { gpuOps.set(op, fn); },
  /** GPUDevice or null. Concurrent callers share one probe. */
  device() {
    if (gpuState !== undefined) return Promise.resolve(gpuState?.device || null);
    return (gpuProbe ||= (async () => {
      let st = null;
      try {
        const adapter = globalThis.navigator?.gpu ? await navigator.gpu.requestAdapter() : null;
        if (adapter) {
          // ask for what the adapter really has, so large images stay on the GPU
          const L = adapter.limits, want = {};
          for (const k of ['maxTextureDimension2D', 'maxBufferSize', 'maxStorageBufferBindingSize']) if (L?.[k]) want[k] = L[k];
          const device = await adapter.requestDevice({ requiredLimits: want }).catch(() => adapter.requestDevice());
          device.lost.then(() => { gpuState = undefined; });
          const i = adapter.info || {};
          st = { adapter, device, info: { vendor: i.vendor || '', architecture: i.architecture || '', device: i.device || '', description: i.description || '', fallback: !!(i.isFallbackAdapter ?? adapter.isFallbackAdapter), f16: adapter.features.has('shader-f16'), features: [...adapter.features].sort() } };
        }
      } catch (e) { console.warn('[μ] webgpu unavailable:', e); }
      gpuState = st; gpuProbe = null;
      return st?.device || null;
    })());
  },
  async info() { await gpu.device(); return gpuState ? { available: true, ...gpuState.info, ops: [...gpuOps.keys()] } : { available: false, ops: [] }; },
};
/**
 * accel(op, img, params, backend='auto') → {img, backend:'webgpu'} or null (caller then runs its CPU/WASM path).
 * backend: 'auto' (GPU if present, silently fall back) | 'gpu' (throw if impossible) | 'cpu' (always null).
 */
async function accel(op, img, params = {}, backend = 'auto') {
  if (backend === 'cpu') return null;
  if (!gpuOps.has(op) && globalThis.navigator?.gpu) await summon('gpu');
  const fn = gpuOps.get(op);
  const device = fn ? await gpu.device() : null;
  if (!fn || !device) {
    if (backend === 'gpu') throw new Error(fn ? 'backend=gpu requested but WebGPU is not available in this browser' : `backend=gpu requested but op "${op}" has no GPU kernel`);
    return null;
  }
  try { return { img: await fn(img, params, device), backend: 'webgpu' }; } catch (e) {
    if (backend === 'gpu') throw e;
    emit('log', { level: 'warn', tool: op, msg: `gpu path failed (${e.message}); falling back to cpu` });
    return null;
  }
}

// ───────────────────────────────────────────────────────── previews ──
// previewers: [{test(stat) → bool, render(stat, el) → Promise}], last registered wins.
const previewers = [];
function registerPreviewer(test, render) { previewers.unshift({ test, render }); }
function preview(path) { const stat = vfs.stat(path); emit('preview', { stat }); return stat; }

// ───────────────────────────────────────────────────────────── misc ──
const scripts = new Map();
/** load a classic (UMD/IIFE) script once; resolves when its globals exist */
function loadScript(url) {
  url = String(url);
  if (!scripts.has(url)) scripts.set(url, new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = url; s.onload = () => res(); s.onerror = () => { scripts.delete(url); rej(new Error(`failed to load ${url}`)); };
    document.head.appendChild(s);
  }));
  return scripts.get(url);
}
const b64 = {
  enc(bytes) { let s = ''; const C = 0x8000; for (let i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C)); return btoa(s); },
  dec(str) { const bin = atob(str.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
};
const human = (n) => { const u = ['B', 'K', 'M', 'G']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${i ? n.toFixed(1) : n}${u[i]}`; };

export const M = {
  version: VERSION, tools, vfs, gpu, previewers,
  register, run, call, manifest, accel, outputsOf, summon, exposed, room: null, registerPreviewer, preview, loadScript, b64, human,
  on: (type, fn) => bus.addEventListener(type, (e) => fn(e.detail)),
  emit, last: null, ready: null,
};
export { vfs, register, run, call, accel, gpu, loadScript, b64, human, registerPreviewer };
globalThis.M = globalThis.metamorphosis = globalThis['μ'] = M;
