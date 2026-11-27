// data/formats — table model, format sniffing, readers and writers for csv/tsv/json/jsonl/yaml/toml/xml/markdown/html/xlsx.
// A table is {columns: string[], rows: any[][]}. Cell values are JSON values: null, boolean, number, string, or nested object/array.
import { vfs } from '../core.js';

export const FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'yaml', 'toml', 'xml', 'markdown', 'html', 'xlsx'];
const EXT_FORMAT = { csv: 'csv', tsv: 'tsv', tab: 'tsv', json: 'json', geojson: 'json', jsonl: 'jsonl', ndjson: 'jsonl', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', xlsx: 'xlsx', xlsm: 'xlsx' };
export const FORMAT_EXT = { csv: 'csv', tsv: 'tsv', json: 'json', jsonl: 'jsonl', yaml: 'yaml', toml: 'toml', xml: 'xml', markdown: 'md', html: 'html', xlsx: 'xlsx' };
const DOC_FORMATS = new Set(['json', 'yaml', 'toml', 'xml']);
export const isDocFormat = (f) => DOC_FORMATS.has(f);

let yamlP, tomlP, xlsxP, fflateP;
export const libYaml = () => (yamlP ||= import(new URL('../../vendor/js-yaml/js-yaml.mjs', import.meta.url).href));
export const libToml = () => (tomlP ||= import(new URL('../../vendor/smol-toml/index.js', import.meta.url).href));
export const libFflate = () => (fflateP ||= import(new URL('../../vendor/fflate/fflate.js', import.meta.url).href));
export const libXlsx = () => (xlsxP ||= import(new URL('./xlsx.js', import.meta.url).href));

// ───────────────────────────────────────────────────────────── text ──
/** bytes → string, honouring a BOM (UTF-8, UTF-16 LE/BE); otherwise UTF-8 with a windows-1252 fallback when the bytes are not valid UTF-8. */
export function decodeText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

// ────────────────────────────────────────────────────────────── csv ──
/** RFC-4180 parser, tolerant of \r\n, \n and \r. Returns records of {v: string, q: wasQuoted}. Blank lines are skipped. */
export function parseDelimited(text, delim = ',') {
  const recs = []; let rec = []; let field = ''; let quoted = false; let inQ = false;
  const n = text.length; const d = delim.charCodeAt(0);
  const endField = () => { rec.push({ v: field, q: quoted }); field = ''; quoted = false; };
  const endRec = () => { endField(); if (!(rec.length === 1 && rec[0].v === '' && !rec[0].q)) recs.push(rec); rec = []; };
  let i = 0; let start = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (inQ) {
      if (c === 34) {
        if (text.charCodeAt(i + 1) === 34) { field += text.slice(start, i + 1); i += 2; start = i; continue; }
        field += text.slice(start, i); inQ = false; i++; start = i; continue;
      }
      i++; continue;
    }
    if (c === 34 && i === start && field === '' && !quoted) { inQ = true; quoted = true; i++; start = i; continue; }
    if (c === d) { field += text.slice(start, i); endField(); i++; start = i; continue; }
    if (c === 10 || c === 13) {
      field += text.slice(start, i); endRec();
      if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
      i++; start = i; continue;
    }
    i++;
  }
  field += text.slice(start, n);
  if (inQ) throw new Error('csv: unterminated quoted field (a " was opened and never closed)');
  if (field !== '' || quoted || rec.length) endRec();
  return recs;
}

/** Pick the delimiter (, ; tab |) that splits the first records into the most consistent, widest rows. Quote-aware. */
export function sniffDelimiter(text) {
  const sample = text.slice(0, 65536);
  let best = ','; let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    let recs;
    try { recs = parseDelimited(sample, d); } catch { try { recs = parseDelimited(sample.slice(0, sample.lastIndexOf('\n') + 1 || sample.length), d); } catch { continue; } }
    if (sample.length < text.length && recs.length > 1) recs.pop();
    recs = recs.slice(0, 50);
    if (!recs.length) continue;
    const counts = new Map(); for (const r of recs) counts.set(r.length, (counts.get(r.length) || 0) + 1);
    let mode = 1; let modeN = 0; for (const [k, v] of counts) if (v > modeN || (v === modeN && k > mode)) { mode = k; modeN = v; }
    if (mode < 2) continue;
    const score = (modeN / recs.length) * 1000 + mode;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

const NUM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const isNumText = (s) => NUM_RE.test(s) && !(/^-?\d{16,}$/.test(s)) && Number.isFinite(Number(s));
const BOOL_RE = /^(?:true|false)$/i;

/** Column-wise typing of text cells: a column becomes number/boolean only if every non-empty cell agrees (so "007" or mixed columns stay strings). */
export function inferColumns(rows, ncol) {
  for (let c = 0; c < ncol; c++) {
    let num = true; let bool = true; let any = false;
    for (const r of rows) {
      const v = r[c]; if (v === null || v === undefined || typeof v !== 'string') continue;
      const s = v.trim(); if (s === '') continue;
      any = true;
      if (num && !isNumText(s)) num = false;
      if (bool && !BOOL_RE.test(s)) bool = false;
      if (!num && !bool) break;
    }
    if (!any || (!num && !bool)) continue;
    for (const r of rows) { const v = r[c]; if (typeof v === 'string') r[c] = v.trim() === '' ? null : num ? Number(v) : v.trim().toLowerCase() === 'true'; }
  }
}

export function uniqueNames(names) {
  const seen = new Map();
  return names.map((n, i) => {
    let name = n === null || n === undefined || String(n).trim() === '' ? `col_${i + 1}` : String(n).trim();
    if (seen.has(name)) { let k = seen.get(name); let cand; do { cand = `${name}_${++k}`; } while (seen.has(cand)); seen.set(name, k); name = cand; }
    seen.set(name, 1);
    return name;
  });
}

/** raw string grid (cells string|null) → table, deciding on a header row and typing columns. */
export function gridToTable(grid, { header = 'auto', infer = true } = {}) {
  const ncol = grid.reduce((m, r) => Math.max(m, r.length), 0);
  let hasHeader = header === true || header === 'true';
  if (header === 'auto' || header === undefined) {
    const f = grid[0] || [];
    const named = f.filter((v) => v !== null && v !== undefined && v !== '');
    hasHeader = grid.length > 0 && named.length >= Math.max(1, Math.ceil(ncol / 2)) && named.every((v) => typeof v === 'string' && v.trim() !== '' && !isNumText(v.trim())) && new Set(named).size === named.length;
  }
  const columns = uniqueNames(hasHeader ? Array.from({ length: ncol }, (_, i) => grid[0][i]) : Array.from({ length: ncol }, () => null));
  const rows = (hasHeader ? grid.slice(1) : grid).map((r) => { const o = new Array(ncol).fill(null); for (let i = 0; i < r.length; i++) o[i] = r[i] === undefined ? null : r[i]; return o; });
  if (infer) inferColumns(rows, ncol);
  return { columns, rows, header: hasHeader };
}

export function parseCSV(text, opts = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = opts.delimiter || sniffDelimiter(text);
  const recs = parseDelimited(text, delimiter);
  const grid = recs.map((r) => r.map((f) => (f.v === '' && !f.q ? null : f.v)));
  const widths = new Set(recs.map((r) => r.length));
  return { ...gridToTable(grid, opts), delimiter, ragged: widths.size > 1 };
}

export const cellText = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

export function writeDelimited(table, delim = ',', { header = true, bom = false, eol = '\n' } = {}) {
  const needs = new RegExp(`["\\r\\n${delim === '\t' ? '\\t' : delim === '|' ? '\\|' : delim}]|^\\s|\\s$`);
  const q = (v) => { if (v === null || v === undefined) return ''; const s = cellText(v); return s === '' || needs.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [];
  if (header) lines.push(table.columns.map(q).join(delim));
  for (const r of table.rows) lines.push(r.map(q).join(delim));
  return (bom ? '﻿' : '') + lines.join(eol) + eol;
}

// ───────────────────────────────────────────────────────── json-ish ──
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** make a parsed YAML/TOML/JSON value pure JSON: Dates → ISO strings, bigint → number|string, undefined → null */
export function normalise(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : (Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity');
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const s = v.toISOString();
    return s.replace(/T00:00:00\.000Z$/, '').replace(/\.000Z$/, 'Z');
  }
  if (Array.isArray(v)) return v.map(normalise);
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), normalise(x)]));
  if (v instanceof Set) return [...v].map(normalise);
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (typeof v === 'object') return Object.fromEntries(Object.keys(v).map((k) => [k, normalise(v[k])]));
  return v;
}

/** descend into a document by a dotted path ("data.items", "a[0].b") */
export function descend(value, path) {
  if (!path) return value;
  const parts = String(path).replace(/^\$\.?/, '').split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== '');
  let cur = value;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) throw new Error(`root path "${path}": no "${p}" at this level — available: ${cur && typeof cur === 'object' ? Object.keys(cur).slice(0, 20).join(', ') : `(a ${typeof cur})`}`);
    cur = cur[p];
  }
  return cur;
}

/** any JSON value → table. Arrays of objects become rows; arrays of arrays use the first row as header (header=auto: when it is all strings). */
export function valueToTable(value, opts = {}) {
  let root = opts.root || null;
  if (root) value = descend(value, root);
  else if (isObj(value)) {
    const arrs = Object.keys(value).filter((k) => Array.isArray(value[k]) && value[k].length && value[k].every(isObj));
    if (arrs.length === 1) { root = arrs[0]; value = value[root]; }
  }
  if (!Array.isArray(value)) {
    if (isObj(value)) return { columns: Object.keys(value), rows: [Object.values(value)], root, shape: 'object' };
    return { columns: ['value'], rows: [[value]], root, shape: 'scalar' };
  }
  if (value.length && value.every(Array.isArray)) {
    const t = gridToTable(value, { header: opts.header ?? 'auto', infer: false });
    return { columns: t.columns, rows: t.rows, root, shape: 'arrays' };
  }
  if (value.every(isObj)) {
    const idx = new Map(); const columns = [];
    for (const o of value) for (const k of Object.keys(o)) if (!idx.has(k)) { idx.set(k, columns.length); columns.push(k); }
    const rows = value.map((o) => { const r = new Array(columns.length).fill(null); for (const k of Object.keys(o)) r[idx.get(k)] = o[k] === undefined ? null : o[k]; return r; });
    return { columns, rows, root, shape: 'objects' };
  }
  return { columns: ['value'], rows: value.map((v) => [v]), root, shape: 'values' };
}

export const tableToObjects = (t) => t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i] === undefined ? null : r[i]])));

export function sortKeysDeep(v) {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
  return v;
}

export function parseJSONL(text) {
  const out = []; let n = 0;
  for (const line of text.split(/\r?\n/)) { n++; if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch (e) { throw new Error(`jsonl: line ${n} is not valid JSON (${e.message})`); } }
  return out;
}

// ────────────────────────────────────────────────────────────── xml ──
export function parseXML(text) {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`xml: not well-formed — ${err.textContent.replace(/\s+/g, ' ').trim().slice(0, 200)}`);
  return doc;
}
const elChildren = (el) => [...el.childNodes].filter((n) => n.nodeType === 1);
const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 || n.nodeType === 4).map((n) => n.nodeValue).join('');

/** element → JSON: attributes as "@name", repeated children as arrays, text as string (or "#text" beside attributes/children) */
export function xmlToJs(el) {
  const kids = elChildren(el); const attrs = [...el.attributes].filter((a) => !a.name.startsWith('xmlns'));
  const text = ownText(el);
  if (!kids.length && !attrs.length) return text.trim() === '' ? '' : text.trim();
  const o = {};
  for (const a of attrs) o[`@${a.name}`] = a.value;
  for (const k of kids) {
    const v = xmlToJs(k);
    if (Object.prototype.hasOwnProperty.call(o, k.nodeName)) { if (Array.isArray(o[k.nodeName])) o[k.nodeName].push(v); else o[k.nodeName] = [o[k.nodeName], v]; } else o[k.nodeName] = v;
  }
  if (text.trim() !== '') o['#text'] = text.trim();
  return o;
}
export const xmlDocToJs = (doc) => ({ [doc.documentElement.nodeName]: xmlToJs(doc.documentElement) });

/** find the repeating record element: the most frequent child name, descending through single wrappers */
export function xmlToTable(doc, opts = {}) {
  let el = doc.documentElement; let rowName = opts.root || null; let recs = null;
  if (rowName) { recs = [...doc.getElementsByTagName(rowName)]; if (!recs.length) throw new Error(`xml: no <${rowName}> elements found`); } else {
    for (let depth = 0; depth < 6; depth++) {
      const kids = elChildren(el); if (!kids.length) break;
      const counts = new Map(); for (const k of kids) counts.set(k.nodeName, (counts.get(k.nodeName) || 0) + 1);
      const [name, cnt] = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (cnt > 1 || (kids.length === 1 && !elChildren(kids[0]).length) || depth === 5) { rowName = name; recs = kids.filter((k) => k.nodeName === name); break; }
      if (kids.length === 1) { el = kids[0]; continue; }
      rowName = name; recs = kids.filter((k) => k.nodeName === name); break;
    }
    if (!recs) { recs = [doc.documentElement]; rowName = doc.documentElement.nodeName; }
  }
  const objs = recs.map((r) => {
    const o = {};
    for (const a of r.attributes) if (!a.name.startsWith('xmlns')) o[a.name] = a.value;
    const kids = elChildren(r);
    if (!kids.length) { const t = ownText(r).trim(); if (t !== '' || !r.attributes.length) o[r.attributes.length ? '#text' : 'value'] = t; }
    for (const k of kids) { const v = xmlToJs(k); if (Object.prototype.hasOwnProperty.call(o, k.nodeName)) { o[k.nodeName] = [].concat(o[k.nodeName], [v]); } else o[k.nodeName] = v; }
    return o;
  });
  const t = valueToTable(objs);
  if (opts.infer !== false) inferColumns(t.rows, t.columns.length);
  return { columns: t.columns, rows: t.rows, root: rowName };
}

export const escXml = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escXml(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
export const xmlName = (s) => { let n = String(s).replace(/[^\p{L}\p{N}_.\-]/gu, '_'); if (!/^[\p{L}_]/u.test(n)) n = `_${n}`; return n || '_'; };

function jsToXmlNode(name, v, ind, lvl, out) {
  const pad = ind ? '\n' + ind.repeat(lvl) : '';
  const tag = xmlName(name);
  if (Array.isArray(v)) { for (const x of v) jsToXmlNode(name, Array.isArray(x) ? { item: x } : x, ind, lvl, out); return; }
  if (v === null || v === undefined) { out.push(`${pad}<${tag}/>`); return; }
  if (typeof v !== 'object') { out.push(`${pad}<${tag}>${escXml(v)}</${tag}>`); return; }
  let attrs = ''; const kids = []; let text = null;
  for (const k of Object.keys(v)) {
    if (k.startsWith('@')) attrs += ` ${xmlName(k.slice(1))}="${escAttr(v[k] ?? '')}"`;
    else if (k === '#text') text = v[k];
    else kids.push(k);
  }
  if (!kids.length) { out.push(text === null || text === '' ? `${pad}<${tag}${attrs}/>` : `${pad}<${tag}${attrs}>${escXml(text)}</${tag}>`); return; }
  out.push(`${pad}<${tag}${attrs}>`);
  if (text !== null) out.push(escXml(text));
  for (const k of kids) jsToXmlNode(k, v[k], ind, lvl + 1, out);
  out.push(`${pad}</${tag}>`);
}
/** JSON → XML (inverse of xmlToJs). A single-key object supplies the root element; anything else is wrapped in <root>. */
export function jsToXml(value, { indent = 2, rootName = 'root', itemName = 'item' } = {}) {
  let name = rootName; let v = value;
  if (isObj(value) && Object.keys(value).length === 1 && !Object.keys(value)[0].startsWith('@') && !Array.isArray(Object.values(value)[0])) { name = Object.keys(value)[0]; v = value[name]; } else if (Array.isArray(value)) v = { [itemName]: value };
  const out = []; jsToXmlNode(name, v, indent ? ' '.repeat(indent) : '', 0, out);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + out.join('').replace(/^\n/, '') + '\n';
}
export function tableToXml(t, { rootName = 'rows', rowName = 'row' } = {}) {
  const names = t.columns.map(xmlName); const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<${xmlName(rootName)}>`];
  for (const r of t.rows) {
    out.push(`  <${xmlName(rowName)}>`);
    for (let i = 0; i < names.length; i++) {
      const v = r[i]; if (v === null || v === undefined) continue;
      if (typeof v === 'object') { const sub = []; jsToXmlNode(names[i], v, '  ', 2, sub); out.push(sub.join('').replace(/^\n/, '')); } else out.push(`    <${names[i]}>${escXml(v)}</${names[i]}>`);
    }
    out.push(`  </${xmlName(rowName)}>`);
  }
  out.push(`</${xmlName(rootName)}>`);
  return out.join('\n') + '\n';
}

/** re-serialise XML: pretty (indent element-only content, leave mixed content alone) or minified (drop whitespace-only text between elements) */
export function formatXml(text, { indent = 2, minify = false, sortAttributes = false } = {}) {
  const doc = parseXML(text); const ind = ' '.repeat(indent); const out = [];
  const decl = /^\s*(<\?xml[^?]*\?>)/.exec(text);
  if (decl) out.push(decl[1]);
  const ser = new XMLSerializer();
  const walk = (node, lvl, inline) => {
    const pad = minify || inline ? '' : (out.length ? '\n' : '') + ind.repeat(lvl);
    if (node.nodeType === 1) {
      let attrs = [...node.attributes]; if (sortAttributes) attrs = attrs.sort((a, b) => a.name.localeCompare(b.name));
      const open = `<${node.nodeName}${attrs.map((a) => ` ${a.name}="${escAttr(a.value)}"`).join('')}`;
      const kids = [...node.childNodes];
      const mixed = kids.some((k) => (k.nodeType === 3 || k.nodeType === 4) && k.nodeValue.trim() !== '');
      const real = mixed ? kids : kids.filter((k) => !(k.nodeType === 3 && k.nodeValue.trim() === ''));
      if (!real.length) { out.push(`${pad}${open}/>`); return; }
      out.push(`${pad}${open}>`);
      for (const k of real) walk(k, lvl + 1, inline || mixed);
      out.push(`${minify || inline || mixed ? '' : '\n' + ind.repeat(lvl)}</${node.nodeName}>`);
    } else if (node.nodeType === 3) out.push(escXml(node.nodeValue));
    else if (node.nodeType === 10) out.push(`${pad}${ser.serializeToString(node)}`);
    else out.push(`${pad}${ser.serializeToString(node)}`);
  };
  for (const n of doc.childNodes) walk(n, 0, false);
  return out.join('') + (minify ? '' : '\n');
}

// ───────────────────────────────────────────────── markdown / html ──
function splitMdRow(line) {
  let s = line.trim(); if (s.startsWith('|')) s = s.slice(1);
  const cells = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; } else cur += s[i];
  }
  if (cur.trim() !== '' || !line.trim().endsWith('|')) cells.push(cur.trim());
  return cells;
}
export function parseMarkdownTable(text, opts = {}) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/); const want = opts.table || 0; let found = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|') || !/^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1]) || !lines[i + 1].includes('-')) continue;
    if (++found < want) continue;
    const head = splitMdRow(lines[i]); const grid = [];
    for (let j = i + 2; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j++) grid.push(splitMdRow(lines[j]).map((c) => (c === '' ? null : c.replace(/<br\s*\/?>/gi, '\n'))));
    const t = gridToTable([head, ...grid], { header: true, infer: opts.infer !== false });
    return { columns: t.columns, rows: t.rows };
  }
  throw new Error(found < 0 ? 'markdown: no pipe table found (need a header row followed by a |---|---| separator row)' : `markdown: only ${found + 1} table(s) found, table index ${want} does not exist`);
}
export function toMarkdown(table, { maxCell = 0, align = true } = {}) {
  const fmt = (v) => { let s = cellText(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'); if (maxCell && s.length > maxCell) s = s.slice(0, Math.max(1, maxCell - 1)) + '…'; return s; };
  const numeric = table.columns.map((_, c) => align && table.rows.length > 0 && table.rows.every((r) => r[c] === null || typeof r[c] === 'number') && table.rows.some((r) => typeof r[c] === 'number'));
  const lines = [`| ${table.columns.map(fmt).join(' | ')} |`, `| ${numeric.map((n) => (n ? '---:' : '---')).join(' | ')} |`];
  for (const r of table.rows) lines.push(`| ${r.map(fmt).join(' | ')} |`);
  return lines.join('\n') + '\n';
}
export function parseHtmlTable(text, opts = {}) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const tables = [...doc.querySelectorAll('table')];
  if (!tables.length) throw new Error('html: no <table> element found');
  const idx = opts.table || 0;
  if (idx >= tables.length) throw new Error(`html: only ${tables.length} table(s) found, table index ${idx} does not exist`);
  const tb = tables[idx]; const trs = [...tb.querySelectorAll('tr')].filter((tr) => tr.closest('table') === tb);
  let headerRow = false;
  const grid = trs.map((tr, i) => {
    const cells = [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH');
    if (i === 0 && cells.length && cells.every((c) => c.tagName === 'TH')) headerRow = true;
    const out = [];
    for (const c of cells) { for (const br of c.querySelectorAll('br')) br.replaceWith('\n'); const t = c.textContent.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim(); const span = Math.min(1000, Number(c.getAttribute('colspan')) || 1); out.push(t === '' ? null : t); for (let k = 1; k < span; k++) out.push(null); }
    return out;
  }).filter((r) => r.length);
  const t = gridToTable(grid, { header: opts.header !== undefined && opts.header !== 'auto' ? opts.header : (headerRow ? true : 'auto'), infer: opts.infer !== false });
  return { columns: t.columns, rows: t.rows, tables: tables.length };
}
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function toHtmlTable(table, { title = 'table' } = {}) {
  const out = ['<!doctype html>', '<html><head><meta charset="utf-8">', `<title>${escHtml(title)}</title></head><body>`, '<table>', `<thead><tr>${table.columns.map((c) => `<th>${escHtml(c)}</th>`).join('')}</tr></thead>`, '<tbody>'];
  for (const r of table.rows) out.push(`<tr>${r.map((v) => `<td>${escHtml(cellText(v)).replace(/\r?\n/g, '<br>')}</td>`).join('')}</tr>`);
  out.push('</tbody>', '</table>', '</body></html>');
  return out.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────── sniff ──
export function sniffFormat(path, bytes, explicit) {
  if (explicit && explicit !== 'auto') { if (explicit === 'md') return 'markdown'; if (!FORMATS.includes(explicit)) throw new Error(`unknown format "${explicit}" — accepted: ${FORMATS.join(', ')}`); return explicit; }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5)) return 'xlsx';
  const byExt = EXT_FORMAT[vfs.extOf(path)];
  if (byExt) return byExt;
  const head = decodeText(bytes.subarray(0, 65536)).replace(/^﻿/, ''); const t = head.trimStart();
  if (t.startsWith('<')) return /<table[\s>]|<!doctype html|<html[\s>]/i.test(t.slice(0, 4096)) ? 'html' : 'xml';
  if (t.startsWith('{') || t.startsWith('[')) {
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (/^\[[^\]\n,{]*\]\s*(#.*)?$/.test(lines[0]) && lines.length > 1 && /^\s*[\w."'-]+\s*=/.test(lines[1])) return 'toml';
    if (lines.length > 1) { try { JSON.parse(lines[0]); JSON.parse(lines[1]); return 'jsonl'; } catch { /* not jsonl */ } }
    return 'json';
  }
  const ls = t.split(/\r?\n/);
  if (ls.length > 1 && ls[0].includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(ls[1])) return 'markdown';
  const d = sniffDelimiter(head);
  const first = (() => { try { return parseDelimited(ls[0], d)[0]?.length || 1; } catch { return 1; } })();
  if (first > 1) return d === '\t' ? 'tsv' : 'csv';
  if (/^(---\s*$|[\w"'-]+:\s|- )/m.test(t) ) return 'yaml';
  if (/^\s*[\w."'-]+\s*=\s*\S/m.test(t)) return 'toml';
  return 'csv';
}

// ───────────────────────────────────────────────────────── loaders ──
/** load a structured document (no tabular interpretation). csv/tsv/markdown/html/xlsx become an array of row objects. */
export async function loadDoc(path, opts = {}) {
  const bytes = vfs.read(path); const format = sniffFormat(path, bytes, opts.format);
  if (format === 'json') { try { return { format, value: JSON.parse(decodeText(bytes).replace(/^﻿/, '')) }; } catch (e) { throw new Error(`json: ${path} is not valid JSON (${e.message})`); } }
  if (format === 'jsonl') return { format, value: parseJSONL(decodeText(bytes)) };
  if (format === 'yaml') {
    const y = await libYaml(); let docs;
    try { docs = y.loadAll(decodeText(bytes)); } catch (e) { throw new Error(`yaml: ${String(e.message).split('\n').slice(0, 4).join(' ').slice(0, 300)}`); }
    return { format, value: normalise(docs.length === 1 ? docs[0] : docs), documents: docs.length };
  }
  if (format === 'toml') {
    const t = await libToml();
    const conv = (v) => (v instanceof Date ? (Number.isNaN(v.getTime()) ? null : v.toISOString().replace(/\.000(?=Z|[+-]|$)/, '')) : Array.isArray(v) ? v.map(conv) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).map((k) => [k, conv(v[k])])) : v);
    try { return { format, value: normalise(conv(t.parse(decodeText(bytes)))) }; } catch (e) { throw new Error(`toml: ${String(e.message).split('\n').slice(0, 6).join(' ').replace(/\s+/g, ' ').slice(0, 300)}`); }
  }
  if (format === 'xml') return { format, value: xmlDocToJs(parseXML(decodeText(bytes))) };
  const t = await loadTable(path, opts);
  return { format, value: tableToObjects(t), table: t };
}

/** load any supported file as a table → {format, columns, rows, ...extras} */
export async function loadTable(path, opts = {}) {
  const bytes = vfs.read(path); const format = sniffFormat(path, bytes, opts.format);
  const common = { header: opts.header ?? 'auto', infer: opts.infer !== false };
  if (format === 'csv' || format === 'tsv') {
    const t = parseCSV(decodeText(bytes), { ...common, delimiter: opts.delimiter || (format === 'tsv' ? '\t' : undefined) });
    return { format, columns: t.columns, rows: t.rows, delimiter: t.delimiter, header: t.header, ragged: t.ragged || undefined };
  }
  if (format === 'markdown') return { format, ...parseMarkdownTable(decodeText(bytes), { ...common, table: opts.table }) };
  if (format === 'html') return { format, ...parseHtmlTable(decodeText(bytes), { ...common, table: opts.table }) };
  if (format === 'xml') return { format, ...xmlToTable(parseXML(decodeText(bytes)), { root: opts.root, infer: common.infer }) };
  if (format === 'xlsx') {
    const x = await libXlsx(); const wb = await x.readWorkbook(bytes, { sheet: opts.sheet });
    const sh = wb.sheet; const t = gridToTable(sh.grid, { header: common.header, infer: false });
    return { format, columns: t.columns, rows: t.rows, sheet: sh.name, sheets: wb.sheets.map((s) => s.name), header: t.header };
  }
  const doc = await loadDoc(path, { ...opts, format });
  const t = valueToTable(doc.value, { root: opts.root, header: opts.header });
  return { format, columns: t.columns, rows: t.rows, root: t.root || undefined, shape: t.shape };
}

/** strip nulls (TOML has no null); returns count dropped */
function dropNulls(v, counter) {
  if (Array.isArray(v)) return v.filter((x) => (x === null || x === undefined ? (counter.n++, false) : true)).map((x) => dropNulls(x, counter));
  if (isObj(v)) return Object.fromEntries(Object.keys(v).filter((k) => (v[k] === null || v[k] === undefined ? (counter.n++, false) : true)).map((k) => [k, dropNulls(v[k], counter)]));
  return v;
}

/** serialise a document value → {data: string, notes} */
export async function serialiseDoc(value, format, opts = {}) {
  const indent = opts.indent ?? 2; const notes = [];
  if (opts.sortKeys) value = sortKeysDeep(value);
  if (format === 'json') return { data: JSON.stringify(value, null, opts.minify ? 0 : indent) + '\n', notes };
  if (format === 'jsonl') return { data: (Array.isArray(value) ? value : [value]).map((v) => JSON.stringify(v)).join('\n') + '\n', notes };
  if (format === 'yaml') { const y = await libYaml(); return { data: y.dump(value, { lineWidth: -1, noRefs: true, indent: Math.max(2, indent) }), notes }; }
  if (format === 'toml') {
    const t = await libToml(); const c = { n: 0 };
    let v = dropNulls(value, c);
    if (!isObj(v)) { v = { [opts.rootName || 'rows']: v }; notes.push(`TOML needs a table at the top level: the value was wrapped under "${opts.rootName || 'rows'}"`); }
    if (c.n) notes.push(`${c.n} null value(s) dropped (TOML has no null)`);
    return { data: t.stringify(v) + '\n', notes };
  }
  if (format === 'xml') return { data: jsToXml(value, { indent: opts.minify ? 0 : indent, rootName: opts.rootName || 'root' }), notes };
  throw new Error(`cannot serialise a document as "${format}"`);
}

/** serialise a table → {data: string|Uint8Array, notes} */
export async function serialiseTable(table, format, opts = {}) {
  if (format === 'csv') return { data: writeDelimited(table, opts.delimiter || ',', { bom: opts.bom }), notes: [] };
  if (format === 'tsv') return { data: writeDelimited(table, '\t', { bom: opts.bom }), notes: [] };
  if (format === 'markdown') return { data: toMarkdown(table), notes: [] };
  if (format === 'html') return { data: toHtmlTable(table, { title: opts.title }), notes: [] };
  if (format === 'xml') return { data: tableToXml(table, { rootName: opts.rootName || 'rows', rowName: opts.rowName || 'row' }), notes: [] };
  if (format === 'xlsx') { const x = await libXlsx(); return { data: await x.writeWorkbook([{ name: opts.sheet || 'Sheet1', columns: table.columns, rows: table.rows }], { dates: opts.dates !== false }), notes: [] }; }
  if (format === 'json' && opts.jsonShape === 'arrays') return { data: (opts.minify ? JSON.stringify([table.columns, ...table.rows]) : '[\n' + [table.columns, ...table.rows].map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]') + '\n', notes: [] };
  if (['json', 'jsonl', 'yaml', 'toml'].includes(format)) return serialiseDoc(tableToObjects(table), format, opts);
  throw new Error(`unknown output format "${format}" — accepted: ${FORMATS.join(', ')}`);
}

// ───────────────────────────────────────────────────────── profile ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; const DT_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
export function valueType(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return DATE_RE.test(v) ? 'date' : DT_RE.test(v) ? 'datetime' : 'string';
  return Array.isArray(v) ? 'array' : 'object';
}
/** one column → {type, count, nulls, distinct, min, max, mean, ...} */
export function profileColumn(table, c, { samples = 3 } = {}) {
  const types = new Map(); let nulls = 0; let sum = 0; let nnum = 0; let min; let max; let minLen = Infinity; let maxLen = 0;
  const distinct = new Set(); const DCAP = 100000; let capped = false;
  for (const r of table.rows) {
    const v = r[c]; const t = valueType(v);
    if (t === 'null') { nulls++; continue; }
    types.set(t, (types.get(t) || 0) + 1);
    const key = typeof v === 'object' ? JSON.stringify(v) : v;
    if (distinct.size < DCAP) distinct.add(typeof v === 'string' ? `s:${key}` : key); else capped = true;
    if (typeof v === 'number') { sum += v; nnum++; }
    if (typeof v === 'string') { if (v.length < minLen) minLen = v.length; if (v.length > maxLen) maxLen = v.length; }
    if (typeof v === 'number' || typeof v === 'string') {
      if (min === undefined || (typeof v === typeof min ? v < min : typeof v === 'number')) min = v;
      if (max === undefined || (typeof v === typeof max ? v > max : typeof v === 'string')) max = v;
    }
  }
  const ks = [...types.keys()];
  let type = !ks.length ? 'null' : ks.length === 1 ? ks[0] : ks.every((k) => k === 'integer' || k === 'number') ? 'number' : ks.every((k) => k === 'date' || k === 'datetime') ? 'datetime' : ks.every((k) => ['string', 'date', 'datetime'].includes(k)) ? 'string' : `mixed(${ks.sort().join('|')})`;
  const out = { name: table.columns[c], type, count: table.rows.length - nulls, nulls, distinct: distinct.size };
  if (capped) out.distinctCapped = true;
  const short = (v) => (typeof v === 'string' && v.length > 60 ? v.slice(0, 59) + '…' : v);
  if (min !== undefined) { out.min = short(min); out.max = short(max); }
  if (nnum && nnum === out.count) out.mean = round(sum / nnum);
  if (maxLen && (type === 'string')) { out.minLength = minLen; out.maxLength = maxLen; }
  if (samples) { const s = []; const seen = new Set(); for (const r of table.rows) { const v = r[c]; if (v === null || v === undefined) continue; const k = typeof v === 'object' ? JSON.stringify(v) : `${typeof v}:${v}`; if (seen.has(k)) continue; seen.add(k); s.push(typeof v === 'object' ? short(JSON.stringify(v)) : short(v)); if (s.length >= samples) break; } out.samples = s; }
  return out;
}
export const round = (x) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(12)) : x);

/** compact markdown preview of some rows */
export const preview = (table, rows, maxCell = 40) => toMarkdown({ columns: table.columns, rows }, { maxCell, align: false });
