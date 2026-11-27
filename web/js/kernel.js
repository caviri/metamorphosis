// μεταμόρφωσις :: kernel — lazy loader and thin typed wrappers for web/wasm/kernel.wasm (Rust, raw C ABI, SIMD),
// plus the small shared helpers of the raster tool families (image.*, analysis.*, dither.*).
// Nothing here touches the network or WebAssembly until kernel() is first awaited.
import { vfs } from './core.js';
import { decode } from './img.js';

const WASM_URL = new URL('../wasm/kernel.wasm', import.meta.url);
/** Hard limit for the raster tools: decoded images above this many pixels are refused (40 MP ≈ 160 MB of RGBA per buffer). */
export const MAX_PIXELS = 40e6;
const RESET_ABOVE = 768 * 1048576; // linear memory never shrinks: drop the instance once it has grown past this

let loading = null;

/** Marks an output buffer argument: K.call('histogram', data, w, h, o = out(Uint32Array, 1280)); afterwards o.value holds a copy. */
export class Out { constructor(Type, length) { this.Type = Type; this.length = length; this.value = null; } }
export const out = (Type, length) => new Out(Type, length);
/** Marks a buffer the kernel modifies in place: copied in, and copied back into .value (same type) after the call. */
export class InOut { constructor(data) { this.data = data; this.value = null; } }
export const io = (data) => new InOut(data);

class Kernel {
  constructor(x) { this.x = x; }
  get memoryBytes() { return this.x.memory.buffer.byteLength; }
  alloc(bytes) {
    const p = this.x.k_alloc(bytes) >>> 0;
    if (!p) throw new Error(`kernel: out of memory allocating ${(bytes / 1048576).toFixed(1)} MB — use a smaller image (image.resize maxSide=…)`);
    return p;
  }
  /**
   * call(name, ...args) → the export's return value.
   * number/boolean → passed through; TypedArray → copied into linear memory, pointer passed; Out → buffer allocated, pointer
   * passed, copied back into .value after the call; null → null pointer. Everything is freed afterwards.
   */
  call(name, ...args) {
    const fn = this.x[name];
    if (typeof fn !== 'function') throw new Error(`kernel: no export "${name}"`);
    const held = [];
    let trapped = false;
    try {
      const argv = args.map((a) => {
        if (a === null || a === undefined) return 0;
        if (typeof a === 'number') return a;
        if (typeof a === 'boolean') return a ? 1 : 0;
        if (a instanceof InOut) {
          const d = a.data; const p = this.alloc(d.byteLength); held.push([p, d.byteLength, a]);
          new Uint8Array(this.x.memory.buffer, p, d.byteLength).set(new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
          return p;
        }
        if (a instanceof Out) { const bytes = a.length * a.Type.BYTES_PER_ELEMENT; const p = this.alloc(bytes); held.push([p, bytes, a]); return p; }
        if (ArrayBuffer.isView(a)) {
          const p = this.alloc(a.byteLength); held.push([p, a.byteLength, null]);
          new Uint8Array(this.x.memory.buffer, p, a.byteLength).set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
          return p;
        }
        throw new Error(`kernel: unsupported argument for ${name}`);
      });
      const r = fn(...argv);
      const buf = this.x.memory.buffer;
      for (const [p, bytes, o] of held) if (o) o.value = new (o instanceof InOut ? o.data.constructor : o.Type)(buf.slice(p, p + bytes));
      return r;
    } catch (e) {
      if (e instanceof WebAssembly.RuntimeError) {
        trapped = true; loading = null; // state after a trap is not trustworthy: re-instantiate on next use
        throw new Error(`kernel: ${name} aborted (${e.message}) — almost always out of memory; use a smaller image (image.resize maxSide=…)`);
      }
      throw e;
    } finally {
      if (!trapped) {
        for (const [p, bytes] of held) this.x.k_free(p, bytes);
        if (this.memoryBytes > RESET_ABOVE) loading = null;
      }
    }
  }
  /** same-size image op: fn(src, w, h, dst, ...params) */
  img(name, img, ...params) {
    const o = out(Uint8ClampedArray, img.width * img.height * 4);
    this.call(name, img.data, img.width, img.height, o, ...params);
    return { width: img.width, height: img.height, data: o.value };
  }
  /** resizing image op: fn(src, sw, sh, dst, dw, dh, ...params) */
  imgTo(name, img, dw, dh, ...params) {
    const o = out(Uint8ClampedArray, dw * dh * 4);
    this.call(name, img.data, img.width, img.height, o, dw, dh, ...params);
    return { width: dw, height: dh, data: o.value };
  }
}

/** kernel() → Promise<Kernel>. Instantiates web/wasm/kernel.wasm on first use. */
export function kernel() {
  return (loading ||= (async () => {
    let instance;
    try { ({ instance } = await WebAssembly.instantiateStreaming(fetch(WASM_URL), {})); } catch {
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error(`kernel: cannot fetch kernel.wasm (HTTP ${res.status})`);
      ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {}));
    }
    return new Kernel(instance.exports);
  })().catch((e) => { loading = null; throw new Error(`kernel: failed to load WebAssembly kernel — ${e.message}`); }));
}

// ───────────────────────────────────────────────────── shared helpers ──

const u16 = (b, o, le) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o, le) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
const ascii = (b, o, n) => { let s = ''; for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };

/** Cheap header sniff: {format, width, height} without decoding (null fields when unknown). */
export function sniffSize(b) {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { format: 'png', width: u32(b, 16), height: u32(b, 20) };
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') return { format: 'gif', width: u16(b, 6, true), height: u16(b, 8, true) };
  if (b.length >= 26 && ascii(b, 0, 2) === 'BM') return { format: 'bmp', width: Math.abs(u32(b, 18, true) | 0), height: Math.abs(u32(b, 22, true) | 0) };
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const t = ascii(b, 12, 4);
    if (t === 'VP8X') return { format: 'webp', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (t === 'VP8L') { const v = u32(b, 21, true); return { format: 'webp', width: 1 + (v & 0x3fff), height: 1 + ((v >>> 14) & 0x3fff) }; }
    if (t === 'VP8 ') return { format: 'webp', width: u16(b, 26, true) & 0x3fff, height: u16(b, 28, true) & 0x3fff };
    return { format: 'webp', width: null, height: null };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { format: 'jpeg', width: u16(b, o + 7), height: u16(b, o + 5) };
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
      if (m === 0xda || m === 0xd9) break;
      o += 2 + u16(b, o + 2);
    }
    return { format: 'jpeg', width: null, height: null };
  }
  return { format: null, width: null, height: null };
}

/**
 * open(path) → img, refusing images above MAX_PIXELS before any pixel is decoded where the header allows it.
 * opts.maxSide downsizes at decode time (browser resampling) for analysis tools that do not need full resolution.
 */
export async function open(path, opts = {}) {
  const bytes = vfs.read(path);
  const limit = opts.maxPixels || MAX_PIXELS;
  const tooBig = (w, h) => new Error(`"${path}" is ${w}×${h} = ${(w * h / 1e6).toFixed(1)} MP; the raster tools accept at most ${(limit / 1e6).toFixed(0)} MP — downscale it first (outside this tool family) or crop the source`);
  const s = sniffSize(bytes);
  if (s.width && s.height && !opts.maxSide && s.width * s.height > limit) throw tooBig(s.width, s.height);
  const img = await decode(path, opts.maxSide ? { maxSide: opts.maxSide } : {});
  if (img.width * img.height > limit) throw tooBig(img.width, img.height);
  if (s.width && s.height) { img.sourceWidth = s.width; img.sourceHeight = s.height; }
  return img;
}

/** '#rgb' | '#rrggbb' | '#rrggbbaa' | 'r,g,b[,a]' | a few names → [r,g,b,a] */
export function parseColor(c, fallback = [0, 0, 0, 255]) {
  if (c === undefined || c === null || c === '') return fallback;
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] === undefined ? 255 : c[3] | 0];
  const names = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff', gray: '#808080', grey: '#808080', yellow: '#ffff00', cyan: '#00ffff', magenta: '#ff00ff', transparent: '#00000000' };
  let s = String(c).trim().toLowerCase(); s = names[s] || s;
  let m = /^#?([0-9a-f]{3,8})$/.exec(s);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1]; if (h.length <= 4) h = [...h].map((x) => x + x).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255];
  }
  m = s.split(/[\s,]+/).map(Number);
  if ((m.length === 3 || m.length === 4) && m.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return [m[0], m[1], m[2], m.length === 4 ? m[3] : 255];
  throw new Error(`cannot parse colour "${c}" — use #rgb, #rrggbb, #rrggbbaa, "r,g,b[,a]" (0..255) or one of: ${Object.keys(names).join(', ')}`);
}
export const packRGBA = (c) => ((c[0] << 24) | (c[1] << 16) | (c[2] << 8) | c[3]) >>> 0;
export const hex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// Colour maps → 256×RGB lookup tables.
// viridis/magma/inferno/plasma are piecewise-linear interpolations of the matplotlib maps sampled at 11 evenly spaced
// anchors (error vs. the 256-entry originals is a few levels at most); turbo is Google's published degree-5 polynomial fit;
// jet/hot/cool/bone/rainbow are their closed-form definitions.
const ANCHORS = {
  viridis: ['440154', '482475', '414487', '355f8d', '2a788e', '21918c', '22a884', '44bf70', '7ad151', 'bddf26', 'fde725'],
  magma: ['000004', '140e36', '3b0f70', '641a80', '8c2981', 'b73779', 'de4968', 'f7705c', 'fe9f6d', 'fecf92', 'fcfdbf'],
  inferno: ['000004', '160b39', '420a68', '6a176e', '932667', 'bc3754', 'dd513a', 'f37819', 'fca50a', 'f6d746', 'fcffa4'],
  plasma: ['0d0887', '41049d', '6a00a8', '8f0da4', 'b12a90', 'cc4778', 'e16462', 'f2844b', 'fca636', 'fcce25', 'f0f921'],
};
export const COLORMAPS = ['viridis', 'magma', 'inferno', 'plasma', 'turbo', 'jet', 'hot', 'cool', 'bone', 'rainbow', 'gray'];
const lutCache = new Map();
export function colormapLut(name, reverse = false) {
  const key = name + (reverse ? ':r' : '');
  if (lutCache.has(key)) return lutCache.get(key);
  const lut = new Uint8Array(768);
  const c01 = (v) => Math.max(0, Math.min(1, v));
  for (let i = 0; i < 256; i++) {
    const x = (reverse ? 255 - i : i) / 255; let r, g, b;
    if (ANCHORS[name]) {
      const a = ANCHORS[name]; const f = x * (a.length - 1); const k = Math.min(a.length - 2, Math.floor(f)); const t = f - k;
      const p = (h, o) => parseInt(h.slice(o, o + 2), 16) / 255;
      r = p(a[k], 0) * (1 - t) + p(a[k + 1], 0) * t; g = p(a[k], 2) * (1 - t) + p(a[k + 1], 2) * t; b = p(a[k], 4) * (1 - t) + p(a[k + 1], 4) * t;
    } else if (name === 'turbo') {
      r = 0.13572138 + x * (4.61539260 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
      g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
      b = 0.10667330 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
    } else if (name === 'jet') { r = 1.5 - Math.abs(4 * x - 3); g = 1.5 - Math.abs(4 * x - 2); b = 1.5 - Math.abs(4 * x - 1); }
    else if (name === 'hot') { r = x / 0.375; g = (x - 0.375) / 0.375; b = (x - 0.75) / 0.25; }
    else if (name === 'cool') { r = x; g = 1 - x; b = 1; }
    else if (name === 'bone') { r = (7 * x + c01((x - 0.75) / 0.25)) / 8; g = (7 * x + c01((x - 0.375) / 0.375)) / 8; b = (7 * x + c01(x / 0.375)) / 8; }
    else if (name === 'rainbow') { const h = (1 - x) * 4.5; const f = (n) => { const k = (n + h) % 6; return 1 - Math.max(0, Math.min(k, 4 - k, 1)); }; r = f(5); g = f(3); b = f(1); }
    else { r = g = b = x; }
    lut[i * 3] = Math.round(c01(r) * 255); lut[i * 3 + 1] = Math.round(c01(g) * 255); lut[i * 3 + 2] = Math.round(c01(b) * 255);
  }
  lutCache.set(key, lut);
  return lut;
}

// ── exact PNG I/O (canvas encoders premultiply alpha, which destroys low bits of semi-transparent pixels) ──
let crcTable;
function crc32(bytes, crc = 0xffffffff) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/** Bit-exact RGBA8 PNG (zlib via CompressionStream, filter type 0). Larger than the canvas encoder's output but never alters a bit. */
export async function encodePngExact(img) {
  const { width: w, height: h, data } = img; const stride = w * 4 + 1;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), y * stride + 1);
  const z = await pipe(raw, new CompressionStream('deflate'));
  const chunk = (type, body) => {
    const c = new Uint8Array(12 + body.length); const dv = new DataView(c.buffer);
    dv.setUint32(0, body.length); for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i); c.set(body, 8);
    dv.setUint32(8 + body.length, (crc32(c.subarray(4, 8 + body.length)) ^ 0xffffffff) >>> 0);
    return c;
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const outb = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { outb.set(p, o); o += p.length; }
  return outb;
}

/**
 * decodeExact(path) → {img, exact}. 8-bit non-interlaced PNGs with an alpha channel (colour types 4 and 6) are inflated and
 * unfiltered here so RGB under semi-transparent pixels is bit-exact; everything else goes through the browser decoder, which is
 * already exact for opaque images.
 */
export async function decodeExact(path) {
  const b = vfs.read(path);
  const isPng = b.length > 33 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG';
  if (isPng && b[24] === 8 && (b[25] === 6 || b[25] === 4) && b[28] === 0) {
    const w = u32(b, 16), h = u32(b, 20), bpp = b[25] === 6 ? 4 : 2;
    if (w * h > MAX_PIXELS) throw new Error(`"${path}" is ${w}×${h}; the raster tools accept at most ${MAX_PIXELS / 1e6} MP`);
    const idat = []; let o = 8;
    while (o + 12 <= b.length) { const len = u32(b, o); const type = ascii(b, o + 4, 4); if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len)); if (type === 'IEND') break; o += 12 + len; }
    const z = new Uint8Array(idat.reduce((a, p) => a + p.length, 0)); let zo = 0; for (const p of idat) { z.set(p, zo); zo += p.length; }
    const raw = await pipe(z, new DecompressionStream('deflate'));
    const stride = w * bpp;
    if (raw.length < (stride + 1) * h) throw new Error(`"${path}": truncated PNG data`);
    const cur = new Uint8Array(stride); let prev = new Uint8Array(stride);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)]; const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a; else if (f === 2) pred = up; else if (f === 3) pred = (a + up) >> 1;
        else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
        cur[i] = (line[i] + pred) & 255;
      }
      if (bpp === 4) data.set(cur, y * stride);
      else for (let x = 0; x < w; x++) { const g = cur[x * 2], q = (y * w + x) * 4; data[q] = data[q + 1] = data[q + 2] = g; data[q + 3] = cur[x * 2 + 1]; }
      prev.set(cur);
    }
    return { img: { width: w, height: h, data }, exact: true };
  }
  return { img: await open(path), exact: false };
}

/** run a GPU-capable op: WebGPU through accel() when available/allowed, else the WASM closure. → {img, backend} */
export async function gpuOr(accel, op, img, params, backend, wasm) {
  const r = await accel(op, img, params, backend);
  if (r) return { img: r.img, backend: 'webgpu' };
  return { img: await wasm(await kernel()), backend: 'wasm' };
}

export const IN = { type: 'string', description: 'VFS path of the source image (png, jpeg, webp, gif, bmp, avif, svg — anything the browser decodes; max 40 megapixels)' };
export const OUT = { type: 'string', description: 'VFS path to write; the extension picks the format (png, jpg, webp). Default: derived from the input name, PNG' };
export const BACKEND = { type: 'string', enum: ['auto', 'gpu', 'cpu'], default: 'auto', description: 'auto = WebGPU when available, else the WASM kernel; gpu = require WebGPU; cpu = force WASM' };
