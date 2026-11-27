// image.* — raster editing. Pixels are processed by the Rust/WASM kernel (web/wasm/kernel.wasm); tools flagged gpu:true
// first try the WebGPU kernels through accel() and fall back to WASM with identical semantics.
import { vfs, register, accel } from '../js/core.js';
import { save, encode } from '../js/img.js';
import { kernel, out, open, parseColor, packRGBA, colormapLut, COLORMAPS, gpuOr, sniffSize, MAX_PIXELS, IN, OUT, BACKEND } from '../js/kernel.js';

const QUALITY = { type: 'number', minimum: 0, maximum: 100, description: 'Quality for jpg/webp output: 0..1, or 1..100 as a percentage (default 0.92 jpg / 0.8 webp; ignored for png)' };
const quality = (q) => (q === undefined ? undefined : q > 1 ? q / 100 : q);
const write = (img, args, tag, meta) => save(img, vfs.out(args.output, args.input, tag, 'png'), { quality: quality(args.quality), meta });
const checkSize = (w, h, what = 'output') => {
  if (!(w >= 1 && h >= 1)) throw new Error(`${what} would be empty (${w}×${h})`);
  if (w * h > MAX_PIXELS) throw new Error(`${what} would be ${w}×${h} = ${(w * h / 1e6).toFixed(1)} MP; the limit is ${MAX_PIXELS / 1e6} MP`);
  if (w > 16384 || h > 16384) throw new Error(`${what} would be ${w}×${h}; no side may exceed 16384 px (browser canvas limit)`);
};

// ───────────────────────────────────────────────────── metadata parsing ──
const u16 = (b, o, le) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o, le) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0;
const latin = (b, o, n) => { let s = ''; for (let i = o; i < Math.min(o + n, b.length); i++) s += String.fromCharCode(b[i]); return s; };
const utf8 = (b) => new TextDecoder('utf-8', { fatal: false }).decode(b);
const clip = (s, n = 200) => (s.length > n ? s.slice(0, n) + '…' : s);

const TIFF_TAGS = {
  0x010e: 'imageDescription', 0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation', 0x011a: 'xResolution', 0x011b: 'yResolution', 0x0128: 'resolutionUnit',
  0x0131: 'software', 0x0132: 'dateTime', 0x013b: 'artist', 0x8298: 'copyright', 0x0100: 'imageWidth', 0x0101: 'imageLength', 0x0102: 'bitsPerSample', 0x0106: 'photometric', 0x0115: 'samplesPerPixel',
};
const EXIF_TAGS = {
  0x829a: 'exposureTime', 0x829d: 'fNumber', 0x8822: 'exposureProgram', 0x8827: 'iso', 0x9000: 'exifVersion', 0x9003: 'dateTimeOriginal', 0x9004: 'dateTimeDigitized',
  0x9010: 'offsetTime', 0x9204: 'exposureBias', 0x9207: 'meteringMode', 0x9209: 'flash', 0x920a: 'focalLength', 0xa001: 'colorSpace', 0xa002: 'pixelXDimension', 0xa003: 'pixelYDimension',
  0xa405: 'focalLengthIn35mm', 0xa433: 'lensMake', 0xa434: 'lensModel', 0xa431: 'bodySerialNumber',
};
const GPS_TAGS = { 1: 'latRef', 2: 'lat', 3: 'lonRef', 4: 'lon', 5: 'altRef', 6: 'alt', 7: 'timeStamp', 0x1d: 'dateStamp', 0x10: 'imgDirectionRef', 0x11: 'imgDirection' };
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/** Parse a TIFF/EXIF block → {tiff:{}, exif:{}, gps:{}} with a handful of well-known tags. Tolerant of truncation. */
function parseTiff(t) {
  const res = { tiff: {}, exif: {}, gps: {} };
  if (t.length < 8) return res;
  const le = t[0] === 0x49;
  if (!((t[0] === 0x49 && t[1] === 0x49) || (t[0] === 0x4d && t[1] === 0x4d)) || u16(t, 2, le) !== 42) return res;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const readIfd = (off, names, into) => {
    const ptrs = {};
    if (off + 2 > t.length) return ptrs;
    const n = u16(t, off, le);
    for (let i = 0; i < n && off + 14 + i * 12 <= t.length; i++) {
      const e = off + 2 + i * 12; const tag = u16(t, e, le), type = u16(t, e + 2, le), count = u32(t, e + 4, le);
      const size = (TYPE_SIZE[type] || 1) * count; const vo = size <= 4 ? e + 8 : u32(t, e + 8, le);
      if (vo + size > t.length) continue;
      if (tag === 0x8769 || tag === 0x8825) { ptrs[tag] = u32(t, e + 8, le); continue; }
      const name = names[tag]; if (!name) continue;
      let v;
      const one = (j) => {
        const o = vo + j * TYPE_SIZE[type];
        switch (type) {
          case 1: case 7: return t[o]; case 6: return dv.getInt8(o);
          case 3: return dv.getUint16(o, le); case 8: return dv.getInt16(o, le);
          case 4: return dv.getUint32(o, le); case 9: return dv.getInt32(o, le);
          case 5: { const d = dv.getUint32(o + 4, le); return d ? dv.getUint32(o, le) / d : 0; }
          case 10: { const d = dv.getInt32(o + 4, le); return d ? dv.getInt32(o, le) / d : 0; }
          case 11: return dv.getFloat32(o, le); case 12: return dv.getFloat64(o, le);
          default: return null;
        }
      };
      if (type === 2) v = clip(latin(t, vo, count).replace(/\0.*$/s, '').trim());
      else if (type === 7 && name === 'exifVersion') v = latin(t, vo, count);
      else if (count === 1) v = one(0);
      else v = Array.from({ length: Math.min(count, 8) }, (_, j) => one(j));
      if (typeof v === 'number' && !Number.isInteger(v)) v = Math.round(v * 1e6) / 1e6;
      into[name] = v;
    }
    return ptrs;
  };
  const p = readIfd(u32(t, 4, le), TIFF_TAGS, res.tiff);
  if (p[0x8769]) readIfd(p[0x8769], EXIF_TAGS, res.exif);
  if (p[0x8825]) {
    const g = {}; readIfd(p[0x8825], GPS_TAGS, g);
    const dms = (a) => (Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : null);
    const lat = dms(g.lat), lon = dms(g.lon);
    if (lat !== null && lon !== null) { res.gps.latitude = +((g.latRef === 'S' ? -lat : lat).toFixed(7)); res.gps.longitude = +((g.lonRef === 'W' ? -lon : lon).toFixed(7)); }
    if (typeof g.alt === 'number') res.gps.altitude = g.altRef === 1 ? -g.alt : g.alt;
    if (g.dateStamp) res.gps.date = g.dateStamp;
    if (typeof g.imgDirection === 'number') res.gps.direction = g.imgDirection;
  }
  if (res.exif.exposureTime) res.exif.exposure = res.exif.exposureTime >= 1 ? `${res.exif.exposureTime}s` : `1/${Math.round(1 / res.exif.exposureTime)}s`;
  return res;
}

/** A few name/value pairs out of an XMP packet (attributes and simple elements), values clipped. */
function parseXmp(text) {
  const o = {}; let n = 0;
  const want = /^(xmp|dc|photoshop|tiff|exif|xmpMM|Iptc4xmpCore|xmpRights|aux|crs|GPano|Camera):/;
  for (const m of text.matchAll(/\s([A-Za-z0-9]+:[A-Za-z0-9]+)="([^"]*)"/g)) { if (want.test(m[1]) && n < 40 && !(m[1] in o) && m[2]) { o[m[1]] = clip(m[2], 120); n++; } }
  for (const m of text.matchAll(/<([A-Za-z0-9]+:[A-Za-z0-9]+)>([^<]+)<\/\1>/g)) { if (want.test(m[1]) && n < 40 && !(m[1] in o) && m[2].trim()) { o[m[1]] = clip(m[2].trim(), 120); n++; } }
  for (const m of text.matchAll(/<(dc:[A-Za-z]+)>\s*<rdf:(?:Alt|Seq|Bag)>\s*<rdf:li[^>]*>([^<]+)</g)) { if (n < 40 && !(m[1] in o)) { o[m[1]] = clip(m[2].trim(), 120); n++; } }
  return o;
}

/** Container-level facts read straight from the bytes. Also returns `segments` for stripMetadata. */
function inspect(b) {
  const r = { format: null, width: null, height: null, metadata: [] };
  const exifFrom = (t) => { const p = parseTiff(t); r.tiffTags = p.tiff; if (Object.keys(p.exif).length) r.exif = p.exif; if (Object.keys(p.gps).length) r.gps = p.gps; };
  if (b.length > 24 && b[0] === 0x89 && latin(b, 1, 3) === 'PNG') {
    r.format = 'png'; r.width = u32(b, 16); r.height = u32(b, 20); r.bitDepth = b[24];
    const ct = b[25]; r.colorType = { 0: 'grayscale', 2: 'rgb', 3: 'palette', 4: 'grayscale+alpha', 6: 'rgba' }[ct] || `unknown(${ct})`;
    r.channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct] || null; r.alphaChannel = ct === 4 || ct === 6; r.interlaced = b[28] === 1;
    r.text = {};
    for (let o = 8; o + 12 <= b.length;) {
      const len = u32(b, o), type = latin(b, o + 4, 4), d = b.subarray(o + 8, o + 8 + len);
      if (type === 'pHYs' && len >= 9) { const x = u32(d, 0), y = u32(d, 4); if (d[8] === 1) r.dpi = { x: +(x * 0.0254).toFixed(2), y: +(y * 0.0254).toFixed(2) }; else r.pixelAspect = y ? +(x / y).toFixed(4) : null; }
      else if (type === 'tRNS') r.alphaChannel = true;
      else if (type === 'gAMA' && len >= 4) r.gamma = +(u32(d, 0) / 100000).toFixed(5);
      else if (type === 'sRGB') r.srgb = true;
      else if (type === 'iCCP') { r.icc = { present: true, name: latin(d, 0, Math.min(79, d.indexOf(0))) }; }
      else if (type === 'acTL' && len >= 8) { r.animated = true; r.frames = u32(d, 0); }
      else if (type === 'eXIf') { exifFrom(d); r.metadata.push('exif'); }
      else if (type === 'tIME' && len >= 7) { r.modified = `${u16(d, 0)}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}T${String(d[4]).padStart(2, '0')}:${String(d[5]).padStart(2, '0')}:${String(d[6]).padStart(2, '0')}Z`; r.metadata.push('time'); }
      else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const z = d.indexOf(0); const key = latin(d, 0, z < 0 ? len : z);
        if (key === 'XML:com.adobe.xmp') { r.xmp = parseXmp(utf8(d.subarray(z + 5))); r.metadata.push('xmp'); }
        else {
          let val = '(compressed)';
          if (type === 'tEXt') val = latin(d, z + 1, len - z - 1);
          else if (type === 'iTXt' && d[z + 1] === 0) { let q = z + 3; q = d.indexOf(0, q) + 1; q = d.indexOf(0, q) + 1; val = utf8(d.subarray(q)); }
          if (Object.keys(r.text).length < 20) r.text[key] = clip(val);
          if (!r.metadata.includes('text')) r.metadata.push('text');
        }
      }
      if (type === 'IEND') break;
      o += 12 + len;
    }
    if (!Object.keys(r.text).length) delete r.text;
    return r;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    r.format = 'jpeg'; let iccBytes = 0;
    for (let o = 2; o + 4 <= b.length;) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { o += 2; continue; }
      if (m === 0xd9 || m === 0xda) break;
      const len = u16(b, o + 2); const d = b.subarray(o + 4, o + 2 + len);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        r.bitDepth = d[0]; r.height = u16(d, 1); r.width = u16(d, 3); r.channels = d[5];
        r.colorType = { 1: 'grayscale', 3: 'ycbcr', 4: 'cmyk' }[d[5]] || `${d[5]} components`;
        r.progressive = m === 0xc2 || m === 0xca; r.lossless = m === 0xc3; r.alphaChannel = false;
        if (d[5] === 3 && d.length >= 15) { const h = d[7] >> 4, v = d[7] & 15; r.chromaSubsampling = h === 2 && v === 2 ? '4:2:0' : h === 2 && v === 1 ? '4:2:2' : h === 1 && v === 1 ? '4:4:4' : `${h}x${v}`; }
      } else if (m === 0xe0 && latin(d, 0, 4) === 'JFIF' && d.length >= 12) {
        const units = d[7], x = u16(d, 8), y = u16(d, 10);
        if (units === 1) r.dpi = { x, y }; else if (units === 2) r.dpi = { x: +(x * 2.54).toFixed(2), y: +(y * 2.54).toFixed(2) };
      } else if (m === 0xe1 && latin(d, 0, 4) === 'Exif') { exifFrom(d.subarray(6)); r.metadata.push('exif'); }
      else if (m === 0xe1 && latin(d, 0, 28) === 'http://ns.adobe.com/xap/1.0/') { r.xmp = parseXmp(utf8(d.subarray(29))); r.metadata.push('xmp'); }
      else if (m === 0xe2 && latin(d, 0, 11) === 'ICC_PROFILE') iccBytes += d.length - 14;
      else if (m === 0xe2 && latin(d, 0, 3) === 'MPF') r.metadata.push('mpf');
      else if (m === 0xed) r.metadata.push('iptc/photoshop');
      else if (m === 0xee && latin(d, 0, 5) === 'Adobe') r.adobeTransform = d[11];
      else if (m === 0xfe) { r.comment = clip(utf8(d)); r.metadata.push('comment'); }
      o += 2 + len;
    }
    if (iccBytes) r.icc = { present: true, bytes: iccBytes };
    return r;
  }
  if (b.length > 20 && latin(b, 0, 4) === 'RIFF' && latin(b, 8, 4) === 'WEBP') {
    r.format = 'webp'; r.bitDepth = 8; const s = sniffSize(b); r.width = s.width; r.height = s.height; r.alphaChannel = false; let frames = 0;
    for (let o = 12; o + 8 <= b.length;) {
      const type = latin(b, o, 4), len = u32(b, o + 4, true), d = b.subarray(o + 8, o + 8 + len);
      if (type === 'VP8X') { const f = d[0]; r.alphaChannel = !!(f & 0x10); r.animated = !!(f & 0x02); if (f & 0x20) r.icc = { present: true }; }
      else if (type === 'VP8L') { r.compression = 'lossless'; if (d.length >= 5 && (d[4] >> 4) & 1) r.alphaChannel = true; }
      else if (type === 'VP8 ') r.compression ||= 'lossy';
      else if (type === 'ALPH') r.alphaChannel = true;
      else if (type === 'ANMF') frames++;
      else if (type === 'EXIF') { exifFrom(latin(d, 0, 4) === 'Exif' ? d.subarray(6) : d); r.metadata.push('exif'); }
      else if (type === 'XMP ') { r.xmp = parseXmp(utf8(d)); r.metadata.push('xmp'); }
      if (type === 'ANMF' || type === 'VP8X' || type !== 'RIFF') o += 8 + len + (len & 1);
    }
    if (frames) r.frames = frames;
    return r;
  }
  if (b.length > 12 && latin(b, 0, 3) === 'GIF') {
    r.format = 'gif'; r.width = u16(b, 6, true); r.height = u16(b, 8, true); r.bitDepth = 8; r.colorType = 'palette'; r.alphaChannel = false;
    let o = 13 + ((b[10] & 0x80) ? 3 * (1 << ((b[10] & 7) + 1)) : 0), frames = 0;
    const skipBlocks = () => { while (o < b.length && b[o]) o += b[o] + 1; o++; };
    while (o < b.length && frames < 100000) {
      if (b[o] === 0x2c) { frames++; const f = b[o + 9]; o += 10 + ((f & 0x80) ? 3 * (1 << ((f & 7) + 1)) : 0) + 1; skipBlocks(); }
      else if (b[o] === 0x21) { if (b[o + 1] === 0xf9 && (b[o + 3] & 1)) r.alphaChannel = true; o += 2; skipBlocks(); }
      else break;
    }
    r.frames = frames; r.animated = frames > 1;
    return r;
  }
  if (b.length > 30 && latin(b, 0, 2) === 'BM') {
    r.format = 'bmp'; r.width = Math.abs(u32(b, 18, true) | 0); r.height = Math.abs(u32(b, 22, true) | 0); r.bitDepth = u16(b, 28, true) <= 8 ? u16(b, 28, true) : 8; r.bitsPerPixel = u16(b, 28, true); r.alphaChannel = r.bitsPerPixel === 32;
    const x = u32(b, 38, true), y = u32(b, 42, true); if (x && y) r.dpi = { x: +(x * 0.0254).toFixed(2), y: +(y * 0.0254).toFixed(2) };
    return r;
  }
  if (b.length > 16 && latin(b, 4, 4) === 'ftyp') {
    const brand = latin(b, 8, 4); r.format = /avi[fs]/.test(brand) ? 'avif' : /hei[cfx]|mif1|msf1/.test(brand) ? 'heic' : `isobmff(${brand.trim()})`;
    for (let i = 12; i + 16 < Math.min(b.length, 65536); i++) if (b[i] === 0x69 && latin(b, i, 4) === 'ispe') { r.width = u32(b, i + 8); r.height = u32(b, i + 12); break; }
    for (let i = 12; i + 12 < Math.min(b.length, 65536); i++) if (b[i] === 0x70 && latin(b, i, 4) === 'pixi') { r.channels = b[i + 8]; r.bitDepth = b[i + 9]; break; }
    return r;
  }
  if (b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 42))) {
    r.format = 'tiff'; const p = parseTiff(b); r.width = p.tiff.imageWidth ?? null; r.height = p.tiff.imageLength ?? null;
    r.bitDepth = Array.isArray(p.tiff.bitsPerSample) ? p.tiff.bitsPerSample[0] : p.tiff.bitsPerSample ?? null; r.channels = p.tiff.samplesPerPixel ?? null;
    r.tiffTags = p.tiff; if (Object.keys(p.exif).length) r.exif = p.exif; if (Object.keys(p.gps).length) r.gps = p.gps;
    return r;
  }
  if (b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) { r.format = 'ico'; r.frames = u16(b, 4, true); r.width = b[6] || 256; r.height = b[7] || 256; return r; }
  const head = utf8(b.subarray(0, 2048));
  if (/<svg[\s>]/i.test(head)) {
    r.format = 'svg'; const tag = /<svg[^>]*>/i.exec(head)?.[0] || '';
    const w = /\swidth="([\d.]+)(px)?"/.exec(tag), h = /\sheight="([\d.]+)(px)?"/.exec(tag), vb = /viewBox="([^"]+)"/.exec(tag);
    if (w && h) { r.width = +w[1]; r.height = +h[1]; } else if (vb) { const p = vb[1].split(/[\s,]+/).map(Number); r.width = p[2]; r.height = p[3]; }
    r.vector = true;
  }
  return r;
}

register({
  name: 'image.info', readOnly: true,
  description: 'Facts about an image file, read from its bytes (not from the file name): sniffed format, pixel dimensions, megapixels, bit depth, colour type / channels, whether the container declares alpha and whether any pixel is actually transparent, whether it is effectively grayscale, DPI (PNG pHYs, JFIF, EXIF), JPEG progressive flag and chroma subsampling, animation frame count, ICC profile presence, EXIF basics (camera, lens, exposure, ISO, date, orientation), GPS position, XMP fields and PNG text chunks. Use it first when you receive an unknown image, or to check for privacy-sensitive metadata. Formats parsed: png, jpeg, webp, gif, bmp, avif/heic (size only), tiff (tags only), ico, svg.',
  schema: { properties: { input: IN, pixels: { type: 'boolean', default: true, description: 'Also decode the image and scan the pixels (true alpha usage, grayscale test). Set false for a header-only answer on huge files' } }, required: ['input'] },
  examples: ['image.info input=photo.jpg'],
  async run({ input, pixels }) {
    const bytes = vfs.read(input);
    const r = inspect(bytes);
    const res = { path: vfs.stat(input).path, bytes: bytes.length, format: r.format || 'unknown', mime: r.format ? (vfs.mimeOf('x.' + (r.format === 'jpeg' ? 'jpg' : r.format)) || null) : null, width: r.width, height: r.height };
    if (r.width && r.height) { res.megapixels = +(r.width * r.height / 1e6).toFixed(3); res.aspectRatio = +(r.width / r.height).toFixed(4); }
    for (const k of ['bitDepth', 'bitsPerPixel', 'channels', 'colorType', 'alphaChannel', 'interlaced', 'progressive', 'lossless', 'chromaSubsampling', 'compression', 'animated', 'frames', 'vector', 'gamma', 'srgb', 'pixelAspect', 'modified', 'comment']) if (r[k] !== undefined && r[k] !== null) res[k] = r[k];
    const t = r.tiffTags || {};
    if (!r.dpi && t.xResolution && t.yResolution) { const k = t.resolutionUnit === 3 ? 2.54 : 1; r.dpi = { x: +(t.xResolution * k).toFixed(2), y: +(t.yResolution * k).toFixed(2) }; r.dpiSource = 'exif'; }
    if (r.dpi) res.dpi = r.dpi;
    if (r.width && r.dpi?.x) res.printSizeInches = { width: +(r.width / r.dpi.x).toFixed(2), height: +(r.height / r.dpi.y).toFixed(2) };
    if (t.orientation) { res.orientation = t.orientation; res.orientationMeaning = ['', 'normal', 'mirrored horizontally', 'rotated 180°', 'mirrored vertically', 'mirrored horizontally then rotated 90° CCW', 'rotated 90° CW to display', 'mirrored horizontally then rotated 90° CW', 'rotated 90° CCW to display'][t.orientation] || 'unknown'; }
    const cam = {}; for (const k of ['make', 'model', 'software', 'dateTime', 'artist', 'copyright', 'imageDescription']) if (t[k] !== undefined && t[k] !== '') cam[k] = t[k];
    if (Object.keys(cam).length || r.exif) res.exif = { ...cam, ...(r.exif || {}) };
    if (r.gps) res.gps = r.gps;
    if (r.xmp && Object.keys(r.xmp).length) res.xmp = r.xmp;
    if (r.text) res.text = r.text;
    if (r.icc) res.icc = r.icc;
    res.metadata = [...new Set(r.metadata)];
    if (r.gps) res.metadata.push('gps');
    res.hasMetadata = res.metadata.length > 0;
    if (pixels && r.format !== 'tiff') {
      if (r.width && r.height && r.width * r.height > MAX_PIXELS) res.pixelScan = `skipped: ${res.megapixels} MP exceeds the ${MAX_PIXELS / 1e6} MP limit`;
      else {
        try {
          const img = await open(input); const K = await kernel(); const o = out(Uint32Array, 5);
          K.call('alpha_info', img.data, img.width, img.height, o);
          res.decodedWidth = img.width; res.decodedHeight = img.height;
          res.hasAlpha = o.value[2] > 0; res.transparentPixels = o.value[2]; res.fullyTransparentPixels = o.value[4]; res.minAlpha = o.value[0]; res.isGrayscale = !!o.value[3];
          if (res.width === null) { res.width = img.width; res.height = img.height; }
        } catch (e) { res.decodable = false; res.decodeError = e.message; }
      }
    }
    return res;
  },
});

// ─────────────────────────────────────────────────────────── stripping ──
function stripBytes(b, keepIcc, keepOrientation) {
  const removed = []; const parts = [];
  const push = (x) => parts.push(x);
  const info = inspect(b);
  if (info.format === 'jpeg') {
    push(b.subarray(0, 2)); let o = 2;
    const orient = info.tiffTags?.orientation;
    if (keepOrientation && orient && orient !== 1) {
      // minimal EXIF holding only the Orientation tag, so the picture still displays the right way up
      push(new Uint8Array([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orient, 0, 0, 0, 0, 0, 0]));
    }
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) throw new Error('malformed JPEG (marker expected)');
      const m = b[o + 1];
      if (m === 0xda) { push(b.subarray(o)); break; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { push(b.subarray(o, o + 2)); o += 2; continue; }
      const len = u16(b, o + 2); const seg = b.subarray(o, o + 2 + len); const id = latin(b, o + 4, 12);
      const isIcc = m === 0xe2 && id.startsWith('ICC_PROFILE');
      const drop = m === 0xfe || (m >= 0xe1 && m <= 0xef && m !== 0xee && !(isIcc && keepIcc));
      if (drop) removed.push({ segment: m === 0xfe ? 'COM' : `APP${m - 0xe0}`, what: m === 0xfe ? 'comment' : id.startsWith('Exif') ? 'exif' : id.startsWith('http') ? 'xmp' : isIcc ? 'icc' : m === 0xed ? 'iptc/photoshop' : id.replace(/[^\x20-\x7e].*$/s, '') || 'app data', bytes: seg.length });
      else push(seg);
      o += 2 + len;
    }
  } else if (info.format === 'png') {
    push(b.subarray(0, 8));
    for (let o = 8; o + 12 <= b.length;) {
      const len = u32(b, o), type = latin(b, o + 4, 4), seg = b.subarray(o, o + 12 + len);
      const drop = ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type) || (type === 'iCCP' && !keepIcc);
      if (drop) removed.push({ segment: type, what: type === 'eXIf' ? 'exif' : type === 'tIME' ? 'time' : type === 'iCCP' ? 'icc' : latin(b, o + 8, Math.min(40, len)).replace(/\0.*$/s, ''), bytes: seg.length }); else push(seg);
      o += 12 + len;
      if (type === 'IEND') break;
    }
  } else if (info.format === 'webp') {
    const body = [];
    for (let o = 12; o + 8 <= b.length;) {
      const type = latin(b, o, 4), len = u32(b, o + 4, true), total = 8 + len + (len & 1);
      let seg = b.subarray(o, Math.min(b.length, o + total));
      const drop = type === 'EXIF' || type === 'XMP ' || (type === 'ICCP' && !keepIcc);
      if (drop) removed.push({ segment: type.trim(), what: type.trim().toLowerCase(), bytes: seg.length });
      else {
        if (type === 'VP8X') { seg = seg.slice(); seg[8] &= ~(0x08 | 0x04 | (keepIcc ? 0 : 0x20)); }
        body.push(seg);
      }
      o += total;
    }
    const size = 4 + body.reduce((a, s) => a + s.length, 0);
    const head = new Uint8Array(12); head.set(b.subarray(0, 12)); new DataView(head.buffer).setUint32(4, size, true);
    push(head); for (const s of body) push(s);
  } else throw new Error(`stripMetadata works losslessly on jpeg, png and webp; this file is ${info.format || 'an unknown format'} — re-encode it with image.convert instead (decoding and re-encoding drops all metadata)`);
  const outb = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { outb.set(p, o); o += p.length; }
  return { bytes: outb, removed, format: info.format };
}

register({
  name: 'image.stripMetadata',
  description: 'Remove metadata from a JPEG, PNG or WebP without re-encoding a single pixel: EXIF (camera, dates, GPS), XMP, IPTC/Photoshop blocks, comments, PNG text and time chunks. The compressed image data is copied byte-for-byte, so there is no quality loss. By default the ICC colour profile is kept (colours stay correct) and a non-default EXIF orientation is rewritten as a minimal tag (the picture stays upright). Use before publishing or sharing a photo. Returns the list of removed segments and bytes saved.',
  schema: {
    properties: {
      input: IN, output: { type: 'string', description: 'VFS path to write (default: <name>.clean.<same extension>)' },
      keepIcc: { type: 'boolean', default: true, description: 'Keep the embedded ICC colour profile' },
      keepOrientation: { type: 'boolean', default: true, description: 'JPEG only: keep the EXIF orientation flag (and nothing else) when it is not "normal"' },
    },
    required: ['input'],
  },
  examples: ['image.stripMetadata input=photo.jpg'],
  async run({ input, output, keepIcc, keepOrientation }) {
    const src = vfs.read(input);
    const { bytes, removed, format } = stripBytes(src, keepIcc, keepOrientation);
    const ext = format === 'jpeg' ? 'jpg' : format;
    const stat = await vfs.write(vfs.out(output, input, 'clean', ext), bytes, { mime: vfs.mimeOf('x.' + ext) });
    return { output: stat, format, removed: removed.slice(0, 50), removedCount: removed.length, truncated: removed.length > 50, bytesBefore: src.length, bytesAfter: bytes.length, bytesSaved: src.length - bytes.length, lossless: true };
  },
});

// ───────────────────────────────────────────────────────────── convert ──
register({
  name: 'image.convert',
  description: 'Re-encode an image as PNG (lossless), JPEG or WebP (lossy, with a quality setting). Decoding and re-encoding also drops all metadata and applies the EXIF orientation. JPEG has no alpha: transparent areas are flattened onto `background` first. Returns the new file with its size and the size ratio to the source.',
  schema: {
    properties: {
      input: IN,
      format: { type: 'string', enum: ['png', 'jpeg', 'jpg', 'webp'], description: 'Target format (default: from the output extension, else png)' },
      quality: QUALITY,
      background: { type: 'string', default: '#ffffff', description: 'Colour under transparent pixels when the target is JPEG' },
      output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.convert input=shot.png format=webp quality=80', 'image.convert input=a.webp output=a.jpg quality=0.9'],
  async run(args) {
    const fromExt = args.output ? vfs.extOf(args.output) : '';
    const format = (args.format || (['png', 'jpg', 'jpeg', 'webp'].includes(fromExt) ? fromExt : 'png')).replace('jpg', 'jpeg');
    let img = await open(args.input); let flattened = false;
    if (format === 'jpeg') {
      const K = await kernel(); const a = out(Uint32Array, 5); K.call('alpha_info', img.data, img.width, img.height, a);
      if (a.value[2] > 0) { const c = parseColor(args.background); img = K.img('flatten', img, c[0], c[1], c[2]); flattened = true; }
    }
    const q = quality(args.quality);
    const { bytes, mime } = await encode(img, { format, quality: q });
    if (mime !== vfs.mimeOf('x.' + format)) throw new Error(`this browser cannot encode ${format} (got ${mime})`);
    const stat = await vfs.write(vfs.out(args.output, args.input, '', format === 'jpeg' ? 'jpg' : format), bytes, { mime, meta: { width: img.width, height: img.height } });
    const srcBytes = vfs.read(args.input).length;
    return { output: stat, format, quality: format === 'png' ? null : q ?? (format === 'jpeg' ? 0.92 : 0.8), flattened, sourceBytes: srcBytes, ratio: +(bytes.length / srcBytes).toFixed(4) };
  },
});

// ──────────────────────────────────────────────────────────── geometry ──
const FILTERS = { nearest: 0, bilinear: 1, area: 2, bicubic: 3, lanczos3: 4 };

register({
  name: 'image.resize', gpu: true,
  description: 'Resize an image. Give width and/or height (one alone keeps the aspect ratio), or maxSide (shrink so the longer side fits; never enlarges), or scale (factor). With both width and height, `fit` decides: fill = stretch, contain = fit inside keeping aspect, cover = fill and centre-crop, pad = contain then pad to the exact box. Filters: lanczos3 (default, sharpest), bicubic (Catmull-Rom) and area (box average) are antialiased when shrinking; nearest and bilinear are plain point sampling (use nearest for pixel art; bilinear aliases on large reductions) and are the two that run on WebGPU. Output is capped at 40 MP.',
  schema: {
    properties: {
      input: IN,
      width: { type: 'integer', minimum: 1, maximum: 16384, description: 'Target width in pixels' },
      height: { type: 'integer', minimum: 1, maximum: 16384, description: 'Target height in pixels' },
      maxSide: { type: 'integer', minimum: 1, maximum: 16384, description: 'Shrink so that max(width, height) ≤ this; no-op if already smaller' },
      scale: { type: 'number', minimum: 0.001, maximum: 64, description: 'Scale factor, e.g. 0.5 or 2' },
      fit: { type: 'string', enum: ['fill', 'contain', 'cover', 'pad'], default: 'fill', description: 'How to reconcile aspect ratios when both width and height are given' },
      filter: { type: 'string', enum: Object.keys(FILTERS), default: 'lanczos3', description: 'Resampling filter' },
      background: { type: 'string', default: '#00000000', description: 'Padding colour for fit=pad' },
      backend: BACKEND, quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.resize input=photo.jpg maxSide=1024', 'image.resize input=a.png width=320 height=240 fit=cover', 'image.resize input=sprite.png scale=4 filter=nearest'],
  async run(args) {
    const img = await open(args.input); const { width: w, height: h } = img;
    let tw = args.width, th = args.height, fit = args.fit;
    if (args.scale) { tw = Math.max(1, Math.round(w * args.scale)); th = Math.max(1, Math.round(h * args.scale)); fit = 'fill'; }
    else if (args.maxSide && !tw && !th) { const k = Math.min(1, args.maxSide / Math.max(w, h)); tw = Math.max(1, Math.round(w * k)); th = Math.max(1, Math.round(h * k)); fit = 'fill'; }
    else if (tw && !th) { th = Math.max(1, Math.round(h * tw / w)); fit = 'fill'; }
    else if (th && !tw) { tw = Math.max(1, Math.round(w * th / h)); fit = 'fill'; }
    else if (!tw && !th) throw new Error('give width and/or height, or maxSide, or scale');
    let rw = tw, rh = th;
    if (fit === 'contain' || fit === 'pad') { const k = Math.min(tw / w, th / h); rw = Math.max(1, Math.round(w * k)); rh = Math.max(1, Math.round(h * k)); }
    else if (fit === 'cover') { const k = Math.max(tw / w, th / h); rw = Math.max(tw, Math.round(w * k)); rh = Math.max(th, Math.round(h * k)); }
    checkSize(rw, rh); checkSize(tw, th);
    const code = FILTERS[args.filter];
    let r;
    if (rw === w && rh === h) r = { img, backend: 'wasm' };
    else if (code <= 1) r = await gpuOr(accel, 'resize', img, { width: rw, height: rh, filter: args.filter }, args.backend, (K) => K.imgTo('resize', img, rw, rh, code));
    else { if (args.backend === 'gpu') throw new Error('backend=gpu: only filter=nearest and filter=bilinear have a WebGPU kernel'); r = { img: (await kernel()).imgTo('resize', img, rw, rh, code), backend: 'wasm' }; }
    let res = r.img;
    if (fit === 'cover' && (rw !== tw || rh !== th)) { const K = await kernel(); const o = out(Uint8ClampedArray, tw * th * 4); K.call('crop', res.data, rw, rh, o, (rw - tw) >> 1, (rh - th) >> 1, tw, th); res = { width: tw, height: th, data: o.value }; }
    if (fit === 'pad' && (rw !== tw || rh !== th)) { const K = await kernel(); res = K.imgTo('pad', res, tw, th, (tw - rw) >> 1, (th - rh) >> 1, 0, packRGBA(parseColor(args.background, [0, 0, 0, 0]))); }
    const output = await write(res, args, 'resize');
    return { output, from: { width: w, height: h }, width: res.width, height: res.height, filter: args.filter, fit: args.width && args.height && !args.scale ? fit : 'aspect', backend: r.backend };
  },
});

register({
  name: 'image.crop',
  description: 'Cut a rectangle out of an image. Coordinates are pixels from the top-left corner; a rectangle that sticks out is clipped to the image. Returns the cropped file and the rectangle actually used.',
  schema: {
    properties: {
      input: IN,
      x: { type: 'integer', default: 0, description: 'Left edge' }, y: { type: 'integer', default: 0, description: 'Top edge' },
      width: { type: 'integer', minimum: 1, description: 'Width of the rectangle (default: to the right edge)' },
      height: { type: 'integer', minimum: 1, description: 'Height of the rectangle (default: to the bottom edge)' },
      quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.crop input=a.png x=100 y=50 width=640 height=480'],
  async run(args) {
    const img = await open(args.input);
    const x0 = Math.max(0, args.x), y0 = Math.max(0, args.y);
    const x1 = Math.min(img.width, args.x + (args.width ?? img.width)), y1 = Math.min(img.height, args.y + (args.height ?? img.height));
    if (x1 <= x0 || y1 <= y0) throw new Error(`crop rectangle lies outside the ${img.width}×${img.height} image`);
    const K = await kernel(); const o = out(Uint8ClampedArray, (x1 - x0) * (y1 - y0) * 4);
    K.call('crop', img.data, img.width, img.height, o, x0, y0, x1 - x0, y1 - y0);
    const output = await write({ width: x1 - x0, height: y1 - y0, data: o.value }, args, 'crop');
    return { output, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, from: { width: img.width, height: img.height }, backend: 'wasm' };
  },
});

register({
  name: 'image.rotate',
  description: 'Rotate an image clockwise by any angle in degrees (negative = counter-clockwise). Multiples of 90° are lossless pixel moves. Other angles are resampled (bilinear by default; bicubic is sharper, nearest keeps hard pixels); with expand=true the canvas grows to hold the whole rotated image, otherwise the original size is kept and corners are cut. Uncovered corners take `background` (transparent by default — save as PNG or WebP to keep that).',
  schema: {
    properties: {
      input: IN,
      angle: { type: 'number', description: 'Degrees clockwise, e.g. 90, -90, 180, 7.5' },
      expand: { type: 'boolean', default: true, description: 'Grow the canvas to fit the rotated image (ignored for multiples of 90°, which always fit exactly)' },
      filter: { type: 'string', enum: ['nearest', 'bilinear', 'bicubic'], default: 'bilinear', description: 'Resampling for arbitrary angles' },
      background: { type: 'string', default: '#00000000', description: 'Fill colour for uncovered corners' },
      quality: QUALITY, output: OUT,
    },
    required: ['input', 'angle'],
  },
  examples: ['image.rotate input=scan.png angle=90', 'image.rotate input=scan.png angle=-3.2 background=#ffffff'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    const a = ((args.angle % 360) + 360) % 360;
    let res, lossless = false;
    if (a % 90 === 0) {
      const k = a / 90; lossless = true;
      if (k === 0) res = img;
      else { const o = out(Uint8ClampedArray, img.data.length); K.call('rot90', img.data, img.width, img.height, o, k); res = k % 2 ? { width: img.height, height: img.width, data: o.value } : { width: img.width, height: img.height, data: o.value }; }
    } else {
      const rad = a * Math.PI / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
      const dw = args.expand ? Math.ceil(img.width * c + img.height * s - 1e-6) : img.width, dh = args.expand ? Math.ceil(img.width * s + img.height * c - 1e-6) : img.height;
      checkSize(dw, dh);
      res = K.imgTo('rotate', img, dw, dh, a, { nearest: 0, bilinear: 1, bicubic: 3 }[args.filter], packRGBA(parseColor(args.background, [0, 0, 0, 0])));
    }
    const output = await write(res, args, 'rot');
    return { output, angle: args.angle, lossless, width: res.width, height: res.height, backend: 'wasm' };
  },
});

register({
  name: 'image.flip',
  description: 'Mirror an image: horizontal swaps left and right (a mirror image), vertical swaps top and bottom, both equals a 180° rotation. Lossless.',
  schema: { properties: { input: IN, direction: { type: 'string', enum: ['horizontal', 'vertical', 'both'], default: 'horizontal', description: 'Axis to mirror across' }, quality: QUALITY, output: OUT }, required: ['input'] },
  examples: ['image.flip input=a.png direction=vertical'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    const res = K.img('flip', img, { horizontal: 0, vertical: 1, both: 2 }[args.direction]);
    return { output: await write(res, args, 'flip'), direction: args.direction, backend: 'wasm' };
  },
});

register({
  name: 'image.pad',
  description: 'Add a border around an image. Give `all`, or individual top/right/bottom/left sizes in pixels. mode=constant fills with `color`; edge repeats the outermost pixels; reflect mirrors the image content. Use it to add margins, make a canvas square, or prepare borders before filtering.',
  schema: {
    properties: {
      input: IN,
      all: { type: 'integer', minimum: 0, maximum: 8192, description: 'Border on every side (individual sides override it)' },
      top: { type: 'integer', minimum: 0, maximum: 8192, description: 'Top border' }, right: { type: 'integer', minimum: 0, maximum: 8192, description: 'Right border' },
      bottom: { type: 'integer', minimum: 0, maximum: 8192, description: 'Bottom border' }, left: { type: 'integer', minimum: 0, maximum: 8192, description: 'Left border' },
      square: { type: 'boolean', default: false, description: 'Instead of explicit sizes: pad the shorter dimension equally on both sides until the image is square' },
      mode: { type: 'string', enum: ['constant', 'edge', 'reflect'], default: 'constant', description: 'How the border is filled' },
      color: { type: 'string', default: '#ffffff', description: 'Border colour for mode=constant (#rrggbb, #rrggbbaa, "r,g,b,a" or a basic name; "transparent" works)' },
      quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.pad input=a.png all=32 color=#000000', 'image.pad input=a.png square=true color=transparent'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    let t = args.top ?? args.all ?? 0, r = args.right ?? args.all ?? 0, b = args.bottom ?? args.all ?? 0, l = args.left ?? args.all ?? 0;
    if (args.square) { const d = Math.abs(img.width - img.height); t = r = b = l = 0; if (img.width > img.height) { t = d >> 1; b = d - t; } else { l = d >> 1; r = d - l; } }
    const dw = img.width + l + r, dh = img.height + t + b; checkSize(dw, dh);
    const res = K.imgTo('pad', img, dw, dh, l, t, { constant: 0, edge: 1, reflect: 2 }[args.mode], packRGBA(parseColor(args.color)));
    return { output: await write(res, args, 'pad'), padding: { top: t, right: r, bottom: b, left: l }, width: dw, height: dh, backend: 'wasm' };
  },
});

// ───────────────────────────────────────────────────────────── filters ──
register({
  name: 'image.blur', gpu: true,
  description: 'Gaussian blur (separable, kernel radius = ceil(3·sigma), edges clamped, alpha untouched). Use to soften, to suppress noise before edge detection or thresholding, or to hide detail. sigma is the standard deviation in pixels: 1 is subtle, 5 is strong, 20+ is a wash. CPU cost grows linearly with sigma (a 12 MP image at sigma 50 takes several seconds on WASM).',
  schema: { properties: { input: IN, sigma: { type: 'number', default: 2, minimum: 0.1, maximum: 100, description: 'Standard deviation in pixels' }, backend: BACKEND, quality: QUALITY, output: OUT }, required: ['input'] },
  examples: ['image.blur input=cat.png sigma=4'],
  async run(args) {
    const img = await open(args.input);
    const r = await gpuOr(accel, 'gaussian', img, { sigma: args.sigma }, args.backend, (K) => K.img('gaussian', img, args.sigma));
    return { output: await write(r.img, args, 'blur'), sigma: args.sigma, radius: Math.ceil(3 * args.sigma), backend: r.backend };
  },
});

register({
  name: 'image.sharpen',
  description: 'Unsharp mask: out = image + amount × (image − gaussian(image, sigma)). The classic way to restore crispness after resizing or to emphasise detail. amount 0.5–1.5 is typical; sigma 1–2 for fine detail, larger for local contrast; threshold skips differences smaller than that many levels so flat noisy areas are not amplified.',
  schema: {
    properties: {
      input: IN,
      amount: { type: 'number', default: 1, minimum: 0, maximum: 10, description: 'Strength (1 = add 100 % of the detail layer)' },
      sigma: { type: 'number', default: 1.5, minimum: 0.1, maximum: 50, description: 'Gaussian radius of the mask in pixels' },
      threshold: { type: 'number', default: 0, minimum: 0, maximum: 255, description: 'Minimum |difference| (0..255) to sharpen' },
      quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.sharpen input=a.jpg amount=1.2 sigma=1'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    return { output: await write(K.img('unsharp', img, args.sigma, args.amount, args.threshold), args, 'sharp'), amount: args.amount, sigma: args.sigma, threshold: args.threshold, backend: 'wasm' };
  },
});

const PRESET_KERNELS = {
  sharpen: { k: [0, -1, 0, -1, 5, -1, 0, -1, 0] }, emboss: { k: [-2, -1, 0, -1, 1, 1, 0, 1, 2] }, box3: { k: Array(9).fill(1), d: 9 }, box5: { k: Array(25).fill(1), d: 25 },
  gaussian3: { k: [1, 2, 1, 2, 4, 2, 1, 2, 1], d: 16 }, edge: { k: [-1, -1, -1, -1, 8, -1, -1, -1, -1] }, laplacian: { k: [0, 1, 0, 1, -4, 1, 0, 1, 0] },
  sobelX: { k: [-1, 0, 1, -2, 0, 2, -1, 0, 1], b: 128 }, sobelY: { k: [-1, -2, -1, 0, 0, 0, 1, 2, 1], b: 128 }, outline: { k: [-1, -1, -1, -1, 9, -1, -1, -1, -1] },
};
register({
  name: 'image.convolve', gpu: true,
  description: 'Apply a custom square convolution kernel to R, G and B: out = Σ(kernel × neighbourhood) / divisor + bias, clamped to 0..255, edges clamped, alpha untouched. Give `kernel` as a row-major list of N×N numbers (N odd: 9, 25, 49 … values) or pick a `preset`. The kernel is applied as written (correlation — not flipped). Use for effects no dedicated tool covers; for plain blur/sharpen/edges prefer image.blur, image.sharpen, image.edges.',
  schema: {
    properties: {
      input: IN,
      kernel: { type: 'array', items: { type: 'number' }, description: 'N×N numbers, row-major, N odd (3..15). Example 3×3 sharpen: 0,-1,0,-1,5,-1,0,-1,0' },
      preset: { type: 'string', enum: Object.keys(PRESET_KERNELS), description: 'Named kernel instead of `kernel`' },
      divisor: { type: 'number', description: 'Divide the sum by this (default 1, or the preset\'s own)' },
      normalize: { type: 'boolean', default: false, description: 'Set divisor to the sum of the kernel (when non-zero) so brightness is preserved' },
      bias: { type: 'number', minimum: -255, maximum: 255, description: 'Added after division, in 0..255 units (default 0; use 128 to see signed results)' },
      backend: BACKEND, quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.convolve input=a.png preset=emboss bias=128', 'image.convolve input=a.png kernel=1,1,1,1,1,1,1,1,1 normalize=true'],
  async run(args) {
    let k = args.kernel, divisor = args.divisor, bias = args.bias;
    if (!k && args.preset) { const p = PRESET_KERNELS[args.preset]; k = p.k; divisor ??= p.d; bias ??= p.b; }
    if (!k) throw new Error(`give kernel (N×N numbers) or preset (${Object.keys(PRESET_KERNELS).join(', ')})`);
    const size = Math.round(Math.sqrt(k.length));
    if (size * size !== k.length || size % 2 === 0 || size < 1 || size > 15) throw new Error(`kernel must have N×N values with N odd and ≤ 15 (9, 25, 49, …); got ${k.length} values`);
    if (k.some((v) => !Number.isFinite(v))) throw new Error('kernel contains a non-numeric value');
    if (args.normalize) { const s = k.reduce((a, v) => a + v, 0); divisor = s !== 0 ? s : 1; }
    divisor ??= 1; bias ??= 0;
    if (divisor === 0) throw new Error('divisor must not be 0');
    const img = await open(args.input);
    const r = await gpuOr(accel, 'convolve', img, { kernel: k, size, divisor, bias }, args.backend, (K) => K.img('convolve', img, new Float32Array(k), size, divisor, bias));
    return { output: await write(r.img, args, 'conv'), size, divisor, bias, backend: r.backend };
  },
});

register({
  name: 'image.grayscale', gpu: true,
  description: 'Convert to gray using Rec.709 luma (0.2126 R + 0.7152 G + 0.0722 B, rounded). The result still has three equal channels plus the original alpha.',
  schema: { properties: { input: IN, backend: BACKEND, quality: QUALITY, output: OUT }, required: ['input'] },
  examples: ['image.grayscale input=a.png'],
  async run(args) {
    const img = await open(args.input);
    const r = await gpuOr(accel, 'grayscale', img, {}, args.backend, (K) => K.img('grayscale', img));
    return { output: await write(r.img, args, 'gray'), backend: r.backend };
  },
});

register({
  name: 'image.invert', gpu: true,
  description: 'Negative: each of R, G, B becomes 255 − value; alpha is kept.',
  schema: { properties: { input: IN, backend: BACKEND, quality: QUALITY, output: OUT }, required: ['input'] },
  examples: ['image.invert input=a.png'],
  async run(args) {
    const img = await open(args.input);
    const r = await gpuOr(accel, 'invert', img, {}, args.backend, (K) => K.img('invert', img));
    return { output: await write(r.img, args, 'inv'), backend: r.backend };
  },
});

register({
  name: 'image.threshold', gpu: true,
  description: 'Binarise to pure black and white from Rec.709 luma. method=fixed: white where luma ≥ t. method=otsu: t is chosen automatically to best separate the two brightness classes (good for bimodal images such as scans; the chosen t is returned). method=adaptive: each pixel is compared with its local mean (box or gaussian window of `radius`) minus `c` — use this for uneven lighting, e.g. photographed documents. Output alpha is 255. Returns the threshold used and the fraction of white pixels.',
  schema: {
    properties: {
      input: IN,
      method: { type: 'string', enum: ['fixed', 'otsu', 'adaptive'], default: 'otsu', description: 'How the threshold is chosen' },
      t: { type: 'number', default: 128, minimum: 0, maximum: 255, description: 'Threshold for method=fixed' },
      radius: { type: 'integer', default: 15, minimum: 1, maximum: 500, description: 'adaptive: half-size of the local window in pixels' },
      c: { type: 'number', default: 7, minimum: -255, maximum: 255, description: 'adaptive: constant subtracted from the local mean (larger → fewer stray black specks on flat background)' },
      window: { type: 'string', enum: ['mean', 'gaussian'], default: 'mean', description: 'adaptive: box mean or gaussian-weighted mean (sigma = radius/2)' },
      invert: { type: 'boolean', default: false, description: 'Swap black and white in the result' },
      backend: BACKEND, quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.threshold input=scan.png', 'image.threshold input=page.jpg method=adaptive radius=25 c=10', 'image.threshold input=a.png method=fixed t=200'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    let r, t = null;
    if (args.method === 'adaptive') { if (args.backend === 'gpu') throw new Error('backend=gpu: adaptive thresholding has no WebGPU kernel'); r = { img: K.img('adaptive_threshold', img, args.radius, args.c, args.window === 'gaussian' ? 1 : 0), backend: 'wasm' }; }
    else {
      t = args.method === 'otsu' ? K.call('otsu', img.data, img.width, img.height) : args.t;
      r = await gpuOr(accel, 'threshold', img, { t }, args.backend, (K2) => K2.img('threshold', img, t));
    }
    let res = r.img;
    if (args.invert) res = K.img('invert', res);
    const st = out(Float64Array, 32); K.call('stats', res.data, res.width, res.height, st);
    return { output: await write(res, args, 'bw'), method: args.method, threshold: t, whiteFraction: +(st.value[20] / 255).toFixed(5), backend: r.backend };
  },
});

register({
  name: 'image.adjust',
  description: 'Tone and colour adjustment in one pass, applied in this order: gamma (out = in^(1/gamma); >1 brightens midtones), contrast (multiplier around mid-gray; 1 = unchanged), brightness (added, −1..1 of full scale), saturation (multiplier; 0 = gray, 1 = unchanged, 2 = vivid), hue (rotation in degrees). Saturation and hue use the SVG/CSS filter matrices (Rec.709 luminance weights). Leave any parameter at its default to skip it.',
  schema: {
    properties: {
      input: IN,
      brightness: { type: 'number', default: 0, minimum: -1, maximum: 1, description: 'Additive offset as a fraction of full scale (0.1 = +25.5 levels)' },
      contrast: { type: 'number', default: 1, minimum: 0, maximum: 10, description: 'Contrast multiplier about 0.5 gray' },
      gamma: { type: 'number', default: 1, minimum: 0.05, maximum: 10, description: 'Gamma correction; 2.2 brightens, 0.45 darkens' },
      saturation: { type: 'number', default: 1, minimum: 0, maximum: 10, description: 'Saturation multiplier' },
      hue: { type: 'number', default: 0, minimum: -360, maximum: 360, description: 'Hue rotation in degrees' },
      quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.adjust input=a.jpg brightness=0.05 contrast=1.2 saturation=1.3', 'image.adjust input=a.jpg gamma=1.8'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    const res = K.img('adjust', img, args.brightness, args.contrast, args.gamma, args.saturation, args.hue);
    return { output: await write(res, args, 'adj'), brightness: args.brightness, contrast: args.contrast, gamma: args.gamma, saturation: args.saturation, hue: args.hue, backend: 'wasm' };
  },
});

const I4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
const m3 = (m) => [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0];
const MATRICES = {
  identity: I4,
  sepia: m3([0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131]),
  grayscale: m3([0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722]),
  invert: [-1, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 0, 1, 0],
  swapRedBlue: m3([0, 0, 1, 0, 1, 0, 1, 0, 0]),
  // Machado, Oliveira & Fernandes (2009) dichromacy simulation matrices, severity 1.0. They are defined for linear RGB;
  // here they act on the gamma-encoded values, which is the usual quick approximation.
  protanopia: m3([0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998]),
  deuteranopia: m3([0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881]),
  tritanopia: m3([1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900]),
};
register({
  name: 'image.colorMatrix', gpu: true,
  description: 'Apply a 4×5 colour matrix (the same convention as SVG feColorMatrix): for each pixel [R\' G\' B\' A\'] = M × [R G B A 1] on 0..1 values, the fifth column being an offset. Give 20 numbers row-major, or a preset: sepia, grayscale, invert, swapRedBlue, and protanopia / deuteranopia / tritanopia (colour-blindness simulation after Machado 2009, applied to gamma-encoded values — an approximation suitable for accessibility checks). Use for channel mixing and tinting.',
  schema: {
    properties: {
      input: IN,
      matrix: { type: 'array', items: { type: 'number' }, description: '20 numbers, row-major 4×5' },
      preset: { type: 'string', enum: Object.keys(MATRICES), description: 'Named matrix instead of `matrix`' },
      backend: BACKEND, quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.colorMatrix input=a.png preset=sepia', 'image.colorMatrix input=ui.png preset=deuteranopia'],
  async run(args) {
    const m = args.matrix || MATRICES[args.preset];
    if (!m) throw new Error(`give matrix (20 numbers) or preset (${Object.keys(MATRICES).join(', ')})`);
    if (m.length !== 20 || m.some((v) => !Number.isFinite(v))) throw new Error(`matrix must be exactly 20 numbers (4 rows × 5 columns); got ${m.length}`);
    const img = await open(args.input);
    const r = await gpuOr(accel, 'colorMatrix', img, { matrix: m }, args.backend, (K) => K.img('color_matrix', img, new Float32Array(m)));
    return { output: await write(r.img, args, 'cm'), preset: args.matrix ? null : args.preset, backend: r.backend };
  },
});

register({
  name: 'image.equalize',
  description: 'Stretch contrast by histogram equalisation. method=global remaps brightness so its histogram becomes flat — strong, can look harsh. method=clahe (contrast-limited adaptive) equalises per tile with a clip limit and blends between tiles: brings out local detail in shadows and highlights without blowing up noise; the standard choice for X-rays, low-light photos and hazy scenes. channels=luma (default) changes brightness only and keeps colours; rgb equalises each channel independently (global only; shifts colours).',
  schema: {
    properties: {
      input: IN,
      method: { type: 'string', enum: ['global', 'clahe'], default: 'global', description: 'Global equalisation or CLAHE' },
      channels: { type: 'string', enum: ['luma', 'rgb'], default: 'luma', description: 'global only: equalise luma (colour-preserving) or R, G, B separately' },
      tiles: { type: 'integer', default: 8, minimum: 1, maximum: 64, description: 'clahe: tiles per side (8 → 8×8 grid)' },
      clipLimit: { type: 'number', default: 2, minimum: 0, maximum: 100, description: 'clahe: histogram clip as a multiple of the uniform bin height; 0 disables clipping (plain adaptive equalisation), 2–4 is typical' },
      quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.equalize input=dark.jpg method=clahe clipLimit=3', 'image.equalize input=a.png'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    const res = args.method === 'clahe' ? K.img('clahe', img, args.tiles, args.tiles, args.clipLimit) : K.img('equalize', img, args.channels === 'rgb' ? 1 : 0);
    return { output: await write(res, args, args.method === 'clahe' ? 'clahe' : 'eq'), method: args.method, ...(args.method === 'clahe' ? { tiles: args.tiles, clipLimit: args.clipLimit } : { channels: args.channels }), backend: 'wasm' };
  },
});

register({
  name: 'image.denoise', gpu: true,
  description: 'Reduce noise. method=median replaces each channel value with the median of its (2·radius+1)² neighbourhood — removes salt-and-pepper specks and scan dust while keeping edges sharp. method=bilateral averages nearby pixels weighted by distance (sigmaSpace) and by colour similarity (sigmaColor, in 0..255 RGB units), so flat areas are smoothed but edges survive — good for sensor noise and JPEG grain; its window radius is ceil(2·sigmaSpace) and CPU cost grows with its square (use the GPU backend or keep sigmaSpace ≤ 5 for large photos).',
  schema: {
    properties: {
      input: IN,
      method: { type: 'string', enum: ['median', 'bilateral'], default: 'median', description: 'Filter type' },
      radius: { type: 'integer', default: 1, minimum: 1, maximum: 50, description: 'median: window half-size (1 → 3×3)' },
      sigmaSpace: { type: 'number', default: 3, minimum: 0.5, maximum: 25, description: 'bilateral: spatial sigma in pixels' },
      sigmaColor: { type: 'number', default: 25, minimum: 1, maximum: 255, description: 'bilateral: colour sigma; larger smooths across stronger edges' },
      backend: BACKEND, quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.denoise input=scan.png method=median radius=1', 'image.denoise input=photo.jpg method=bilateral sigmaSpace=4 sigmaColor=30'],
  async run(args) {
    const img = await open(args.input);
    if (args.method === 'median') {
      if (args.backend === 'gpu') throw new Error('backend=gpu: the median filter has no WebGPU kernel (bilateral has)');
      const K = await kernel();
      return { output: await write(K.img('median', img, args.radius), args, 'median'), method: 'median', radius: args.radius, backend: 'wasm' };
    }
    const r = await gpuOr(accel, 'bilateral', img, { sigmaSpace: args.sigmaSpace, sigmaColor: args.sigmaColor }, args.backend, (K) => K.img('bilateral', img, args.sigmaSpace, args.sigmaColor));
    return { output: await write(r.img, args, 'bilateral'), method: 'bilateral', sigmaSpace: args.sigmaSpace, sigmaColor: args.sigmaColor, radius: Math.ceil(2 * args.sigmaSpace), backend: r.backend };
  },
});

const MORPH = { erode: 0, dilate: 1, open: 2, close: 3, gradient: 4, tophat: 5, blackhat: 6 };
register({
  name: 'image.morph', gpu: true,
  description: 'Mathematical morphology with a square (2·radius+1)² structuring element, per RGB channel (works on binary masks and on gray/colour images). erode shrinks bright regions (min filter); dilate grows them (max filter); open = erode→dilate removes small bright specks; close = dilate→erode fills small dark holes and gaps; gradient = dilate − erode gives outlines; tophat = image − open isolates small bright details; blackhat = close − image isolates small dark details. Typical use: clean a thresholded mask before analysis.components.',
  schema: {
    properties: {
      input: IN,
      op: { type: 'string', enum: Object.keys(MORPH), description: 'Operation' },
      radius: { type: 'integer', default: 1, minimum: 1, maximum: 100, description: 'Half-size of the square element (1 → 3×3)' },
      iterations: { type: 'integer', default: 1, minimum: 1, maximum: 20, description: 'Repeat erode/dilate this many times (only for op=erode|dilate)' },
      backend: BACKEND, quality: QUALITY, output: OUT,
    },
    required: ['input', 'op'],
  },
  examples: ['image.morph input=mask.png op=open radius=2', 'image.morph input=a.png op=gradient'],
  async run(args) {
    const img = await open(args.input); const { op, radius } = args;
    const prim = (im, o) => gpuOr(accel, 'morph', im, { op: o, radius }, args.backend, (K) => K.img('morph', im, MORPH[o], radius));
    let r;
    if (op === 'erode' || op === 'dilate') { r = { img }; for (let i = 0; i < args.iterations; i++) r = await prim(r.img, op); }
    else if (op === 'open' || op === 'close') { const a = await prim(img, op === 'open' ? 'erode' : 'dilate'); r = await prim(a.img, op === 'open' ? 'dilate' : 'erode'); }
    else { if (args.backend === 'gpu') throw new Error(`backend=gpu: op=${op} runs in the WASM kernel only (erode, dilate, open, close have WebGPU paths)`); r = { img: (await kernel()).img('morph', img, MORPH[op], radius), backend: 'wasm' }; }
    return { output: await write(r.img, args, op), op, radius, backend: r.backend };
  },
});

register({
  name: 'image.edges', gpu: true,
  description: 'Edge detection on Rec.709 luma; output is a gray image (alpha 255). sobel / scharr / prewitt give gradient magnitude sqrt(gx²+gy²) (scharr is rotation-accurate and normalised here to sobel\'s scale); laplacian (4-neighbour) and laplacian8 give |second derivative| (sensitive to noise and fine detail). canny produces thin, one-pixel, binary edges: gaussian smoothing (sigma), gradient, non-maximum suppression and hysteresis between low/high thresholds — thresholds are on a scale where a full black→white step is 255, and are chosen automatically when omitted (high = Otsu threshold of the gradient magnitudes, low = 0.4 × high). Use sobel to see edge strength, canny for clean contours to feed analysis.lines.',
  schema: {
    properties: {
      input: IN,
      method: { type: 'string', enum: ['sobel', 'scharr', 'prewitt', 'laplacian', 'laplacian8', 'canny'], default: 'sobel', description: 'Detector' },
      scale: { type: 'number', default: 1, minimum: 0.01, maximum: 100, description: 'Multiply the response before clamping to 255 (not used by canny)' },
      sigma: { type: 'number', default: 1.4, minimum: 0, maximum: 20, description: 'canny: gaussian pre-blur sigma (0 = none)' },
      low: { type: 'number', minimum: 0, maximum: 360, description: 'canny: low hysteresis threshold (default: 0.4 × high)' },
      high: { type: 'number', minimum: 0, maximum: 360, description: 'canny: high hysteresis threshold (default: automatic)' },
      backend: BACKEND, quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.edges input=a.png', 'image.edges input=a.png method=canny sigma=2', 'image.edges input=a.png method=canny low=20 high=60'],
  async run(args) {
    const img = await open(args.input); const m = args.method;
    if (m === 'canny') {
      if (args.backend === 'gpu') throw new Error('backend=gpu: canny runs in the WASM kernel only (sobel has a WebGPU path)');
      const K = await kernel(); const o = out(Uint8ClampedArray, img.data.length), thr = out(Float32Array, 2);
      const n = K.call('canny', img.data, img.width, img.height, o, args.sigma, args.low ?? -1, args.high ?? -1, thr);
      return { output: await write({ width: img.width, height: img.height, data: o.value }, args, 'canny'), method: m, sigma: args.sigma, low: +thr.value[0].toFixed(2), high: +thr.value[1].toFixed(2), edgePixels: n, edgeFraction: +(n / (img.width * img.height)).toFixed(5), backend: 'wasm' };
    }
    let r;
    if (m === 'sobel' && args.scale === 1) r = await gpuOr(accel, 'sobel', img, {}, args.backend, (K) => K.img('edges', img, 0, 1));
    else {
      if (args.backend === 'gpu') throw new Error('backend=gpu: only method=sobel with scale=1 has a WebGPU kernel');
      const code = { sobel: 0, scharr: 1, prewitt: 2, laplacian: 3, laplacian8: 4 }[m];
      r = { img: (await kernel()).img('edges', img, code, args.scale * (m === 'scharr' ? 0.25 : 1)), backend: 'wasm' };
    }
    return { output: await write(r.img, args, m), method: m, scale: args.scale, backend: r.backend };
  },
});

register({
  name: 'image.colormap',
  description: `False colour: map each pixel's brightness (Rec.709 luma) through a colour scale. Makes subtle gradients in depth maps, heat maps, spectrograms, X-rays and difference images visible. Maps: ${COLORMAPS.join(', ')}. viridis, magma, inferno and plasma are perceptually uniform (interpolated from 11 anchors of the matplotlib tables); turbo is Google's rainbow (their polynomial fit); jet/hot/cool/bone/rainbow are the classic formulas.`,
  schema: {
    properties: {
      input: IN,
      map: { type: 'string', enum: COLORMAPS, default: 'viridis', description: 'Colour scale' },
      reverse: { type: 'boolean', default: false, description: 'Flip the scale (dark ↔ bright ends)' },
      quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.colormap input=depth.png map=turbo'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    return { output: await write(K.img('colormap', img, colormapLut(args.map, args.reverse)), args, args.map), map: args.map, reverse: args.reverse, backend: 'wasm' };
  },
});

const CH = { r: 0, g: 1, b: 2, a: 3, 0: 4, 1: 5, l: 6 };
register({
  name: 'image.channels',
  description: 'Extract or rearrange colour channels. `extract` = r, g, b, a or luma writes that channel as a gray image; extract=all writes one gray file per channel (r, g, b and, if the image has transparency, a). `order` rebuilds the image from a 3- or 4-letter recipe, one letter per output channel R G B [A], each taken from: r g b a (source channels), l (luma), 0 (zero), 1 (255) — e.g. bgr swaps red and blue, rgb1 makes the image opaque, ggg shows green as gray, rgbl uses brightness as alpha, r00 keeps only red. Use to inspect an alpha mask, fix BGR/RGB mix-ups, or look at channels separately.',
  schema: {
    properties: {
      input: IN,
      extract: { type: 'string', enum: ['r', 'g', 'b', 'a', 'luma', 'all'], description: 'Write one channel (or all) as gray' },
      order: { type: 'string', description: 'Recipe of 3 or 4 characters from r g b a l 0 1, e.g. "bgr", "rgb1", "ggg"' },
      quality: QUALITY, output: OUT,
    },
    required: ['input'],
  },
  examples: ['image.channels input=a.png extract=a', 'image.channels input=a.png order=bgr', 'image.channels input=a.png extract=all'],
  async run(args) {
    if (!args.extract === !args.order) throw new Error('give exactly one of: extract (r|g|b|a|luma|all) or order (e.g. "bgr")');
    const img = await open(args.input); const K = await kernel();
    if (args.order) {
      const s = args.order.toLowerCase();
      if (!/^[rgbal01]{3,4}$/.test(s)) throw new Error(`order must be 3 or 4 characters from "r g b a l 0 1" (got "${args.order}")`);
      const m = [...s].map((c) => CH[c]); if (m.length === 3) m.push(3);
      return { output: await write(K.img('permute', img, ...m), args, s), order: s, backend: 'wasm' };
    }
    const one = (c) => { const code = c === 'luma' ? 6 : CH[c]; return K.img('permute', img, code, code, code, 5); };
    if (args.extract !== 'all') return { output: await write(one(args.extract), args, args.extract), channel: args.extract, backend: 'wasm' };
    const a = out(Uint32Array, 5); K.call('alpha_info', img.data, img.width, img.height, a);
    const list = a.value[2] > 0 ? ['r', 'g', 'b', 'a'] : ['r', 'g', 'b'];
    const outputs = [];
    for (const c of list) outputs.push(await save(one(c), args.output ? args.output.replace(/(\.[A-Za-z0-9]+)?$/, `.${c}$1`) : vfs.out(null, args.input, c, 'png')));
    return { outputs, channels: list, backend: 'wasm' };
  },
});

// ────────────────────────────────────────────────────────── compositing ──
const BLEND = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'add', 'subtract'];
const GRAVITY = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

register({
  name: 'image.composite',
  description: 'Combine two images. layout=over (default) draws `overlay` on top of `input` with alpha blending, an opacity and a blend mode (normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, add, subtract — W3C compositing formulas); position it with `gravity` plus x/y offsets; the result keeps the size of `input`. layout=horizontal or vertical puts the two images next to each other (side-by-side comparison) on a `background` canvas with an optional `gap`; with match=true the second is resized to the first one\'s height (horizontal) or width (vertical). Use for watermarks, overlays, before/after sheets.',
  schema: {
    properties: {
      input: { ...IN, description: 'VFS path of the base (bottom / first) image' },
      overlay: { type: 'string', description: 'VFS path of the top / second image' },
      layout: { type: 'string', enum: ['over', 'horizontal', 'vertical'], default: 'over', description: 'Blend on top, or place side by side' },
      mode: { type: 'string', enum: BLEND, default: 'normal', description: 'Blend mode for layout=over' },
      opacity: { type: 'number', default: 1, minimum: 0, maximum: 1, description: 'Overlay opacity for layout=over' },
      gravity: { type: 'string', enum: GRAVITY, default: 'top-left', description: 'Anchor of the overlay inside the base (layout=over)' },
      x: { type: 'integer', default: 0, description: 'Horizontal offset from the anchor in pixels (may be negative)' },
      y: { type: 'integer', default: 0, description: 'Vertical offset from the anchor in pixels (may be negative)' },
      gap: { type: 'integer', default: 0, minimum: 0, maximum: 1024, description: 'Space between the images for horizontal/vertical layouts' },
      match: { type: 'boolean', default: false, description: 'horizontal/vertical: resize the second image so the shared side matches the first' },
      background: { type: 'string', default: '#00000000', description: 'Canvas colour for horizontal/vertical layouts' },
      quality: QUALITY, output: OUT,
    },
    required: ['input', 'overlay'],
  },
  examples: ['image.composite input=photo.png overlay=logo.png gravity=bottom-right x=-16 y=-16 opacity=0.7', 'image.composite input=before.png overlay=after.png layout=horizontal gap=8'],
  async run(args) {
    const base = await open(args.input); let top = await open(args.overlay); const K = await kernel();
    if (args.layout === 'over') {
      const g = args.gravity; const gx = g.includes('left') ? 0 : g.includes('right') ? base.width - top.width : (base.width - top.width) >> 1;
      const gy = g.startsWith('top') ? 0 : g.startsWith('bottom') ? base.height - top.height : (base.height - top.height) >> 1;
      const x = gx + args.x, y = gy + args.y;
      const o = out(Uint8ClampedArray, base.data.length);
      K.call('composite', base.data, base.width, base.height, top.data, top.width, top.height, o, x, y, args.opacity, BLEND.indexOf(args.mode));
      const covered = Math.max(0, Math.min(base.width, x + top.width) - Math.max(0, x)) * Math.max(0, Math.min(base.height, y + top.height) - Math.max(0, y));
      return { output: await write({ width: base.width, height: base.height, data: o.value }, args, 'comp'), layout: 'over', mode: args.mode, opacity: args.opacity, position: { x, y }, overlaySize: { width: top.width, height: top.height }, coveredPixels: covered, backend: 'wasm' };
    }
    const horiz = args.layout === 'horizontal';
    if (args.match) {
      const tw = horiz ? Math.max(1, Math.round(top.width * base.height / top.height)) : base.width, th = horiz ? base.height : Math.max(1, Math.round(top.height * base.width / top.width));
      if (tw !== top.width || th !== top.height) { checkSize(tw, th); top = K.imgTo('resize', top, tw, th, 4); }
    }
    const W = horiz ? base.width + args.gap + top.width : Math.max(base.width, top.width), H = horiz ? Math.max(base.height, top.height) : base.height + args.gap + top.height;
    checkSize(W, H);
    const res = sheet(K, W, H, parseColor(args.background, [0, 0, 0, 0]), [[base, 0, 0], [top, horiz ? base.width + args.gap : 0, horiz ? 0 : base.height + args.gap]]);
    return { output: await write(res, args, horiz ? 'sbs' : 'stack'), layout: args.layout, width: W, height: H, placed: [{ x: 0, y: 0, width: base.width, height: base.height }, { x: horiz ? base.width + args.gap : 0, y: horiz ? 0 : base.height + args.gap, width: top.width, height: top.height }], backend: 'wasm' };
  },
});

/** Build a W×H canvas inside the kernel: fill with a colour, alpha-over [img, x, y] tiles, copy out once. */
function sheet(K, W, H, color, tiles) {
  const n = W * H * 4; const p = K.alloc(n);
  try {
    K.call('fill', p, W, H, color[0], color[1], color[2], color[3]);
    for (const [img, x, y] of tiles) K.call('blit', img.data, img.width, img.height, p, W, H, x, y, 1);
    return { width: W, height: H, data: new Uint8ClampedArray(K.x.memory.buffer.slice(p, p + n)) };
  } finally { K.x.k_free(p, n); }
}

register({
  name: 'image.montage',
  description: 'Contact sheet: arrange several images in a grid, each scaled (aspect kept, antialiased) to fit a cell and centred in it. Use to compare variants at a glance, to summarise a folder of frames or pages in a single picture, or to build a sprite sheet (set gap=0 and a background of transparent). Up to 100 inputs; the sheet is capped at 40 MP. Returns the sheet and the rectangle of every tile in input order.',
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths, in reading order (left→right, top→bottom)' },
      columns: { type: 'integer', minimum: 1, maximum: 100, description: 'Grid columns (default: ceil(sqrt(count)))' },
      cellWidth: { type: 'integer', default: 256, minimum: 8, maximum: 4096, description: 'Cell width in pixels' },
      cellHeight: { type: 'integer', minimum: 8, maximum: 4096, description: 'Cell height in pixels (default: same as cellWidth)' },
      gap: { type: 'integer', default: 8, minimum: 0, maximum: 256, description: 'Space between and around cells' },
      background: { type: 'string', default: '#202020', description: 'Sheet colour' },
      enlarge: { type: 'boolean', default: false, description: 'Also scale up images smaller than the cell (default: only shrink)' },
      quality: QUALITY, output: OUT,
    },
    required: ['inputs'],
  },
  examples: ['image.montage inputs=a.png,b.png,c.png,d.png columns=2 cellWidth=320'],
  async run(args, ctx) {
    const list = args.inputs;
    if (!list.length) throw new Error('inputs is empty');
    if (list.length > 100) throw new Error(`at most 100 inputs (got ${list.length})`);
    const cols = Math.min(args.columns || Math.ceil(Math.sqrt(list.length)), list.length), rows = Math.ceil(list.length / cols);
    const cw = args.cellWidth, ch = args.cellHeight || cw, gap = args.gap;
    const W = cols * cw + (cols + 1) * gap, H = rows * ch + (rows + 1) * gap; checkSize(W, H, 'montage');
    const K = await kernel(); const tiles = []; const placed = [];
    for (let i = 0; i < list.length; i++) {
      let img = await open(list[i]);
      const k = Math.min(cw / img.width, ch / img.height, args.enlarge ? Infinity : 1);
      const tw = Math.max(1, Math.round(img.width * k)), th = Math.max(1, Math.round(img.height * k));
      if (tw !== img.width || th !== img.height) img = K.imgTo('resize', img, tw, th, k < 1 ? 4 : 3);
      const x = gap + (i % cols) * (cw + gap) + ((cw - tw) >> 1), y = gap + Math.floor(i / cols) * (ch + gap) + ((ch - th) >> 1);
      tiles.push([img, x, y]); placed.push({ input: list[i], x, y, width: tw, height: th });
      ctx.progress((i + 1) / list.length, list[i]);
    }
    const res = sheet(K, W, H, parseColor(args.background), tiles);
    const output = await save(res, vfs.out(args.output, list[0], 'montage', 'png'), { quality: quality(args.quality) });
    return { output, columns: cols, rows, cell: { width: cw, height: ch }, count: list.length, tiles: placed, backend: 'wasm' };
  },
});
