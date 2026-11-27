// pdf.* — read, render, restructure, shrink and write PDFs in the browser.
// Reading/rendering: pdf.js (Mozilla, Apache-2.0). Writing/restructuring: pdf-lib (@cantoo fork, MIT). Both load lazily.
import { M, vfs, register } from '../js/core.js';
import { decode, canvasOf, canvasBytes } from '../js/img.js';

const V = (p) => new URL(`../vendor/${p}`, import.meta.url).href;
const PDF_MIME = 'application/pdf';

// ─────────────────────────────────────────────────────────── loaders ──
let libP, jsP;
const lib = () => (libP ||= import(V('pdf-lib/pdf-lib.esm.min.js')).catch((e) => { libP = null; throw new Error(`could not load pdf-lib: ${e.message}`); }));
const pdfjsLib = () => (jsP ||= import(V('pdfjs/pdf.min.mjs')).then((m) => {
  m.GlobalWorkerOptions.workerSrc = V('pdfjs/pdf.worker.min.mjs');
  return m;
}).catch((e) => { jsP = null; throw new Error(`could not load pdf.js: ${e.message}`); }));

// ─────────────────────────────────────────────────────────── helpers ──
const round = (x, d = 2) => { const k = 10 ** d; return Math.round(x * k) / k; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const pad = (n, total) => String(n).padStart(String(total).length, '0');

function assertPdf(bytes, path) {
  const head = String.fromCharCode.apply(null, bytes.subarray(0, Math.min(1024, bytes.length)));
  if (!head.includes('%PDF-')) throw new Error(`"${path}" is not a PDF (no %PDF- header; mime ${vfs.stat(path).mime}, ${bytes.length} bytes)`);
}

/**
 * "1-3,7,10-" → [0,1,2,6,9,…] (0-based, order and duplicates preserved).
 * Accepts: N · N-M · N- (to the end) · -M (from 1) · M-N reversed · last · odd · even · all. Separators: , ; or spaces.
 */
function parsePages(spec, n, what = 'pages') {
  const all = () => Array.from({ length: n }, (_, i) => i);
  if (spec === undefined || spec === null || spec === '') return all();
  if (Array.isArray(spec)) spec = spec.join(',');
  spec = String(spec).trim();
  const out = [];
  const help = 'use 1-based pages like "1-3,7,10-" (also: all, odd, even, last, "-5" = first five, "5-1" = reversed)';
  const num = (s) => (s === 'last' || s === 'end' ? n : Number(s));
  for (const raw of spec.split(/[,;\s]+/).filter(Boolean)) {
    const t = raw.toLowerCase(); let m, a, b;
    if (t === 'all') { out.push(...all()); continue; }
    if (t === 'odd' || t === 'even') { for (let i = t === 'odd' ? 0 : 1; i < n; i += 2) out.push(i); continue; }
    if ((m = /^(\d+|last|end)$/.exec(t))) a = b = num(m[1]);
    else if ((m = /^(\d+|last|end)?-(\d+|last|end)?$/.exec(t)) && (m[1] || m[2])) { a = m[1] ? num(m[1]) : 1; b = m[2] ? num(m[2]) : n; }
    else throw new Error(`bad page range "${raw}" in ${what}="${spec}" — ${help}`);
    for (const v of [a, b]) if (v < 1 || v > n) throw new Error(`page ${v} is out of range in ${what}="${spec}" — the document has ${n} page${n === 1 ? '' : 's'} (1-${n})`);
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1); else for (let i = a; i >= b; i--) out.push(i - 1);
  }
  if (!out.length) throw new Error(`${what}="${spec}" selects no pages — ${help}`);
  return out;
}
const uniqSorted = (a) => [...new Set(a)].sort((x, y) => x - y);
/** [0,1,2,6] → "1-3,7" */
function fmtPages(idx) {
  const s = uniqSorted(idx); const parts = [];
  for (let i = 0; i < s.length; i++) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; parts.push(i === j ? `${s[i] + 1}` : `${s[i] + 1}-${s[j] + 1}`); i = j; }
  return parts.join(',');
}

async function openLib(path, password, opts = {}) {
  const L = await lib(); const bytes = vfs.read(path); assertPdf(bytes, path);
  const load = (pw) => L.PDFDocument.load(bytes, { updateMetadata: false, ...(pw !== undefined ? { password: pw } : {}), ...opts });
  let doc;
  try { doc = await load(password || undefined); } catch (e) {
    const enc = /encrypt|password/i.test(`${e?.name} ${e?.message}`);
    if (enc && !password) {
      try { doc = await load(''); } catch { throw new Error(`"${path}" is encrypted and needs a password — pass password=<user or owner password>`); }
    } else if (enc) throw new Error(`"${path}": the password was not accepted (${e.message})`);
    else throw new Error(`"${path}" could not be parsed as a PDF: ${e.message}`);
  }
  return { L, doc, bytes, wasEncrypted: scrubDecrypted(L, doc, bytes) };
}

/**
 * After a password load pdf-lib holds plaintext objects but keeps the old cross-reference stream (whose dictionary still
 * says /Encrypt) and the encryption dictionary itself, and forgets /Info. Remove the leftovers so what we save is a
 * clean, unencrypted file that every reader agrees on.
 */
function scrubDecrypted(L, doc, bytes) {
  const ctx = doc.context; if (!ctx.isDecrypted) return false;
  const N = (s) => L.PDFName.of(s);
  if (!ctx.trailerInfo.Info) { // the trailer (never encrypted) still names the Info dictionary: take the last one in the file
    let tail = ''; const from = Math.max(0, bytes.length - 65536); for (let i = from; i < bytes.length; i += 8192) tail += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 8192)));
    const all = [...tail.matchAll(/\/Info\s+(\d+)\s+(\d+)\s+R/g)]; const m = all[all.length - 1];
    if (m) { const ref = L.PDFRef.of(Number(m[1]), Number(m[2])); if (ctx.lookup(ref) instanceof L.PDFDict) ctx.trailerInfo.Info = ref; }
  }
  for (const [ref, o] of ctx.enumerateIndirectObjects()) {
    if (o instanceof L.PDFRawStream && o.dict.get(N('Type')) === N('XRef')) {
      const info = o.dict.get(N('Info')); if (!ctx.trailerInfo.Info && info instanceof L.PDFRef && ctx.lookup(info)) ctx.trailerInfo.Info = info;
      const enc = o.dict.get(N('Encrypt')); if (enc instanceof L.PDFRef) ctx.delete(enc);
      ctx.delete(ref);
    } else if (o instanceof L.PDFDict && o.get(N('Filter')) === N('Standard') && o.has(N('O')) && o.has(N('U'))) ctx.delete(ref);
  }
  delete ctx.trailerInfo.Encrypt;
  return true;
}
/** pdf.js returns Maps/Sets in recent versions and plain objects/arrays in older ones */
const entriesOf = (x) => (!x ? [] : x instanceof Map ? [...x.entries()] : Object.entries(x));
const hasFlag = (x, f) => (!x ? undefined : x instanceof Set ? x.has(f) : Array.isArray(x) ? x.includes(f) : undefined);

async function withJs(path, password, fn) {
  const pdfjs = await pdfjsLib(); const bytes = vfs.read(path); assertPdf(bytes, path);
  const task = pdfjs.getDocument({
    data: bytes.slice(), password: password || undefined, verbosity: 0,
    cMapUrl: V('pdfjs/cmaps/'), cMapPacked: true, standardFontDataUrl: V('pdfjs/standard_fonts/'), wasmUrl: V('pdfjs/wasm/'), iccUrl: V('pdfjs/iccs/'),
  });
  let doc;
  try { doc = await task.promise; } catch (e) {
    try { await task.destroy(); } catch { /* ignore */ }
    if (e?.name === 'PasswordException') throw new Error(e.code === 2 ? `"${path}": incorrect password` : `"${path}" is encrypted and needs a password — pass password=<user or owner password>`);
    throw new Error(`"${path}" could not be opened as a PDF: ${e?.message || e}`);
  }
  try { return await fn({ pdfjs, doc, bytes }); } finally { try { await task.destroy(); } catch { /* ignore */ } }
}

async function savePdf(doc, path, meta = {}, saveOpts = {}) {
  let bytes;
  try { bytes = await doc.save({ useObjectStreams: true, ...saveOpts }); } catch (e) { throw new Error(`could not serialise the PDF: ${e.message}`); }
  return vfs.write(path, bytes, { mime: PDF_MIME, meta: { pages: doc.getPageCount(), ...meta } });
}

/** copy the Info-dictionary fields pdf-lib exposes from one document to another (best effort) */
function copyInfo(src, dst) {
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
    try { const v = src[`get${k}`](); if (v) { if (k === 'Keywords') dst.setKeywords([v]); else dst[`set${k}`](v); } } catch { /* odd encodings */ }
  }
  for (const k of ['CreationDate', 'ModificationDate']) { try { const v = src[`get${k}`](); if (v) dst[`set${k}`](v); } catch { /* ignore */ } }
}

/** new document holding the given pages (0-based, in order, duplicates allowed) of an opened source */
async function subset(L, src, indices) {
  const out = await L.PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  for (const p of pages) out.addPage(p);
  copyInfo(src, out);
  return out;
}

const PW = { password: { type: 'string', description: 'Password, if the PDF is encrypted (user or owner password). Any PDF this tool writes is unencrypted — re-apply pdf.encrypt if needed' } };
const PAGES = (extra = '') => ({ type: 'string', description: `1-based page selection such as "1-3,7,10-" ("10-" = to the end; also all, odd, even, last, "-5", reversed "5-1").${extra}` });
const NOTE_COPY = ' Bookmarks, form-field definitions and document-level attachments are not carried into the new file (page content, links and annotations are).';

const SIZES = { a3: [841.89, 1190.55], a4: [595.28, 841.89], a5: [419.53, 595.28], a6: [297.64, 419.53], b5: [498.9, 708.66], letter: [612, 792], legal: [612, 1008], tabloid: [792, 1224], executive: [522, 756] };
function pageSizeOf(spec, orientation = 'portrait') {
  let wh;
  const s = String(spec || 'a4').trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*[x×,]\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (SIZES[s]) wh = [...SIZES[s]];
  else if (m) wh = [Number(m[1]), Number(m[2])];
  else throw new Error(`unknown pageSize "${spec}" — use one of ${Object.keys(SIZES).join(', ')} or "WIDTHxHEIGHT" in points (72 pt = 1 inch; A4 = 595x842)`);
  if (wh[0] < 10 || wh[1] < 10 || wh[0] > 14400 || wh[1] > 14400) throw new Error(`pageSize "${spec}" is out of range (10-14400 pt per side)`);
  if ((orientation === 'landscape' && wh[0] < wh[1]) || (orientation === 'portrait' && wh[0] > wh[1] && SIZES[s])) wh.reverse();
  return wh;
}
function sizeName(w, h) {
  const a = Math.min(w, h), b = Math.max(w, h);
  for (const [k, [sw, sh]] of Object.entries(SIZES)) if (Math.abs(a - sw) < 2.5 && Math.abs(b - sh) < 2.5) return `${k[0].toUpperCase()}${k.slice(1)}${w > h ? ' landscape' : ''}`;
  return null;
}

const NAMED = { black: '#000000', white: '#ffffff', red: '#d00000', green: '#008000', blue: '#0000d0', gray: '#808080', grey: '#808080', orange: '#e07000', yellow: '#e0c000' };
function colorOf(L, spec, what = 'color') {
  let s = String(spec || '#000000').trim().toLowerCase(); s = NAMED[s] || s;
  let m = /^#?([0-9a-f]{3})$/.exec(s); if (m) s = '#' + [...m[1]].map((c) => c + c).join('');
  m = /^#?([0-9a-f]{6})$/.exec(s);
  if (!m) throw new Error(`bad ${what} "${spec}" — use #rrggbb, #rgb or one of ${Object.keys(NAMED).join(', ')}`);
  const v = parseInt(m[1], 16);
  return L.rgb(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
}

// Standard-14 fonts only know WinAnsi (≈ Latin-1 + a few typographic signs). Everything else is transliterated or becomes "?".
const TRANSLIT = { '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '⇐': '<=', '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '-', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '★': '*', '☆': '*', '●': '•', '○': 'o', '■': '•', '□': 'o', '▪': '•', '◦': 'o', '‣': '•', '⁃': '-', '∙': '·', '′': "'", '″': '"', '‹': '<', '›': '>', '\u00a0': ' ', '\u2002': ' ', '\u2003': ' ', '\u2009': ' ', '\u200a': ' ', '\u202f': ' ', '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i', '∞': 'inf', '∑': 'Sum', '√': 'sqrt', '≡': '==', '∈': 'in', '∧': '^', '∨': 'v' };
function makeCleaner() {
  const sets = new Map(); const stats = { replaced: 0, samples: new Set() };
  const clean = (font, str) => {
    let set = sets.get(font); if (!set) { set = new Set(font.getCharacterSet()); sets.set(font, set); }
    let out = '';
    for (const ch of String(str)) {
      const cp = ch.codePointAt(0);
      if (set.has(cp)) { out += ch; continue; }
      if (cp === 9) { out += '    '; continue; }
      if (cp < 32 || cp === 127) continue;
      let r = TRANSLIT[ch];
      if (r === undefined) { const d = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); if (d && [...d].every((c) => set.has(c.codePointAt(0)))) r = d; }
      if (r === undefined) { r = '?'; stats.replaced++; if (stats.samples.size < 12) stats.samples.add(ch); }
      out += r;
    }
    return out;
  };
  const report = () => (stats.replaced ? { unencodable: stats.replaced, unencodableSamples: [...stats.samples].join(' '), note: 'Standard PDF fonts only cover WinAnsi (Latin-1 plus a few signs); other characters (Greek, Cyrillic, CJK, emoji…) were written as "?".' } : {});
  return { clean, report };
}

async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
const deflate = (b) => pipe(b, new CompressionStream('deflate'));
const inflate = (b) => pipe(b, new DecompressionStream('deflate'));

function jpegOrientation(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let o = 2;
  while (o + 4 < b.length && b[o] === 0xff) {
    const m = b[o + 1], len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) {
      const t = o + 10, le = b[t] === 0x49;
      const r16 = (p) => (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]);
      const r32 = (p) => (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0 : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0);
      const ifd = t + r32(t + 4); const n = r16(ifd);
      for (let i = 0; i < n; i++) { const e = ifd + 2 + i * 12; if (e + 12 > b.length) break; if (r16(e) === 0x0112) return r16(e + 8) || 1; }
      return 1;
    }
    if (m === 0xda) break;
    o += 2 + len;
  }
  return 1;
}

/** embed any browser-decodable image; JPEG and PNG bytes go in untouched unless quality/maxSide force a re-encode */
async function embedImage(doc, path, { quality, maxSide } = {}) {
  const bytes = vfs.read(path);
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  let direct = quality === undefined && !maxSide;
  if (!direct && quality === undefined && (isJpg || isPng)) { // maxSide only: keep the original bytes when the image is already small enough
    try { const probe = await createImageBitmap(vfs.blob(path)); direct = Math.max(probe.width, probe.height) <= maxSide; probe.close?.(); } catch { /* decoded below */ }
  }
  if (direct && isJpg && jpegOrientation(bytes) === 1) { try { return { image: await doc.embedJpg(bytes), how: 'jpeg-passthrough' }; } catch { /* fall through to re-encode */ } }
  if (direct && isPng) { try { return { image: await doc.embedPng(bytes), how: 'png' }; } catch { /* fall through */ } }
  // decode with the browser (applies EXIF orientation), then re-encode
  let bmp;
  try { bmp = await createImageBitmap(vfs.blob(path)); } catch {
    const img = await decode(path); const c0 = canvasOf(img.width, img.height); c0.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0); bmp = c0;
  }
  let w = bmp.width, h = bmp.height;
  if (maxSide && Math.max(w, h) > maxSide) { const k = maxSide / Math.max(w, h); w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k)); }
  const c = canvasOf(w, h); const g = c.getContext('2d');
  const asJpeg = quality !== undefined || isJpg;
  if (asJpeg) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h); bmp.close?.();
  if (asJpeg) { const { bytes: jb } = await canvasBytes(c, 'jpeg', quality ?? 0.92); return { image: await doc.embedJpg(jb), how: 'jpeg-reencoded' }; }
  const { bytes: pb } = await canvasBytes(c, 'png');
  return { image: await doc.embedPng(pb), how: 'png-reencoded' };
}

/**
 * Visible frame of a page: size as displayed (CropBox, /Rotate applied) and a map from visual coordinates
 * (origin bottom-left of the displayed page, y up) to user space, so stamps come out upright on rotated pages.
 */
function frameOf(page) {
  const c = page.getCropBox(); const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const W = rot % 180 ? c.height : c.width, H = rot % 180 ? c.width : c.height;
  const map = (vx, vy) => {
    if (rot === 90) return [c.x + c.width - vy, c.y + vx];
    if (rot === 180) return [c.x + c.width - vx, c.y + c.height - vy];
    if (rot === 270) return [c.x + vy, c.y + c.height - vx];
    return [c.x + vx, c.y + vy];
  };
  return { W, H, rot, map };
}

// ───────────────────────────────────────────────── text reconstruction ──
/**
 * Lines of one page from pdf.js text items. Items that follow each other on one baseline are joined (a wide gap
 * starts a new segment = table cell); stream order is kept between lines, which preserves columns in most PDFs.
 * Coordinates are viewport points: x right, y DOWN from the top of the displayed page.
 */
async function pageLines(pdfjs, page, { order = 'stream', fonts = false } = {}) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  if (fonts) { try { await page.getOperatorList(); } catch { /* font info is optional */ } }
  const fontInfo = new Map();
  const infoOf = (name) => {
    if (fontInfo.has(name)) return fontInfo.get(name);
    const st = tc.styles?.[name]; let info = { mono: st?.fontFamily === 'monospace', bold: false, italic: false, name: null };
    if (fonts) { try { const f = page.commonObjs.get(name); const nm = f?.name || ''; info = { mono: info.mono || !!f?.isMonospace, bold: !!f?.bold || !!f?.black || /bold|black|heavy|semibold|demi|medi$/i.test(nm), italic: !!f?.italic || /italic|oblique/i.test(nm), name: nm || null }; } catch { /* not resolved */ } }
    fontInfo.set(name, info); return info;
  };
  const lines = []; let cur = null; let pendingSpace = false;
  const flush = () => {
    if (!cur) return;
    const segs = cur.segs.map((s) => ({ x: s.x, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text);
    if (segs.length) {
      let size = cur.size, best = 0; for (const [k, v] of cur.sizes) if (v > best) { best = v; size = k; }
      let font = null; best = 0; for (const [k, v] of cur.fonts) if (v > best) { best = v; font = k; }
      const fi = infoOf(font);
      lines.push({ x: segs[0].x, xEnd: cur.xEnd, y: cur.y, size, ang: cur.ang, segs, text: segs.map((s) => s.text).join('   '), mono: fi.mono, bold: fi.bold, italic: fi.italic });
    }
    cur = null; pendingSpace = false;
  };
  for (const it of tc.items) {
    if (typeof it.str !== 'string') continue;
    if (!it.str.trim()) { if (it.str) pendingSpace = true; if (it.hasEOL) flush(); continue; }
    const t = pdfjs.Util.transform(vp.transform, it.transform);
    const size = round(Math.hypot(t[2], t[3]) || it.height || 1, 1);
    const th = Math.atan2(t[1], t[0]); const ang = Math.round((th * 180) / Math.PI);
    const cos = Math.cos(th), sin = Math.sin(th);
    const u = t[4] * cos + t[5] * sin, v = -t[4] * sin + t[5] * cos; // along / across the writing direction
    const w = it.width || 0;
    const n = it.str.length;
    if (cur && cur.ang === ang && Math.abs(v - cur.v) <= 0.45 * Math.max(size, cur.size) && u >= cur.uEnd - 1.2 * Math.max(size, cur.size)) {
      const gap = u - cur.uEnd; const seg = cur.segs[cur.segs.length - 1];
      if (gap > 0.8 * Math.max(size, cur.size)) cur.segs.push({ x: t[4], text: it.str });
      else seg.text += ((pendingSpace || gap > 0.18 * size) && !/\s$/.test(seg.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
    } else {
      flush();
      cur = { ang, v, y: t[5], size, uEnd: u, xEnd: t[4], segs: [{ x: t[4], text: it.str }], sizes: new Map(), fonts: new Map() };
    }
    cur.uEnd = Math.max(cur.uEnd, u + w); cur.xEnd = Math.max(cur.xEnd, t[4] + w * cos);
    cur.sizes.set(size, (cur.sizes.get(size) || 0) + n); cur.fonts.set(it.fontName, (cur.fonts.get(it.fontName) || 0) + n);
    pendingSpace = false;
    if (it.hasEOL) flush();
  }
  flush();
  let out = lines;
  if (order === 'position') {
    // strict top-to-bottom, left-to-right: fixes jumbled stream order but interleaves multi-column layouts
    const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x); out = [];
    for (const l of sorted) {
      const p = out[out.length - 1];
      if (p && p.ang === l.ang && Math.abs(p.y - l.y) < 0.3 * Math.max(p.size, l.size)) {
        const segs = [...p.segs, ...l.segs].sort((a, b) => a.x - b.x);
        Object.assign(p, { segs, x: segs[0].x, xEnd: Math.max(p.xEnd, l.xEnd), text: segs.map((s) => s.text).join('   ') });
      } else out.push({ ...l });
    }
  }
  return { lines: out, width: vp.width, height: vp.height };
}

function linesToText(lines) {
  let s = ''; let prev = null;
  for (const l of lines) {
    if (prev) { const d = l.y - prev.y; s += d > 1.75 * Math.max(prev.size, l.size) || d < -1.2 * prev.size ? '\n\n' : '\n'; }
    s += l.text; prev = l;
  }
  return s;
}

/** drop running headers/footers: short lines in the top/bottom 10% of the page that repeat (digits ignored) on most pages */
function stripRepeated(pages) {
  if (pages.length < 3) return 0;
  const key = (l, p) => `${l.y < p.height / 2 ? 'T' : 'B'}|${l.text.replace(/\d+/g, '#').trim()}`;
  const inMargin = (l, p) => l.text.length <= 80 && (l.y < p.height * 0.1 || l.y > p.height * 0.9);
  const seen = new Map();
  for (const p of pages) { const ks = new Set(p.lines.filter((l) => inMargin(l, p)).map((l) => key(l, p))); for (const k of ks) seen.set(k, (seen.get(k) || 0) + 1); }
  const need = Math.max(3, Math.ceil(pages.length * 0.5)); let removed = 0;
  for (const p of pages) { const before = p.lines.length; p.lines = p.lines.filter((l) => !(inMargin(l, p) && seen.get(key(l, p)) >= need)); removed += before - p.lines.length; }
  return removed;
}

const BULLET = /^([•◦▪■●○‣·∙*\-–—])\s+(.*)$/;
const NUMBERED = /^(\(?\d{1,3}[.)])\s+(.*)$/;

function pagesToMarkdown(pages, { pageMarkers = false, tables = true } = {}) {
  const hist = new Map();
  for (const p of pages) for (const l of p.lines) if (l.ang === 0) { const k = Math.round(l.size * 2) / 2; hist.set(k, (hist.get(k) || 0) + l.text.length); }
  let body = 10, best = -1; for (const [k, v] of hist) if (v > best) { best = v; body = k; }
  // Heading levels: font sizes clearly above body size, clustered (sizes within 6% are one level). The first heading
  // met in the document is taken as its title (level 1); anything larger (figure lettering, cover art) is level 1 too.
  const big = [...hist.keys()].filter((s) => s >= body * 1.12).sort((a, b) => b - a);
  const clusters = []; for (const s of big) { const c = clusters[clusters.length - 1]; if (c && c[0] / s <= 1.06) c.push(s); else clusters.push([s]); }
  let first = null;
  outer: for (const p of pages) for (const l of p.lines) if (l.ang === 0 && l.text.length <= 200 && l.size >= body * 1.12) { first = Math.round(l.size * 2) / 2; break outer; }
  const top = Math.max(0, clusters.findIndex((c) => c.includes(first)));
  const headSizes = clusters.slice(top).map((c) => c[0]);
  const levelOf = (l) => { const k = Math.round(l.size * 2) / 2; const i = clusters.findIndex((c) => c.includes(k)); return i < 0 ? 0 : Math.min(Math.max(0, i - top) + 1, 6); };
  const boldLevel = Math.min(headSizes.length + 1, 6);
  const isList = (l) => BULLET.test(l.text) || (NUMBERED.test(l.text) && !(l.text.length <= 120 && (l.bold || l.size >= body * 1.12))); // "1. Introduction" in bold or large type is a heading, not a list item
  const headingLevel = (l, next) => {
    if (l.text.length > 200 || isList(l) || l.segs.length > 2) return 0;
    const lv = levelOf(l); if (lv) return lv;
    if (l.bold && !l.mono && l.segs.length === 1 && l.text.length <= 90 && !/[.,;:]$/.test(l.text) && /[A-Za-z\u00c0-\uffff]/.test(l.text) && (!next || !next.bold)) return boldLevel;
    return 0;
  };
  const esc = (s) => s.replace(/\|/g, '\\|');
  const stats = { headings: 0, paragraphs: 0, listItems: 0, tables: 0, codeBlocks: 0 };
  const out = [];
  for (const p of pages) {
    if (pageMarkers) out.push(`<!-- page ${p.n} -->`);
    const L = p.lines.filter((l) => l.ang === 0); let i = 0;
    const gapOk = (a, b, k = 1.75) => b.y - a.y > -0.5 * a.size && b.y - a.y <= k * Math.max(a.size, b.size);
    while (i < L.length) {
      const l = L[i]; let m;
      if (l.mono) {
        const blk = [l]; let j = i + 1;
        while (j < L.length && L[j].mono && L[j].y - L[j - 1].y < 4 * l.size && L[j].y > L[j - 1].y) blk.push(L[j++]);
        if (blk.length === 1 && l.text.length <= 80) { out.push('`' + l.text.replace(/`/g, "'") + '`'); stats.paragraphs++; i = j; continue; } // a lone monospace line (e-mail, URL, identifier)
        const x0 = Math.min(...blk.map((b) => b.x)); const cw = l.size * 0.6;
        out.push('```\n' + blk.map((b) => ' '.repeat(clamp(Math.round((b.x - x0) / cw), 0, 40)) + b.text).join('\n') + '\n```'); stats.codeBlocks++; i = j; continue;
      }
      const lv = headingLevel(l, L[i + 1]);
      if (lv) {
        let text = l.text; let j = i + 1;
        while (j < L.length && levelOf(L[j]) === lv && levelOf(l) === lv && gapOk(L[j - 1], L[j], 1.5) && !isList(L[j])) text += ' ' + L[j++].text;
        out.push(`${'#'.repeat(lv)} ${text.replace(/\s{2,}/g, ' ')}`); stats.headings++; i = j; continue;
      }
      if (tables && l.segs.length >= 2) {
        const rows = [l]; let j = i + 1;
        while (j < L.length && L[j].segs.length >= 2 && !L[j].mono && gapOk(L[j - 1], L[j], 3)) rows.push(L[j++]);
        if (rows.length >= 2) {
          const xs = rows.flatMap((r) => r.segs.map((s) => s.x)).sort((a, b) => a - b); const tol = Math.max(6, l.size * 1.2);
          const cols = []; for (const x of xs) { if (!cols.length || x - cols[cols.length - 1] > tol) cols.push(x); }
          const maxSegs = Math.max(...rows.map((r) => r.segs.length));
          if (cols.length === maxSegs && cols.length <= 16) {
            const grid = rows.map((r) => { const cells = Array(cols.length).fill(''); for (const s of r.segs) { let c = 0; for (let k = 0; k < cols.length; k++) if (s.x >= cols[k] - 0.5) c = k; cells[c] = cells[c] ? `${cells[c]} ${s.text}` : s.text; } return cells; });
            const row = (c) => `| ${c.map(esc).join(' | ')} |`;
            out.push([row(grid[0]), `|${' --- |'.repeat(cols.length)}`, ...grid.slice(1).map(row)].join('\n')); stats.tables++; i = j; continue;
          }
        }
      }
      if ((m = BULLET.exec(l.text)) || (m = NUMBERED.exec(l.text))) {
        const items = []; let j = i; const x0 = l.x;
        while (j < L.length) {
          const a = L[j]; const mm = BULLET.exec(a.text) || NUMBERED.exec(a.text);
          if (!mm || a.mono || headingLevel(a, L[j + 1]) || (j > i && !gapOk(L[j - 1], a, 2.6))) break;
          let text = mm[2]; const marker = BULLET.test(a.text) ? '-' : mm[1].replace(/[()]/g, '').replace(/\.?$/, '.'); j++;
          while (j < L.length && !isList(L[j]) && !L[j].mono && L[j].x > a.x + 1 && gapOk(L[j - 1], L[j], 1.6) && !levelOf(L[j])) text = joinWrapped(text, L[j++].text);
          items.push(`${'  '.repeat(clamp(Math.round((a.x - x0) / (1.5 * a.size)), 0, 4))}${marker} ${text}`);
        }
        if (items.length) { out.push(items.join('\n')); stats.listItems += items.length; i = j; continue; }
      }
      let text = l.text; let j = i + 1;
      while (j < L.length) {
        const a = L[j], pv = L[j - 1];
        if (a.mono || isList(a) || headingLevel(a, L[j + 1]) || !gapOk(pv, a, 1.6) || Math.abs(a.size - pv.size) > 0.8) break;
        if (a.x > pv.x + 0.8 * a.size && j - 1 > i) break; // first-line indent → new paragraph
        if (tables && a.segs.length >= 2 && L[j + 1]?.segs.length >= 2) break;
        text = joinWrapped(text, a.text); j++;
      }
      out.push(text); stats.paragraphs++; i = j;
    }
  }
  return { markdown: out.join('\n\n') + '\n', stats, bodySize: body, headingSizes: headSizes.slice(0, 6) };
}
function joinWrapped(a, b) {
  if (/[A-Za-z\u00c0-\u024f]-$/.test(a) && /^[a-z\u00df-\u00ff]/.test(b)) return a.slice(0, -1) + b; // de-hyphenate
  return `${a} ${b}`;
}

async function extractPages(input, password, pagesSpec, opts, ctx, tag = 'reading') {
  return withJs(input, password, async ({ pdfjs, doc }) => {
    const idx = uniqSorted(parsePages(pagesSpec, doc.numPages));
    const pages = [];
    for (let k = 0; k < idx.length; k++) {
      const page = await doc.getPage(idx[k] + 1);
      const r = await pageLines(pdfjs, page, opts);
      pages.push({ n: idx[k] + 1, ...r }); page.cleanup();
      ctx?.progress?.((k + 1) / idx.length, `${tag} page ${idx[k] + 1}`);
    }
    return { pages, numPages: doc.numPages };
  });
}

// ─────────────────────────────────────────────────────────────── info ──
register({
  name: 'pdf.info', readOnly: true,
  description: 'Inspect a PDF without changing it: page count, page sizes (points, with /Rotate applied), PDF version, metadata, encryption, whether pages carry a text layer (if not, it is a scan and needs OCR), fonts, image count and their share of the file size, and whether an outline, form fields or attachments exist. Use it first to decide between pdf.text / OCR and which pdf.compress mode can help.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      deep: { type: 'boolean', default: false, description: 'Check every page for text (default: up to 40 evenly spaced pages)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.info input=report.pdf'],
  async run({ input, deep, password }) {
    const bytesTotal = vfs.read(input).length;
    const res = await withJs(input, password, async ({ pdfjs, doc, bytes }) => {
      const n = doc.numPages;
      const head = String.fromCharCode.apply(null, bytes.subarray(0, 1024)); const hv = /%PDF-(\d\.\d)/.exec(head);
      const md = await doc.getMetadata().catch(() => ({ info: {} })); const info = md.info || {};
      const date = (s) => { try { const d = pdfjs.PDFDateString.toDateObject(s); return d ? d.toISOString() : s || undefined; } catch { return s || undefined; } };
      const metadata = {}; for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) if (info[k]) metadata[k.toLowerCase()] = String(info[k]).slice(0, 300);
      if (info.CreationDate) metadata.created = date(info.CreationDate); if (info.ModDate) metadata.modified = date(info.ModDate);
      // page sizes, grouped
      const groups = []; const sizeLimit = Math.min(n, 2000);
      for (let i = 1; i <= sizeLimit; i++) {
        const page = await doc.getPage(i); const vp = page.getViewport({ scale: 1 }); const w = round(vp.width, 1), h = round(vp.height, 1);
        const g = groups.find((x) => x.width === w && x.height === h && x.rotation === page.rotate);
        if (g) g.idx.push(i - 1); else groups.push({ width: w, height: h, rotation: page.rotate, idx: [i - 1] });
      }
      const pageSizes = groups.slice(0, 20).map((g) => ({ pages: fmtPages(g.idx), count: g.idx.length, widthPt: g.width, heightPt: g.height, widthMm: round(g.width / 72 * 25.4, 0), heightMm: round(g.height / 72 * 25.4, 0), rotation: g.rotation, name: sizeName(g.width, g.height) || undefined }));
      // text layer
      const check = deep || n <= 40 ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: 40 }, (_, i) => Math.round((i * (n - 1)) / 39));
      const noText = []; let chars = 0;
      for (const i of uniqSorted(check)) { const page = await doc.getPage(i + 1); const tc = await page.getTextContent(); const c = tc.items.reduce((a, it) => a + (it.str ? it.str.trim().length : 0), 0); chars += c; if (c < 2) noText.push(i); page.cleanup(); }
      const checked = uniqSorted(check).length;
      const outline = await doc.getOutline().catch(() => null);
      const att = await doc.getAttachments().catch(() => null);
      const fields = await doc.getFieldObjects().catch(() => null);
      const perms = await doc.getPermissions().catch(() => null);
      const P = pdfjs.PermissionFlag || {};
      return {
        pages: n, version: info.PDFFormatVersion || hv?.[1] || null, encrypted: !!info.EncryptFilterName, encryption: info.EncryptFilterName || undefined,
        permissions: perms ? { print: hasFlag(perms, P.PRINT), copy: hasFlag(perms, P.COPY), modify: hasFlag(perms, P.MODIFY_CONTENTS), annotate: hasFlag(perms, P.MODIFY_ANNOTATIONS), fillForms: hasFlag(perms, P.FILL_INTERACTIVE_FORMS) } : undefined,
        linearized: !!info.IsLinearized, metadata, hasXmp: !!md.metadata,
        pageSizes, pageSizesTruncated: groups.length > 20 || sizeLimit < n || undefined,
        textLayer: { pagesChecked: checked, sampled: checked < n, pagesWithText: checked - noText.length, pagesWithoutText: noText.length ? fmtPages(noText) : '', charsPerPage: Math.round(chars / Math.max(1, checked)), verdict: noText.length === 0 ? 'text' : noText.length === checked ? 'none (scan — OCR needed to get text)' : 'partial (some pages are images only — OCR those)' },
        outline: { present: !!outline?.length, topLevelItems: outline?.length || 0 },
        forms: { present: !!info.IsAcroFormPresent || entriesOf(fields).length > 0, fields: entriesOf(fields).length, xfa: !!info.IsXFAPresent, signatures: !!info.IsSignaturesPresent },
        attachments: { present: entriesOf(att).length > 0, count: entriesOf(att).length },
      };
    });
    res.bytes = bytesTotal; res.bytesPerPage = Math.round(bytesTotal / Math.max(1, res.pages));
    // object-level scan (fonts, images) with pdf-lib — skipped for very large files
    if (bytesTotal <= 80 * 1048576) {
      try {
        const { L, doc } = await openLib(input, password);
        const N = (s) => L.PDFName.of(s); const ctx = doc.context; const fonts = new Map(); let images = 0, imageBytes = 0, objects = 0;
        const embedded = (d) => { const fd = d.lookup(N('FontDescriptor')); return !!(fd instanceof L.PDFDict && (fd.has(N('FontFile')) || fd.has(N('FontFile2')) || fd.has(N('FontFile3')))); };
        for (const [, obj] of ctx.enumerateIndirectObjects()) {
          objects++;
          if (obj instanceof L.PDFRawStream) { if (obj.dict.get(N('Subtype')) === N('Image')) { images++; imageBytes += obj.contents.length; } continue; }
          if (!(obj instanceof L.PDFDict) || obj.get(N('Type')) !== N('Font')) continue;
          const sub = obj.get(N('Subtype'))?.asString?.().slice(1) || '?'; if (/^CIDFont/.test(sub)) continue;
          const name = (obj.lookup(N('BaseFont'))?.asString?.() || '/(unnamed)').slice(1);
          let emb = false; try { emb = sub === 'Type3' ? true : sub === 'Type0' ? embedded(ctx.lookup(obj.lookup(N('DescendantFonts'), L.PDFArray).get(0), L.PDFDict)) : embedded(obj); } catch { /* malformed */ }
          fonts.set(`${name}|${sub}`, { name: name.replace(/^[A-Z]{6}\+/, ''), type: sub, embedded: emb, subset: /^[A-Z]{6}\+/.test(name) });
        }
        res.fonts = [...fonts.values()].slice(0, 40); if (fonts.size > 40) res.fontsTruncated = true;
        res.images = { count: images, bytes: imageBytes, shareOfFile: round(imageBytes / Math.max(1, bytesTotal), 3) };
        res.objects = objects;
      } catch (e) { res.fontsNote = `object scan skipped: ${e.message}`; }
    } else res.fontsNote = 'object scan (fonts, images) skipped: file larger than 80 MB';
    return res;
  },
});

// ─────────────────────────────────────────────────────────────── text ──
register({
  name: 'pdf.text',
  description: 'Extract the text layer of a PDF into a .txt file (best-effort reading order, one block per page) and return a short excerpt plus per-page character counts. Pages with no text layer (scanned images) are listed in pagesWithoutText — run OCR on a pdf.render of those pages instead. For headings/lists/tables use pdf.toMarkdown.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      pages: PAGES(' Default: all pages.'),
      order: { type: 'string', enum: ['stream', 'position'], default: 'stream', description: 'stream = order in which the PDF emits text (keeps columns together; right for most files); position = strict top-to-bottom, left-to-right (use when stream order comes out jumbled; interleaves multi-column pages)' },
      pageMarkers: { type: 'boolean', default: true, description: 'Put a "[page N]" line before each page' },
      stripHeaders: { type: 'boolean', default: false, description: 'Drop running headers/footers (lines repeated at the top/bottom of most pages)' },
      excerptChars: { type: 'integer', default: 600, minimum: 0, maximum: 4000, description: 'Characters of text to return inline' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.text.txt)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.text input=paper.pdf pages=1-5'],
  async run(a, ctx) {
    const { pages, numPages } = await extractPages(a.input, a.password, a.pages, { order: a.order }, ctx);
    const stripped = a.stripHeaders ? stripRepeated(pages) : 0;
    const parts = []; const empty = []; const counts = []; let total = 0;
    for (const p of pages) {
      const t = linesToText(p.lines); const c = t.replace(/\s/g, '').length;
      if (c < 2) empty.push(p.n - 1);
      counts.push({ page: p.n, chars: t.length }); total += t.length;
      parts.push((a.pageMarkers ? `[page ${p.n}]\n` : '') + t);
    }
    const text = parts.join(a.pageMarkers ? '\n\n' : '\n\n\f') + '\n';
    const output = await vfs.write(vfs.out(a.output, a.input, 'text', 'txt'), text, { meta: { pages: pages.length } });
    const body = parts.map((s) => s.replace(/^\[page \d+\]\n/, '')).join('\n').trim();
    return {
      output, pages: numPages, pagesRead: pages.length, chars: total,
      pagesWithoutText: empty.length ? fmtPages(empty) : '', needsOcr: empty.length > 0,
      note: empty.length ? `${empty.length} of ${pages.length} page(s) have no text layer (scanned images): render them with pdf.render and run OCR.` : undefined,
      headerLinesStripped: a.stripHeaders ? stripped : undefined,
      perPage: counts.slice(0, 60), perPageTruncated: counts.length > 60 || undefined,
      excerpt: body.slice(0, a.excerptChars), excerptTruncated: body.length > a.excerptChars,
    };
  },
});

register({
  name: 'pdf.toMarkdown',
  description: 'Convert a PDF with a text layer to Markdown using layout heuristics: headings from font sizes (and short bold lines), paragraphs re-flowed and de-hyphenated, bullet/numbered lists, monospace runs as code blocks, and simple tables where cells line up in columns. Heuristic — complex layouts, merged cells and multi-line table cells will not survive; images are not included (see pdf.images). Writes a .md file and returns counts plus an excerpt.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      pages: PAGES(' Default: all pages.'),
      pageMarkers: { type: 'boolean', default: false, description: 'Insert "<!-- page N -->" comments at page starts' },
      stripHeaders: { type: 'boolean', default: true, description: 'Drop running headers/footers (lines repeated at the top/bottom of most pages, e.g. page numbers)' },
      tables: { type: 'boolean', default: true, description: 'Detect column-aligned rows and emit Markdown tables' },
      order: { type: 'string', enum: ['stream', 'position'], default: 'stream', description: 'Line order: stream (PDF emission order, keeps columns) or position (top-to-bottom, left-to-right)' },
      excerptChars: { type: 'integer', default: 600, minimum: 0, maximum: 4000, description: 'Characters of Markdown to return inline' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.md)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.toMarkdown input=paper.pdf pageMarkers=true'],
  async run(a, ctx) {
    const { pages, numPages } = await extractPages(a.input, a.password, a.pages, { order: a.order, fonts: true }, ctx);
    const empty = pages.filter((p) => !p.lines.length).map((p) => p.n - 1);
    const stripped = a.stripHeaders ? stripRepeated(pages) : 0;
    const { markdown, stats, bodySize, headingSizes } = pagesToMarkdown(pages, a);
    const output = await vfs.write(vfs.out(a.output, a.input, '', 'md'), markdown, { meta: { pages: pages.length } });
    return {
      output, pages: numPages, pagesRead: pages.length, chars: markdown.length, ...stats, bodyFontSize: bodySize, headingFontSizes: headingSizes,
      headerLinesStripped: stripped, pagesWithoutText: empty.length ? fmtPages(empty) : '', needsOcr: empty.length > 0,
      excerpt: markdown.slice(0, a.excerptChars), excerptTruncated: markdown.length > a.excerptChars,
    };
  },
});

register({
  name: 'pdf.find', readOnly: true,
  description: 'Search the text layer of a PDF for a string or regular expression and return the pages and surrounding snippets (first 50 matches). Use it to locate the pages worth extracting or rendering in a long document. Matching runs per page on re-flowed text, so phrases broken across lines still match.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      query: { type: 'string', description: 'Text to find, or a JavaScript regular expression source when regex=true' },
      regex: { type: 'boolean', default: false, description: 'Treat query as a regular expression' },
      caseSensitive: { type: 'boolean', default: false, description: 'Match case exactly' },
      pages: PAGES(' Default: all pages.'),
      ...PW,
    },
    required: ['input', 'query'],
  },
  examples: ['pdf.find input=contract.pdf query="termination"'],
  async run(a, ctx) {
    let re;
    try { re = new RegExp(a.regex ? a.query : a.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), a.caseSensitive ? 'g' : 'gi'); } catch (e) { throw new Error(`bad regular expression: ${e.message}`); }
    const { pages, numPages } = await extractPages(a.input, a.password, a.pages, {}, ctx, 'searching');
    const matches = []; const perPage = {}; let total = 0;
    for (const p of pages) {
      const text = p.lines.map((l) => l.text).join(' ').replace(/\s+/g, ' '); let m; re.lastIndex = 0;
      while ((m = re.exec(text))) {
        if (!m[0]) { re.lastIndex++; continue; }
        total++; perPage[p.n] = (perPage[p.n] || 0) + 1;
        if (matches.length < 50) matches.push({ page: p.n, match: m[0].slice(0, 120), snippet: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60) });
      }
    }
    const pagesHit = Object.keys(perPage).map((k) => Number(k) - 1);
    return { pages: numPages, pagesSearched: pages.length, total, pagesWithMatches: pagesHit.length ? fmtPages(pagesHit) : '', matches, truncated: total > matches.length };
  },
});

// ───────────────────────────────────────────────────────────── render ──
async function renderPage(page, { scale, background = '#ffffff', forms = true }, pdfjs) {
  const vp = page.getViewport({ scale });
  const w = Math.max(1, Math.round(vp.width)), h = Math.max(1, Math.round(vp.height));
  if (w > 16384 || h > 16384 || w * h > 120e6) throw new Error(`page would render at ${w}x${h} px, which is beyond what a canvas can hold — lower dpi/width`);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  await page.render({ canvas, viewport: vp, background: background === 'transparent' ? 'rgba(0,0,0,0)' : background, annotationMode: forms ? pdfjs.AnnotationMode.ENABLE : pdfjs.AnnotationMode.DISABLE }).promise;
  return canvas;
}

register({
  name: 'pdf.render',
  description: 'Rasterise PDF pages to PNG, JPEG or WebP images at a given DPI or pixel width (pdf.js renderer; fonts, CJK cmaps, JPEG2000/JBIG2 and ICC colour supported). Use it to look at a page, to feed OCR or vision tools, or to make thumbnails. Returns one image stat per page in outputs (with width, height, page).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      pages: PAGES(' Default: all pages (at most maxPages).'),
      dpi: { type: 'number', default: 144, minimum: 8, maximum: 1200, description: 'Resolution; 72 = 1 px per point, 144 is good for reading, 300 for OCR. Ignored when width is given' },
      width: { type: 'integer', minimum: 16, maximum: 16384, description: 'Target width in pixels for every page (overrides dpi)' },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], default: 'png', description: 'Image format' },
      quality: { type: 'number', default: 0.9, minimum: 0.05, maximum: 1, description: 'JPEG/WebP quality' },
      background: { type: 'string', default: '#ffffff', description: 'Paper colour as CSS colour, or "transparent" (PNG/WebP only)' },
      annotations: { type: 'boolean', default: true, description: 'Draw annotations and form-field appearances' },
      maxPages: { type: 'integer', default: 50, minimum: 1, maximum: 1000, description: 'Safety cap on the number of pages rendered in one call' },
      output: { type: 'string', description: 'VFS path. One page: used as is. Several pages: "{n}" is replaced by the page number (zero-padded to the width of the page count, e.g. 03 of 15), otherwise "-<n>" is inserted before the extension. Default: <input>.p<n>.<ext>' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.render input=report.pdf pages=1 dpi=150', 'pdf.render input=scan.pdf pages=1-3 width=1600 format=jpeg'],
  async run(a, ctx) {
    const ext = a.format === 'jpeg' ? 'jpg' : a.format;
    return withJs(a.input, a.password, async ({ pdfjs, doc }) => {
      const idx = uniqSorted(parsePages(a.pages, doc.numPages));
      if (idx.length > a.maxPages) throw new Error(`${idx.length} pages selected but maxPages=${a.maxPages} — narrow pages= (e.g. "1-${a.maxPages}") or raise maxPages`);
      const outputs = [];
      for (let k = 0; k < idx.length; k++) {
        const n = idx[k] + 1; const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = a.width ? a.width / base.width : a.dpi / 72;
        const canvas = await renderPage(page, { scale, background: a.format === 'jpeg' && a.background === 'transparent' ? '#ffffff' : a.background, forms: a.annotations }, pdfjs);
        let path;
        if (a.output) path = idx.length === 1 ? a.output.replace('{n}', n) : a.output.includes('{n}') ? a.output.replace('{n}', pad(n, doc.numPages)) : a.output.replace(/(\.[A-Za-z0-9]+)?$/, (e) => `-${pad(n, doc.numPages)}${e || '.' + ext}`);
        else path = vfs.unique(`${vfs.stemOf(a.input)}.p${pad(n, doc.numPages)}`, ext);
        const { bytes, mime } = await canvasBytes(canvas, a.format, a.quality);
        outputs.push(await vfs.write(path, bytes, { mime, meta: { width: canvas.width, height: canvas.height, page: n, dpi: round(scale * 72, 1) } }));
        canvas.width = canvas.height = 0; page.cleanup();
        ctx.progress((k + 1) / idx.length, `rendered page ${n}`);
      }
      return { outputs, pages: doc.numPages, rendered: outputs.length, format: a.format, backend: 'js' };
    });
  },
});

// ─────────────────────────────────────────────── page-level restructuring ──
register({
  name: 'pdf.merge',
  description: 'Concatenate several PDFs (optionally only some pages of each) into one PDF, in the order given. Returns the merged file with its page count and how many pages came from each input.' + NOTE_COPY,
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths of the PDFs, in output order (a path may repeat)' },
      ranges: { type: 'array', items: { type: 'string' }, description: 'Optional page selection per input, same order as inputs, e.g. ["1-3", "all", "2,5-"]' },
      output: { type: 'string', description: 'VFS path to write (default: <first input>.merged.pdf)' },
      password: { type: 'string', description: 'Password tried on every encrypted input' },
    },
    required: ['inputs'],
  },
  examples: ['pdf.merge inputs=a.pdf,b.pdf output=both.pdf'],
  async run(a, ctx) {
    if (!a.inputs.length) throw new Error('inputs is empty — give at least one PDF path');
    if (a.ranges && a.ranges.length !== a.inputs.length) throw new Error(`ranges has ${a.ranges.length} entries but inputs has ${a.inputs.length} — give one range per input (use "all")`);
    const L = await lib(); const out = await L.PDFDocument.create(); const from = [];
    for (let i = 0; i < a.inputs.length; i++) {
      const { doc } = await openLib(a.inputs[i], a.password);
      const idx = parsePages(a.ranges?.[i], doc.getPageCount(), `ranges[${i}]`);
      for (const p of await out.copyPages(doc, idx)) out.addPage(p);
      if (i === 0) copyInfo(doc, out);
      from.push({ input: a.inputs[i], pages: idx.length });
      ctx.progress((i + 1) / a.inputs.length, a.inputs[i]);
    }
    return { output: await savePdf(out, vfs.out(a.output, a.inputs, 'merged', 'pdf')), pages: out.getPageCount(), from };
  },
});

register({
  name: 'pdf.split',
  description: 'Split one PDF into several: one file per page (default), a file every N pages, at given pages, or by explicit ranges. Returns the parts in outputs, each with its page count and source range.' + NOTE_COPY,
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      every: { type: 'integer', minimum: 1, description: 'Pages per part (default 1 = one file per page) when neither at nor ranges is given' },
      at: { type: 'string', description: 'Pages that START a new part, e.g. "4,9" on a 12-page file gives 1-3, 4-8, 9-12' },
      ranges: { type: 'array', items: { type: 'string' }, description: 'Explicit parts, one page selection each, e.g. ["1-3", "4-", "1,last"]' },
      outputPrefix: { type: 'string', description: 'Prefix for part names (default: input name without extension); parts are <prefix>.part<k>.pdf' },
      maxParts: { type: 'integer', default: 500, minimum: 1, maximum: 5000, description: 'Safety cap on the number of files written' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.split input=book.pdf every=10', 'pdf.split input=book.pdf at=4,9'],
  async run(a, ctx) {
    if ([a.every, a.at, a.ranges].filter((x) => x !== undefined).length > 1) throw new Error('give only one of: every, at, ranges');
    const { L, doc } = await openLib(a.input, a.password); const n = doc.getPageCount();
    let parts = [];
    if (a.ranges) parts = a.ranges.map((r, i) => parsePages(r, n, `ranges[${i}]`));
    else if (a.at) {
      const cuts = uniqSorted(parsePages(a.at, n, 'at')).filter((c) => c > 0); let s = 0;
      for (const c of [...cuts, n]) { parts.push(Array.from({ length: c - s }, (_, i) => s + i)); s = c; }
    } else { const e = a.every || 1; for (let s = 0; s < n; s += e) parts.push(Array.from({ length: Math.min(e, n - s) }, (_, i) => s + i)); }
    if (parts.length > a.maxParts) throw new Error(`this would write ${parts.length} files (maxParts=${a.maxParts}) — raise maxParts or split more coarsely`);
    const prefix = a.outputPrefix || vfs.stemOf(a.input); const outputs = [];
    for (let k = 0; k < parts.length; k++) {
      const part = await subset(L, doc, parts[k]);
      outputs.push(await savePdf(part, vfs.unique(`${prefix}.part${pad(k + 1, parts.length)}`, 'pdf'), { sourcePages: fmtPages(parts[k]) }));
      ctx.progress((k + 1) / parts.length, `part ${k + 1}`);
    }
    return { outputs: outputs.slice(0, 200), outputsTruncated: outputs.length > 200 || undefined, parts: outputs.length, pages: n };
  },
});

function subsetTool(name, description, pick, tag, extra = {}) {
  register({
    name, description: description + NOTE_COPY,
    schema: {
      properties: { input: { type: 'string', description: 'VFS path of the PDF' }, ...extra, output: { type: 'string', description: `VFS path to write (default: <input>.${tag}.pdf)` }, ...PW },
      required: ['input', ...Object.keys(extra)],
    },
    examples: [`${name} input=doc.pdf ${Object.keys(extra)[0]}=${name === 'pdf.reorder' ? '3,1,2' : '2-4'}`],
    async run(a) {
      const { L, doc, bytes } = await openLib(a.input, a.password); const n = doc.getPageCount();
      const idx = pick(a, n);
      const out = await subset(L, doc, idx);
      const output = await savePdf(out, vfs.out(a.output, a.input, tag, 'pdf'));
      return { output, pages: idx.length, sourcePages: n, order: idx.length <= 60 ? idx.map((i) => i + 1) : undefined, inputBytes: bytes.length };
    },
  });
}
subsetTool('pdf.extract', 'Copy the selected pages of a PDF into a new PDF, in the order written (pages may repeat). Use it to pull out a chapter or a single page.',
  (a, n) => parsePages(a.pages, n), 'extract', { pages: PAGES(' Order and repeats are honoured: "5,1-2,5".') });
subsetTool('pdf.remove', 'Delete the selected pages from a PDF and write the rest as a new PDF (the removed pages\' content is really gone from the file, so it also gets smaller).',
  (a, n) => { const drop = new Set(parsePages(a.pages, n)); const keep = Array.from({ length: n }, (_, i) => i).filter((i) => !drop.has(i)); if (!keep.length) throw new Error('that would remove every page — a PDF needs at least one'); return keep; },
  'removed', { pages: PAGES(' These pages are deleted.') });
subsetTool('pdf.reorder', 'Rearrange the pages of a PDF. Give the new order as a page selection; pages you leave out are appended in their original order unless dropUnlisted=true. Examples: "3,1,2" · "last,1-" (move last page to front) · "5-1" (reverse a 5-page file) · "odd,even".',
  (a, n) => { const idx = parsePages(a.order, n, 'order'); if (a.dropUnlisted) return idx; const seen = new Set(idx); return [...idx, ...Array.from({ length: n }, (_, i) => i).filter((i) => !seen.has(i))]; },
  'reordered', { order: PAGES(' This is the new page order.') });
M.tools.get('pdf.reorder').schema.properties.dropUnlisted = { type: 'boolean', default: false, description: 'Drop pages not mentioned in order instead of appending them' };

register({
  name: 'pdf.rotate',
  description: 'Rotate pages of a PDF by a multiple of 90° (sets the page /Rotate flag — lossless, nothing is re-rendered; bookmarks and forms are kept). By default the angle is added to each page\'s current rotation.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      angle: { type: 'integer', enum: [90, 180, 270, -90, -180, -270, 0], default: 90, description: 'Degrees clockwise' },
      pages: PAGES(' Default: all pages.'),
      absolute: { type: 'boolean', default: false, description: 'Set the rotation to angle instead of adding it to the existing rotation' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.rotated.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.rotate input=scan.pdf angle=90 pages=2-3'],
  async run(a) {
    const { L, doc } = await openLib(a.input, a.password); const idx = uniqSorted(parsePages(a.pages, doc.getPageCount()));
    const rotations = [];
    for (const i of idx) { const p = doc.getPage(i); const r = ((((a.absolute ? 0 : p.getRotation().angle) + a.angle) % 360) + 360) % 360; p.setRotation(L.degrees(r)); rotations.push(r); }
    return { output: await savePdf(doc, vfs.out(a.output, a.input, 'rotated', 'pdf')), pages: doc.getPageCount(), rotated: idx.length, rotatedPages: fmtPages(idx), rotation: [...new Set(rotations)].length === 1 ? rotations[0] : 'mixed' };
  },
});

register({
  name: 'pdf.crop',
  description: 'Set the visible area (CropBox, and MediaBox with hard=true) of PDF pages: either trim margins, give an explicit box, or auto-trim to the inked content. Units are PDF points (72 pt = 1 inch, origin bottom-left of the unrotated page). Cropping hides content outside the box but does not delete it from the file. Returns the new page sizes.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      pages: PAGES(' Default: all pages.'),
      margins: { type: 'array', items: { type: 'number' }, description: 'Points to trim from the current visible box as [top, right, bottom, left] of the page as stored (one number = all sides, two = [vertical, horizontal]); negative values enlarge' },
      box: { type: 'array', items: { type: 'number' }, description: 'Explicit box [x, y, width, height] in points, origin bottom-left of the unrotated page' },
      auto: { type: 'boolean', default: false, description: 'Trim each page to its content bounding box (found by rendering the page and looking for non-white pixels)' },
      padding: { type: 'number', default: 6, minimum: 0, maximum: 500, description: 'Points of white space kept around the content when auto=true' },
      hard: { type: 'boolean', default: false, description: 'Also set the MediaBox, so tools that ignore CropBox see the same size' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.cropped.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.crop input=paper.pdf auto=true', 'pdf.crop input=doc.pdf margins=36', 'pdf.crop input=doc.pdf pages=1 box=50,400,300,200'],
  async run(a, ctx) {
    if ([a.margins, a.box, a.auto || undefined].filter((x) => x !== undefined).length !== 1) throw new Error('give exactly one of: margins, box, auto=true');
    const { doc } = await openLib(a.input, a.password); const n = doc.getPageCount(); const idx = uniqSorted(parsePages(a.pages, n));
    const boxes = new Map();
    if (a.auto) {
      await withJs(a.input, a.password, async ({ pdfjs, doc: jd }) => {
        for (let k = 0; k < idx.length; k++) {
          const page = await jd.getPage(idx[k] + 1); const scale = 1.5; const vp = page.getViewport({ scale });
          const canvas = await renderPage(page, { scale }, pdfjs); const w = canvas.width, h = canvas.height;
          const d = canvas.getContext('2d').getImageData(0, 0, w, h).data; let x0 = w, y0 = h, x1 = -1, y1 = -1;
          for (let y = 0; y < h; y++) for (let x = 0, o = y * w * 4; x < w; x++, o += 4) if (d[o] < 245 || d[o + 1] < 245 || d[o + 2] < 245) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          if (x1 >= 0) {
            const pd = a.padding * scale;
            const [ax, ay] = vp.convertToPdfPoint(Math.max(0, x0 - pd), Math.max(0, y0 - pd)); const [bx, by] = vp.convertToPdfPoint(Math.min(w, x1 + 1 + pd), Math.min(h, y1 + 1 + pd));
            boxes.set(idx[k], [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)]);
          }
          canvas.width = canvas.height = 0; page.cleanup(); ctx.progress((k + 1) / idx.length, `measured page ${idx[k] + 1}`);
        }
      });
    }
    let m;
    if (a.margins) { const v = a.margins; if (![1, 2, 4].includes(v.length) || v.some((x) => typeof x !== 'number' || Number.isNaN(x))) throw new Error('margins must be 1, 2 or 4 numbers: [all] | [vertical, horizontal] | [top, right, bottom, left]'); m = v.length === 1 ? [v[0], v[0], v[0], v[0]] : v.length === 2 ? [v[0], v[1], v[0], v[1]] : v; }
    if (a.box && (a.box.length !== 4 || a.box.some((x) => typeof x !== 'number' || Number.isNaN(x)) || a.box[2] <= 0 || a.box[3] <= 0)) throw new Error('box must be [x, y, width, height] in points with positive width and height');
    const sizes = []; const blank = [];
    for (const i of idx) {
      const p = doc.getPage(i); const c = p.getCropBox(); let b;
      if (a.box) b = a.box;
      else if (m) b = [c.x + m[3], c.y + m[2], c.width - m[1] - m[3], c.height - m[0] - m[2]];
      else { b = boxes.get(i); if (!b) { blank.push(i); continue; } }
      if (b[2] < 1 || b[3] < 1) throw new Error(`page ${i + 1}: the crop leaves no visible area (${round(b[2])} x ${round(b[3])} pt) — the page is ${round(c.width)} x ${round(c.height)} pt`);
      if (a.hard) p.setMediaBox(b[0], b[1], b[2], b[3]);
      p.setCropBox(b[0], b[1], b[2], b[3]);
      // keep the other boxes inside the new visible area
      const N = (await lib()).PDFName; for (const k of ['TrimBox', 'ArtBox', 'BleedBox']) p.node.delete(N.of(k));
      sizes.push({ page: i + 1, box: b.map((x) => round(x, 1)) });
    }
    return { output: await savePdf(doc, vfs.out(a.output, a.input, 'cropped', 'pdf')), pages: n, cropped: sizes.length, boxes: sizes.slice(0, 40), boxesTruncated: sizes.length > 40 || undefined, blankPagesSkipped: blank.length ? fmtPages(blank) : undefined, note: 'Content outside the box is hidden, not deleted.' };
  },
});

register({
  name: 'pdf.nup',
  description: 'Impose several pages per sheet (2-up, 4-up, …) for printing or compact review: each source page is scaled as a vector (text stays text) into a grid cell on a new sheet. Returns the new PDF with its sheet count. Links, form fields and bookmarks are not kept.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      perSheet: { type: 'integer', enum: [2, 4, 6, 8, 9, 16], default: 2, description: 'Pages per sheet' },
      pages: PAGES(' Default: all pages; order is honoured.'),
      pageSize: { type: 'string', default: 'a4', description: 'Sheet size: a3, a4, a5, letter, legal, tabloid or "WIDTHxHEIGHT" in points' },
      orientation: { type: 'string', enum: ['auto', 'portrait', 'landscape'], default: 'auto', description: 'Sheet orientation; auto picks whichever shows the pages larger' },
      margin: { type: 'number', default: 18, minimum: 0, maximum: 300, description: 'Sheet margin in points' },
      gap: { type: 'number', default: 8, minimum: 0, maximum: 300, description: 'Space between cells in points' },
      border: { type: 'boolean', default: false, description: 'Draw a thin frame around each page' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.<n>up.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.nup input=slides.pdf perSheet=4'],
  async run(a, ctx) {
    const { L, doc: src } = await openLib(a.input, a.password); const idx = parsePages(a.pages, src.getPageCount());
    const grid = { 2: [1, 2], 4: [2, 2], 6: [2, 3], 8: [2, 4], 9: [3, 3], 16: [4, 4] }[a.perSheet];
    const frames = idx.map((i) => frameOf(src.getPage(i)));
    const avgAspect = frames.reduce((s, f) => s + f.W / f.H, 0) / frames.length;
    const [pw, ph] = pageSizeOf(a.pageSize, 'portrait');
    const layouts = [];
    for (const [SW, SH] of a.orientation === 'portrait' ? [[pw, ph]] : a.orientation === 'landscape' ? [[ph, pw]] : [[pw, ph], [ph, pw]]) for (const [cols, rows] of [[grid[0], grid[1]], [grid[1], grid[0]]]) {
      const cw = (SW - 2 * a.margin - (cols - 1) * a.gap) / cols, ch = (SH - 2 * a.margin - (rows - 1) * a.gap) / rows;
      if (cw > 4 && ch > 4) layouts.push({ SW, SH, cols, rows, cw, ch, fit: Math.min(cw / avgAspect, ch) });
    }
    if (!layouts.length) throw new Error('margin/gap leave no room for the pages — reduce them');
    const lay = layouts.sort((x, y) => y.fit - x.fit)[0];
    const out = await L.PDFDocument.create(); copyInfo(src, out);
    const ok = idx.map((i) => { try { const c = src.getPage(i).node.Contents(); return !!c; } catch { return false; } });
    const srcPages = idx.filter((_, k) => ok[k]).map((i) => src.getPage(i));
    const embedded = srcPages.length ? await out.embedPages(srcPages, srcPages.map((p) => { const c = p.getCropBox(); return { left: c.x, bottom: c.y, right: c.x + c.width, top: c.y + c.height }; })) : [];
    let e = 0; let sheet = null;
    for (let k = 0; k < idx.length; k++) {
      const slot = k % a.perSheet; if (slot === 0) sheet = out.addPage([lay.SW, lay.SH]);
      const col = slot % lay.cols, row = Math.floor(slot / lay.cols); const f = frames[k];
      const s = Math.min(lay.cw / f.W, lay.ch / f.H); const dw = f.W * s, dh = f.H * s;
      const cx = a.margin + col * (lay.cw + a.gap) + (lay.cw - dw) / 2, cy = lay.SH - a.margin - row * (lay.ch + a.gap) - lay.ch + (lay.ch - dh) / 2;
      if (ok[k]) {
        const ep = embedded[e++]; const w = ep.width * s, h = ep.height * s; // unrotated extents
        const pos = f.rot === 90 ? [cx, cy + w] : f.rot === 180 ? [cx + w, cy + h] : f.rot === 270 ? [cx + h, cy] : [cx, cy];
        sheet.drawPage(ep, { x: pos[0], y: pos[1], xScale: s, yScale: s, rotate: L.degrees(-f.rot) });
      }
      if (a.border) sheet.drawRectangle({ x: cx, y: cy, width: dw, height: dh, borderColor: L.rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
      ctx.progress((k + 1) / idx.length);
    }
    return { output: await savePdf(out, vfs.out(a.output, a.input, `${a.perSheet}up`, 'pdf')), sheets: out.getPageCount(), sourcePages: idx.length, perSheet: a.perSheet, grid: `${lay.cols}x${lay.rows}`, sheetSizePt: [round(lay.SW, 1), round(lay.SH, 1)], emptySourcePages: ok.filter((x) => !x).length || undefined };
  },
});

// ─────────────────────────────────────────────────────────── compress ──
function childrenOf(L, obj) {
  if (obj instanceof L.PDFDict) return obj.values();
  if (obj instanceof L.PDFArray) return obj.asArray();
  if (obj instanceof L.PDFStream) return obj.dict.values();
  return [];
}
/** delete every indirect object that cannot be reached from the trailer; returns how many were dropped */
function collectGarbage(L, doc) {
  const ctx = doc.context; const seen = new Set(); const stack = [];
  const visit = (o) => { if (o instanceof L.PDFRef) { if (!seen.has(o.tag)) { seen.add(o.tag); const t = ctx.lookup(o); if (t) stack.push(t); } } else if (o instanceof L.PDFDict || o instanceof L.PDFArray || o instanceof L.PDFStream) stack.push(o); };
  for (const k of ['Root', 'Info', 'Encrypt', 'ID']) visit(ctx.trailerInfo[k]);
  while (stack.length) for (const c of childrenOf(L, stack.pop())) visit(c);
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) { ctx.delete(ref); dropped++; }
  return dropped;
}
function fnv(bytes) { let h1 = 0x811c9dc5, h2 = 0x01000193; for (let i = 0; i < bytes.length; i++) { h1 = Math.imul(h1 ^ bytes[i], 0x01000193); h2 = Math.imul(h2 + bytes[i], 0x85ebca6b) ^ (h2 >>> 13); } return `${h1 >>> 0}.${h2 >>> 0}`; }
/** point every reference to a byte-identical stream at one copy; returns the number of duplicates folded */
function dedupeStreams(L, doc) {
  const ctx = doc.context; const first = new Map(); const remap = new Map();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof L.PDFRawStream)) continue;
    const key = `${obj.contents.length}|${fnv(obj.contents)}|${obj.dict.toString()}`;
    const keep = first.get(key);
    if (!keep) { first.set(key, { ref, obj }); continue; }
    const x = keep.obj.contents, y = obj.contents; let same = x.length === y.length; for (let i = 0; same && i < x.length; i++) if (x[i] !== y[i]) same = false;
    if (same) remap.set(ref.tag, keep.ref);
  }
  if (!remap.size) return 0;
  const fix = (o) => {
    if (o instanceof L.PDFStream) o = o.dict;
    if (o instanceof L.PDFDict) { for (const [k, v] of o.entries()) { if (v instanceof L.PDFRef) { const r = remap.get(v.tag); if (r) o.set(k, r); } else fix(v); } } else if (o instanceof L.PDFArray) { for (let i = 0; i < o.size(); i++) { const v = o.get(i); if (v instanceof L.PDFRef) { const r = remap.get(v.tag); if (r) o.set(i, r); } else fix(v); } }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
  for (const [ref] of ctx.enumerateIndirectObjects()) if (remap.has(ref.tag)) ctx.delete(ref);
  return remap.size;
}
async function structuralPass(L, doc, { stripMetadata }) {
  const ctx = doc.context; const N = (s) => L.PDFName.of(s); const d = { deflatedStreams: 0, duplicateStreams: 0, unreachableObjects: 0 };
  if (stripMetadata) {
    doc.catalog.delete(N('Metadata')); doc.catalog.delete(N('PieceInfo'));
    if (ctx.trailerInfo.Info) { if (ctx.trailerInfo.Info instanceof L.PDFRef) ctx.delete(ctx.trailerInfo.Info); ctx.trailerInfo.Info = undefined; }
    for (const [, obj] of ctx.enumerateIndirectObjects()) { const dict = obj instanceof L.PDFStream ? obj.dict : obj; if (dict instanceof L.PDFDict) { if (dict.get(N('Type')) === N('Page')) { dict.delete(N('Thumb')); dict.delete(N('PieceInfo')); } else if (dict.get(N('Subtype')) === N('Image') || dict.get(N('Subtype')) === N('Form')) dict.delete(N('Metadata')); } }
    d.metadataStripped = true;
  }
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof L.PDFRawStream) || obj.dict.has(N('Filter')) || obj.contents.length < 96) continue;
    if (obj.dict.get(N('Type')) === N('Metadata')) continue; // XMP is meant to stay readable as plain text
    const z = await deflate(obj.contents);
    if (z.length < obj.contents.length * 0.95) { const dict = obj.dict.clone(ctx); dict.set(N('Filter'), N('FlateDecode')); dict.delete(N('DecodeParms')); ctx.assign(ref, L.PDFRawStream.of(dict, z)); d.deflatedStreams++; }
  }
  d.duplicateStreams = dedupeStreams(L, doc);
  d.unreachableObjects = collectGarbage(L, doc);
  return d;
}

function unpredictPng(data, colors, columns) {
  const stride = colors * columns, rows = Math.floor(data.length / (stride + 1)); const out = new Uint8Array(rows * stride);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (stride + 1)], s = r * (stride + 1) + 1, o = r * stride;
    for (let i = 0; i < stride; i++) {
      const x = data[s + i], A = i >= colors ? out[o + i - colors] : 0, B = r ? out[o - stride + i] : 0, C = r && i >= colors ? out[o - stride + i - colors] : 0;
      let v;
      if (ft === 0) v = x; else if (ft === 1) v = x + A; else if (ft === 2) v = x + B; else if (ft === 3) v = x + ((A + B) >> 1);
      else { const p = A + B - C, pa = Math.abs(p - A), pb = Math.abs(p - B), pc = Math.abs(p - C); v = x + (pa <= pb && pa <= pc ? A : pb <= pc ? B : C); }
      out[o + i] = v & 255;
    }
  }
  return out;
}

/** largest page (long side, inches) on which each image XObject is used, following form XObjects */
function imageUsage(L, doc) {
  const N = (s) => L.PDFName.of(s); const ctx = doc.context; const usage = new Map();
  const walk = (res, inches, seen) => {
    if (!(res instanceof L.PDFDict)) return;
    const xo = res.lookup(N('XObject')); if (!(xo instanceof L.PDFDict)) return;
    for (const [, v] of xo.entries()) {
      if (!(v instanceof L.PDFRef) || seen.has(v.tag)) continue; seen.add(v.tag);
      const s = ctx.lookup(v); if (!(s instanceof L.PDFStream)) continue;
      const sub = s.dict.get(N('Subtype'));
      if (sub === N('Image')) usage.set(v.tag, Math.max(usage.get(v.tag) || 0, inches));
      else if (sub === N('Form')) { try { walk(s.dict.lookup(N('Resources')), inches, seen); } catch { /* ignore */ } }
    }
  };
  for (const p of doc.getPages()) { try { const c = p.getCropBox(); walk(p.node.Resources(), Math.max(c.width, c.height) / 72, new Set()); } catch { /* ignore */ } }
  return usage;
}

async function recompressImages(L, doc, { dpi, quality, maxSide, grayscale }, ctx2) {
  const N = (s) => L.PDFName.of(s); const ctx = doc.context; const usage = imageUsage(L, doc);
  const st = { images: 0, recompressed: 0, imageBytesBefore: 0, imageBytesAfter: 0, skipped: {} };
  const skip = (why, len) => { st.skipped[why] = (st.skipped[why] || 0) + 1; st.imageBytesAfter += len; };
  const list = ctx.enumerateIndirectObjects().filter(([, o]) => o instanceof L.PDFRawStream && o.dict.get(N('Subtype')) === N('Image'));
  let done = 0;
  for (const [ref, obj] of list) {
    ctx2?.progress?.(++done / list.length, 'images');
    const d = obj.dict; const len = obj.contents.length; st.images++; st.imageBytesBefore += len;
    const num = (k) => { const v = d.lookup(N(k)); return v instanceof L.PDFNumber ? v.asNumber() : undefined; };
    const w = num('Width'), h = num('Height'), bpc = num('BitsPerComponent');
    if (!w || !h) { skip('no size', len); continue; }
    if (d.lookup(N('ImageMask')) === L.PDFBool.True) { skip('stencil mask', len); continue; }
    if (len < 3000 || w * h < 4096) { skip('tiny', len); continue; }
    if (d.has(N('Decode'))) { skip('custom Decode array', len); continue; }
    if (d.lookup(N('Mask')) instanceof L.PDFArray) { skip('colour-key mask', len); continue; }
    const sm = d.lookup(N('SMask')); if (sm instanceof L.PDFStream && sm.dict.has(N('Matte'))) { skip('pre-multiplied alpha', len); continue; }
    let filter = d.lookup(N('Filter')); if (filter instanceof L.PDFArray) { if (filter.size() > 1) { skip('filter chain', len); continue; } filter = filter.size() ? filter.lookup(0) : undefined; }
    const fname = filter instanceof L.PDFName ? filter.asString().slice(1) : filter ? '?' : '';
    let cs = d.lookup(N('ColorSpace')); let comps = 0;
    if (cs instanceof L.PDFName) comps = { '/DeviceRGB': 3, '/DeviceGray': 1, '/DeviceCMYK': 4, '/RGB': 3, '/G': 1 }[cs.asString()] || 0;
    else if (cs instanceof L.PDFArray && cs.size()) { const kind = cs.lookup(0); const kn = kind instanceof L.PDFName ? kind.asString() : ''; if (kn === '/ICCBased') { const prof = cs.lookup(1); const nn = prof instanceof L.PDFStream ? prof.dict.lookup(N('N')) : null; comps = nn instanceof L.PDFNumber ? nn.asNumber() : 0; } else if (kn === '/CalRGB') comps = 3; else if (kn === '/CalGray') comps = 1; else { skip(`${kn.slice(1) || 'unknown'} colour space`, len); continue; } }
    if (comps !== 1 && comps !== 3) { skip(comps === 4 ? 'CMYK' : 'unsupported colour space', len); continue; }
    const pageIn = usage.get(ref.tag);
    let scale = 1; const long = Math.max(w, h);
    if (dpi && pageIn) scale = Math.min(scale, (dpi * pageIn) / long);
    if (maxSide) scale = Math.min(scale, maxSide / long);
    const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    let source; // something drawImage accepts
    try {
      if (fname === 'DCTDecode') source = await createImageBitmap(new Blob([obj.contents], { type: 'image/jpeg' }));
      else if (fname === 'FlateDecode' || fname === '') {
        if (bpc !== 8) { skip(`${bpc}-bit samples`, len); continue; }
        let raw = fname ? await inflate(obj.contents) : obj.contents;
        let parms = d.lookup(N('DecodeParms')); if (parms instanceof L.PDFArray) parms = parms.size() ? parms.lookup(0) : undefined;
        const pred = parms instanceof L.PDFDict && parms.lookup(N('Predictor')) instanceof L.PDFNumber ? parms.lookup(N('Predictor')).asNumber() : 1;
        if (pred >= 10) raw = unpredictPng(raw, comps, w); else if (pred !== 1) { skip('TIFF predictor', len); continue; }
        if (raw.length < w * h * comps) { skip('short pixel data', len); continue; }
        const px = new Uint8ClampedArray(w * h * 4);
        if (comps === 3) for (let i = 0, j = 0; i < w * h; i++, j += 4) { px[j] = raw[i * 3]; px[j + 1] = raw[i * 3 + 1]; px[j + 2] = raw[i * 3 + 2]; px[j + 3] = 255; }
        else for (let i = 0, j = 0; i < w * h; i++, j += 4) { px[j] = px[j + 1] = px[j + 2] = raw[i]; px[j + 3] = 255; }
        source = canvasOf(w, h); source.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
      } else { skip(`${fname} (not re-encodable here)`, len); continue; }
    } catch { skip('undecodable', len); continue; }
    const c = canvasOf(nw, nh); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, nw, nh); g.imageSmoothingQuality = 'high';
    if (grayscale) g.filter = 'grayscale(1)';
    g.drawImage(source, 0, 0, nw, nh); source.close?.();
    const { bytes: jb } = await canvasBytes(c, 'jpeg', quality);
    if (jb.length >= len * 0.92) { skip('already compact', len); continue; }
    const nd = d.clone(ctx); for (const k of ['DecodeParms', 'Filter', 'ColorSpace', 'Length', 'Intent']) nd.delete(N(k));
    nd.set(N('Filter'), N('DCTDecode')); nd.set(N('ColorSpace'), N('DeviceRGB')); nd.set(N('BitsPerComponent'), L.PDFNumber.of(8)); nd.set(N('Width'), L.PDFNumber.of(nw)); nd.set(N('Height'), L.PDFNumber.of(nh));
    ctx.assign(ref, L.PDFRawStream.of(nd, jb)); st.recompressed++; st.imageBytesAfter += jb.length;
  }
  return st;
}

register({
  name: 'pdf.compress',
  description: 'Make a PDF smaller and report honest before/after bytes. Three modes: "structural" (lossless: pack objects into compressed object streams, Flate-compress raw streams, fold duplicate streams, drop unreachable objects; optional metadata strip — typically a few % on modern files, much more on unoptimised ones); "images" (lossy for pictures only: downsample and re-encode embedded 8-bit RGB/gray images as JPEG, text and vectors untouched — the mode for image-heavy files; CMYK, JPEG2000, JBIG2, CCITT, indexed and masked-stencil images are left alone); "raster" (lossy fallback: every page becomes one JPEG at the chosen DPI — DESTROYS the text layer, links, forms and vector sharpness; use only for scans or when nothing else helps). If the result is not smaller, no file is written unless force=true. Check pdf.info images.shareOfFile to choose a mode.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      mode: { type: 'string', enum: ['structural', 'images', 'raster'], default: 'structural', description: 'structural = lossless; images = recompress embedded images (plus the structural pass); raster = replace pages by JPEG renderings (text is lost)' },
      dpi: { type: 'number', default: 150, minimum: 20, maximum: 600, description: 'images: target resolution, estimated as if each image filled the largest page it appears on (smaller placements keep more than this). raster: rendering resolution' },
      quality: { type: 'number', default: 0.7, minimum: 0.05, maximum: 1, description: 'JPEG quality for images/raster modes' },
      maxSide: { type: 'integer', minimum: 16, maximum: 16384, description: 'images: additionally cap the longer side of every image to this many pixels' },
      grayscale: { type: 'boolean', default: false, description: 'images/raster: convert pictures to gray' },
      stripMetadata: { type: 'boolean', default: false, description: 'Also remove the Info dictionary, XMP metadata, page thumbnails and application private data' },
      force: { type: 'boolean', default: false, description: 'Write the output even when it is not smaller than the input' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.min.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.compress input=report.pdf', 'pdf.compress input=photos.pdf mode=images dpi=120 quality=0.6', 'pdf.compress input=scan.pdf mode=raster dpi=100 quality=0.5'],
  async run(a, ctx) {
    const inputBytes = vfs.read(a.input).length; let bytes, details = {}, pages;
    if (a.mode === 'raster') {
      const L = await lib(); const out = await L.PDFDocument.create();
      await withJs(a.input, a.password, async ({ pdfjs, doc }) => {
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n); const vp = page.getViewport({ scale: 1 });
          const canvas = await renderPage(page, { scale: a.dpi / 72 }, pdfjs);
          let c = canvas; if (a.grayscale) { c = canvasOf(canvas.width, canvas.height); const g = c.getContext('2d'); g.filter = 'grayscale(1)'; g.drawImage(canvas, 0, 0); }
          const { bytes: jb } = await canvasBytes(c, 'jpeg', a.quality);
          const img = await out.embedJpg(jb); out.addPage([vp.width, vp.height]).drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
          canvas.width = canvas.height = 0; page.cleanup(); ctx.progress(n / doc.numPages, `rasterised page ${n}`);
        }
      });
      if (!a.stripMetadata) { try { copyInfo((await openLib(a.input, a.password)).doc, out); } catch { /* optional */ } }
      pages = out.getPageCount(); bytes = await out.save({ useObjectStreams: true });
      details = { dpi: a.dpi, quality: a.quality, textLayer: 'destroyed', warning: 'Pages are now pictures: no selectable text, links, form fields or bookmarks.' };
    } else {
      const { L, doc } = await openLib(a.input, a.password);
      if (a.mode === 'images') details.images = await recompressImages(L, doc, a, ctx);
      Object.assign(details, await structuralPass(L, doc, a));
      pages = doc.getPageCount();
      try { bytes = await doc.save({ useObjectStreams: true }); } catch (e) { throw new Error(`could not serialise the PDF: ${e.message}`); }
    }
    const outputBytes = bytes.length; const smaller = outputBytes < inputBytes;
    const res = { mode: a.mode, inputBytes, outputBytes, savedBytes: inputBytes - outputBytes, ratio: round(outputBytes / inputBytes, 4), percentSaved: round((1 - outputBytes / inputBytes) * 100, 1), smaller, pages, ...details };
    if (smaller || a.force) res.output = await vfs.write(vfs.out(a.output, a.input, 'min', 'pdf'), bytes, { mime: PDF_MIME, meta: { pages } });
    if (!smaller) res.note = a.force ? 'The result is NOT smaller than the input; written anyway because force=true.' : `The result would not be smaller (${outputBytes} vs ${inputBytes} bytes), so nothing was written and the original stands. ${a.mode === 'structural' ? 'The file is already well packed; try mode=images if it contains pictures.' : a.mode === 'images' ? 'Try a lower dpi/quality, or mode=raster for scans.' : 'Try a lower dpi/quality.'}`;
    return res;
  },
});

// ───────────────────────────────────────────────────── images in / out ──
register({
  name: 'pdf.fromImages',
  description: 'Build a PDF from images, one per page (PNG, JPEG, WebP, GIF, BMP, AVIF, SVG…). JPEGs are embedded byte-for-byte (no quality loss) unless quality/maxSide ask for a re-encode; EXIF rotation is honoured. Page size is either each image\'s own size at a DPI, or a fixed paper size with the image fitted inside the margins. Returns the PDF and its page count.',
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths of the images, in page order' },
      pageSize: { type: 'string', default: 'image', description: '"image" = page matches each image (pixels ÷ dpi), or a4, a3, a5, letter, legal, tabloid, or "WIDTHxHEIGHT" in points' },
      dpi: { type: 'number', default: 96, minimum: 10, maximum: 2400, description: 'For pageSize=image: pixels per inch (a 2480 px wide scan at 300 dpi becomes A4 width)' },
      orientation: { type: 'string', enum: ['auto', 'portrait', 'landscape'], default: 'auto', description: 'For fixed paper sizes; auto follows each image\'s aspect' },
      fit: { type: 'string', enum: ['contain', 'cover', 'stretch', 'none'], default: 'contain', description: 'How the image fills the area inside the margins: contain (whole image, centred), cover (fill and crop), stretch, none (pixels ÷ dpi, centred)' },
      margin: { type: 'number', default: 0, minimum: 0, maximum: 1000, description: 'Margin in points on every side' },
      quality: { type: 'number', minimum: 0.05, maximum: 1, description: 'Re-encode every image as JPEG at this quality (smaller file; drops transparency)' },
      maxSide: { type: 'integer', minimum: 16, maximum: 16384, description: 'Downscale images whose longer side exceeds this many pixels' },
      title: { type: 'string', description: 'Document title to store in the metadata' },
      output: { type: 'string', description: 'VFS path to write (default: <first input>.pdf)' },
    },
    required: ['inputs'],
  },
  examples: ['pdf.fromImages inputs=scan1.jpg,scan2.jpg pageSize=a4 margin=18'],
  async run(a, ctx) {
    if (!a.inputs.length) throw new Error('inputs is empty — give at least one image path');
    const L = await lib(); const doc = await L.PDFDocument.create(); const how = {};
    if (a.title) doc.setTitle(a.title);
    for (let i = 0; i < a.inputs.length; i++) {
      let emb;
      try { emb = await embedImage(doc, a.inputs[i], a); } catch (e) { throw new Error(`"${a.inputs[i]}" could not be embedded as an image: ${e.message}`); }
      const { image } = emb; how[emb.how] = (how[emb.how] || 0) + 1;
      const iw = (image.width / a.dpi) * 72, ih = (image.height / a.dpi) * 72; let pw, ph;
      if (String(a.pageSize).toLowerCase() === 'image') { pw = iw + 2 * a.margin; ph = ih + 2 * a.margin; } else [pw, ph] = pageSizeOf(a.pageSize, a.orientation === 'auto' ? (image.width > image.height ? 'landscape' : 'portrait') : a.orientation);
      const page = doc.addPage([pw, ph]); const aw = pw - 2 * a.margin, ah = ph - 2 * a.margin;
      if (aw <= 0 || ah <= 0) throw new Error(`margin=${a.margin} leaves no room on a ${round(pw)} x ${round(ph)} pt page`);
      let w = iw, h = ih;
      if (a.fit === 'stretch') { w = aw; h = ah; } else if (a.fit !== 'none') { const s = a.fit === 'cover' ? Math.max(aw / iw, ah / ih) : Math.min(aw / iw, ah / ih); w = iw * s; h = ih * s; }
      if (a.fit === 'cover' || a.fit === 'none') { page.pushOperators(L.pushGraphicsState(), L.rectangle(a.margin, a.margin, aw, ah), L.clip(), L.endPath()); }
      page.drawImage(image, { x: a.margin + (aw - w) / 2, y: a.margin + (ah - h) / 2, width: w, height: h });
      if (a.fit === 'cover' || a.fit === 'none') page.pushOperators(L.popGraphicsState());
      ctx.progress((i + 1) / a.inputs.length, a.inputs[i]);
    }
    return { output: await savePdf(doc, vfs.out(a.output, a.inputs, '', 'pdf')), pages: doc.getPageCount(), embedded: how };
  },
});

register({
  name: 'pdf.images',
  description: 'Extract the raster images embedded in a PDF (photos, scans, figures) as PNG/JPEG/WebP files, decoded by pdf.js so JPEG2000, JBIG2, CMYK and indexed images work too. Each output carries the page it was found on and its pixel size. Images repeated on several pages are written once; stencil masks and vector drawings are not images and are skipped. For a picture of a whole page use pdf.render.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      pages: PAGES(' Default: all pages.'),
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], default: 'png', description: 'Output format (png is lossless)' },
      quality: { type: 'number', default: 0.9, minimum: 0.05, maximum: 1, description: 'JPEG/WebP quality' },
      minSide: { type: 'integer', default: 32, minimum: 1, description: 'Skip images whose shorter side is below this many pixels (icons, rules, spacers)' },
      maxImages: { type: 'integer', default: 100, minimum: 1, maximum: 2000, description: 'Stop after this many images' },
      outputPrefix: { type: 'string', description: 'Prefix for file names (default: input name); files are <prefix>.p<page>.img<k>.<ext>' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.images input=brochure.pdf pages=1-4'],
  async run(a, ctx) {
    const ext = a.format === 'jpeg' ? 'jpg' : a.format; const prefix = a.outputPrefix || vfs.stemOf(a.input);
    return withJs(a.input, a.password, async ({ pdfjs, doc }) => {
      const idx = uniqSorted(parsePages(a.pages, doc.numPages)); const OPS = pdfjs.OPS; const outputs = []; const seen = new Set(); let found = 0, small = 0, failed = 0, truncated = false;
      const getObj = (page, id) => new Promise((res) => { const store = id.startsWith('g_') ? page.commonObjs : page.objs; let done = false; const t = setTimeout(() => { if (!done) { done = true; res(null); } }, 15000); try { store.get(id, (o) => { if (!done) { done = true; clearTimeout(t); res(o); } }); } catch { clearTimeout(t); res(null); } });
      outer: for (let k = 0; k < idx.length; k++) {
        const n = idx[k] + 1; const page = await doc.getPage(n); const ops = await page.getOperatorList(); let onPage = 0;
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i]; let img = null, id = null;
          if (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat) { id = ops.argsArray[i][0]; if (seen.has(id)) continue; seen.add(id); img = await getObj(page, id); } else if (fn === OPS.paintInlineImageXObject) img = ops.argsArray[i][0];
          else continue;
          found++;
          if (!img || !img.width || !img.height) { failed++; continue; }
          if (Math.min(img.width, img.height) < a.minSide) { small++; continue; }
          if (outputs.length >= a.maxImages) { truncated = true; break outer; }
          const c = canvasOf(img.width, img.height); const g = c.getContext('2d');
          try {
            if (img.bitmap) g.drawImage(img.bitmap, 0, 0);
            else if (img.data) {
              const w = img.width, h = img.height, src = img.data, px = new Uint8ClampedArray(w * h * 4);
              if (img.kind === 3 || src.length === w * h * 4) px.set(src.subarray(0, w * h * 4));
              else if (img.kind === 2 || src.length === w * h * 3) for (let p = 0, q = 0; p < w * h; p++, q += 4) { px[q] = src[p * 3]; px[q + 1] = src[p * 3 + 1]; px[q + 2] = src[p * 3 + 2]; px[q + 3] = 255; }
              else { const rb = (w + 7) >> 3; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = (src[y * rb + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0; const q = (y * w + x) * 4; px[q] = px[q + 1] = px[q + 2] = v; px[q + 3] = 255; } }
              g.putImageData(new ImageData(px, w, h), 0, 0);
            } else { failed++; continue; }
          } catch { failed++; continue; }
          let cc = c; if (a.format === 'jpeg') { cc = canvasOf(c.width, c.height); const g2 = cc.getContext('2d'); g2.fillStyle = '#fff'; g2.fillRect(0, 0, c.width, c.height); g2.drawImage(c, 0, 0); }
          const { bytes, mime } = await canvasBytes(cc, a.format, a.quality);
          outputs.push(await vfs.write(vfs.unique(`${prefix}.p${pad(n, doc.numPages)}.img${++onPage}`, ext), bytes, { mime, meta: { width: img.width, height: img.height, page: n } }));
        }
        page.cleanup(); ctx.progress((k + 1) / idx.length, `page ${n}`);
      }
      return { outputs, images: outputs.length, found, skippedSmall: small, failed: failed || undefined, truncated: truncated || undefined, pagesScanned: idx.length, note: outputs.length ? undefined : 'No embedded raster images on these pages (content may be vector, or the pages are text only).' };
    });
  },
});

// ─────────────────────────────────────────────── text / markdown → PDF ──
function mdInline(text, style = {}) {
  const spans = []; const re = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^\s*][\s\S]*?)\*|(?<![A-Za-z0-9])_([^\s_][\s\S]*?)_(?![A-Za-z0-9])|(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<((?:https?:\/\/|mailto:)[^>\s]+)>/g;
  let last = 0, m; const push = (t, s) => { if (t) spans.push({ text: t.replace(/\ue000(.)/g, '$1'), ...s }); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index), style); last = re.lastIndex;
    if (m[1]) push(m[2], { ...style, code: true });
    else if (m[3] !== undefined || m[4] !== undefined) spans.push(...mdInline(m[3] ?? m[4], { ...style, bold: true }));
    else if (m[5] !== undefined) spans.push(...mdInline(m[5], { ...style, strike: true }));
    else if (m[6] !== undefined || m[7] !== undefined) spans.push(...mdInline(m[6] ?? m[7], { ...style, italic: true }));
    else if (m[10] !== undefined) { if (m[8]) push(`[image: ${m[9] || m[10]}]`, { ...style, italic: true }); else { spans.push(...mdInline(m[9], { ...style, link: true })); if (m[9] !== m[10] && !/^#/.test(m[10])) push(` (${m[10]})`, { ...style, small: true }); } } else if (m[11]) push(m[11], { ...style, link: true });
  }
  push(text.slice(last), style);
  return spans;
}
function mdBlocks(src) {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '\ue000$1').split('\n'); const blocks = []; let i = 0;
  const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/; const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const TSEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  while (i < lines.length) {
    const ln = lines[i]; let m;
    if (!ln.trim()) { i++; continue; }
    if ((m = /^\s*(```|~~~)/.exec(ln))) { const code = []; i++; while (i < lines.length && !lines[i].trimStart().startsWith(m[1])) code.push(lines[i++].replace(/\ue000/g, '\\')); i++; blocks.push({ type: 'code', lines: code }); continue; }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln))) { blocks.push({ type: 'h', level: m[1].length, text: m[2] }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(ln)) { blocks.push({ type: 'hr' }); i++; continue; }
    if (ln.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && lines[i + 1].includes('|') && TSEP.test(lines[i + 1])) { const rows = [cells(ln)]; i += 2; while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++])); blocks.push({ type: 'table', rows }); continue; }
    if ((m = LIST.exec(ln))) { let text = m[3]; const depth = Math.min(5, Math.floor(m[1].replace(/\t/g, '    ').length / 2)); const marker = /\d/.test(m[2]) ? m[2].replace(')', '.') : '•'; i++; while (i < lines.length && /^\s+\S/.test(lines[i]) && !LIST.test(lines[i])) text += ' ' + lines[i++].trim(); const task = /^\[([ xX])\]\s+(.*)$/.exec(text); blocks.push({ type: 'li', depth, marker: task ? (task[1] === ' ' ? '[ ]' : '[x]') : marker, text: task ? task[2] : text }); continue; }
    if (/^\s*>/.test(ln)) { const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, '')); blocks.push({ type: 'quote', text: q.join(' ') }); continue; }
    if ((m = /^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/.exec(ln))) { blocks.push({ type: 'img', alt: m[1], src: m[2] }); i++; continue; }
    if (i + 1 < lines.length && /^\s*=+\s*$/.test(lines[i + 1])) { blocks.push({ type: 'h', level: 1, text: ln.trim() }); i += 2; continue; }
    if (i + 1 < lines.length && /^\s*-{2,}\s*$/.test(lines[i + 1])) { blocks.push({ type: 'h', level: 2, text: ln.trim() }); i += 2; continue; }
    const para = [ln.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>)/.test(lines[i]) && !LIST.test(lines[i]) && !(lines[i].includes('|') && lines[i + 1] && TSEP.test(lines[i + 1]) && lines[i + 1].includes('|'))) para.push(lines[i++].trim());
    blocks.push({ type: 'p', text: para.join(' ') });
  }
  return blocks;
}

const FAMILIES = { helvetica: ['Helvetica', 'HelveticaBold', 'HelveticaOblique', 'HelveticaBoldOblique'], times: ['TimesRoman', 'TimesRomanBold', 'TimesRomanItalic', 'TimesRomanBoldItalic'], courier: ['Courier', 'CourierBold', 'CourierOblique', 'CourierBoldOblique'] };
/** tiny typesetter over pdf-lib: flowing rich-text lines with page breaks */
async function typesetter(L, a) {
  const doc = await L.PDFDocument.create(); const [PW_, PH_] = pageSizeOf(a.pageSize, a.orientation);
  const mg = a.margin; if (PW_ - 2 * mg < 60 || PH_ - 2 * mg < 60) throw new Error(`margin=${mg} leaves no usable area on a ${round(PW_)} x ${round(PH_)} pt page`);
  const emb = async (names) => Promise.all(names.map((n) => doc.embedFont(L.StandardFonts[n])));
  const [R, B, I, BI] = await emb(FAMILIES[a.font]); const [MR, MB] = await emb(FAMILIES.courier);
  const { clean, report } = makeCleaner(); const black = L.rgb(0.08, 0.08, 0.08);
  const T = { doc, W: PW_, H: PH_, mg, width: PW_ - 2 * mg, page: null, y: 0, clean, report, black, fonts: { R, B, I, BI, MR, MB } };
  T.newPage = () => { T.page = doc.addPage([PW_, PH_]); T.y = PH_ - mg; };
  T.ensure = (h) => { if (!T.page || T.y - h < mg) T.newPage(); };
  T.fontOf = (s) => (s.code ? (s.bold ? MB : MR) : s.bold && s.italic ? BI : s.bold ? B : s.italic ? I : R);
  /** spans → wrapped lines of runs; each run {text, font, size, color, w} */
  T.wrap = (spans, size, maxW, base = {}) => {
    const lines = [[]]; let x = 0;
    const put = (text, font, sz, sp) => { const w = font.widthOfTextAtSize(text, sz); lines[lines.length - 1].push({ text, font, size: sz, w, x, link: sp.link, strike: sp.strike, code: sp.code }); x += w; };
    for (const sp0 of spans) {
      const sp = { ...base, ...sp0 }; const font = T.fontOf(sp); const sz = sp.code ? size * 0.92 : sp.small ? size * 0.85 : size;
      for (const tok of clean(font, sp.text).split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) { if (x > 0) { const w = font.widthOfTextAtSize(' ', sz); if (x + w <= maxW) { lines[lines.length - 1].push({ text: ' ', font, size: sz, w, x, space: true }); x += w; } } continue; }
        let word = tok; let w = font.widthOfTextAtSize(word, sz);
        if (x > 0 && x + w > maxW) { lines.push([]); x = 0; }
        while (w > maxW && word.length > 1) { // a word longer than the line: break it by characters
          let cut = word.length - 1; while (cut > 1 && font.widthOfTextAtSize(word.slice(0, cut), sz) > maxW - x) cut--;
          put(word.slice(0, cut), font, sz, sp); lines.push([]); x = 0; word = word.slice(cut); w = font.widthOfTextAtSize(word, sz);
        }
        put(word, font, sz, sp);
      }
    }
    for (const l of lines) while (l.length && l[l.length - 1].space) l.pop();
    return lines.filter((l, i) => l.length || i === 0);
  };
  T.drawLine = (runs, x0, y, color = black) => {
    for (const r of runs) {
      if (r.space) continue;
      if (r.code) T.page.drawRectangle({ x: x0 + r.x - 1, y: y - r.size * 0.25, width: r.w + 2, height: r.size * 1.15, color: L.rgb(0.93, 0.93, 0.93) });
      T.page.drawText(r.text, { x: x0 + r.x, y, size: r.size, font: r.font, color: r.link ? L.rgb(0.05, 0.25, 0.7) : color });
      if (r.strike) T.page.drawLine({ start: { x: x0 + r.x, y: y + r.size * 0.3 }, end: { x: x0 + r.x + r.w, y: y + r.size * 0.3 }, thickness: 0.6, color });
    }
  };
  /** flow spans as a paragraph at indent; returns nothing, advances T.y */
  T.para = (spans, { size = a.fontSize, indent = 0, base = {}, color = black, after = 0.5, lead = a.lineHeight, bullet = null, keep = 1 } = {}) => {
    const lines = T.wrap(spans, size, T.width - indent, base); const lh = size * lead;
    T.ensure(lh * Math.min(lines.length, keep));
    lines.forEach((runs, i) => {
      T.ensure(lh); T.y -= lh;
      if (i === 0 && bullet) T.page.drawText(clean(base.bold ? B : R, bullet.text), { x: mg + bullet.x, y: T.y + lh * 0.22, size, font: R, color });
      T.drawLine(runs, mg + indent, T.y + lh * 0.22, color);
    });
    T.y -= size * after;
  };
  return T;
}
const TYPESET_PROPS = {
  pageSize: { type: 'string', default: 'a4', description: 'a4, a3, a5, letter, legal, tabloid or "WIDTHxHEIGHT" in points' },
  orientation: { type: 'string', enum: ['portrait', 'landscape'], default: 'portrait', description: 'Page orientation' },
  margin: { type: 'number', default: 56, minimum: 0, maximum: 400, description: 'Page margin in points (56 pt ≈ 2 cm)' },
  lineHeight: { type: 'number', default: 1.4, minimum: 0.9, maximum: 3, description: 'Line height as a multiple of the font size' },
  pageNumbers: { type: 'boolean', default: false, description: 'Print "n / total" at the bottom centre of each page' },
  title: { type: 'string', description: 'Document title to store in the metadata' },
};
function finishTypeset(L, T, a) {
  if (!T.page) T.newPage();
  if (a.title) T.doc.setTitle(a.title);
  if (a.pageNumbers) { const ps = T.doc.getPages(); ps.forEach((p, i) => { const s = `${i + 1} / ${ps.length}`; p.drawText(s, { x: (T.W - T.fonts.R.widthOfTextAtSize(s, 9)) / 2, y: Math.max(14, T.mg * 0.45), size: 9, font: T.fonts.R, color: L.rgb(0.4, 0.4, 0.4) }); }); }
}
function sourceText(a, what) {
  if ((a.input === undefined) === (a.text === undefined)) throw new Error(`give exactly one of: input (VFS path of a ${what} file), text (inline ${what})`);
  return a.input !== undefined ? vfs.text(a.input) : a.text;
}

register({
  name: 'pdf.fromMarkdown',
  description: 'Typeset Markdown as a paginated PDF: headings, wrapped paragraphs with bold/italic/inline code/links, bullet, numbered and task lists (nested), fenced code blocks, block quotes, rules, tables with wrapped cells, and images referenced by VFS path. Uses the built-in PDF fonts, which only cover WinAnsi (Western European Latin): other characters are transliterated where possible, otherwise written as "?" and counted in the result (unencodable). No HTML, footnotes or maths. Returns the PDF and its page count.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of a Markdown file (or give text)' },
      text: { type: 'string', description: 'Inline Markdown (alternative to input)' },
      font: { type: 'string', enum: ['helvetica', 'times', 'courier'], default: 'helvetica', description: 'Body font family' },
      fontSize: { type: 'number', default: 11, minimum: 5, maximum: 40, description: 'Body font size in points' },
      ...TYPESET_PROPS,
      output: { type: 'string', description: 'VFS path to write (default: <input>.pdf or document.pdf)' },
    },
  },
  examples: ['pdf.fromMarkdown input=notes.md', 'pdf.fromMarkdown text="# Title\\n\\nHello **world**" output=hello.pdf'],
  async run(a) {
    const src = sourceText(a, 'Markdown'); const L = await lib(); const T = await typesetter(L, a); const fs = a.fontSize; const { mg } = T;
    const gray = L.rgb(0.35, 0.35, 0.35); const rule = L.rgb(0.75, 0.75, 0.75); const HS = [2.0, 1.6, 1.3, 1.15, 1.0, 0.92];
    const blocks = mdBlocks(src); const counts = {}; const missing = [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi]; counts[b.type] = (counts[b.type] || 0) + 1;
      if (b.type === 'h') { const size = fs * HS[b.level - 1]; if (T.page && T.y < T.H - mg - 1) T.y -= size * 0.55; T.ensure(size * 1.3 + fs * a.lineHeight * 2); T.para(mdInline(b.text), { size, base: { bold: true }, lead: 1.25, after: 0.35 }); if (b.level <= 2) { T.page.drawLine({ start: { x: mg, y: T.y + size * 0.12 }, end: { x: T.W - mg, y: T.y + size * 0.12 }, thickness: b.level === 1 ? 1 : 0.5, color: rule }); T.y -= size * 0.25; } }
      else if (b.type === 'p') T.para(mdInline(b.text), { after: 0.7, keep: 2 });
      else if (b.type === 'li') { const ind = 14 + b.depth * 16; const mw = T.fonts.R.widthOfTextAtSize(T.clean(T.fonts.R, b.marker), fs); T.para(mdInline(b.text), { indent: ind + Math.max(0, mw - 9) + 2, bullet: { text: b.marker, x: ind - 11 }, after: blocks[bi + 1]?.type === 'li' ? 0.15 : 0.7 }); }
      else if (b.type === 'quote') { const y0 = T.y; const p0 = T.page; T.para(mdInline(b.text), { indent: 14, base: { italic: true }, color: gray, after: 0.2 }); if (T.page === p0) T.page.drawLine({ start: { x: mg + 4, y: y0 - 2 }, end: { x: mg + 4, y: T.y + fs * 0.2 }, thickness: 2, color: rule }); T.y -= fs * 0.5; }
      else if (b.type === 'hr') { T.ensure(fs * 1.5); T.y -= fs * 0.6; T.page.drawLine({ start: { x: mg, y: T.y }, end: { x: T.W - mg, y: T.y }, thickness: 0.7, color: rule }); T.y -= fs * 0.9; }
      else if (b.type === 'code') {
        const size = fs * 0.88, lh = size * 1.3, font = T.fonts.MR; const maxChars = Math.max(8, Math.floor((T.width - 12) / (size * 0.6))); const rows = [];
        for (const raw of b.lines) { const s = T.clean(font, raw.replace(/\t/g, '    ')); if (!s) rows.push(''); for (let k = 0; k < s.length; k += maxChars) rows.push(s.slice(k, k + maxChars)); }
        T.ensure(lh * Math.min(rows.length, 3) + 8); T.y -= 4;
        for (const r of rows) { T.ensure(lh); T.y -= lh; T.page.drawRectangle({ x: mg, y: T.y - lh * 0.1, width: T.width, height: lh + 0.5, color: L.rgb(0.95, 0.95, 0.95) }); if (r) T.page.drawText(r, { x: mg + 6, y: T.y + lh * 0.2, size, font, color: T.black }); }
        T.y -= fs * 0.9;
      } else if (b.type === 'img') {
        if (!vfs.exists(b.src)) { missing.push(b.src); T.para([{ text: `[image: ${b.alt || b.src}]`, italic: true }], { color: gray }); continue; }
        try { const { image } = await embedImage(T.doc, b.src, { maxSide: 2400 }); let w = Math.min(T.width, image.width * 0.75), h = (w / image.width) * image.height; const maxH = T.H - 2 * mg; if (h > maxH) { h = maxH; w = (h / image.height) * image.width; } T.ensure(h + 4); T.y -= h; T.page.drawImage(image, { x: mg, y: T.y, width: w, height: h }); T.y -= fs * 0.8; } catch { missing.push(b.src); T.para([{ text: `[image: ${b.alt || b.src}]`, italic: true }], { color: gray }); }
      } else if (b.type === 'table') {
        const nc = Math.max(...b.rows.map((r) => r.length)); const size = fs * 0.92, padX = 4, lh = size * 1.3;
        const cellSpans = b.rows.map((r, ri) => Array.from({ length: nc }, (_, c) => mdInline(r[c] || '', ri === 0 ? { bold: true } : {})));
        const nat = Array(nc).fill(20); for (const r of cellSpans) r.forEach((sp, c) => { const w = T.wrap(sp, size, 1e6)[0].reduce((s, run) => s + run.w, 0); nat[c] = Math.max(nat[c], w + 2 * padX + 1); });
        let widths = nat; const sum = nat.reduce((s, x) => s + x, 0);
        if (sum > T.width) { const min = Math.min(48, T.width / nc); const flex = nat.map((x) => Math.max(0, x - min)); const fsum = flex.reduce((s, x) => s + x, 0) || 1; const room = T.width - min * nc; widths = nat.map((_, c) => min + (flex[c] / fsum) * Math.max(0, room)); }
        const tw = widths.reduce((s, x) => s + x, 0);
        cellSpans.forEach((r, ri) => {
          const wrapped = r.map((sp, c) => T.wrap(sp, size, Math.max(10, widths[c] - 2 * padX))); const rh = Math.max(...wrapped.map((w) => w.length)) * lh + 5;
          T.ensure(rh); const top = T.y; T.y -= rh;
          if (ri === 0) T.page.drawRectangle({ x: mg, y: T.y, width: tw, height: rh, color: L.rgb(0.93, 0.93, 0.93) });
          let x = mg; wrapped.forEach((ls, c) => { ls.forEach((runs, li) => T.drawLine(runs, x + padX, top - 3 - (li + 1) * lh + lh * 0.25)); x += widths[c]; });
          x = mg; for (let c = 0; c <= nc; c++) { T.page.drawLine({ start: { x, y: top }, end: { x, y: T.y }, thickness: 0.4, color: rule }); x += widths[c] || 0; }
          T.page.drawLine({ start: { x: mg, y: top }, end: { x: mg + tw, y: top }, thickness: 0.4, color: rule }); T.page.drawLine({ start: { x: mg, y: T.y }, end: { x: mg + tw, y: T.y }, thickness: 0.4, color: rule });
        });
        T.y -= fs * 0.9;
      }
    }
    finishTypeset(L, T, a);
    const output = await savePdf(T.doc, a.output || (a.input ? vfs.out(undefined, a.input, '', 'pdf') : vfs.unique('document', 'pdf')));
    return { output, pages: T.doc.getPageCount(), blocks: counts, missingImages: missing.length ? missing.slice(0, 20) : undefined, font: a.font, ...T.report() };
  },
});

register({
  name: 'pdf.fromText',
  description: 'Turn plain text into a paginated PDF, keeping line breaks and indentation and wrapping long lines (monospace by default, so column-aligned text and logs stay aligned). A form-feed character starts a new page. Built-in PDF fonts only cover WinAnsi (Western European Latin): other characters are transliterated where possible, otherwise written as "?" and counted in the result. For headings, lists and tables use pdf.fromMarkdown.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of a text file (or give text)' },
      text: { type: 'string', description: 'Inline text (alternative to input)' },
      font: { type: 'string', enum: ['courier', 'helvetica', 'times'], default: 'courier', description: 'Font family' },
      fontSize: { type: 'number', default: 10, minimum: 4, maximum: 40, description: 'Font size in points' },
      ...TYPESET_PROPS,
      output: { type: 'string', description: 'VFS path to write (default: <input>.pdf or document.pdf)' },
    },
  },
  examples: ['pdf.fromText input=log.txt fontSize=8 orientation=landscape'],
  async run(a) {
    const src = sourceText(a, 'text').replace(/\r\n?/g, '\n'); const L = await lib(); const T = await typesetter(L, { ...a, lineHeight: a.lineHeight }); const font = T.fonts.R; const fs = a.fontSize; const lh = fs * a.lineHeight; let lineCount = 0;
    T.newPage();
    const pagesSrc = src.split('\f');
    pagesSrc.forEach((chunk, ci) => {
      if (ci > 0) T.newPage();
      for (const raw of chunk.split('\n')) {
        let expanded = ''; for (const ch of raw) expanded += ch === '\t' ? ' '.repeat(4 - (expanded.length % 4)) : ch;
        const lead = /^ */.exec(expanded)[0]; const indent = Math.min(font.widthOfTextAtSize(lead, fs), T.width * 0.6);
        const body = expanded.slice(lead.length);
        // keep runs of inner spaces (alignment): wrap on the cleaned string by measuring greedily
        const s = T.clean(font, body); const rows = []; let rest = s;
        while (rest.length) {
          if (font.widthOfTextAtSize(rest, fs) <= T.width - indent) { rows.push(rest); break; }
          let cut = rest.length; let lo = 1, hi = rest.length; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (font.widthOfTextAtSize(rest.slice(0, mid), fs) <= T.width - indent) lo = mid; else hi = mid - 1; } cut = lo;
          const sp = rest.lastIndexOf(' ', cut); if (sp > cut * 0.5) cut = sp;
          rows.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^ +/, '');
        }
        if (!rows.length) rows.push('');
        for (const r of rows) { T.ensure(lh); T.y -= lh; if (r.trim()) T.page.drawText(r, { x: T.mg + indent, y: T.y + lh * 0.22, size: fs, font, color: T.black }); lineCount++; }
      }
    });
    finishTypeset(L, T, a);
    const output = await savePdf(T.doc, a.output || (a.input ? vfs.out(undefined, a.input, '', 'pdf') : vfs.unique('document', 'pdf')));
    return { output, pages: T.doc.getPageCount(), lines: lineCount, font: a.font, ...T.report() };
  },
});

// ───────────────────────────────────────────── metadata / stamps / forms ──
register({
  name: 'pdf.metadata',
  description: 'Read, set or strip a PDF\'s document metadata (title, author, subject, keywords, creator, producer, dates). With no fields and strip=false it only reads (no file written). Setting fields rewrites the Info dictionary and removes a stale XMP packet so viewers do not show old values; strip=true removes Info and XMP entirely (privacy clean-up). Returns the metadata after the change.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      title: { type: 'string', description: 'Set the title ("" clears it)' },
      author: { type: 'string', description: 'Set the author' },
      subject: { type: 'string', description: 'Set the subject' },
      keywords: { type: 'string', description: 'Set the keywords (one string, comma-separated by convention)' },
      creator: { type: 'string', description: 'Set the creating application' },
      producer: { type: 'string', description: 'Set the PDF producer' },
      creationDate: { type: 'string', description: 'Set the creation date (ISO 8601, e.g. 2026-01-31T12:00:00Z)' },
      modificationDate: { type: 'string', description: 'Set the modification date (ISO 8601)' },
      strip: { type: 'boolean', default: false, description: 'Remove all document metadata (Info dictionary and XMP) before applying any fields given' },
      output: { type: 'string', description: 'VFS path to write when something changes (default: <input>.meta.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.metadata input=doc.pdf', 'pdf.metadata input=doc.pdf title="Q3 report" author="Ops"', 'pdf.metadata input=doc.pdf strip=true'],
  async run(a) {
    const read = (path) => withJs(path, a.password, async ({ pdfjs, doc }) => {
      const md = await doc.getMetadata().catch(() => ({ info: {} })); const info = md.info || {}; const out = {};
      const date = (s) => { try { const d = pdfjs.PDFDateString.toDateObject(s); return d ? d.toISOString() : s; } catch { return s; } };
      for (const [k, key] of [['Title', 'title'], ['Author', 'author'], ['Subject', 'subject'], ['Keywords', 'keywords'], ['Creator', 'creator'], ['Producer', 'producer']]) if (info[k]) out[key] = String(info[k]).slice(0, 500);
      if (info.CreationDate) out.creationDate = date(info.CreationDate); if (info.ModDate) out.modificationDate = date(info.ModDate);
      if (info.Custom && Object.keys(info.Custom).length) out.custom = Object.fromEntries(Object.entries(info.Custom).slice(0, 20).map(([k, v]) => [k, String(v).slice(0, 200)]));
      return { metadata: out, hasXmp: !!md.metadata, pdfVersion: info.PDFFormatVersion };
    });
    const fields = ['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'creationDate', 'modificationDate'].filter((k) => a[k] !== undefined);
    if (!fields.length && !a.strip) return { changed: false, ...(await read(a.input)) };
    const { L, doc } = await openLib(a.input, a.password); const N = (s) => L.PDFName.of(s); const ctx = doc.context;
    const mref = doc.catalog.get(N('Metadata')); const hadXmp = !!mref;
    if (mref instanceof L.PDFRef) ctx.delete(mref); doc.catalog.delete(N('Metadata'));
    if (a.strip && ctx.trailerInfo.Info) { if (ctx.trailerInfo.Info instanceof L.PDFRef) ctx.delete(ctx.trailerInfo.Info); ctx.trailerInfo.Info = undefined; }
    const dateOf = (s, k) => { const d = new Date(s); if (Number.isNaN(d.getTime())) throw new Error(`${k}="${s}" is not a date — use ISO 8601 like 2026-01-31T12:00:00Z`); return d; };
    for (const k of fields) {
      const v = a[k];
      if (k === 'title') doc.setTitle(v); else if (k === 'author') doc.setAuthor(v); else if (k === 'subject') doc.setSubject(v); else if (k === 'keywords') doc.setKeywords([v]);
      else if (k === 'creator') doc.setCreator(v); else if (k === 'producer') doc.setProducer(v); else if (k === 'creationDate') doc.setCreationDate(dateOf(v, k)); else doc.setModificationDate(dateOf(v, k));
    }
    const output = await savePdf(doc, vfs.out(a.output, a.input, 'meta', 'pdf'));
    return { changed: true, output, set: fields, stripped: a.strip, xmpRemoved: hadXmp, ...(await read(output.path)) };
  },
});

const POSITIONS = ['center', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'tile'];
register({
  name: 'pdf.watermark',
  description: 'Stamp text or an image on PDF pages — a diagonal "DRAFT"/"CONFIDENTIAL", a logo in a corner, or a tiled pattern — with opacity and rotation, over or under the page content. The page content stays intact (text remains selectable). Text uses a built-in font (WinAnsi only; other characters become "?"). Returns the stamped PDF.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      text: { type: 'string', description: 'Watermark text (give text or image)' },
      image: { type: 'string', description: 'VFS path of an image to use as watermark (PNG with transparency works)' },
      pages: PAGES(' Default: all pages.'),
      position: { type: 'string', enum: POSITIONS, default: 'center', description: 'Where on the page; tile repeats it across the page' },
      opacity: { type: 'number', default: 0.2, minimum: 0.01, maximum: 1, description: '0-1' },
      rotation: { type: 'number', default: 45, minimum: -180, maximum: 180, description: 'Degrees counter-clockwise (45 = rising diagonal; use 0 for corners)' },
      fontSize: { type: 'number', minimum: 4, maximum: 600, description: 'Text size in points (default: sized to span about 70% of the page for center, 5% of the page width otherwise)' },
      color: { type: 'string', default: '#808080', description: 'Text colour (#rrggbb or a basic colour name)' },
      scale: { type: 'number', default: 0.4, minimum: 0.01, maximum: 2, description: 'Image width as a fraction of the page width' },
      margin: { type: 'number', default: 28, minimum: 0, maximum: 500, description: 'Distance from the page edge in points for edge/corner positions' },
      layer: { type: 'string', enum: ['over', 'under'], default: 'over', description: 'over = on top of the content; under = behind it (invisible where the page paints an opaque background, e.g. scans)' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.watermarked.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.watermark input=doc.pdf text=DRAFT', 'pdf.watermark input=doc.pdf image=logo.png position=top-right rotation=0 scale=0.15 opacity=1'],
  async run(a, ctx) {
    if ((a.text === undefined) === (a.image === undefined)) throw new Error('give exactly one of: text, image');
    const { L, doc } = await openLib(a.input, a.password); const idx = uniqSorted(parsePages(a.pages, doc.getPageCount()));
    const color = colorOf(L, a.color); const cl = makeCleaner(); let font, image, text;
    if (a.text !== undefined) { font = await doc.embedFont(L.StandardFonts.HelveticaBold); text = cl.clean(font, a.text); if (!text.trim()) throw new Error('text is empty'); } else image = (await embedImage(doc, a.image)).image;
    const th = (a.rotation * Math.PI) / 180, cos = Math.cos(th), sin = Math.sin(th);
    for (let k = 0; k < idx.length; k++) {
      const page = doc.getPage(idx[k]); const f = frameOf(page); let w, h, size;
      if (font) { size = a.fontSize || (a.position === 'center' ? clamp((0.7 * (Math.abs(cos) > 0.01 && Math.abs(sin) > 0.01 ? Math.hypot(f.W, f.H) : Math.abs(sin) > 0.7 ? f.H : f.W)) / font.widthOfTextAtSize(text, 1), 6, 400) : Math.max(8, f.W * 0.05)); w = font.widthOfTextAtSize(text, size); h = size * 0.72; } else { w = f.W * a.scale; h = (w / image.width) * image.height; }
      // bounding box of the rotated stamp, to keep edge positions inside the page
      const bw = Math.abs(w * cos) + Math.abs(h * sin), bh = Math.abs(w * sin) + Math.abs(h * cos);
      const centres = [];
      if (a.position === 'tile') { const sx = bw + Math.max(40, w * 0.35), sy = bh + Math.max(40, h * 2.5); for (let y = sy / 2, r = 0; y < f.H + sy / 2; y += sy, r++) for (let x = (r % 2 ? 0 : sx / 2); x < f.W + sx / 2; x += sx) centres.push([x, y]); } else {
        const cx = a.position.includes('left') ? a.margin + bw / 2 : a.position.includes('right') ? f.W - a.margin - bw / 2 : f.W / 2;
        const cy = a.position.startsWith('top') ? f.H - a.margin - bh / 2 : a.position.startsWith('bottom') ? a.margin + bh / 2 : f.H / 2;
        centres.push([cx, cy]);
      }
      const before = page.node.Contents();
      const countBefore = before instanceof L.PDFArray ? before.size() : before ? 1 : 0;
      for (const [cx, cy] of centres) {
        const vx = cx - (w / 2) * cos + (h / 2) * sin, vy = cy - (w / 2) * sin - (h / 2) * cos; const [x, y] = f.map(vx, vy); const rotate = L.degrees(a.rotation + f.rot);
        if (font) page.drawText(text, { x, y, size, font, color, opacity: a.opacity, rotate }); else page.drawImage(image, { x, y, width: w, height: h, opacity: a.opacity, rotate });
      }
      if (a.layer === 'under') { // move the stream(s) just appended to the front of the page's content array
        const arr = page.node.Contents();
        if (arr instanceof L.PDFArray && arr.size() > 1) { const items = arr.asArray().slice(); const added = items.splice(items.length - 1, 1); const fresh = doc.context.obj([...added, ...items]); page.node.set(L.PDFName.of('Contents'), fresh); }
        else if (countBefore === 0) { /* empty page: nothing to go under */ }
      }
      ctx.progress((k + 1) / idx.length);
    }
    return { output: await savePdf(doc, vfs.out(a.output, a.input, 'watermarked', 'pdf')), pages: doc.getPageCount(), stamped: idx.length, kind: font ? 'text' : 'image', layer: a.layer, ...cl.report() };
  },
});

register({
  name: 'pdf.pageNumbers',
  description: 'Print page numbers (or any short running label) on PDF pages, e.g. "{n}", "Page {n} of {total}" or "ACME-{n}". Numbers follow the position of each page in the document; start shifts the first number. The text is added on top of the existing content with a built-in font. Returns the numbered PDF.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      format: { type: 'string', default: '{n}', description: 'Label template: {n} = page number, {total} = last number' },
      position: { type: 'string', enum: ['bottom-center', 'bottom-left', 'bottom-right', 'top-center', 'top-left', 'top-right'], default: 'bottom-center', description: 'Where to print' },
      pages: PAGES(' Pages that receive a label (default: all). Use "2-" to leave a cover page unnumbered.'),
      start: { type: 'integer', default: 1, description: 'Number given to the first labelled page' },
      fontSize: { type: 'number', default: 10, minimum: 4, maximum: 72, description: 'Text size in points' },
      margin: { type: 'number', default: 28, minimum: 0, maximum: 500, description: 'Distance from the page edges in points' },
      color: { type: 'string', default: '#000000', description: 'Text colour (#rrggbb or a basic colour name)' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.numbered.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.pageNumbers input=doc.pdf format="Page {n} of {total}" pages=2- start=2'],
  async run(a) {
    const { L, doc } = await openLib(a.input, a.password); const idx = uniqSorted(parsePages(a.pages, doc.getPageCount()));
    const font = await doc.embedFont(L.StandardFonts.Helvetica); const color = colorOf(L, a.color); const cl = makeCleaner(); const total = a.start + idx.length - 1;
    idx.forEach((pi, k) => {
      const page = doc.getPage(pi); const f = frameOf(page); const s = cl.clean(font, a.format.replace(/\{n\}/g, a.start + k).replace(/\{total\}/g, total)); const w = font.widthOfTextAtSize(s, a.fontSize);
      const vx = a.position.endsWith('left') ? a.margin : a.position.endsWith('right') ? f.W - a.margin - w : (f.W - w) / 2; const vy = a.position.startsWith('top') ? f.H - a.margin - a.fontSize * 0.75 : a.margin;
      const [x, y] = f.map(vx, vy); page.drawText(s, { x, y, size: a.fontSize, font, color, rotate: L.degrees(f.rot) });
    });
    return { output: await savePdf(doc, vfs.out(a.output, a.input, 'numbered', 'pdf')), pages: doc.getPageCount(), numbered: idx.length, first: a.start, last: total, ...cl.report() };
  },
});

register({
  name: 'pdf.outline',
  description: 'Read a PDF\'s bookmarks (outline / table of contents) as a flat list with nesting level and target page — a cheap map of a long document. With set=[…] it instead writes a new outline (replacing any existing one) and returns the new PDF; use that to restore navigation after pdf.merge.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      maxItems: { type: 'integer', default: 200, minimum: 1, maximum: 2000, description: 'Cap on the number of entries returned' },
      set: { type: 'array', items: { type: 'object' }, description: 'Write mode: entries in reading order, each {title: string, page: 1-based number, level?: 1.. (default 1; a level-2 entry nests under the previous level-1 entry)}' },
      output: { type: 'string', description: 'Write mode: VFS path to write (default: <input>.outlined.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.outline input=manual.pdf', 'pdf.outline input=merged.pdf set=[{"title":"Part A","page":1},{"title":"Details","page":3,"level":2}]'],
  async run(a) {
    if (a.set) {
      const { L, doc } = await openLib(a.input, a.password); const n = doc.getPageCount(); const N = (s) => L.PDFName.of(s); const ctx = doc.context;
      if (!a.set.length) throw new Error('set is empty — give at least one {title, page} entry');
      const nodes = a.set.map((e, i) => { if (typeof e === 'string') { try { e = JSON.parse(e); } catch { /* handled below */ } } if (!e || typeof e !== 'object' || typeof e.title !== 'string' || !Number.isInteger(Number(e.page))) throw new Error(`set[${i}] must be {title: string, page: number, level?: number}`); const page = Number(e.page); if (page < 1 || page > n) throw new Error(`set[${i}].page=${page} is out of range (1-${n})`); return { title: e.title, page, level: Math.max(1, Math.round(Number(e.level) || 1)), kids: [], ref: ctx.nextRef() }; });
      const rootRef = ctx.nextRef(); const top = []; const stack = [];
      for (const nd of nodes) { while (stack.length && stack[stack.length - 1].level >= nd.level) stack.pop(); const parent = stack[stack.length - 1]; nd.parent = parent ? parent.ref : rootRef; (parent ? parent.kids : top).push(nd); stack.push(nd); }
      const count = (nd) => nd.kids.reduce((s, k) => s + 1 + count(k), 0);
      const emit = (list) => list.forEach((nd, i) => {
        const d = ctx.obj({}); d.set(N('Title'), L.PDFHexString.fromText(nd.title)); d.set(N('Parent'), nd.parent);
        d.set(N('Dest'), ctx.obj([doc.getPage(nd.page - 1).ref, N('Fit')]));
        if (i > 0) d.set(N('Prev'), list[i - 1].ref); if (i < list.length - 1) d.set(N('Next'), list[i + 1].ref);
        if (nd.kids.length) { d.set(N('First'), nd.kids[0].ref); d.set(N('Last'), nd.kids[nd.kids.length - 1].ref); d.set(N('Count'), L.PDFNumber.of(count(nd))); emit(nd.kids); }
        ctx.assign(nd.ref, d);
      });
      emit(top);
      const root = ctx.obj({}); root.set(N('Type'), N('Outlines')); root.set(N('First'), top[0].ref); root.set(N('Last'), top[top.length - 1].ref); root.set(N('Count'), L.PDFNumber.of(nodes.length)); ctx.assign(rootRef, root);
      doc.catalog.set(N('Outlines'), rootRef); doc.catalog.set(N('PageMode'), N('UseOutlines'));
      return { output: await savePdf(doc, vfs.out(a.output, a.input, 'outlined', 'pdf')), pages: n, items: nodes.length, topLevel: top.length };
    }
    return withJs(a.input, a.password, async ({ doc }) => {
      const tree = await doc.getOutline(); const items = []; let total = 0;
      const pageOf = async (dest) => { try { if (typeof dest === 'string') dest = await doc.getDestination(dest); if (!Array.isArray(dest)) return null; const r = dest[0]; if (typeof r === 'number') return r + 1; return (await doc.getPageIndex(r)) + 1; } catch { return null; } };
      const walk = async (list, level) => { for (const it of list || []) { total++; if (items.length < a.maxItems) items.push({ level, title: String(it.title || '').replace(/\s+/g, ' ').trim().slice(0, 200), page: it.dest ? await pageOf(it.dest) : null, url: it.url || undefined }); await walk(it.items, level + 1); } };
      await walk(tree, 1);
      return { present: total > 0, total, items, truncated: total > items.length, pages: doc.numPages, note: total ? undefined : 'This PDF has no bookmarks. pdf.toMarkdown can recover headings from the text instead.' };
    });
  },
});

register({
  name: 'pdf.forms',
  description: 'Work with interactive PDF forms (AcroForm): list every field with its type, current value and choices; fill fields from a {name: value} object; and optionally flatten (burn the values into the page so they can no longer be edited). With no values and flatten=false it only lists (no file written). Text values use the form\'s fonts or Helvetica, so characters outside WinAnsi may be rejected. Hybrid AcroForm+XFA files work, but the XFA part is dropped from the written file; XFA-only forms (Adobe LiveCycle) are not supported.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      values: { type: 'object', description: 'Fields to fill: {"Field name": value}. Text: string; checkbox: true/false; radio group and dropdown: the option name; list box: an array of option names' },
      flatten: { type: 'boolean', default: false, description: 'Turn all fields into static page content after filling' },
      output: { type: 'string', description: 'VFS path to write when filling/flattening (default: <input>.filled.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.forms input=form.pdf', 'pdf.forms input=form.pdf values={"name":"Ada","agree":true} flatten=true'],
  async run(a) {
    const { L, doc } = await openLib(a.input, a.password); let form;
    try { form = doc.getForm(); } catch (e) { throw new Error(`could not read the form: ${e.message}`); }
    const typeOf = (f) => (f instanceof L.PDFTextField ? 'text' : f instanceof L.PDFCheckBox ? 'checkbox' : f instanceof L.PDFRadioGroup ? 'radio' : f instanceof L.PDFDropdown ? 'dropdown' : f instanceof L.PDFOptionList ? 'list' : f instanceof L.PDFButton ? 'button' : f instanceof L.PDFSignature ? 'signature' : 'unknown');
    const describe = (f) => {
      const type = typeOf(f); const o = { name: f.getName(), type }; const tryGet = (fn) => { try { return fn(); } catch { return undefined; } };
      if (type === 'text') { o.value = tryGet(() => f.getText()) ?? ''; const ml = tryGet(() => f.getMaxLength()); if (ml) o.maxLength = ml; if (tryGet(() => f.isMultiline())) o.multiline = true; } else if (type === 'checkbox') o.value = !!tryGet(() => f.isChecked());
      else if (type === 'radio') { o.value = tryGet(() => f.getSelected()) ?? null; o.options = tryGet(() => f.getOptions())?.slice(0, 50); } else if (type === 'dropdown' || type === 'list') { o.value = tryGet(() => f.getSelected()) ?? []; o.options = tryGet(() => f.getOptions())?.slice(0, 50); }
      if (tryGet(() => f.isReadOnly())) o.readOnly = true; if (tryGet(() => f.isRequired())) o.required = true;
      if (typeof o.value === 'string') o.value = o.value.slice(0, 500);
      return o;
    };
    const fields = form.getFields();
    const list = () => ({ fieldCount: fields.length, fields: fields.slice(0, 200).map(describe), truncated: fields.length > 200 || undefined });
    let values = a.values; if (typeof values === 'string') { try { values = JSON.parse(values); } catch { throw new Error('values must be a JSON object like {"Field name": "value"}'); } }
    const names = values ? Object.keys(values) : [];
    if (!names.length && !a.flatten) return { changed: false, ...list(), note: fields.length ? undefined : 'This PDF has no AcroForm fields.' };
    if (!fields.length) throw new Error('this PDF has no AcroForm fields to fill or flatten');
    const byName = new Map(fields.map((f) => [f.getName(), f])); const filled = [];
    for (const name of names) {
      const f = byName.get(name); if (!f) throw new Error(`no field named "${name}" — fields are: ${[...byName.keys()].slice(0, 40).join(', ')}`);
      const v = values[name]; const type = typeOf(f);
      try {
        if (type === 'text') f.setText(v === null || v === undefined ? '' : String(v));
        else if (type === 'checkbox') { if (v === true || v === 'true' || v === 1 || v === 'yes' || v === 'on') f.check(); else f.uncheck(); } else if (type === 'radio' || type === 'dropdown' || type === 'list') {
          const want = type === 'list' && Array.isArray(v) ? v.map(String) : [String(v)]; const opts = f.getOptions(); const editable = type === 'dropdown' && f.isEditable();
          const bad = want.filter((x) => !opts.includes(x)); if (bad.length && !editable) throw new Error(`"${bad[0]}" is not one of its options`);
          f.select(type === 'list' ? want : want[0]);
        }
        else throw new Error(`fields of type ${type} cannot be filled`);
      } catch (e) { throw new Error(`field "${name}" (${type}): ${e.message}${describe(f).options ? ` — options: ${describe(f).options.join(', ')}` : ''}`); }
      filled.push(name);
    }
    const after = list();
    if (a.flatten) { try { form.flatten(); } catch (e) { throw new Error(`flatten failed: ${e.message}`); } }
    let output;
    try { output = await savePdf(doc, vfs.out(a.output, a.input, a.flatten ? 'flat' : 'filled', 'pdf')); } catch (e) { throw new Error(`${e.message} — a value probably contains characters the form font cannot encode (WinAnsi only)`); }
    return { changed: true, output, filled, flattened: a.flatten, ...after };
  },
});

register({
  name: 'pdf.attachments',
  description: 'List the files embedded in a PDF (document-level attachments such as source spreadsheets or XML invoices), optionally extracting them into the VFS; or attach VFS files to the PDF with add=[…]. Listing returns name, size and description for each.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      extract: { type: 'boolean', default: false, description: 'Write the attachments to the VFS and return them in outputs' },
      outputPrefix: { type: 'string', description: 'extract: folder-like prefix for extracted files (default: "<input name>.attachments/")' },
      add: { type: 'array', items: { type: 'string' }, description: 'Attach mode: VFS paths of files to embed into the PDF' },
      output: { type: 'string', description: 'Attach mode: VFS path to write (default: <input>.attached.pdf)' },
      ...PW,
    },
    required: ['input'],
  },
  examples: ['pdf.attachments input=invoice.pdf extract=true', 'pdf.attachments input=report.pdf add=data.csv'],
  async run(a) {
    if (a.add?.length) {
      const { doc } = await openLib(a.input, a.password);
      for (const p of a.add) { const st = vfs.stat(p); await doc.attach(vfs.read(p), p.split('/').pop(), { mimeType: st.mime, creationDate: new Date(), modificationDate: new Date() }); }
      return { output: await savePdf(doc, vfs.out(a.output, a.input, 'attached', 'pdf')), attached: a.add.map((p) => ({ name: p.split('/').pop(), bytes: vfs.stat(p).bytes })) };
    }
    return withJs(a.input, a.password, async ({ doc }) => {
      const list = entriesOf(await doc.getAttachments()); const prefix = a.outputPrefix ?? `${vfs.stemOf(a.input)}.attachments/`; const outputs = []; const items = [];
      for (const [key, f] of list.slice(0, 100)) {
        let content = f.content; if (!content && doc.getAttachmentContent) { try { content = await doc.getAttachmentContent(key); } catch { /* unreadable */ } }
        const name = String(f.filename || f.rawFilename || key || 'unnamed');
        items.push({ name, bytes: content?.length ?? null, description: f.description || undefined });
        if (!a.extract || !content) continue;
        const safe = name.replace(/[\\/:*?"<>|]+/g, '_'); const ext = vfs.extOf(safe);
        const path = vfs.exists(prefix + safe) ? vfs.unique(prefix + (ext ? safe.slice(0, -ext.length - 1) : safe), ext) : prefix + safe;
        outputs.push(await vfs.write(path, content.slice()));
      }
      return { count: list.length, attachments: items, truncated: list.length > 100 || undefined, ...(a.extract ? { outputs } : {}) };
    });
  },
});

// ─────────────────────────────────────────────────────── encryption ──
register({
  name: 'pdf.encrypt',
  description: 'Password-protect a PDF with AES-256 (or AES-128 for old viewers). userPassword is needed to open the file; ownerPassword unlocks the permission restrictions (printing, copying, modifying). Note that permission flags are only honoured by cooperating viewers — the user password is the real protection. Returns the encrypted PDF.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      userPassword: { type: 'string', description: 'Password required to open the document ("" or omitted = opens without a password, restrictions only)' },
      ownerPassword: { type: 'string', description: 'Password that lifts the restrictions (default: same as userPassword)' },
      algorithm: { type: 'string', enum: ['AES-256', 'AES-128'], default: 'AES-256', description: 'Cipher; AES-256 needs a PDF 1.7 ext. 3 / 2.0 capable reader (anything from the last decade)' },
      allowPrinting: { type: 'boolean', default: true, description: 'Permission flag: printing' },
      allowCopying: { type: 'boolean', default: true, description: 'Permission flag: copying text and images' },
      allowModifying: { type: 'boolean', default: false, description: 'Permission flag: editing content, annotating, filling forms' },
      password: { type: 'string', description: 'Current password, if the input is already encrypted' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.encrypted.pdf)' },
    },
    required: ['input'],
  },
  examples: ['pdf.encrypt input=doc.pdf userPassword=s3cret'],
  async run(a) {
    if (!a.userPassword && !a.ownerPassword) throw new Error('give userPassword (needed to open the file) and/or ownerPassword (restrictions only)');
    const { L, doc } = await openLib(a.input, a.password);
    try { doc.encrypt({ userPassword: a.userPassword || '', ownerPassword: a.ownerPassword || a.userPassword, algorithm: a.algorithm, permissions: { printing: a.allowPrinting ? 'highResolution' : false, copying: a.allowCopying, modifying: a.allowModifying, annotating: a.allowModifying, fillingForms: a.allowModifying, contentAccessibility: true, documentAssembly: a.allowModifying } }); } catch (e) { throw new Error(`encryption failed: ${e.message}`); }
    // pdf-lib encrypts stream data (object streams included) but leaves strings in objects written outside object
    // streams — stream dictionaries, the catalog, page nodes — in clear text, which readers then "decrypt" into garbage.
    // Encrypt those strings here so the file is conformant (ISO 32000 §7.6.2).
    const ctx = doc.context; const sec = ctx.security; let strings = 0;
    const hex = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0'); return s; };
    const seal = (o, fn) => {
      const one = (v, put) => { if (v instanceof L.PDFString || v instanceof L.PDFHexString) { put(L.PDFHexString.of(hex(fn(v.asBytes())))); strings++; } else if (v instanceof L.PDFDict || v instanceof L.PDFArray) seal(v, fn); };
      if (o instanceof L.PDFDict) for (const [k, v] of o.entries()) one(v, (x) => o.set(k, x)); else if (o instanceof L.PDFArray) for (let i = 0; i < o.size(); i++) one(o.get(i), (x) => o.set(i, x));
    };
    if (sec?.getEncryptFn) for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (ref === ctx.trailerInfo.Encrypt) continue;
      const isStream = obj instanceof L.PDFStream;
      if (!(isStream || obj instanceof L.PDFCatalog || obj instanceof L.PDFPageTree || obj instanceof L.PDFPageLeaf || ref.generationNumber !== 0)) continue;
      if (!isStream && obj.get(L.PDFName.of('Type')) === L.PDFName.of('Sig')) continue;
      seal(isStream ? obj.dict : obj, sec.getEncryptFn(ref.objectNumber, ref.generationNumber));
    }
    const output = await savePdf(doc, vfs.out(a.output, a.input, 'encrypted', 'pdf'));
    return { output, algorithm: a.algorithm, needsPasswordToOpen: !!a.userPassword, permissions: { printing: a.allowPrinting, copying: a.allowCopying, modifying: a.allowModifying } };
  },
});

register({
  name: 'pdf.decrypt',
  description: 'Remove password protection from a PDF you have the password for, writing an unencrypted copy that every other tool (and every viewer) can open without a password. Files that are only permission-restricted (open without a password) need no password here.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the encrypted PDF' },
      password: { type: 'string', description: 'User or owner password (omit for files that open without one)' },
      output: { type: 'string', description: 'VFS path to write (default: <input>.decrypted.pdf)' },
    },
    required: ['input'],
  },
  examples: ['pdf.decrypt input=locked.pdf password=s3cret'],
  async run(a) {
    const { L, doc, wasEncrypted } = await openLib(a.input, a.password);
    const output = await savePdf(doc, vfs.out(a.output, a.input, 'decrypted', 'pdf'));
    // prove it: both libraries must open the result without a password
    const head = await withJs(output.path, undefined, async ({ doc: d }) => ({ pages: d.numPages, enc: !!(await d.getMetadata()).info?.EncryptFilterName }));
    let reopens = true; try { await L.PDFDocument.load(vfs.read(output.path), { updateMetadata: false }); } catch { reopens = false; }
    if (head.enc || !reopens) { vfs.rm(output.path); throw new Error('the output is still encrypted — this file uses a scheme the library cannot remove'); }
    return { output, wasEncrypted, pages: head.pages, note: wasEncrypted ? undefined : 'The input was not encrypted; the output is a plain re-save.' };
  },
});

// ────────────────────────────────────────────────────────── previewer ──
M.registerPreviewer((stat) => stat.mime === PDF_MIME, async (stat, el) => {
  el.textContent = '';
  const cap = document.createElement('div'); cap.style.cssText = 'font:12px/1.4 ui-monospace,monospace;opacity:.75;margin:0 0 6px'; cap.textContent = `${stat.path} — loading…`;
  const canvasBox = document.createElement('div'); el.append(cap, canvasBox);
  try {
    await withJs(stat.path, undefined, async ({ pdfjs, doc }) => {
      const page = await doc.getPage(1); const base = page.getViewport({ scale: 1 });
      const cssW = clamp(el.clientWidth || 800, 200, 1600); const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
      const canvas = await renderPage(page, { scale: Math.min((cssW * dpr) / base.width, 4) }, pdfjs);
      canvas.style.cssText = 'max-width:100%;height:auto;display:block;background:#fff;box-shadow:0 0 0 1px rgba(128,128,128,.4)';
      canvasBox.append(canvas);
      cap.textContent = `${stat.path} — page 1 of ${doc.numPages} · ${Math.round(base.width)} × ${Math.round(base.height)} pt · ${M.human(stat.bytes)}`;
    });
  } catch (e) { cap.textContent = `${stat.path} — cannot preview: ${e.message}`; }
});
