// Format readers for doc.*: sniffing, zip containers, and one converter per document type, all ending in Markdown.
import { M, vfs } from '../core.js';
import * as H from './html.js';
import * as S from './subs.js';
import { shiftHeadings } from './text.js';

// ───────────────────────────────────────────────────────── libraries ──
let fflateP; let mammothP;
export const fflate = () => (fflateP ||= import(new URL('../../vendor/fflate/fflate.js', import.meta.url)).catch((e) => { fflateP = null; throw new Error(`could not load vendored fflate (web/vendor/fflate/fflate.js): ${e.message}`); }));
const mammothLib = () => (mammothP ||= M.loadScript(new URL('../../vendor/mammoth/mammoth.browser.min.js', import.meta.url)).then(() => { if (!globalThis.mammoth) throw new Error('mammoth global missing'); return globalThis.mammoth; }).catch((e) => { mammothP = null; throw new Error(`could not load vendored mammoth: ${e.message}`); }));

// ──────────────────────────────────────────────────────────── bytes ──
export function decodeText(bytes, hint) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (hint) { try { return new TextDecoder(hint).decode(bytes); } catch { /* unknown label \u2192 fall through */ } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}
export function decodeHtmlBytes(bytes) {
  const head = binStr(bytes.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_:-]+)/i.exec(head) || /<\?xml[^>]+encoding\s*=\s*["']([A-Za-z0-9_:-]+)/i.exec(head);
  return decodeText(bytes, m && !/^utf-?8$/i.test(m[1]) ? m[1] : undefined);
}
export function binStr(bytes) { let s = ''; const C = 0x8000; for (let i = 0; i < bytes.length; i += C) s += String.fromCharCode.apply(null, bytes.subarray(i, i + C)); return s; }
const binBytes = (s) => { const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff; return out; };
const IMG_MAGIC = [[[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x47, 0x49, 0x46, 0x38], 'image/gif'], [[0x42, 0x4d], 'image/bmp'], [[0x52, 0x49, 0x46, 0x46], 'image/webp'], [[0x49, 0x49, 0x2a, 0], 'image/tiff'], [[0x4d, 0x4d, 0, 0x2a], 'image/tiff']];
const EXTRA_MIME = { emf: 'image/x-emf', wmf: 'image/x-wmf', jfif: 'image/jpeg', svgz: 'image/svg+xml', xhtml: 'application/xhtml+xml', opf: 'application/oebps-package+xml', ncx: 'application/x-dtbncx+xml', eml: 'message/rfc822', mbox: 'application/mbox', rtf: 'application/rtf', ipynb: 'application/x-ipynb+json', epub: 'application/epub+zip', odt: 'application/vnd.oasis.opendocument.text', odp: 'application/vnd.oasis.opendocument.presentation', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
export const mimeFor = (name, bytes) => {
  if (bytes) for (const [sig, mime] of IMG_MAGIC) if (sig.every((b, i) => bytes[i] === b)) return mime;
  const m = vfs.mimeOf(name); return m !== 'application/octet-stream' ? m : EXTRA_MIME[vfs.extOf(name)] || m;
};
const EXT_FOR = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/x-emf': 'emf', 'image/x-wmf': 'wmf', 'application/pdf': 'pdf', 'text/plain': 'txt', 'text/html': 'html', 'message/rfc822': 'eml' };
export const extFor = (mime) => EXT_FOR[(mime || '').split(';')[0].trim().toLowerCase()] || vfs.extForMime(mime);

// ────────────────────────────────────────────────────────────── zip ──
export async function openZip(bytes) {
  const { unzipSync } = await fflate();
  const entries = new Map();
  try { unzipSync(bytes, { filter: (f) => { if (!f.name.endsWith('/')) entries.set(f.name, { size: f.originalSize, compressed: f.size }); return false; } }); } catch (e) { throw new Error(`not a readable zip container: ${e.message || e}`); }
  const cache = new Map();
  const z = {
    entries, names: [...entries.keys()], has: (n) => entries.has(n),
    readMany(names) { const want = new Set(names.filter((n) => entries.has(n) && !cache.has(n))); if (want.size) { const got = unzipSync(bytes, { filter: (f) => want.has(f.name) }); for (const k in got) cache.set(k, got[k]); } return names.map((n) => cache.get(n) || null); },
    read(n) { if (!entries.has(n)) return null; return z.readMany([n])[0]; },
    text(n) { const b = z.read(n); return b ? decodeText(b) : null; },
    xml(n) { const t = z.text(n); return t ? parseXml(t, n) : null; },
    drop(n) { cache.delete(n); },
  };
  return z;
}
export function parseXml(text, label = 'xml') {
  const d = new DOMParser().parseFromString(text.replace(/^\ufeff/, ''), 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error(`malformed XML in ${label}`);
  return d;
}
const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const desc = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
const attr = (el, name) => { if (!el) return null; for (const a of el.attributes) if (a.localName === name) return a.value; return null; };
const zipJoin = (base, rel) => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return null;
  const parts = rel.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const p of rel.split(/[?#]/)[0].split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
  let out = parts.join('/'); try { out = decodeURIComponent(out); } catch { /* keep raw */ }
  return out;
};
function relsOf(zip, partPath) {
  const dir = partPath.split('/').slice(0, -1).join('/'); const file = partPath.split('/').pop();
  const x = zip.xml(`${dir ? dir + '/' : ''}_rels/${file}.rels`); const map = new Map();
  if (x) for (const r of desc(x, 'Relationship')) { const ext = r.getAttribute('TargetMode') === 'External'; const t = r.getAttribute('Target') || ''; map.set(r.getAttribute('Id'), { type: (r.getAttribute('Type') || '').split('/').pop(), target: ext ? t : zipJoin(partPath, t), external: ext }); }
  return map;
}

// ──────────────────────────────────────────────────────────── sniff ──
const TEXT_EXT = { md: 'markdown', markdown: 'markdown', mdown: 'markdown', txt: 'text', text: 'text', log: 'text', rst: 'text', org: 'text', html: 'html', htm: 'html', xhtml: 'html', ipynb: 'ipynb', srt: 'srt', vtt: 'vtt', eml: 'eml', mbox: 'mbox', rtf: 'rtf' };
const OTHER = {
  pdf: ['pdf.toMarkdown', 'PDF is handled by the pdf.* family'], xlsx: ['data.convert', 'spreadsheets are handled by the data.* family'], xls: ['data.convert', 'spreadsheets are handled by the data.* family'], ods: ['data.convert', 'spreadsheets are handled by the data.* family'],
  csv: ['data.convert', 'tabular data is handled by the data.* family'], tsv: ['data.convert', 'tabular data is handled by the data.* family'], json: ['data.convert', 'structured data is handled by the data.* family'], jsonl: ['data.convert', 'structured data is handled by the data.* family'], ndjson: ['data.convert', 'structured data is handled by the data.* family'],
  yaml: ['data.convert', 'structured data is handled by the data.* family'], yml: ['data.convert', 'structured data is handled by the data.* family'], toml: ['data.convert', 'structured data is handled by the data.* family'], xml: ['data.convert', 'generic XML is handled by the data.* family'],
  zip: ['data.unzip', 'plain zip archives are handled by the data.* family'], image: ['vision.ocr', 'images need OCR (vision.* / image.* families)'], audio: ['audio.transcribe', 'audio needs transcription (audio.* family)'], video: ['video.info', 'video is handled by the video.* family'],
  legacy: [null, 'legacy binary Office files (.doc/.ppt/.xls, OLE2) are not supported in the browser \u2014 re-save as .docx/.pptx/.xlsx'],
};
export const SUPPORTED = 'docx, pptx, odt, odp, epub, html, ipynb, rtf, eml, mbox, md, txt, srt, vtt';
function hint(kind) {
  const [tool, why] = OTHER[kind] || [null, null]; if (!why) return null;
  const domain = tool ? tool.split('.')[0] : null;
  const present = tool && M.tools.has(tool);
  const alt = !present && domain ? [...M.tools.keys()].filter((n) => n.startsWith(domain + '.')).slice(0, 12) : [];
  return { tool: present ? tool : null, note: `${why}${tool ? (present ? ` \u2014 use ${tool}` : alt.length ? ` \u2014 ${tool} is not registered here; ${domain}.* tools available: ${alt.join(', ')}` : ` \u2014 no ${domain}.* tools are loaded in this page`) : ''}` };
}
/** \u2192 {type, family:'doc'|'other', zip?, text?, bytes, suggest?} \u2014 type is one of SUPPORTED or a foreign kind (pdf, xlsx, \u2026) */
export async function sniff(path) {
  const bytes = vfs.read(path); const ext = vfs.extOf(path);
  const out = { type: 'unknown', family: 'other', bytes, ext };
  const other = (kind, type = kind) => { out.type = type; out.suggest = hint(kind); return out; };
  if (bytes.length === 0) { out.type = 'empty'; return out; }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) {
    const zip = await openZip(bytes); out.zip = zip;
    const mt = zip.has('mimetype') ? (zip.text('mimetype') || '').trim() : '';
    const set = (t) => { out.type = t; out.family = 'doc'; return out; };
    if (zip.has('word/document.xml')) return set('docx');
    if (zip.has('ppt/presentation.xml')) return set('pptx');
    if (zip.has('xl/workbook.xml')) return other('xlsx');
    if (mt === 'application/epub+zip' || zip.has('META-INF/container.xml')) return set('epub');
    if (/opendocument\.text/.test(mt)) return set('odt');
    if (/opendocument\.presentation/.test(mt)) return set('odp');
    if (/opendocument\.spreadsheet/.test(mt)) return other('ods');
    if (zip.has('content.xml') && ext === 'odt') return set('odt');
    if (zip.has('content.xml') && ext === 'odp') return set('odp');
    return other('zip');
  }
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return other('pdf');
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return other('legacy', 'ole2');
  if (bytes[0] === 0x7b && bytes[1] === 0x5c && bytes[2] === 0x72 && bytes[3] === 0x74) { out.type = 'rtf'; out.family = 'doc'; return out; }
  const mime = mimeFor(path, bytes);
  if (/^image\//.test(mime) && !/svg/.test(mime)) return other('image');
  if (/^audio\//.test(mime)) return other('audio');
  if (/^video\//.test(mime)) return other('video');
  // binary?
  let nul = 0; const n = Math.min(bytes.length, 4096); for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
  if (nul > n / 100 && !utf16) { out.type = 'binary'; return out; }
  const doc = (t) => { out.type = t; out.family = 'doc'; return out; };
  const text = ext === 'html' || ext === 'htm' || ext === 'xhtml' ? decodeHtmlBytes(bytes) : decodeText(bytes); out.text = text;
  const head = text.slice(0, 3000).replace(/^\ufeff/, '');
  if (TEXT_EXT[ext] && !['text', 'markdown'].includes(TEXT_EXT[ext])) return doc(TEXT_EXT[ext]);
  if ((ext === 'json' || !ext) && /^\s*\{/.test(head) && /"cells"\s*:/.test(text.slice(0, 200000)) && /"nbformat"\s*:/.test(text)) return doc('ipynb');
  if (OTHER[ext] && !['image', 'audio', 'video', 'legacy'].includes(ext)) return other(ext);
  // content sniff (wrong or missing extension)
  if (/^\s*(<!doctype html|<html[\s>])/i.test(head) || (/^\s*<\?xml/.test(head) && /<html[\s>]/i.test(head))) { out.text = decodeHtmlBytes(bytes); return doc('html'); }
  if (S.sniffSubs(head)) return doc(S.sniffSubs(head));
  if (/^\s*\{/.test(head) && /"cells"\s*:/.test(text.slice(0, 200000)) && /"nbformat"\s*:/.test(text)) return doc('ipynb');
  if (/^From \S+.*\d{4}\r?\n/.test(head) && /\n(From|Subject|Date|Message-ID):/i.test(head)) return doc('mbox');
  if (!TEXT_EXT[ext] && /^(?:[A-Za-z][A-Za-z0-9-]*:[^\n]*\r?\n(?:[ \t][^\n]*\r?\n)*){2,}/.test(head) && /^(Received|From|Subject|MIME-Version|Return-Path|Delivered-To|Date|Message-ID):/im.test(head) && /^(From|To|Subject):/im.test(head)) return doc('eml');
  if (TEXT_EXT[ext]) return doc(TEXT_EXT[ext]);
  if (/^\s*<\?xml|^\s*<[A-Za-z][\w:-]*[\s>]/.test(head) && /<\/[\w:-]+>\s*$/.test(text.slice(-200))) return /<(p|div|body|h1|table)[\s>]/i.test(head) ? doc('html') : other('xml');
  if (/^\s*[[{]/.test(head)) { try { JSON.parse(text); return other('json'); } catch { /* not json */ } }
  return doc('text');
}

// ─────────────────────────────────────────────────────── image sink ──
const relPath = (fromFile, toFile) => {
  const a = fromFile.split('/').slice(0, -1); const b = toFile.split('/'); let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].map((s) => (s === '..' ? s : encodeURIComponent(s).replace(/%2F/gi, '/'))).join('/');
};
const safeName = (n) => (n || 'file').replace(/^.*[\\/]/, '').replace(/[^\p{L}\p{N}_.\-()+ ]+/gu, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
export function makeSink(mdPath, dir, dry = false) {
  dir = (dir || `${mdPath.replace(/\.[A-Za-z0-9]+$/, '')}_media`).replace(/\/+$/, '');
  const used = new Set(); const byKey = new Map(); const outputs = [];
  return {
    dir, outputs,
    /** write once per key; \u2192 relative link from the markdown file */
    async put(name, bytes, mime, key) {
      if (key && byKey.has(key)) return byKey.get(key);
      name = safeName(name); if (!vfs.extOf(name) && mime) name += '.' + extFor(mime);
      let n = name; let i = 1; while (used.has(n.toLowerCase())) { const e = vfs.extOf(name); n = `${name.replace(/\.[A-Za-z0-9]+$/, '')}-${++i}${e ? '.' + e : ''}`; }
      used.add(n.toLowerCase());
      const path = `${dir}/${n}`; const link = relPath(mdPath, path);
      if (dry) outputs.push({ path, mime: mime || mimeFor(n, bytes), bytes: bytes.length, notWritten: true });
      else outputs.push(await vfs.write(path, bytes, { mime: mime && mime !== 'application/octet-stream' ? mime : mimeFor(n, bytes) }));
      if (key) byKey.set(key, link);
      return link;
    },
  };
}
const parseDataUri = (src) => { const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(src); if (!m) return null; try { const b64 = /;base64/i.test(m[2]); const bytes = b64 ? M.b64.dec(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])); return { bytes, mime: m[1] || 'application/octet-stream' }; } catch { return null; } };
/** Apply the images policy to a DOM: extract | inline | alt | drop. resolve(src) \u2192 {bytes, mime, name, key}|null for container-internal images. */
async function applyImages(root, c, resolve) {
  let n = 0;
  await H.rewriteImages(root, async (src) => {
    if (c.images === 'drop') return null;
    if (c.images === 'alt') return { alt: true };
    let r = null;
    if (/^data:/i.test(src)) { r = parseDataUri(src); if (r) { r.name = `image-${++n}.${extFor(r.mime)}`; } else return null; } else if (resolve) r = await resolve(src);
    if (!r) return src || null;
    if (c.images === 'inline') return `data:${r.mime};base64,${M.b64.enc(r.bytes)}`;
    return c.sink.put(r.name, r.bytes, r.mime, r.key);
  });
}

// ─────────────────────────────────────────────────── inline markdown ──
export const escMd = (s) => s.replace(/([\\`*_[\]<])/g, '\\$1');
const escLine = (s) => s.replace(/^(\s*)(#{1,6}\s|[-+>]\s|\d+[.)]\s)/, (m, sp, x) => `${sp}\\${x}`);
/** runs: [{text, bold, italic, strike, code, href, br}] \u2192 markdown, merging equal neighbours and keeping spaces outside markers */
export function runsToMd(runs) {
  const merged = [];
  for (const r of runs) {
    if (r.br) { merged.push({ br: true }); continue; }
    if (!r.text) continue;
    const p = merged[merged.length - 1];
    if (p && !p.br && !!p.bold === !!r.bold && !!p.italic === !!r.italic && !!p.strike === !!r.strike && !!p.code === !!r.code && (p.href || '') === (r.href || '')) p.text += r.text; else merged.push({ ...r });
  }
  let out = '';
  for (const r of merged) {
    if (r.br) { out = out.replace(/[ \t]+$/, '') + '  \n'; continue; }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text); let core = m[2]; if (!core) { out += r.text; continue; }
    if (r.code) core = '`' + core.replace(/`/g, "'") + '`'; else core = escMd(core);
    if (r.bold && r.italic) core = `***${core}***`; else if (r.bold) core = `**${core}**`; else if (r.italic) core = `*${core}*`;
    if (r.strike) core = `~~${core}~~`;
    if (r.href) core = `[${core}](${r.href.replace(/\s/g, '%20').replace(/([()])/g, '\\$1')})`;
    out += m[1] + core + m[3];
  }
  return out.replace(/\*\*\*\*/g, '').trim();
}
const cellMd = (s) => s.replace(/\s*\n\s*/g, '<br>').trim();
const tableMd = (rows) => { const width = Math.max(0, ...rows.map((r) => r.length)); if (!width) return ''; const grid = rows.map((r) => { const g = r.map(cellMd); while (g.length < width) g.push(''); return g; }); return H.gridToMarkdown(grid, width); };

// ───────────────────────────────────────────────────────── OOXML meta ──
export function ooxmlMeta(zip) {
  const meta = {};
  const core = zip.xml('docProps/core.xml');
  if (core) { const g = (n) => desc(core, n)[0]?.textContent.trim() || undefined; Object.assign(meta, { title: g('title'), author: g('creator'), subject: g('subject'), keywords: g('keywords'), description: g('description'), lastModifiedBy: g('lastModifiedBy'), created: g('created'), modified: g('modified'), revision: g('revision') }); }
  const app = zip.xml('docProps/app.xml');
  if (app) { const g = (n) => desc(app, n)[0]?.textContent.trim() || undefined; const num = (n) => { const v = parseInt(g(n) || '', 10); return Number.isFinite(v) ? v : undefined; }; Object.assign(meta, { application: g('Application'), pagesStored: num('Pages'), company: g('Company') }); }
  for (const k of Object.keys(meta)) if (meta[k] === undefined || meta[k] === '') delete meta[k];
  return meta;
}

// ───────────────────────────────────────────────────────────── docx ──
const DOCX_STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => p:fresh",
  ...['Source Code', 'Code', 'Code Block', 'HTML Preformatted', 'Preformatted Text', 'macro'].map((s) => `p[style-name='${s}'] => pre:separator('\\n')`),
  ...['Verbatim Char', 'Source Text', 'Code Char', 'HTML Code', 'Inline Code', 'Source Code Char'].map((s) => `r[style-name='${s}'] => code`),
  ...['Quote', 'Intense Quote', 'Block Text', 'Block Quote', 'Quotations'].map((s) => `p[style-name='${s}'] => blockquote > p:fresh`),
  "p[style-name='Horizontal Line'] => hr", 'strike => del',
];
export async function docxToHtml(bytes, { images = true } = {}) {
  const mammoth = await mammothLib();
  const store = new Map(); let n = 0;
  const options = {
    styleMap: DOCX_STYLE_MAP,
    convertImage: mammoth.images.imgElement(async (image) => {
      if (!images) return { src: '' };
      const buf = new Uint8Array(await image.readAsArrayBuffer()); const key = `mu-docx-image:${++n}`;
      store.set(key, { bytes: buf, mime: image.contentType || mimeFor('', buf), name: `image${n}.${extFor(image.contentType || mimeFor('', buf))}`, key });
      return { src: key };
    }),
  };
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  let res;
  try { res = await mammoth.convertToHtml({ arrayBuffer: ab }, options); } catch (e) { throw new Error(`docx could not be read (${e.message || e}) \u2014 is the file a valid, unencrypted .docx?`); }
  const warnings = [...new Set(res.messages.map((m) => m.message))].slice(0, 20);
  return { html: res.value, store, warnings };
}
async function docxToMd(s, c) {
  const { html, store, warnings } = await docxToHtml(s.bytes, { images: c.images !== 'drop' });
  const doc = H.parseHtml(html);
  for (const pre of doc.querySelectorAll('pre')) for (const br of pre.querySelectorAll('br')) br.replaceWith('\n');
  await applyImages(doc.body, c, (src) => store.get(src) || null);
  for (const w of warnings) c.warn(w);
  const meta = ooxmlMeta(s.zip);
  return { markdown: await H.domToMarkdown(doc.body, c), title: meta.title || doc.querySelector('h1')?.textContent.trim() || null, meta };
}

// ───────────────────────────────────────────────────────────── pptx ──
function pptxRuns(p, rels) {
  const runs = [];
  for (const el of p.children) {
    if (el.localName === 'br') runs.push({ br: true });
    else if (el.localName === 'r' || el.localName === 'fld') {
      const rPr = kid(el, 'rPr'); const text = kids(el, 't').map((t) => t.textContent).join('');
      const link = rPr ? kid(rPr, 'hlinkClick') : null; const rel = link ? rels.get(attr(link, 'id')) : null;
      const font = rPr ? attr(kid(rPr, 'latin'), 'typeface') || '' : '';
      runs.push({ text, bold: rPr?.getAttribute('b') === '1' || rPr?.getAttribute('b') === 'true', italic: rPr?.getAttribute('i') === '1' || rPr?.getAttribute('i') === 'true', strike: /Strike/.test(rPr?.getAttribute('strike') || '') && rPr.getAttribute('strike') !== 'noStrike', code: /^(Courier|Consolas|Menlo|Monaco|.*\bMono\b)/i.test(font), href: rel && rel.external ? rel.target : undefined });
    }
  }
  return runs;
}
function pptxTextBody(txBody, rels, bulletsDefault) {
  const lines = []; let counters = [];
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr'); const lvl = Math.min(8, parseInt(pPr?.getAttribute('lvl') || '0', 10) || 0);
    const text = runsToMd(pptxRuns(p, rels));
    if (!text) { lines.push({ blank: true }); continue; }
    let bullet = bulletsDefault; let numbered = false;
    if (pPr) { if (kid(pPr, 'buNone')) bullet = false; else if (kid(pPr, 'buAutoNum')) { bullet = true; numbered = true; } else if (kid(pPr, 'buChar') || kid(pPr, 'buBlip')) bullet = true; }
    if (bullet || lvl > 0) {
      counters = counters.slice(0, lvl + 1); counters[lvl] = (counters[lvl] || 0) + 1;
      lines.push({ list: `${'  '.repeat(lvl) + (numbered ? ' '.repeat(lvl) : '')}${numbered ? `${counters[lvl]}.` : '-'} ${text.replace(/ {2}\n/g, ' ')}` });
    } else { counters = []; lines.push({ para: escLine(text) }); }
  }
  let out = ''; let prev = null;
  for (const l of lines) {
    if (l.blank) { prev = null; continue; }
    if (l.list) out += (prev === 'list' ? '\n' : out ? '\n\n' : '') + l.list; else out += (out ? '\n\n' : '') + l.para;
    prev = l.list ? 'list' : 'para';
  }
  return out;
}
const SKIP_PH = new Set(['sldNum', 'dt', 'ftr', 'hdr', 'sldImg']);
async function pptxShapes(tree, rels, c, zip, slideNo, out) {
  for (const el of tree.children) {
    const n = el.localName;
    if (n === 'grpSp') { await pptxShapes(el, rels, c, zip, slideNo, out); continue; }
    if (n === 'AlternateContent') { const ch = kid(el, 'Choice') || kid(el, 'Fallback'); if (ch) await pptxShapes(ch, rels, c, zip, slideNo, out); continue; }
    if (n === 'sp') {
      const ph = desc(kid(el, 'nvSpPr'), 'ph')[0]; const type = ph ? ph.getAttribute('type') || 'body' : null;
      if (type && SKIP_PH.has(type)) continue;
      const tx = kid(el, 'txBody'); if (!tx) continue;
      if (type === 'title' || type === 'ctrTitle') { const t = kids(tx, 'p').map((p) => runsToMd(pptxRuns(p, rels).map((r) => (r.br ? { text: ' ' } : { text: r.text })))).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); if (t && !out.title) { out.title = t; continue; } }
      const md = pptxTextBody(tx, rels, !!ph && type !== 'subTitle' && type !== 'title' && type !== 'ctrTitle');
      if (md) out.blocks.push(md);
    } else if (n === 'pic') {
      const blip = desc(el, 'blip')[0]; const rid = blip ? attr(blip, 'embed') || attr(blip, 'link') : null; const rel = rid ? rels.get(rid) : null;
      const cNv = desc(kid(el, 'nvPicPr'), 'cNvPr')[0]; const alt = (cNv?.getAttribute('descr') || '').replace(/\s+/g, ' ').trim();
      const media = desc(kid(el, 'nvPicPr'), 'videoFile')[0] || desc(kid(el, 'nvPicPr'), 'audioFile')[0];
      if (media) c.warn(`slide ${slideNo}: embedded audio/video is not converted (list it with doc.media)`);
      if (!rel) continue;
      out.images++;
      if (c.images === 'drop') continue;
      if (c.images === 'alt') { if (alt) out.blocks.push(`[image: ${escMd(alt)}]`); continue; }
      if (rel.external) { out.blocks.push(`![${escMd(alt)}](${rel.target})`); continue; }
      const bytes = zip.read(rel.target); if (!bytes) continue;
      const mime = mimeFor(rel.target, bytes); const name = rel.target.split('/').pop();
      const link = c.images === 'inline' ? `data:${mime};base64,${M.b64.enc(bytes)}` : await c.sink.put(name, bytes, mime, rel.target);
      out.blocks.push(`![${escMd(alt)}](${link})`);
    } else if (n === 'graphicFrame') {
      const tbl = desc(el, 'tbl')[0];
      if (tbl) {
        const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => { const tx = kid(tc, 'txBody'); return tx ? kids(tx, 'p').map((p) => runsToMd(pptxRuns(p, rels))).filter(Boolean).join('\n') : ''; }));
        if (c.tables === 'drop') continue;
        const md = c.tables === 'csv' ? '```csv\n' + rows.map((r) => r.map((x) => (/[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(',')).join('\n') + '\n```' : tableMd(rows);
        if (md) out.blocks.push(md);
      } else {
        const uri = desc(el, 'graphicData')[0]?.getAttribute('uri') || ''; const kind = /chart/.test(uri) ? 'chart' : /diagram/.test(uri) ? 'SmartArt diagram' : /ole/.test(uri) ? 'embedded object' : 'graphic';
        const name = desc(kid(el, 'nvGraphicFramePr'), 'cNvPr')[0]?.getAttribute('name') || '';
        out.blocks.push(`*[${kind}${name ? `: ${escMd(name)}` : ''} \u2014 not converted]*`); c.warn(`slide ${slideNo}: ${kind} not converted`);
      }
    }
  }
}
export function pptxSlideList(zip) {
  const pres = zip.xml('ppt/presentation.xml'); const rels = relsOf(zip, 'ppt/presentation.xml');
  const ids = desc(pres, 'sldId').map((s) => rels.get(attr(s, 'id'))?.target).filter((t) => t && zip.has(t));
  return ids.length ? ids : zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
}
async function pptxToMd(s, c) {
  const zip = s.zip; const slides = pptxSlideList(zip); const meta = ooxmlMeta(zip); const parts = []; let withNotes = 0; let hidden = 0;
  for (let i = 0; i < slides.length; i++) {
    const x = zip.xml(slides[i]); const rels = relsOf(zip, slides[i]);
    const out = { title: null, blocks: [], images: 0 };
    const tree = desc(x, 'spTree')[0]; if (tree) await pptxShapes(tree, rels, c, zip, i + 1, out);
    const isHidden = x.documentElement.getAttribute('show') === '0'; if (isHidden) hidden++;
    let md = `## Slide ${i + 1}${isHidden ? ' (hidden)' : ''}${out.title ? `: ${out.title}` : ''}`;
    if (out.blocks.length) md += '\n\n' + out.blocks.join('\n\n');
    if (c.notes) {
      const nrel = [...rels.values()].find((r) => r.type === 'notesSlide');
      const nx = nrel ? zip.xml(nrel.target) : null;
      if (nx) {
        const nrels = relsOf(zip, nrel.target); const bodies = [];
        for (const sp of desc(nx, 'sp')) { const ph = desc(kid(sp, 'nvSpPr'), 'ph')[0]; if (!ph || ph.getAttribute('type') !== 'body') continue; const tx = kid(sp, 'txBody'); const t = tx ? pptxTextBody(tx, nrels, false) : ''; if (t) bodies.push(t); }
        if (bodies.length) { withNotes++; md += `\n\n**Speaker notes:**\n\n${bodies.join('\n\n')}`; }
      }
    }
    parts.push(md); zip.drop(slides[i]);
    c.progress?.((i + 1) / slides.length, `slide ${i + 1}/${slides.length}`);
  }
  const title = meta.title || null;
  return { markdown: (title ? `# ${escMd(title)}\n\n` : '') + parts.join('\n\n') + '\n', title, meta: { ...meta, slides: slides.length, slidesWithNotes: withNotes, hiddenSlides: hidden } };
}

// ──────────────────────────────────────────────────────── odt / odp ──
function odfStyles(zip, content) {
  const styles = new Map(); const lists = new Map();
  const scan = (doc) => {
    if (!doc) return;
    for (const st of desc(doc, 'style')) {
      const name = attr(st, 'name'); if (!name) continue; const tp = kid(st, 'text-properties'); const e = { parent: attr(st, 'parent-style-name') };
      if (tp) { e.bold = /bold|[6-9]00/.test(attr(tp, 'font-weight') || ''); e.italic = /italic|oblique/.test(attr(tp, 'font-style') || ''); e.strike = !!attr(tp, 'text-line-through-style') && attr(tp, 'text-line-through-style') !== 'none'; e.mono = /courier|mono|consolas/i.test(attr(tp, 'font-name') || ''); }
      styles.set(name, e);
    }
    for (const ls of desc(doc, 'list-style')) { const lv = new Map(); for (const ch of ls.children) { const l = parseInt(attr(ch, 'level') || '1', 10); lv.set(l, ch.localName === 'list-level-style-number'); } lists.set(attr(ls, 'name'), lv); }
  };
  scan(zip.xml('styles.xml')); scan(content);
  const resolve = (name, seen = 0) => { const s = styles.get(name); if (!s) return {}; const p = s.parent && seen < 8 ? resolve(s.parent, seen + 1) : {}; return { bold: s.bold ?? p.bold, italic: s.italic ?? p.italic, strike: s.strike ?? p.strike, mono: s.mono ?? p.mono, name, parentName: s.parent }; };
  return { resolve, lists };
}
async function odfToMd(s, c) {
  const zip = s.zip; const content = zip.xml('content.xml'); if (!content) throw new Error('OpenDocument file has no content.xml');
  const st = odfStyles(zip, content); const notes = []; let images = 0; const out = [];
  const inline = async (el, fmt, runs) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { runs.push({ ...fmt, text: n.nodeValue }); continue; }
      if (n.nodeType !== 1) continue;
      const ln = n.localName;
      if (ln === 's') runs.push({ ...fmt, text: ' '.repeat(parseInt(attr(n, 'c') || '1', 10) || 1) });
      else if (ln === 'tab') runs.push({ ...fmt, text: '\t' });
      else if (ln === 'line-break') runs.push({ br: true });
      else if (ln === 'span') { const r = st.resolve(attr(n, 'style-name')); await inline(n, { ...fmt, bold: fmt.bold || r.bold, italic: fmt.italic || r.italic, strike: fmt.strike || r.strike, code: fmt.code || r.mono || /source|code|teletype/i.test(`${r.name} ${r.parentName}`) }, runs); } else if (ln === 'a') await inline(n, { ...fmt, href: attr(n, 'href') || undefined }, runs);
      else if (ln === 'note') { const body = kid(n, 'note-body'); const t = []; for (const p of desc(body, 'p')) { const r = []; await inline(p, {}, r); t.push(runsToMd(r)); } notes.push(t.join(' ')); runs.push({ text: `\u0001FN${notes.length}\u0001` }); } else if (ln === 'frame') { const md = await frame(n); if (md) runs.push({ text: `\u0001RAW${md}\u0001` }); } else if (ln === 'annotation' || ln === 'annotation-end' || ln === 'bookmark' || ln === 'bookmark-start' || ln === 'bookmark-end' || ln === 'soft-page-break') { /* skip */ } else await inline(n, fmt, runs);
    }
  };
  const finish = (md) => md.replace(/\\?\u0001FN(\d+)\\?\u0001/g, '[^$1]').replace(/\u0001RAW([\s\S]*?)\u0001/g, (m, raw) => raw.replace(/\\([\\`*_[\]<])/g, '$1'));
  const frame = async (f) => {
    const img = kid(f, 'image'); const tb = kid(f, 'text-box');
    if (tb) { const sub = []; await blocks(tb, sub, 0); return sub.join(' '); }
    if (!img) return '';
    images++;
    const href = attr(img, 'href') || ''; const alt = (kid(f, 'title')?.textContent || kid(f, 'desc')?.textContent || attr(f, 'name') || '').replace(/\s+/g, ' ').trim();
    if (c.images === 'drop') return '';
    if (c.images === 'alt') return alt ? `[image: ${alt}]` : '';
    const p = zipJoin('content.xml', href); const bytes = p ? zip.read(p) : null;
    if (!bytes) return /^https?:/.test(href) ? `![${alt}](${href})` : '';
    const mime = mimeFor(p, bytes);
    const link = c.images === 'inline' ? `data:${mime};base64,${M.b64.enc(bytes)}` : await c.sink.put(p.split('/').pop(), bytes, mime, p);
    return `![${alt.replace(/[[\]]/g, '')}](${link})`;
  };
  const para = async (p) => { const runs = []; const ps = st.resolve(attr(p, 'style-name')); const code = /preformatted|source|code/i.test(`${ps.name} ${ps.parentName}`); await inline(p, {}, runs); return { md: finish(runsToMd(runs)), code, quote: /quot/i.test(`${ps.name} ${ps.parentName}`), text: code ? p.textContent : null }; };
  const list = async (l, depth, styleName, sink) => {
    styleName = attr(l, 'style-name') || styleName; const numbered = st.lists.get(styleName)?.get(depth + 1) || false; let i = 0;
    for (const item of l.children) {
      if (item.localName !== 'list-item' && item.localName !== 'list-header') continue;
      i++; let first = true;
      for (const ch of item.children) {
        if (ch.localName === 'p' || ch.localName === 'h') { const { md } = await para(ch); if (!md) continue; const ind = '  '.repeat(depth) + (numbered ? ' '.repeat(depth) : ''); sink.push(first ? `${ind}${numbered ? `${i}.` : '-'} ${md.replace(/ {2}\n/g, ' ')}` : `${ind}  ${md.replace(/ {2}\n/g, ' ')}`); first = false; } else if (ch.localName === 'list') await list(ch, depth + 1, styleName, sink);
      }
    }
  };
  const table = async (t) => {
    const rows = [];
    for (const tr of desc(t, 'table-row')) {
      if (tr.closest && [...desc(t, 'table')].some((inner) => inner.contains(tr))) continue;
      const row = []; const rep = Math.min(parseInt(attr(tr, 'number-rows-repeated') || '1', 10) || 1, 50);
      for (const tc of tr.children) {
        if (tc.localName !== 'table-cell' && tc.localName !== 'covered-table-cell') continue;
        const sub = []; await blocks(tc, sub, 0); const text = sub.join('\n');
        const n = Math.min(parseInt(attr(tc, 'number-columns-repeated') || '1', 10) || 1, text ? 50 : 1);
        for (let i = 0; i < n; i++) row.push(text);
      }
      if (row.some(Boolean)) for (let i = 0; i < rep; i++) rows.push(row);
    }
    return c.tables === 'drop' ? '' : tableMd(rows);
  };
  async function blocks(parent, sink, depth) {
    let codeBuf = null;
    const flushCode = () => { if (codeBuf) { sink.push('```\n' + codeBuf.join('\n') + '\n```'); codeBuf = null; } };
    for (const el of parent.children) {
      const ln = el.localName;
      if (ln === 'p') { const r = await para(el); if (r.code && r.text.trim()) { (codeBuf ||= []).push(r.text); continue; } flushCode(); if (r.md) sink.push(r.quote ? r.md.split('\n').map((x) => `> ${x}`).join('\n') : escLine(r.md)); } else {
        flushCode();
        if (ln === 'h') { const { md } = await para(el); const lvl = Math.max(1, Math.min(6, parseInt(attr(el, 'outline-level') || '1', 10) || 1)); if (md) sink.push(`${'#'.repeat(lvl)} ${md.replace(/\s*\n\s*/g, ' ')}`); } else if (ln === 'list') { const items = []; await list(el, 0, null, items); if (items.length) sink.push(items.join('\n')); } else if (ln === 'table') { const md = await table(el); if (md) sink.push(md); } else if (ln === 'section' || ln === 'text-box' || ln === 'index-body' || ln === 'table-of-content') await blocks(el, sink, depth); else if (ln === 'frame') { const md = await frame(el); if (md) sink.push(md); } else if (ln === 'g' || ln === 'custom-shape' || ln === 'rect' || ln === 'ellipse') await blocks(el, sink, depth);
      }
    }
    flushCode();
  }
  const metaDoc = zip.xml('meta.xml'); const meta = {};
  if (metaDoc) { const g = (n) => desc(metaDoc, n)[0]?.textContent.trim() || undefined; Object.assign(meta, { title: g('title'), author: g('initial-creator') || g('creator'), subject: g('subject'), description: g('description'), created: g('creation-date'), modified: g('date'), application: g('generator') }); const stat = desc(metaDoc, 'document-statistic')[0]; if (stat) { for (const [k, a] of [['pages', 'page-count'], ['words', 'word-count'], ['characters', 'character-count'], ['tables', 'table-count'], ['paragraphs', 'paragraph-count']]) { const v = parseInt(attr(stat, a) || '', 10); if (Number.isFinite(v)) meta[k] = v; } } for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k]; }
  if (s.type === 'odp') {
    const pages = desc(content, 'page'); let withNotes = 0;
    for (let i = 0; i < pages.length; i++) {
      let title = ''; const body = []; const notesMd = [];
      for (const f of pages[i].children) {
        if (f.localName === 'notes') { for (const nf of desc(f, 'frame')) { if (attr(nf, 'class') !== 'notes') continue; const sub = []; const tb = kid(nf, 'text-box'); if (tb) await blocks(tb, sub, 0); notesMd.push(...sub); } continue; }
        if (f.localName !== 'frame') { const sub = []; await blocks(f, sub, 0); body.push(...sub); continue; }
        const cls = attr(f, 'class'); const tb = kid(f, 'text-box');
        if (cls === 'title' && tb && !title) { title = tb.textContent.replace(/\s+/g, ' ').trim(); continue; }
        if (tb) await blocks(tb, body, 0); else { const tbl = kid(f, 'table'); if (tbl) { const md = await table(tbl); if (md) body.push(md); } else { const md = await frame(f); if (md) body.push(md); } }
      }
      let md = `## Slide ${i + 1}${title ? `: ${escMd(title)}` : ''}`; if (body.length) md += '\n\n' + body.join('\n\n');
      if (c.notes && notesMd.length) { withNotes++; md += `\n\n**Speaker notes:**\n\n${notesMd.join('\n\n')}`; }
      out.push(md);
    }
    meta.slides = pages.length; meta.slidesWithNotes = withNotes;
  } else {
    const text = desc(content, 'text').find((e) => e.parentElement?.localName === 'body') || desc(content, 'body')[0];
    await blocks(text, out, 0);
  }
  let md = (s.type === 'odp' && meta.title ? `# ${escMd(meta.title)}\n\n` : '') + out.join('\n\n');
  if (notes.length) md += '\n\n' + notes.map((n, i) => `[^${i + 1}]: ${n}`).join('\n');
  meta.images = images;
  return { markdown: md + '\n', title: meta.title || null, meta };
}

// ───────────────────────────────────────────────────────────── epub ──
export function epubPackage(zip) {
  const cont = zip.xml('META-INF/container.xml');
  const opfPath = cont ? attr(desc(cont, 'rootfile')[0], 'full-path') : zip.names.find((n) => n.endsWith('.opf'));
  const opf = opfPath ? zip.xml(opfPath) : null; if (!opf) throw new Error('epub has no package document (.opf)');
  const md = desc(opf, 'metadata')[0]; const g = (n) => desc(md, n)[0]?.textContent.trim() || undefined; const all = (n) => desc(md, n).map((e) => e.textContent.trim()).filter(Boolean);
  const meta = { title: g('title'), author: all('creator').join(', ') || undefined, language: g('language'), publisher: g('publisher'), published: g('date'), identifier: g('identifier'), description: g('description'), subjects: all('subject').slice(0, 20) };
  if (!meta.subjects.length) delete meta.subjects;
  const modified = kids(md, 'meta').find((m) => m.getAttribute('property') === 'dcterms:modified'); if (modified) meta.modified = modified.textContent.trim();
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  const manifest = new Map();
  for (const it of desc(opf, 'item')) manifest.set(it.getAttribute('id'), { href: zipJoin(opfPath, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
  const spine = desc(opf, 'itemref').map((r) => ({ ...manifest.get(r.getAttribute('idref')), linear: r.getAttribute('linear') !== 'no' })).filter((x) => x.href);
  return { opfPath, meta, manifest, spine };
}
async function epubToMd(s, c) {
  const zip = s.zip; const pkg = epubPackage(zip); const parts = []; let chapters = 0;
  const docs = pkg.spine.filter((it) => /html|xml/.test(it.type) || /\.x?html?$/i.test(it.href));
  for (let i = 0; i < docs.length; i++) {
    const it = docs[i];
    if (/\bnav\b/.test(it.props)) continue;
    const bytes = zip.read(it.href); if (!bytes) { c.warn(`spine item missing from archive: ${it.href}`); continue; }
    const doc = H.parseXhtml(decodeHtmlBytes(bytes)); H.cleanDom(doc.body);
    await applyImages(doc.body, c, (src) => { const p = zipJoin(it.href, src); const b = p ? zip.read(p) : null; return b ? { bytes: b, mime: mimeFor(p, b), name: p.split('/').pop(), key: p } : null; });
    // links between chapters cannot survive a single-file conversion: keep only their text
    for (const a of doc.body.querySelectorAll('a[href]')) { const h = a.getAttribute('href'); if (!/^[a-z][a-z0-9+.-]*:/i.test(h)) a.removeAttribute('href'); }
    const md = (await H.domToMarkdown(doc.body, c)).trim();
    if (md) { parts.push(md); chapters++; }
    zip.drop(it.href);
    c.progress?.((i + 1) / docs.length, `chapter ${i + 1}/${docs.length}`);
  }
  return { markdown: parts.join('\n\n') + '\n', title: pkg.meta.title || null, meta: { ...pkg.meta, spineItems: pkg.spine.length, chapters } };
}

// ───────────────────────────────────────────────────────────── html ──
export async function htmlToMd(text, c) {
  const doc = H.parseHtml(text);
  const base = H.effectiveBase(doc, c.baseUrl);
  const title = (doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || '').replace(/\s+/g, ' ').trim() || null;
  H.cleanDom(doc.body); H.fixLazyImages(doc.body);
  // "permalink" anchors wrapped around or placed inside headings are noise in Markdown
  for (const a of doc.body.querySelectorAll('h1 a[href^="#"], h2 a[href^="#"], h3 a[href^="#"], h4 a[href^="#"], h5 a[href^="#"], h6 a[href^="#"]')) { if (/^[#\u00b6\u00a7\ud83d\udd17\s]*$/u.test(a.textContent)) a.remove(); else a.replaceWith(...a.childNodes); }
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const h1s = [...doc.body.querySelectorAll('h1')].map((h) => norm(h.textContent)).filter(Boolean);
  let root = doc.body; let main = null;
  if (c.mainContentOnly) { const r = H.pickMain(doc); root = r.el; main = r.info; }
  const rewritten = H.absolutize(root, base);
  await applyImages(root, c, null);
  let md = await H.domToMarkdown(root, c);
  if (c.mainContentOnly && !root.querySelector('h1')) {
    // the page's own H1 often sits outside the article container: put the title back unless a heading already says it
    const want = h1s.length === 1 && (!title || title.toLowerCase().includes(h1s[0].toLowerCase())) ? h1s[0] : title || h1s[0]; const have = [...root.querySelectorAll('h2, h3')].map((h) => norm(h.textContent).toLowerCase());
    if (want && !have.some((h) => h && (h === want.toLowerCase() || want.toLowerCase().startsWith(h)))) { md = `# ${escMd(want)}\n\n${md}`; main.titleAdded = want; }
  }
  const meta = { lang: doc.documentElement.getAttribute('lang') || undefined, description: doc.querySelector('meta[name="description"]')?.getAttribute('content') || undefined, urlsRewritten: base ? rewritten : undefined, baseUrl: base || undefined };
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  return { markdown: md, title: title || root.querySelector('h1')?.textContent.replace(/\s+/g, ' ').trim() || null, meta, mainContent: main };
}

// ──────────────────────────────────────────────────────────── ipynb ──
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const joinSrc = (v) => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');
async function ipynbToMd(s, c) {
  let nb; try { nb = JSON.parse(s.text ?? decodeText(s.bytes)); } catch (e) { throw new Error(`notebook is not valid JSON: ${e.message}`); }
  const cells = nb.cells || (nb.worksheets || []).flatMap((w) => w.cells || []);
  if (!Array.isArray(cells)) throw new Error('notebook has no "cells" array (nbformat 3/4 expected)');
  const lang = nb.metadata?.language_info?.name || nb.metadata?.kernelspec?.language || (nb.metadata?.kernelspec?.name || '').replace(/\d+$/, '') || '';
  const parts = []; const count = { markdown: 0, code: 0, raw: 0, outputs: 0, images: 0 }; const cap = c.maxOutputChars;
  const clip = (t) => { t = stripAnsi(t).replace(/\s+$/, ''); if (cap && t.length > cap) { c.warn(`an output was cut to ${cap} characters (raise maxOutputChars to keep more)`); return `${t.slice(0, cap)}\n\u2026 [output truncated: ${t.length - cap} more characters]`; } return t; };
  const fence = (t, l = '') => { let f = '```'; while (t.includes(f)) f += '`'; return `${f}${l}\n${t}\n${f}`; };
  const image = async (b64OrText, mime, name) => {
    count.images++;
    if (c.images === 'drop') return '';
    if (c.images === 'alt') return `[image output: ${mime}]`;
    const isSvg = /svg/.test(mime); const data = joinSrc(b64OrText);
    if (c.images === 'inline') return `![output](data:${mime};base64,${isSvg ? M.b64.enc(new TextEncoder().encode(data)) : data.replace(/\s+/g, '')})`;
    let bytes; try { bytes = isSvg ? new TextEncoder().encode(data) : M.b64.dec(data); } catch { c.warn(`an ${mime} output had invalid base64 and was skipped`); return ''; }
    return `![output](${await c.sink.put(name, bytes, mime)})`;
  };
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]; const src = joinSrc(cell.source ?? cell.input);
    if (cell.cell_type === 'markdown' || cell.cell_type === 'heading') {
      count.markdown++; let md = cell.cell_type === 'heading' ? `${'#'.repeat(cell.level || 1)} ${src}` : src;
      if (cell.attachments) { for (const [name, bundle] of Object.entries(cell.attachments)) { const mime = Object.keys(bundle)[0]; if (!mime) continue; const link = await image(bundle[mime], mime, `cell${i + 1}-${name}`); md = md.split(`attachment:${name}`).join(link ? link.replace(/^!\[[^\]]*\]\(|\)$/g, '') : ''); } }
      if (md.trim()) parts.push(md.trim());
    } else if (cell.cell_type === 'code') {
      count.code++;
      const magic = /^%%(\w+)/.exec(src); const l = magic ? ({ bash: 'bash', sh: 'bash', html: 'html', javascript: 'javascript', js: 'javascript', sql: 'sql', latex: 'latex', writefile: '' }[magic[1]] ?? lang) : lang;
      if (src.trim()) parts.push(fence(src.replace(/\s+$/, ''), l));
      let k = 0; let stream = null;
      const flush = () => { if (stream) { parts.push(fence(clip(stream.text), 'text')); stream = null; } };
      for (const o of cell.outputs || []) {
        count.outputs++; k++;
        const type = o.output_type;
        if (type === 'stream') { const t = joinSrc(o.text); if (stream) stream.text += t; else stream = { text: t }; continue; }
        flush();
        if (type === 'error' || type === 'pyerr') { parts.push(fence(clip((o.traceback || []).join('\n') || `${o.ename}: ${o.evalue}`), 'text')); continue; }
        const data = o.data || o; // nbformat 3 keeps mime keys at top level
        const imgMime = ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml'].find((m) => data[m]) || (data.png ? 'png' : data.jpeg ? 'jpeg' : null);
        if (imgMime) { const mime = imgMime.includes('/') ? imgMime : `image/${imgMime}`; const md = await image(data[imgMime], mime, `cell${i + 1}-output${k}.${extFor(mime)}`); if (md) parts.push(md); if (!data['text/markdown'] && !data['text/latex']) continue; }
        if (data['text/markdown']) parts.push(joinSrc(data['text/markdown']).trim());
        else if (data['text/latex']) parts.push(joinSrc(data['text/latex']).trim());
        else if (data['text/html'] && /<table/i.test(joinSrc(data['text/html'])) && c.tables !== 'drop') { const d = H.parseHtml(joinSrc(data['text/html'])); H.cleanDom(d.body); const md = (await H.domToMarkdown(d.body, { ...c, images: 'drop' })).trim(); if (md) parts.push(cap && md.length > cap * 2 ? fence(clip(joinSrc(data['text/plain'] || md)), 'text') : md); } else if (data['text/plain'] || data.text) parts.push(fence(clip(joinSrc(data['text/plain'] || data.text)), 'text'));
        else if (data['application/json']) parts.push(fence(clip(JSON.stringify(data['application/json'], null, 1)), 'json'));
      }
      flush();
    } else if (src.trim()) { count.raw++; parts.push(fence(src.replace(/\s+$/, ''))); }
  }
  const title = nb.metadata?.title || (/^#\s+(.+)$/m.exec(parts.find((p) => /^#\s/.test(p)) || '') || [])[1] || null;
  return { markdown: parts.join('\n\n') + '\n', title, meta: { nbformat: `${nb.nbformat ?? '?'}.${nb.nbformat_minor ?? 0}`, kernel: nb.metadata?.kernelspec?.display_name || nb.metadata?.kernelspec?.name || undefined, language: lang || undefined, cells: cells.length, markdownCells: count.markdown, codeCells: count.code, rawCells: count.raw, outputs: count.outputs, imageOutputs: count.images } };
}

// ────────────────────────────────────────────────────────────── rtf ──
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'pict', 'object', 'objdata', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'generator', 'listtable', 'listoverridetable', 'rsidtbl', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'revtbl', 'filetbl', 'operator', 'creatim', 'revtim', 'printim', 'buptim', 'company', 'manager', 'category', 'keywords', 'comment', 'doccomm', 'hlinkbase', 'nonshppict', 'bkmkstart', 'bkmkend', 'template', 'passwordhash', 'userprops', 'xe', 'tc', 'annotation', 'atnid', 'atnauthor', 'atrfstart', 'atrfend', 'falt', 'panose', 'fname', 'wgrffmtfilter', 'shpinst', 'sp', 'sn', 'sv', 'pnseclvl', 'listpicture', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc']);
const RTF_CP = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 65001: 'utf-8', 437: 'ibm866', 850: 'windows-1252' };
const RTF_SYM = { tab: '\t', emdash: '\u2014', endash: '\u2013', bullet: '\u2022', lquote: '\u2018', rquote: '\u2019', ldblquote: '\u201c', rdblquote: '\u201d', emspace: ' ', enspace: ' ', qmspace: ' ', '~': '\u00a0', _: '-' };
export function rtfToMd(bytes, c = {}) {
  const src = binStr(bytes); const n = src.length; let i = 0;
  let decoder = new TextDecoder('windows-1252'); const meta = {}; const styles = new Map();
  const stack = []; let st = { skip: false, bold: false, italic: false, strike: false, uc: 1, dest: null, href: null };
  const blocks = []; let runs = []; let para = { level: 0, intbl: false, list: false }; let row = []; let table = [];
  let pending = []; let skipChars = 0; let fieldUrl = null; let styleCur = null; let styleName = '';
  const flushBytes = () => { if (pending.length) { const t = decoder.decode(new Uint8Array(pending)); pending = []; emit(t); } };
  const emit = (t) => {
    if (st.skip) return;
    if (st.dest === 'title' || st.dest === 'author' || st.dest === 'subject') { meta[st.dest] = (meta[st.dest] || '') + t; return; }
    if (st.dest === 'info') return;
    if (st.dest === 'stylesheet') { styleName += t; return; }
    if (st.dest === 'fldinst') { st.inst.text += t; return; }
    runs.push({ text: t, bold: st.bold, italic: st.italic, strike: st.strike, href: st.href || undefined });
  };
  const flushTable = () => { if (table.length) { const md = tableMd(table); if (md && c.tables !== 'drop') blocks.push(md); table = []; } };
  const endPara = () => {
    flushBytes();
    if (para.intbl) { if (runs.length) runs.push({ br: true }); return ''; } // cell text is collected by \cell
    const md = runsToMd(runs); runs = [];
    flushTable();
    if (md) blocks.push(para.level ? `${'#'.repeat(Math.min(6, para.level))} ${md.replace(/\s*\n\s*/g, ' ').replace(/^\*\*(.*)\*\*$/, '$1')}` : para.list ? `- ${md.replace(/^(?:[\u2022\u00b7o*-]|\d+[.)])\s+/, '')}` : escLine(md));
    para.list = false;
    return md;
  };
  while (i < n) {
    const ch = src[i];
    if (ch === '{') {
      flushBytes(); stack.push(st);
      st = { ...st, fieldRoot: false, instOwner: false, star: false, sheetRoot: false, styleEntry: !!st.sheetRoot };
      if (st.styleEntry) { styleCur = 0; styleName = ''; }
      i++; continue;
    }
    if (ch === '}') {
      flushBytes();
      const closing = st; st = stack.pop() || st;
      if (closing.styleEntry && styleCur !== null) styles.set(styleCur, styleName.replace(/;\s*$/, '').trim());
      if (closing.instOwner) { const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/.exec(closing.inst.text); fieldUrl = m ? m[1] : null; }
      if (closing.fieldRoot) fieldUrl = null;
      i++; continue;
    }
    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === "'") { const b = parseInt(src.substr(i + 2, 2), 16); i += 4; if (skipChars > 0) { skipChars--; continue; } if (!Number.isNaN(b)) { if (st.skip) continue; pending.push(b); } continue; }
      if (/[a-zA-Z]/.test(nx || '')) {
        let j = i + 1; while (j < n && /[a-zA-Z]/.test(src[j])) j++;
        const word = src.slice(i + 1, j); let k = j; if (src[k] === '-') k++; while (k < n && src[k] >= '0' && src[k] <= '9') k++;
        const hasNum = k > j && !(k === j + 1 && src[j] === '-'); const num = hasNum ? parseInt(src.slice(j, k), 10) : null; if (!hasNum) k = j;
        if (src[k] === ' ') k++;
        i = k;
        if (word === 'u' && hasNum) { flushBytes(); if (!st.skip) emit(String.fromCharCode(num < 0 ? num + 65536 : num)); skipChars = st.uc; continue; }
        if (word === 'bin' && hasNum) { i += Math.max(0, num); continue; }
        flushBytes(); skipChars = 0;
        if (word === 'uc') { st.uc = num ?? 1; continue; }
        if (word === 'ansicpg' && num) { try { decoder = new TextDecoder(RTF_CP[num] || `windows-${num}`); } catch { /* keep 1252 */ } continue; }
        if (st.star) { st.star = false; if (!['fldinst', 'pn', 'pntext', 'listtext'].includes(word)) { st.skip = true; continue; } }
        if (RTF_SKIP.has(word) || word === 'footnote') { st.skip = true; continue; }
        if (word === 'info') { st.dest = 'info'; continue; }
        if (st.dest === 'info') { if (['title', 'author', 'subject'].includes(word)) st.dest = word; else if (word === 'nofpages' && hasNum) meta.pages = String(num); else if (word === 'nofwords' && hasNum) meta.words = String(num); continue; }
        if (word === 'stylesheet') { st.dest = 'stylesheet'; st.sheetRoot = true; continue; }
        if (st.dest === 'stylesheet') { if (word === 's' && hasNum) styleCur = num; else if ((word === 'cs' || word === 'ds' || word === 'ts') && hasNum) styleCur = null; continue; }
        if (word === 'field') { st.fieldRoot = true; continue; }
        if (word === 'fldinst') { st.dest = 'fldinst'; st.inst = { text: '' }; st.instOwner = true; continue; }
        if (word === 'fldrslt') { st.dest = null; st.href = fieldUrl; continue; }
        if (word === 'pntext' || word === 'listtext') { para.list = true; st.skip = true; continue; }
        if (st.skip) continue;
        switch (word) {
          case 'par': case 'sect': case 'page': endPara(); break;
          case 'line': runs.push({ br: true }); break;
          case 'pard': para = { level: 0, intbl: false, list: para.list && !runs.length }; break;
          case 'plain': st.bold = st.italic = st.strike = false; break;
          case 'b': st.bold = num !== 0; break;
          case 'i': st.italic = num !== 0; break;
          case 'strike': st.strike = num !== 0; break;
          case 'outlinelevel': if (num !== null && num >= 0 && num < 6) para.level = num + 1; break;
          case 's': { const nm = styles.get(num) || ''; const m = /^heading (\d)/i.exec(nm); if (m) para.level = +m[1]; else if (/^title$/i.test(nm)) para.level = 1; else if (/list (bullet|paragraph|number)/i.test(nm)) para.list = true; break; }
          case 'ls': case 'ilvl': if (word === 'ls' && num > 0) para.list = true; break;
          case 'intbl': para.intbl = true; break;
          case 'cell': { flushBytes(); const md = runsToMd(runs); runs = []; row.push(md); break; }
          case 'row': if (row.length) { table.push(row); row = []; } para.intbl = false; break;
          default: if (RTF_SYM[word] !== undefined) emit(RTF_SYM[word]);
        }
        continue;
      }
      // control symbol
      i += 2;
      if (nx === '*') { st.star = true; continue; }
      if (nx === '\\' || nx === '{' || nx === '}') { if (skipChars > 0) { skipChars--; continue; } flushBytes(); emit(nx); continue; }
      if (nx === '\n' || nx === '\r') { flushBytes(); if (!st.skip) endPara(); continue; }
      if (RTF_SYM[nx] !== undefined) { flushBytes(); emit(RTF_SYM[nx]); }
      continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    i++;
    if (skipChars > 0) { skipChars--; continue; }
    if (st.skip) continue;
    const code = ch.charCodeAt(0);
    if (code < 0x80 && !pending.length) {
      // fast path: gather a run of plain ASCII
      let j = i; while (j < n) { const d = src.charCodeAt(j); if (d === 0x5c || d === 0x7b || d === 0x7d || d === 10 || d === 13 || d >= 0x80) break; j++; }
      emit(ch + src.slice(i, j)); i = j;
    } else pending.push(code);
  }
  endPara(); if (row.length) table.push(row); flushTable();
  // join consecutive list items / keep blocks apart
  let md = ''; let prevList = false;
  for (const b of blocks) { const isList = /^- /.test(b); md += (md ? (isList && prevList ? '\n' : '\n\n') : '') + b; prevList = isList; }
  for (const k of Object.keys(meta)) meta[k] = meta[k].replace(/\s+/g, ' ').trim();
  return { markdown: md + '\n', title: meta.title || null, meta };
}

// ───────────────────────────────────────────────────────── eml / mbox ──
function decodeWords(s) {
  s = s.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?)/g, '$1');
  return s.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (all, cs, enc, data) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? M.b64.dec(data) : binBytes(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
      return new TextDecoder(cs.split('*')[0]).decode(bytes);
    } catch { return all; }
  });
}
function parseHeaders(block) {
  const map = new Map(); const order = [];
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([^\s:]+):\s?(.*)$/.exec(line); if (!m) continue;
    let v = m[2]; if (/[\u0080-\u00ff]/.test(v)) { try { v = new TextDecoder('utf-8', { fatal: true }).decode(binBytes(v)); } catch { /* keep latin1 */ } }
    v = decodeWords(v).trim(); const k = m[1].toLowerCase();
    if (!map.has(k)) map.set(k, v); order.push([m[1], v]);
  }
  return { map, order };
}
function parseParams(v) {
  const out = { value: (v || '').split(';')[0].trim().toLowerCase(), params: {} }; const cont = {};
  for (const m of (v || '').matchAll(/;\s*([\w.*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g)) {
    let k = m[1].toLowerCase(); let val = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
    const star = /^(.*?)(?:\*(\d+))?(\*)?$/.exec(k); k = star[1];
    if (star[3]) { const mm = /^([^']*)'[^']*'(.*)$/.exec(val); let cs = 'utf-8'; if (mm) { cs = mm[1] || 'utf-8'; val = mm[2]; } try { val = new TextDecoder(cs).decode(binBytes(val.replace(/%([0-9A-Fa-f]{2})/g, (x, h) => String.fromCharCode(parseInt(h, 16))))); } catch { /* raw */ } }
    if (star[2] !== undefined) { (cont[k] ||= [])[+star[2]] = val; } else out.params[k] = val;
  }
  for (const k in cont) out.params[k] = cont[k].join('');
  return out;
}
function decodeBody(bin, enc) {
  enc = (enc || '').trim().toLowerCase();
  if (enc === 'base64') { try { return M.b64.dec(bin.replace(/[^A-Za-z0-9+/=]/g, '')); } catch { return binBytes(bin); } }
  if (enc === 'quoted-printable') return binBytes(bin.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
  return binBytes(bin);
}
function parseMime(bin, depth = 0) {
  const m = /\r?\n\r?\n/.exec(bin); const headBlock = m ? bin.slice(0, m.index) : bin; const body = m ? bin.slice(m.index + m[0].length) : '';
  const h = parseHeaders(headBlock); const ct = parseParams(h.map.get('content-type') || 'text/plain'); const cd = parseParams(h.map.get('content-disposition') || '');
  const part = { headers: h, type: ct.value || 'text/plain', params: ct.params, disposition: cd.value, filename: decodeWords(cd.params.filename || ct.params.name || '') || null, cid: (h.map.get('content-id') || '').replace(/^<|>$/g, '') || null, parts: [] };
  if (/^multipart\//.test(part.type) && ct.params.boundary && depth < 12) {
    const b = ct.params.boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const segs = body.split(new RegExp(`(?:^|\\r?\\n)--${b}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    for (let i = 1; i < segs.length; i++) { if (!segs[i].trim() && i === segs.length - 1) continue; if (segs[i].length) part.parts.push(parseMime(segs[i], depth + 1)); }
  } else part.bytes = decodeBody(body, h.map.get('content-transfer-encoding'));
  return part;
}
async function messageToMd(bin, c, prefix, level = 1) {
  const root = parseMime(bin); const texts = []; const htmls = []; const files = [];
  const walk = (p, inAlt) => {
    if (p.parts.length) { for (const q of p.parts) walk(q, inAlt || p.type === 'multipart/alternative'); return; }
    const isAtt = p.disposition === 'attachment' || (p.filename && !/^text\/(plain|html)$/.test(p.type)) || !/^text\/(plain|html)$/.test(p.type);
    if (isAtt) { if (p.bytes && (p.bytes.length || p.filename)) files.push(p); return; }
    const text = decodeText(p.bytes, p.params.charset);
    if (p.type === 'text/html') htmls.push(text); else texts.push(p.params.format === 'flowed' ? text.replace(/ \r?\n/g, ' ') : text);
  };
  walk(root, false);
  const H0 = root.headers.map; const subject = H0.get('subject') || '(no subject)';
  const lines = [`${'#'.repeat(level)} ${escMd(subject)}`, ''];
  for (const k of ['From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Date']) { const v = H0.get(k.toLowerCase()); if (v) lines.push(`- **${k}:** ${escMd(v)}`); }
  const cidLinks = new Map(); const attLines = []; const attachments = [];
  let ai = 0;
  for (const f of files) {
    ai++; const name = f.filename || `${f.cid ? 'inline' : 'attachment'}-${ai}.${extFor(f.type)}`; const isImg = /^image\//.test(f.type);
    const entry = { name, mime: f.type, bytes: f.bytes.length, inline: !!f.cid && f.disposition !== 'attachment' };
    if (c.attachments === 'extract' && !(isImg && entry.inline && (c.images === 'drop' || c.images === 'alt'))) { const link = await c.sink.put(prefix + name, f.bytes, f.type); entry.link = link; if (f.cid) cidLinks.set(f.cid, link); }
    attachments.push(entry);
    attLines.push(`- ${entry.link ? `[${escMd(name)}](${entry.link})` : escMd(name)} (${f.type}, ${M.human(f.bytes.length)})`);
  }
  let body = ''; let used = 'none';
  const useHtml = htmls.length && (c.emailBody === 'html' || (c.emailBody === 'auto' && !texts.some((t) => t.trim())));
  if (useHtml) {
    const doc = H.parseHtml(htmls.join('\n<hr>\n')); H.cleanDom(doc.body);
    await applyImages(doc.body, c, null);
    for (const img of doc.body.querySelectorAll('img[src^="cid:"]')) { const l = cidLinks.get(img.getAttribute('src').slice(4)); if (l) img.setAttribute('src', l); else img.remove(); }
    body = (await H.domToMarkdown(doc.body, c)).trim(); used = 'text/html';
  } else if (texts.length) { body = texts.join('\n\n').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); used = 'text/plain'; }
  let md = lines.join('\n') + (body ? `\n\n${body}` : '');
  if (attLines.length) md += `\n\n**Attachments:**\n\n${attLines.join('\n')}`;
  return { markdown: md, subject, from: H0.get('from') || null, to: H0.get('to') || null, date: H0.get('date') || null, messageId: H0.get('message-id') || null, attachments, bodyFrom: used };
}
export function splitMbox(bin) {
  const out = []; const re = /(?:^|\n)From [^\n]*\n/g; let m; let last = -1;
  while ((m = re.exec(bin))) { if (last >= 0) out.push(bin.slice(last, m.index)); last = m.index + m[0].length; }
  if (last >= 0) out.push(bin.slice(last));
  return out.map((s) => s.replace(/\n>(>*From )/g, '\n$1'));
}
async function emailToMd(s, c) {
  const bin = binStr(s.bytes);
  if (s.type === 'eml') { const r = await messageToMd(bin, c, ''); return { markdown: r.markdown + '\n', title: r.subject, meta: { from: r.from, to: r.to, date: r.date, messageId: r.messageId, bodyFrom: r.bodyFrom, attachments: r.attachments.length, attachmentList: r.attachments.slice(0, 30) } }; }
  const msgs = splitMbox(bin); const max = c.maxMessages || 200; const parts = []; let att = 0; const subjects = [];
  for (let i = 0; i < Math.min(msgs.length, max); i++) { const r = await messageToMd(msgs[i], c, `msg${i + 1}-`, 1); parts.push(r.markdown); att += r.attachments.length; if (subjects.length < 20) subjects.push(r.subject); c.progress?.((i + 1) / Math.min(msgs.length, max), `message ${i + 1}`); }
  if (msgs.length > max) c.warn(`mbox holds ${msgs.length} messages; only the first ${max} were converted (raise maxMessages)`);
  return { markdown: parts.join('\n\n---\n\n') + '\n', title: null, meta: { messages: msgs.length, converted: parts.length, attachments: att, subjects } };
}
export async function emailInfo(s) {
  const bin = binStr(s.bytes);
  if (s.type === 'mbox') { const msgs = splitMbox(bin); return { messages: msgs.length, subjects: msgs.slice(0, 20).map((m) => parseHeaders(m.split(/\r?\n\r?\n/)[0]).map.get('subject') || '(no subject)') }; }
  const r = await messageToMd(bin, { attachments: 'list', images: 'drop', emailBody: 'text', tables: 'markdown', warn() {} }, '');
  return { title: r.subject, from: r.from, to: r.to, date: r.date, messageId: r.messageId, attachments: r.attachments.length, attachmentList: r.attachments.slice(0, 30) };
}

// ───────────────────────────────────────────────────────── dispatcher ──
export function unsupported(s, path, toolName) {
  const sug = s.suggest;
  if (s.type === 'empty') return new Error(`"${path}" is empty (0 bytes)`);
  if (sug) return new Error(`${toolName} cannot convert "${path}" (detected: ${s.type}): ${sug.note}. ${toolName} accepts: ${SUPPORTED}.`);
  return new Error(`${toolName} cannot convert "${path}" (detected: ${s.type}${s.type === 'binary' ? ' data of unknown format' : ''}). Accepted: ${SUPPORTED}. For PDF use pdf.*, for spreadsheets/CSV/JSON use data.*.`);
}
/**
 * convert(path, opts) \u2192 {type, markdown, title, meta, warnings, outputs (extracted files), mainContent?}
 * opts: {mdPath, images, imagesDir, tables, headingOffset, timestamps, notes, mainContentOnly, baseUrl, maxOutputChars, attachments, emailBody, maxMessages, dry, type}
 */
export async function convert(path, opts = {}, ctx) {
  const s = await sniff(path);
  if (opts.type && opts.type !== 'auto' && opts.type !== s.type) {
    const zipType = ['docx', 'pptx', 'odt', 'odp', 'epub'].includes(opts.type);
    if (zipType !== !!s.zip) throw new Error(`type=${opts.type} was forced but "${path}" ${s.zip ? 'is a zip container' : 'is not a zip container'} (detected: ${s.type})`);
    s.type = opts.type; s.family = 'doc'; delete s.suggest;
  }
  if (s.family !== 'doc') throw unsupported(s, path, opts.tool || 'doc.toMarkdown');
  const warnings = [];
  const mdPath = opts.mdPath || `${vfs.stemOf(path)}.md`;
  const c = {
    images: opts.images || 'extract', tables: opts.tables || 'markdown', notes: opts.notes !== false, timestamps: opts.timestamps || 'collapse', mainContentOnly: !!opts.mainContentOnly, baseUrl: opts.baseUrl || null,
    maxOutputChars: opts.maxOutputChars ?? 4000, attachments: opts.attachments || 'extract', emailBody: opts.emailBody || 'auto', maxMessages: opts.maxMessages, stripLinks: !!opts.stripLinks,
    sink: makeSink(mdPath, opts.imagesDir, !!opts.dry), warn: (w) => { if (warnings.length < 30 && !warnings.includes(w)) warnings.push(w); }, progress: ctx?.progress,
  };
  let r;
  switch (s.type) {
    case 'docx': r = await docxToMd(s, c); break;
    case 'pptx': r = await pptxToMd(s, c); break;
    case 'odt': case 'odp': r = await odfToMd(s, c); break;
    case 'epub': r = await epubToMd(s, c); break;
    case 'html': r = await htmlToMd(s.text ?? decodeHtmlBytes(s.bytes), c); break;
    case 'ipynb': r = await ipynbToMd(s, c); break;
    case 'rtf': r = rtfToMd(s.bytes, c); break;
    case 'eml': case 'mbox': r = await emailToMd(s, c); break;
    case 'srt': case 'vtt': { const p = S.parseSubs(s.text ?? decodeText(s.bytes)); if (!p.cues.length) throw new Error(`no subtitle cues found in "${path}" (expected SRT or WebVTT timing lines like 00:00:01,000 --> 00:00:04,000)`); r = { markdown: S.toTranscript(p.cues, { timestamps: c.timestamps, markdown: true }), title: null, meta: { cues: p.cues.length, durationSeconds: +(p.cues[p.cues.length - 1].end / 1000).toFixed(3), skippedBlocks: p.skipped } }; break; }
    case 'markdown': r = { markdown: (s.text ?? decodeText(s.bytes)).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'), title: null, meta: {} }; r.title = (/^#\s+(.+)$/m.exec(r.markdown) || [])[1] || null; break;
    case 'text': r = { markdown: (s.text ?? decodeText(s.bytes)).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n'), title: null, meta: { note: 'plain text passed through unchanged (no Markdown escaping applied)' } }; break;
    default: throw unsupported(s, path, opts.tool || 'doc.toMarkdown');
  }
  let md = r.markdown.replace(/\n{3,}/g, '\n\n');
  if (opts.headingOffset) md = shiftHeadings(md, opts.headingOffset);
  if (md && !md.endsWith('\n')) md += '\n';
  return { type: s.type, markdown: md, title: r.title || null, meta: r.meta || {}, mainContent: r.mainContent || undefined, warnings, outputs: c.sink.outputs };
}
