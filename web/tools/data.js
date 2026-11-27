// data.* archive.* hash.* encode.* file.* — structured data, archives, digests, text codecs and raw-byte forensics.
// Helpers live in web/js/data/ and are imported lazily, as are the vendored fflate, js-yaml and smol-toml.
import { M, vfs, register, b64 } from '../js/core.js';

const lazy = (rel) => { let p; return () => (p ||= import(new URL(rel, import.meta.url).href)); };
const F = lazy('../js/data/formats.js');
const X = lazy('../js/data/expr.js');
const S = lazy('../js/data/schema.js');
const H = lazy('../js/data/hash.js');
const A = lazy('../js/data/archive.js');
const D = lazy('../js/data/draw.js');
const G = lazy('../js/data/magic.js');
const IMG = lazy('../js/img.js');

const INLINE = 50; // max rows / list items returned inline
const FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'yaml', 'toml', 'xml', 'markdown', 'html', 'xlsx'];
const enc = new TextEncoder();
const hex2 = (n) => n.toString(16).padStart(2, '0');
const hexOf = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += hex2(b[i]); return s; };
const round = (x, p = 6) => (typeof x === 'number' && Number.isFinite(x) ? Number(x.toPrecision(p)) : x);
const concat = (parts) => { let n = 0; for (const p of parts) n += p.length; const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// ── shared argument blocks ──
const SRC = {
  input: { type: 'string', description: 'VFS path of the data file: csv, tsv, json, jsonl, yaml, toml, xml, markdown table, html table or xlsx' },
  format: { type: 'string', enum: ['auto', ...FORMATS], default: 'auto', description: 'Input format. auto = by file extension, then by content sniffing' },
  sheet: { type: 'string', description: 'xlsx input only: sheet name or 0-based index (default: first visible sheet; list them with data.sheets)' },
  header: { type: 'string', enum: ['auto', 'true', 'false'], default: 'auto', description: 'Is the first row column names? auto = yes when it is all distinct non-numeric text. With false, columns are named col_1, col_2 …' },
  delimiter: { type: 'string', description: 'csv input only: field delimiter (default: sniffed among , ; tab |)' },
  root: { type: 'string', description: 'json/yaml/toml: dotted path of the array to use as rows, e.g. "data.items" (default: the top-level array, or the only array-of-objects property). xml: name of the repeating row element (default: auto-detected)' },
  table: { type: 'integer', minimum: 0, default: 0, description: 'html/markdown input only: which table in the document (0-based)' },
};
const srcOpts = (a) => ({ format: a.format, sheet: a.sheet, header: a.header, delimiter: a.delimiter === '\\t' ? '\t' : a.delimiter, root: a.root, table: a.table });
const loadTable = async (a, key = 'input') => (await F()).loadTable(a[key], srcOpts(a));
const srcInfo = (t) => ({ format: t.format, ...(t.sheet ? { sheet: t.sheet } : {}), ...(t.root ? { root: t.root } : {}), ...(t.delimiter ? { delimiter: t.delimiter === '\t' ? 'tab' : t.delimiter } : {}) });
const formatOfPath = (p) => ({ csv: 'csv', tsv: 'tsv', json: 'json', jsonl: 'jsonl', ndjson: 'jsonl', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', xlsx: 'xlsx' }[vfs.extOf(p || '')]);
const MIME = { markdown: 'text/markdown', jsonl: 'application/x-ndjson' };
async function writeTable(table, path, format, opts = {}) {
  const f = await F(); const { data, notes } = await f.serialiseTable(table, format, opts);
  const st = await vfs.write(path, data, { ...(MIME[format] && !vfs.extOf(path) ? { mime: MIME[format] } : {}), meta: { rows: table.rows.length, columns: table.columns.length } });
  return { stat: st, notes };
}
/** bytes from `input` (VFS path) or inline `text` */
function source(a) {
  const hasIn = a.input !== undefined && a.input !== ''; const hasText = a.text !== undefined;
  if (hasIn === hasText) throw new Error('give exactly one of: input (a VFS path) or text (inline content)');
  return hasIn ? { bytes: vfs.read(a.input), from: 'file' } : { bytes: enc.encode(a.text), from: 'text' };
}
const BYTES_SRC = { input: { type: 'string', description: 'VFS path of the file to read' }, text: { type: 'string', description: 'Inline UTF-8 text to use instead of a file' } };

// ═════════════════════════════════════════════════════════════ data ══
register({
  name: 'data.info', readOnly: true,
  description: 'Profile a tabular or structured data file: detected format, row and column counts, and for every column its inferred type (integer, number, boolean, string, date, datetime, object, array, mixed), null count, distinct count, min/max, mean and a few sample values. Use it first on any unknown csv/tsv/json/jsonl/yaml/toml/xml/markdown/html/xlsx file. Returns at most 50 column profiles inline.',
  schema: { properties: { ...SRC, samples: { type: 'integer', default: 3, minimum: 0, maximum: 10, description: 'Sample values per column' } }, required: ['input'] },
  examples: ['data.info input=sales.csv', 'data.info input=book.xlsx sheet=Q3'],
  async run(a) {
    const f = await F(); const t = await loadTable(a);
    const cols = t.columns.slice(0, INLINE).map((_, i) => f.profileColumn(t, i, { samples: a.samples }));
    return { ...srcInfo(t), bytes: vfs.stat(a.input).bytes, rows: t.rows.length, columns: t.columns.length, ...(t.sheets ? { sheets: t.sheets } : {}), ...(t.header !== undefined ? { headerRow: t.header } : {}), ...(t.ragged ? { ragged: true } : {}), columnInfo: cols, truncated: t.columns.length > INLINE };
  },
});

register({
  name: 'data.convert',
  description: 'Convert a data file between csv, tsv, json (array of objects or array of arrays), jsonl, yaml, toml, xml, markdown table, html table and xlsx. Tabular conversions keep value types (numbers, booleans, nulls, ISO dates become real date cells in xlsx). Between json/yaml/toml/xml the whole document is converted as-is (nested config files work), unless mode=table. Returns the written file plus row/column counts and notes about anything lossy (e.g. TOML has no null).',
  schema: {
    properties: {
      ...SRC,
      to: { type: 'string', enum: FORMATS, description: 'Target format (default: from the output file extension)' },
      output: { type: 'string', description: 'VFS path to write (default: input name with the target extension)' },
      mode: { type: 'string', enum: ['auto', 'table', 'document'], default: 'auto', description: 'table = interpret the input as rows × columns; document = convert the parsed value unchanged (only json/yaml/toml/xml on both sides); auto = document when both sides are json/yaml/toml/xml, else table' },
      jsonShape: { type: 'string', enum: ['objects', 'arrays'], default: 'objects', description: 'json output in table mode: array of row objects, or array of arrays with a header row first' },
      sheetName: { type: 'string', default: 'Sheet1', description: 'xlsx output: name of the sheet to create' },
      dates: { type: 'boolean', default: true, description: 'xlsx output: write strings shaped like YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS as real date cells' },
      indent: { type: 'integer', default: 2, minimum: 0, maximum: 8, description: 'Indentation for json/yaml/xml output (0 = compact json)' },
      sortKeys: { type: 'boolean', default: false, description: 'Sort object keys alphabetically (json/yaml/toml document output)' },
      bom: { type: 'boolean', default: false, description: 'csv/tsv output: prepend a UTF-8 BOM (helps Excel open UTF-8 csv)' },
      outDelimiter: { type: 'string', description: 'csv output: delimiter to write (default ",")' },
      rootName: { type: 'string', description: 'xml output: root element name (default "rows" in table mode, "root" in document mode); toml output: key used to wrap a top-level array (default "rows")' },
      rowName: { type: 'string', default: 'row', description: 'xml output in table mode: element name of each row' },
    },
    required: ['input'],
  },
  examples: ['data.convert input=sales.csv to=xlsx', 'data.convert input=config.yaml to=toml', 'data.convert input=book.xlsx sheet=Q3 output=q3.json'],
  async run(a) {
    const f = await F(); const bytes = vfs.read(a.input);
    const from = f.sniffFormat(a.input, bytes, a.format);
    const to = a.to || formatOfPath(a.output);
    if (!to) throw new Error(`cannot tell the target format: pass to=<${FORMATS.join('|')}> or an output path with a known extension`);
    const out = vfs.out(a.output, a.input, '', f.FORMAT_EXT[to]);
    if (!a.output && out === a.input) throw new Error('input already has the target extension — pass an explicit output path');
    let mode = a.mode;
    if (mode === 'document' && !(f.isDocFormat(from) && (f.isDocFormat(to) || to === 'jsonl'))) throw new Error('mode=document needs json, yaml, toml or xml on both sides');
    if (mode === 'auto') mode = f.isDocFormat(from) && f.isDocFormat(to) && a.jsonShape !== 'arrays' && !a.root ? 'document' : 'table';
    const common = { indent: a.indent, minify: a.indent === 0, sortKeys: a.sortKeys, rootName: a.rootName };
    if (mode === 'document') {
      const doc = await f.loadDoc(a.input, { ...srcOpts(a), format: from });
      const { data, notes } = await f.serialiseDoc(doc.value, to, common);
      return { output: await vfs.write(out, data), from, to, mode, topLevel: Array.isArray(doc.value) ? `array(${doc.value.length})` : doc.value === null ? 'null' : typeof doc.value, ...(notes.length ? { notes } : {}) };
    }
    const t = await f.loadTable(a.input, { ...srcOpts(a), format: from });
    const { stat, notes } = await writeTable(t, out, to, { ...common, jsonShape: a.jsonShape, sheet: a.sheetName, dates: a.dates, bom: a.bom, delimiter: a.outDelimiter === '\\t' ? '\t' : a.outDelimiter, rowName: a.rowName, title: vfs.stemOf(a.input) });
    return { output: stat, from, to, mode, rows: t.rows.length, columns: t.columns.length, ...srcInfo(t), format: undefined, ...(notes.length ? { notes } : {}) };
  },
});

const QUERY_HELP = 'Expression language (no eval): comparisons == != < <= > >=, and/or/not, in (a, b), between a and b, like/ilike (% and _ wildcards), contains/icontains/startswith/endswith, matches (regex), is null / is not null, arithmetic + - * / %, functions lower upper trim len abs round floor ceil sqrt pow min max coalesce if number string substr replace concat year month day. Strings in single or double quotes; column names bare, dotted into nested values (user.city), or in `backticks` when they contain spaces or punctuation.';
register({
  name: 'data.query',
  description: `Query a table like a small SQL SELECT: filter rows (where), group and aggregate (count, sum, avg, min, max, median, distinct, first, last, stddev), compute columns (select "price * qty as total"), sort, de-duplicate, offset/limit. The full result is written to a file (csv by default); the first rows come back inline as a markdown table. ${QUERY_HELP}`,
  schema: {
    properties: {
      ...SRC,
      where: { type: 'string', description: 'Row filter expression, e.g. "price > 10 and country in (\'FR\', \'DE\') and name icontains \'pro\'"' },
      select: { type: 'array', items: { type: 'string' }, description: 'Columns or expressions to output, each optionally "… as alias"; "*" = all. After groupBy, refers to group keys and aggregate aliases' },
      groupBy: { type: 'array', items: { type: 'string' }, description: 'Columns (or expressions) to group by' },
      aggregates: { type: 'array', items: { type: 'string' }, description: 'Aggregates per group (or over all rows without groupBy), e.g. ["count", "sum(amount) as total", "avg(price)"]. Default alias: fn_column' },
      having: { type: 'string', description: 'Filter on the grouped rows, using group keys and aggregate aliases' },
      sort: { type: 'array', items: { type: 'string' }, description: 'Sort keys: "column", "-column" or "column desc". Nulls sort last' },
      distinct: { type: 'boolean', default: false, description: 'Drop duplicate output rows' },
      offset: { type: 'integer', default: 0, minimum: 0, description: 'Skip this many result rows' },
      limit: { type: 'integer', minimum: 0, description: 'Keep at most this many result rows (default: all)' },
      to: { type: 'string', enum: FORMATS, description: 'Output format (default: from the output extension, else csv)' },
      output: { type: 'string', description: 'VFS path for the full result (default: <input>.query.csv)' },
      preview: { type: 'integer', default: 20, minimum: 0, maximum: INLINE, description: 'Rows to return inline as a markdown table' },
    },
    required: ['input'],
  },
  examples: ['data.query input=sales.csv where="amount > 100" sort=-amount limit=10', 'data.query input=sales.csv groupBy=region aggregates="count,sum(amount) as total" sort=-total'],
  async run(a) {
    const f = await F(); const x = await X(); const t = await loadTable(a);
    const r = x.runQuery(t, { where: a.where, select: a.select, groupBy: a.groupBy, aggregates: a.aggregates, having: a.having, sort: a.sort, distinct: a.distinct, offset: a.offset, limit: a.limit });
    const to = a.to || formatOfPath(a.output) || 'csv';
    const { stat } = await writeTable(r, vfs.out(a.output, a.input, 'query', f.FORMAT_EXT[to]), to, {});
    const shown = r.rows.slice(0, a.preview);
    return { output: stat, sourceRows: t.rows.length, matched: r.matched, rows: r.rows.length, columns: r.columns, preview: f.preview(r, shown), truncated: shown.length < r.rows.length };
  },
});

const PEEK = { columns: { type: 'array', items: { type: 'string' }, description: 'Only these columns (default: all)' }, maxCell: { type: 'integer', default: 40, minimum: 5, maximum: 500, description: 'Truncate cell text to this many characters' } };
function narrow(t, columns) {
  if (!columns?.length) return t;
  const idx = columns.map((c) => { const i = t.columns.indexOf(c); if (i < 0) throw new Error(`unknown column "${c}" — columns: ${t.columns.slice(0, 40).join(', ')}`); return i; });
  return { columns, rows: t.rows.map((r) => idx.map((i) => r[i])) };
}
register({
  name: 'data.head', readOnly: true,
  description: 'Peek at the first N rows of a data file as a compact markdown table (the quick way to see what a csv/xlsx/json table looks like). Use offset to page, columns to narrow. Returns the markdown inline plus total row and column counts.',
  schema: { properties: { ...SRC, n: { type: 'integer', default: 10, minimum: 1, maximum: 200, description: 'Rows to show' }, offset: { type: 'integer', default: 0, minimum: 0, description: 'Rows to skip first' }, ...PEEK }, required: ['input'] },
  examples: ['data.head input=sales.csv n=5'],
  async run(a) {
    const f = await F(); const t = await loadTable(a); const v = narrow(t, a.columns);
    const rows = v.rows.slice(a.offset, a.offset + a.n);
    return { ...srcInfo(t), rows: t.rows.length, columns: t.columns.length, shown: rows.length, offset: a.offset, markdown: f.preview(v, rows, a.maxCell), truncated: a.offset + rows.length < t.rows.length };
  },
});
function mulberry32(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
register({
  name: 'data.sample', readOnly: true,
  description: 'Seeded uniform random sample of N rows from a data file, as a compact markdown table with a row-number column (#, 0-based, in file order). The same seed always returns the same rows. Use it to see typical rows rather than just the first ones.',
  schema: { properties: { ...SRC, n: { type: 'integer', default: 10, minimum: 1, maximum: 200, description: 'Rows to sample' }, seed: { type: 'integer', default: 1, description: 'Random seed' }, ...PEEK, output: { type: 'string', description: 'Optional VFS path to also write the sampled rows to (format from its extension)' } }, required: ['input'] },
  examples: ['data.sample input=sales.csv n=8 seed=42'],
  async run(a) {
    const f = await F(); const t = await loadTable(a); const v = narrow(t, a.columns);
    const n = Math.min(a.n, v.rows.length); const idx = Array.from({ length: v.rows.length }, (_, i) => i); const rnd = mulberry32(a.seed);
    for (let i = 0; i < n; i++) { const j = i + Math.floor(rnd() * (idx.length - i)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    const pickIdx = idx.slice(0, n).sort((p, q) => p - q);
    const res = { ...srcInfo(t), rows: t.rows.length, columns: t.columns.length, shown: n, seed: a.seed, markdown: f.preview({ columns: ['#', ...v.columns] }, pickIdx.map((i) => [i, ...v.rows[i]]), a.maxCell) };
    if (a.output) res.output = (await writeTable({ columns: v.columns, rows: pickIdx.map((i) => v.rows[i]) }, a.output, formatOfPath(a.output) || 'csv')).stat;
    return res;
  },
});

function describeNumeric(vals, bins) {
  const s = Float64Array.from(vals).sort(); const n = s.length; let sum = 0; for (const v of s) sum += v; const mean = sum / n;
  let ss = 0; for (const v of s) ss += (v - mean) ** 2;
  const q = (p) => { const pos = (n - 1) * p; const lo = Math.floor(pos); const hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
  const out = { count: n, mean: round(mean), std: n > 1 ? round(Math.sqrt(ss / (n - 1))) : null, min: s[0], q1: round(q(0.25)), median: round(q(0.5)), q3: round(q(0.75)), max: s[n - 1], sum: round(sum, 12) };
  if (bins) out.histogram = histogram(s, bins);
  return out;
}
function histogram(sorted, bins) {
  const lo = sorted[0]; const hi = sorted[sorted.length - 1];
  if (lo === hi) return { edges: [lo, hi], counts: [sorted.length] };
  const w = (hi - lo) / bins; const counts = new Array(bins).fill(0);
  for (const v of sorted) counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  return { edges: Array.from({ length: bins + 1 }, (_, i) => round(lo + w * i, 8)), counts };
}
function pearson(xs, ys) {
  let n = 0; let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0;
  for (let i = 0; i < xs.length; i++) { const x = xs[i]; const y = ys[i]; if (typeof x !== 'number' || typeof y !== 'number') continue; n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  if (n < 2) return null; const d = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return d === 0 ? null : round((n * sxy - sx * sy) / d, 4);
}
register({
  name: 'data.stats', readOnly: false,
  description: 'Descriptive statistics per column. Numeric columns: count, nulls, mean, sample std, min, quartiles, max, sum and histogram bins. Other columns: distinct count and the most frequent values. Plus a Pearson correlation matrix across the numeric columns. Returns up to 50 columns inline; pass output to write the complete report as JSON.',
  schema: {
    properties: {
      ...SRC,
      columns: { type: 'array', items: { type: 'string' }, description: 'Only these columns (default: all)' },
      bins: { type: 'integer', default: 10, minimum: 0, maximum: 100, description: 'Histogram bins for numeric columns (0 = no histogram)' },
      top: { type: 'integer', default: 5, minimum: 0, maximum: 50, description: 'Most frequent values to list for non-numeric columns' },
      correlation: { type: 'boolean', default: true, description: 'Compute the correlation matrix of numeric columns (inline for up to 12 columns)' },
      output: { type: 'string', description: 'Optional VFS path for the full JSON report' },
    },
    required: ['input'],
  },
  examples: ['data.stats input=sales.csv', 'data.stats input=sales.csv columns=price,qty bins=20'],
  async run(a) {
    const t0 = await loadTable(a); const t = narrow(t0, a.columns); const cols = []; const numeric = [];
    t.columns.forEach((name, c) => {
      const vals = []; let nulls = 0; let nonNum = 0; const freq = new Map();
      for (const r of t.rows) { const v = r[c]; if (v === null || v === undefined) { nulls++; continue; } if (typeof v === 'number' && Number.isFinite(v)) vals.push(v); else nonNum++; if (a.top) { const k = typeof v === 'object' ? JSON.stringify(v) : v; if (freq.size < 200000 || freq.has(k)) freq.set(k, (freq.get(k) || 0) + 1); } }
      if (vals.length && !nonNum) { cols.push({ name, kind: 'numeric', nulls, ...describeNumeric(vals, a.bins) }); numeric.push(c); return; }
      const top = [...freq].sort((p, q) => q[1] - p[1]).slice(0, a.top).map(([value, count]) => ({ value: typeof value === 'string' && value.length > 80 ? value.slice(0, 79) + '…' : value, count }));
      cols.push({ name, kind: vals.length ? 'mixed' : 'categorical', count: t.rows.length - nulls, nulls, distinct: freq.size, ...(a.top ? { top } : {}) });
    });
    let correlation = null;
    if (a.correlation && numeric.length >= 2) {
      const use = numeric.slice(0, 40); const series = use.map((c) => t.rows.map((r) => r[c]));
      correlation = { columns: use.map((c) => t.columns[c]), matrix: use.map((_, i) => use.map((__, j) => (i === j ? 1 : j < i ? null : pearson(series[i], series[j])))) };
      for (let i = 0; i < use.length; i++) for (let j = 0; j < i; j++) correlation.matrix[i][j] = correlation.matrix[j][i];
    }
    const res = { ...srcInfo(t0), rows: t.rows.length, columns: t.columns.length, numericColumns: numeric.length, stats: cols.slice(0, INLINE), truncated: cols.length > INLINE };
    if (correlation) { if (correlation.columns.length <= 12) res.correlation = correlation; else { res.correlation = { columns: correlation.columns.slice(0, 12), matrix: correlation.matrix.slice(0, 12).map((r) => r.slice(0, 12)) }; res.correlationTruncated = true; } }
    if (a.output) res.output = await vfs.write(a.output, JSON.stringify({ rows: t.rows.length, stats: cols, correlation }, null, 1) + '\n');
    return res;
  },
});

register({
  name: 'data.schema',
  description: 'Infer a JSON Schema (draft 2020-12) from a data file: types (with integer vs number and nullable unions), object properties, required keys (present in every sample), array item schemas, and string formats (date, date-time, email, uri, uuid) when every value matches. Tabular inputs yield the schema of an array of row objects. Writes the schema to a .schema.json file and returns it inline when small.',
  schema: { properties: { ...SRC, required: { type: 'boolean', default: true, description: 'Emit "required" for keys present in every object' }, formats: { type: 'boolean', default: true, description: 'Detect string formats' }, enums: { type: 'boolean', default: false, description: 'Emit "enum" for low-cardinality string fields' }, output: { type: 'string', description: 'VFS path (default: <input>.schema.json)' } }, required: ['input'] },
  examples: ['data.schema input=users.json'],
  async run(a) {
    const f = await F(); const s = await S(); const doc = await f.loadDoc(a.input, srcOpts(a));
    let value = doc.value; if (a.root && f.isDocFormat(doc.format)) value = f.descend(value, a.root);
    const schema = s.inferSchema(value, { required: a.required, formats: a.formats, enums: a.enums });
    const text = JSON.stringify(schema, null, 2);
    const res = { output: await vfs.write(vfs.out(a.output, a.input, 'schema', 'json'), text + '\n'), format: doc.format };
    if (text.length <= 6000) res.schema = schema; else { res.truncated = true; res.note = 'schema too large to inline — read the output file'; }
    return res;
  },
});

register({
  name: 'data.flatten',
  description: 'Flatten nested JSON/YAML/TOML into single-level objects with path keys ({"a":{"b":[1,2]}} → {"a.b.0":1,"a.b.1":2}). An array of objects is flattened row by row, which makes nested records ready for csv/xlsx: give an output ending in .csv/.xlsx/.md to write a table directly. Returns the written file and the distinct flattened keys (first 50).',
  schema: { properties: { input: { type: 'string', description: 'VFS path of a json, jsonl, yaml, toml or xml file' }, format: SRC.format, root: SRC.root, separator: { type: 'string', default: '.', description: 'Key separator' }, arrays: { type: 'boolean', default: true, description: 'Also flatten arrays by index (false keeps arrays as values)' }, output: { type: 'string', description: 'VFS path (default: <input>.flat.json); the extension picks the format' } }, required: ['input'] },
  examples: ['data.flatten input=users.json output=users.csv'],
  async run(a) {
    const f = await F(); const s = await S(); const doc = await f.loadDoc(a.input, { format: a.format });
    const value = a.root ? f.descend(doc.value, a.root) : doc.value; const o = { sep: a.separator, arrays: a.arrays };
    const perRow = Array.isArray(value) && value.length > 0 && value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    const flat = perRow ? value.map((v) => s.flatten(v, o)) : s.flatten(value, o);
    const keys = perRow ? [...new Set(flat.flatMap((r) => Object.keys(r)))] : Object.keys(flat);
    const out = vfs.out(a.output, a.input, 'flat', 'json'); const to = formatOfPath(out) || 'json';
    const stat = to === 'json' ? await vfs.write(out, JSON.stringify(flat, null, 2) + '\n') : (await writeTable(f.valueToTable(perRow ? flat : [flat]), out, to)).stat;
    return { output: stat, records: perRow ? flat.length : 1, keyCount: keys.length, keys: keys.slice(0, INLINE), truncated: keys.length > INLINE };
  },
});
register({
  name: 'data.unflatten',
  description: 'Inverse of data.flatten: rebuild nested JSON from path-like keys ("a.b.0": 1 → {"a":{"b":[1]}}; objects whose keys are 0..n-1 become arrays). Works on a flat JSON object, an array of flat objects, or any table (csv/xlsx with dotted column names → array of nested objects; null cells are omitted). Writes JSON.',
  schema: { properties: { ...SRC, separator: { type: 'string', default: '.', description: 'Key separator' }, keepNulls: { type: 'boolean', default: false, description: 'Keep null values instead of omitting them' }, output: { type: 'string', description: 'VFS path (default: <input>.nested.json)' } }, required: ['input'] },
  examples: ['data.unflatten input=users.csv'],
  async run(a) {
    const f = await F(); const s = await S(); const doc = await f.loadDoc(a.input, srcOpts(a));
    const strip = (o) => (a.keepNulls ? o : Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)));
    const value = Array.isArray(doc.value) ? doc.value.map((r) => s.unflatten(strip(r), { sep: a.separator })) : s.unflatten(strip(doc.value), { sep: a.separator });
    return { output: await vfs.write(vfs.out(a.output, a.input, 'nested', 'json'), JSON.stringify(value, null, 2) + '\n'), records: Array.isArray(value) ? value.length : 1 };
  },
});

const brief = (v, n = 300) => { const s = JSON.stringify(v); return s === undefined ? null : s.length <= n ? v : `${s.slice(0, n)}… (${s.length} chars of JSON)`; };
register({
  name: 'data.pick', readOnly: false,
  description: 'Pull a sub-tree out of a JSON/YAML/TOML/XML document with a JSONPath-style path. Supported: $.a.b, [0], [-1], [*], ..name (any depth), [1:4] slices, [\'a\',\'b\'] unions, and filters [?(@.price > 10 and @.tags contains \'x\')] using the data.query expression language. Returns the matches inline (first 50, long values abbreviated) and, with output, writes them as JSON.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of a json, jsonl, yaml, toml or xml file (tables load as an array of row objects)' }, format: SRC.format, path: { type: 'string', description: 'JSONPath expression, e.g. "$.store.book[?(@.price < 10)].title"' }, output: { type: 'string', description: 'Optional VFS path: writes the matched values as a JSON array (or the bare value with unwrap)' }, unwrap: { type: 'boolean', default: false, description: 'With exactly one match, write/return the value itself instead of a one-element array' } }, required: ['input', 'path'] },
  examples: ['data.pick input=pkg.json path=$.dependencies', 'data.pick input=api.json path="$.items[?(@.stars > 100)].name"'],
  async run(a) {
    const f = await F(); const s = await S(); const doc = await f.loadDoc(a.input, { format: a.format });
    const hits = s.pick(doc.value, a.path);
    const res = { count: hits.length, matches: hits.slice(0, INLINE).map((h) => ({ path: h.path, value: brief(h.value) })), truncated: hits.length > INLINE };
    if (a.output) { const vals = hits.map((h) => h.value); res.output = await vfs.write(a.output, JSON.stringify(a.unwrap && vals.length === 1 ? vals[0] : vals, null, 2) + '\n'); }
    return res;
  },
});

register({
  name: 'data.diff',
  description: 'Compare two data files. With key columns: a row-level table diff — rows added, removed and changed (per-column from → to), matched by key. Without key: a structural diff of the two parsed documents (JSON pointer path + add/remove/replace). Returns counts and the first differences inline (20 per kind); the complete diff is written to a JSON file.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the first ("before") file' }, other: { type: 'string', description: 'VFS path of the second ("after") file' },
      key: { type: 'array', items: { type: 'string' }, description: 'Key column(s) identifying a row → table diff. Omit for a structural document diff' },
      ignore: { type: 'array', items: { type: 'string' }, description: 'Table diff: columns to ignore' },
      tolerance: { type: 'number', default: 0, minimum: 0, description: 'Table diff: numbers differing by at most this are equal' },
      sheet: SRC.sheet, header: SRC.header, root: SRC.root,
      output: { type: 'string', description: 'VFS path of the full diff (default: <input>.diff.json)' },
    },
    required: ['input', 'other'],
  },
  examples: ['data.diff input=old.csv other=new.csv key=id', 'data.diff input=a.json other=b.json'],
  async run(a) {
    const f = await F(); const s = await S(); const o = { sheet: a.sheet, header: a.header, root: a.root }; const CAP = 20;
    const out = vfs.out(a.output, a.input, 'diff', 'json');
    if (a.key?.length) {
      const A_ = await f.loadTable(a.input, o); const B_ = await f.loadTable(a.other, o);
      const d = s.diffTables(A_, B_, a.key, { ignore: a.ignore || [], numericTolerance: a.tolerance });
      const stat = await vfs.write(out, JSON.stringify(d, null, 1) + '\n');
      return { mode: 'table', identical: !d.added.length && !d.removed.length && !d.changed.length && !d.columnsAdded.length && !d.columnsRemoved.length, rowsA: A_.rows.length, rowsB: B_.rows.length, added: d.added.length, removed: d.removed.length, changed: d.changed.length, unchanged: d.unchanged, columnsAdded: d.columnsAdded, columnsRemoved: d.columnsRemoved, ...(d.duplicateKeysA || d.duplicateKeysB ? { duplicateKeys: { a: d.duplicateKeysA, b: d.duplicateKeysB }, note: 'duplicate keys: only the first row per key was compared' } : {}), addedRows: d.added.slice(0, CAP), removedRows: d.removed.slice(0, CAP), changedRows: d.changed.slice(0, CAP), truncated: d.added.length > CAP || d.removed.length > CAP || d.changed.length > CAP, output: stat };
    }
    const da = await f.loadDoc(a.input, o); const db = await f.loadDoc(a.other, o);
    const d = s.diffJson(da.value, db.value);
    const stat = await vfs.write(out, JSON.stringify(d, null, 1) + '\n');
    const c = { add: 0, remove: 0, replace: 0 }; for (const x of d) c[x.op]++;
    return { mode: 'document', identical: d.length === 0, differences: d.length, added: c.add, removed: c.remove, replaced: c.replace, changes: d.slice(0, INLINE).map((x) => ({ path: x.path, op: x.op, ...('from' in x ? { from: brief(x.from, 120) } : {}), ...('to' in x ? { to: brief(x.to, 120) } : {}) })), truncated: d.length > INLINE, output: stat };
  },
});

register({
  name: 'data.validate', readOnly: true,
  description: 'Validate a JSON/YAML/TOML document (or each row of a table / each line of jsonl with each=true) against a JSON Schema. Implements a careful subset: type, enum, const, properties, required, additionalProperties, patternProperties, propertyNames, min/maxProperties, dependentRequired, dependentSchemas, items, prefixItems, min/maxItems, uniqueItems, contains, minimum/maximum (and exclusive forms), multipleOf, min/maxLength, pattern, format (date, date-time, time, email, uri, uuid, ipv4, ipv6, hostname), allOf/anyOf/oneOf/not, if/then/else, local $ref (#/…). NOT supported: remote $ref, $id/$anchor resolution, $dynamicRef, unevaluatedProperties/Items. Returns valid, the error count and the first 50 errors (JSON pointer path, keyword, message).',
  schema: {
    properties: {
      ...SRC,
      schema: { type: 'string', description: 'VFS path of the JSON Schema (json or yaml)' },
      schemaText: { type: 'string', description: 'The JSON Schema inline, as JSON text (instead of schema)' },
      each: { type: 'boolean', default: false, description: 'Validate every element of the top-level array (or every table row) separately against the schema; errors then carry an index' },
    },
    required: ['input'],
  },
  examples: ['data.validate input=users.json schema=users.schema.json', 'data.validate input=rows.csv each=true schemaText=\'{"required":["id"],"properties":{"id":{"type":"integer"}}}\''],
  async run(a) {
    const f = await F(); const s = await S();
    if ((a.schema === undefined) === (a.schemaText === undefined)) throw new Error('give exactly one of: schema (VFS path) or schemaText (inline JSON)');
    let schema; if (a.schemaText !== undefined) { try { schema = JSON.parse(a.schemaText); } catch (e) { throw new Error(`schemaText is not valid JSON (${e.message})`); } } else schema = (await f.loadDoc(a.schema)).value;
    const doc = await f.loadDoc(a.input, srcOpts(a)); let value = doc.value; if (a.root && f.isDocFormat(doc.format)) value = f.descend(value, a.root);
    let errors = []; let checked = 1;
    if (a.each) {
      if (!Array.isArray(value)) throw new Error('each=true needs a top-level array (or a table); this document is not an array — use root to point at one');
      checked = value.length;
      for (let i = 0; i < value.length && errors.length < 1000; i++) for (const e of s.validate(value[i], schema, { max: 50 })) errors.push({ index: i, ...e });
    } else errors = s.validate(value, schema, { max: 1000 });
    const unsupported = []; const scan = (x) => { if (Array.isArray(x)) x.forEach(scan); else if (x && typeof x === 'object') for (const k of Object.keys(x)) { if (['unevaluatedProperties', 'unevaluatedItems', '$dynamicRef', '$recursiveRef', '$anchor'].includes(k)) unsupported.push(k); scan(x[k]); } }; scan(schema);
    return { valid: errors.length === 0 && !unsupported.length ? true : errors.length === 0 ? null : false, checked, errorCount: errors.length, errorCountCapped: errors.length >= 1000, errors: errors.slice(0, INLINE), truncated: errors.length > INLINE, ...(unsupported.length ? { unsupportedKeywords: [...new Set(unsupported)], note: 'the schema uses keywords this validator ignores, so "valid" is null (not proven) when no other error is found' } : {}) };
  },
});

register({
  name: 'data.format',
  description: 'Pretty-print or minify JSON, JSON Lines or XML. JSON: choose the indent, optionally sort object keys recursively (stable output for diffs and hashing). XML: re-indent element-only content (mixed text content is left untouched) or strip inter-element whitespace. Returns the written file and the size before/after.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of a json, jsonl or xml file' }, format: { type: 'string', enum: ['auto', 'json', 'jsonl', 'xml'], default: 'auto', description: 'auto = by extension, then content' }, minify: { type: 'boolean', default: false, description: 'Remove all optional whitespace instead of pretty-printing' }, indent: { type: 'integer', default: 2, minimum: 1, maximum: 8, description: 'Spaces per level when pretty-printing' }, sortKeys: { type: 'boolean', default: false, description: 'JSON: sort object keys alphabetically at every level. XML: sort attributes by name' }, output: { type: 'string', description: 'VFS path (default: <input>.fmt.<ext> or <input>.min.<ext>)' } }, required: ['input'] },
  examples: ['data.format input=api.json sortKeys=true', 'data.format input=feed.xml minify=true'],
  async run(a) {
    const f = await F(); const bytes = vfs.read(a.input); let fmt = a.format === 'auto' ? f.sniffFormat(a.input, bytes) : a.format;
    if (fmt === 'html') fmt = 'xml';
    if (!['json', 'jsonl', 'xml'].includes(fmt)) throw new Error(`data.format handles json, jsonl and xml — this looks like ${fmt} (use data.convert to change formats)`);
    const text = f.decodeText(bytes); let out;
    if (fmt === 'xml') out = f.formatXml(text, { indent: a.indent, minify: a.minify, sortAttributes: a.sortKeys });
    else if (fmt === 'jsonl') out = f.parseJSONL(text).map((v) => JSON.stringify(a.sortKeys ? f.sortKeysDeep(v) : v)).join('\n') + '\n';
    else { let v; try { v = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`not valid JSON: ${e.message}`); } if (a.sortKeys) v = f.sortKeysDeep(v); out = JSON.stringify(v, null, a.minify ? 0 : a.indent) + (a.minify ? '' : '\n'); }
    const stat = await vfs.write(vfs.out(a.output, a.input, a.minify ? 'min' : 'fmt', fmt), out);
    return { output: stat, format: fmt, bytesBefore: bytes.length, bytesAfter: stat.bytes };
  },
});

register({
  name: 'data.chart',
  description: 'Draw a quick chart of table columns as a PNG (dark terminal style, labelled axes) so a vision model can look at the data. bar: one bar per category of x (values of y summed/averaged/counted per category, top N). line: y series against x (numbers, dates or ordered categories). scatter: y against numeric x. histogram: distribution of one numeric column. Up to 8 y series. Returns the PNG and the plotted ranges.',
  schema: {
    properties: {
      ...SRC,
      type: { type: 'string', enum: ['bar', 'line', 'scatter', 'histogram'], default: 'bar', description: 'Chart type' },
      x: { type: 'string', description: 'Column for the x axis / categories. histogram: the numeric column to bin. line: defaults to the row number' },
      y: { type: 'array', items: { type: 'string' }, description: 'Numeric column(s) to plot (max 8). bar without y: counts rows per category' },
      where: { type: 'string', description: 'Optional row filter (data.query expression language)' },
      agg: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'], default: 'sum', description: 'bar: how to combine rows sharing a category' },
      sort: { type: 'string', enum: ['none', 'value', 'label'], default: 'none', description: 'bar: order categories as in the data, by descending first-series value, or alphabetically' },
      limit: { type: 'integer', default: 25, minimum: 1, maximum: 100, description: 'bar: max categories drawn' },
      bins: { type: 'integer', default: 20, minimum: 2, maximum: 200, description: 'histogram: number of bins' },
      title: { type: 'string', description: 'Chart title (default: derived from the columns)' },
      width: { type: 'integer', default: 1000, minimum: 320, maximum: 4000, description: 'Image width in px' },
      height: { type: 'integer', default: 600, minimum: 200, maximum: 4000, description: 'Image height in px (bar charts grow with the number of categories unless set)' },
      output: { type: 'string', description: 'VFS path of the PNG (default: <input>.<type>.png)' },
    },
    required: ['input'],
  },
  examples: ['data.chart input=sales.csv type=bar x=region y=amount', 'data.chart input=temps.csv type=line x=date y=min,max', 'data.chart input=sales.csv type=histogram x=amount bins=30'],
  async run(a, ctx) {
    const x = await X(); const d = await D(); const { saveCanvas } = await IMG(); let t = await loadTable(a);
    if (a.where) t = { columns: t.columns, rows: x.runQuery(t, { where: a.where }).rows };
    const col = (name) => { const i = t.columns.indexOf(name); if (i < 0) throw new Error(`unknown column "${name}" — columns: ${t.columns.slice(0, 40).join(', ')}`); return i; };
    const numCols = () => t.columns.filter((_, c) => t.rows.some((r) => typeof r[c] === 'number') && t.rows.every((r) => r[c] === null || typeof r[c] === 'number'));
    if (!t.rows.length) throw new Error('no rows to plot (empty table or the where filter matched nothing)');
    let ys = a.y || []; if (ys.length > 8) throw new Error('at most 8 y series per chart — plot fewer columns');
    const out = vfs.out(a.output, a.input, a.type, 'png'); const base = { width: a.width, title: a.title }; let canvas; let info;
    const numAt = (r, c) => { const v = r[c]; return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null; };
    if (a.type === 'histogram') {
      const name = a.x || ys[0] || numCols()[0]; if (!name) throw new Error('histogram needs a numeric column: pass x=<column>');
      const c = col(name); const vals = t.rows.map((r) => numAt(r, c)).filter((v) => v !== null).sort((p, q) => p - q);
      if (!vals.length) throw new Error(`column "${name}" has no numeric values`);
      const h = histogram(vals, a.bins);
      canvas = d.histChart({ ...base, height: a.height, edges: h.edges, counts: h.counts, title: a.title || `Distribution of ${name}`, subtitle: `${vals.length} values · ${h.counts.length} bins · min ${d.fmtNum(vals[0])} · max ${d.fmtNum(vals[vals.length - 1])}`, xLabel: name });
      info = { column: name, values: vals.length, min: vals[0], max: vals[vals.length - 1], bins: h.counts.length, maxBinCount: Math.max(...h.counts) };
    } else if (a.type === 'bar') {
      const xn = a.x || t.columns.find((_, c) => t.rows.every((r) => r[c] === null || typeof r[c] !== 'number')) || t.columns[0]; const xc = col(xn);
      const yc = ys.map(col); const counting = !yc.length; const agg = counting ? 'count' : a.agg;
      const groups = new Map();
      for (const r of t.rows) { const k = r[xc] === null || r[xc] === undefined ? '(null)' : typeof r[xc] === 'object' ? JSON.stringify(r[xc]) : String(r[xc]); let g = groups.get(k); if (!g) groups.set(k, (g = { n: 0, vals: (counting ? [0] : yc).map(() => []) })); g.n++; if (!counting) yc.forEach((c, i) => { const v = numAt(r, c); if (v !== null) g.vals[i].push(v); }); }
      const reduce = (g, i) => { if (agg === 'count') return counting ? g.n : g.vals[i].length; const v = g.vals[i]; if (!v.length) return null; if (agg === 'sum') return round(v.reduce((p, q) => p + q, 0), 12); if (agg === 'avg') return round(v.reduce((p, q) => p + q, 0) / v.length, 12); return agg === 'min' ? Math.min(...v) : Math.max(...v); };
      let cats = [...groups].map(([label, g]) => ({ label, values: (counting ? [0] : yc).map((_, i) => reduce(g, i)) }));
      if (a.sort === 'value') cats.sort((p, q) => (q.values[0] ?? -Infinity) - (p.values[0] ?? -Infinity)); else if (a.sort === 'label') cats.sort((p, q) => p.label.localeCompare(q.label, undefined, { numeric: true }));
      const total = cats.length; cats = cats.slice(0, a.limit);
      const names = counting ? ['count'] : ys.map((n) => (agg === 'sum' && groups.size === t.rows.length ? n : `${agg}(${n})`));
      canvas = d.barChart({ ...base, height: a.height !== 600 ? a.height : undefined, labels: cats.map((c) => c.label), series: names.map((name, i) => ({ name, values: cats.map((c) => c.values[i]) })), title: a.title || `${names.join(', ')} by ${xn}`, subtitle: total > cats.length ? `showing ${cats.length} of ${total} categories${a.sort === 'value' ? ' (largest first)' : ''}` : `${total} categories`, xLabel: names.length === 1 ? names[0] : undefined });
      info = { x: xn, series: names, categories: total, shown: cats.length, truncated: total > cats.length, top: cats.slice(0, 5).map((c) => ({ label: c.label, values: c.values })) };
    } else {
      if (!ys.length) { ys = numCols().filter((n) => n !== a.x).slice(0, a.type === 'scatter' ? 1 : 4); if (!ys.length) throw new Error('no numeric column to plot: pass y=<column>'); }
      const yc = ys.map(col); let xs; let kind; let labels; let rows = t.rows;
      if (rows.length > 20000) { const step = Math.ceil(rows.length / 20000); rows = rows.filter((_, i) => i % step === 0); ctx.log(`downsampled ${t.rows.length} rows to ${rows.length} for plotting`); }
      if (a.x) {
        const xc = col(a.x); const raw = rows.map((r) => r[xc]); const nn = raw.filter((v) => v !== null && v !== undefined);
        if (nn.length && nn.every((v) => typeof v === 'number')) { kind = 'number'; xs = raw.map((v) => (typeof v === 'number' ? v : null)); } else if (nn.length && nn.every((v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2})?/.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T'))))) { kind = 'time'; xs = raw.map((v) => (v === null || v === undefined ? null : Date.parse(v.replace(' ', 'T') + (v.length <= 10 ? '' : /Z|[+-]\d{2}:?\d{2}$/.test(v) ? '' : 'Z')))); } else { if (a.type === 'scatter') throw new Error(`scatter needs a numeric or date x column; "${a.x}" is text — use type=bar or type=line`); kind = 'category'; xs = raw.map((_, i) => i); labels = raw.map((v) => (v === null || v === undefined ? '' : String(v))); }
      } else { if (a.type === 'scatter') throw new Error('scatter needs x=<numeric column>'); kind = 'number'; xs = rows.map((_, i) => i); }
      const series = ys.map((name, i) => ({ name, values: rows.map((r) => numAt(r, yc[i])) }));
      if (kind !== 'category' && a.type === 'line') { const order = xs.map((v, i) => i).filter((i) => xs[i] !== null).sort((p, q) => xs[p] - xs[q]); xs = order.map((i) => xs[i]); for (const s of series) s.values = order.map((i) => s.values[i]); }
      canvas = d.xyChart({ ...base, height: a.height, kind: a.type, x: { kind, values: xs, labels }, series, title: a.title || `${ys.join(', ')} ${a.type === 'scatter' ? 'vs' : 'by'} ${a.x || 'row'}`, subtitle: `${rows.length} points${rows.length < t.rows.length ? ` (downsampled from ${t.rows.length})` : ''}`, xLabel: a.x || 'row', yLabel: ys.length === 1 ? ys[0] : undefined });
      const flat = series.flatMap((s) => s.values.filter((v) => v !== null));
      info = { x: a.x || '(row number)', xKind: kind, series: ys, points: rows.length, yMin: flat.length ? Math.min(...flat.slice(0, 100000)) : null, yMax: flat.length ? Math.max(...flat.slice(0, 100000)) : null };
      if (a.type === 'scatter' && kind === 'number') info.correlation = pearson(xs, series[0].values);
    }
    return { output: await saveCanvas(canvas, out), type: a.type, ...info };
  },
});

register({
  name: 'data.sheets', readOnly: true,
  description: 'List the worksheets of an .xlsx workbook: name, index, visibility, used rows and columns, used range, non-empty cell count and number of formula cells. Use it before data.head / data.convert with sheet=… .',
  schema: { properties: { input: { type: 'string', description: 'VFS path of an .xlsx/.xlsm file' } }, required: ['input'] },
  examples: ['data.sheets input=book.xlsx'],
  async run(a) {
    const f = await F(); const x = await f.libXlsx(); const wb = await x.readWorkbook(vfs.read(a.input), { all: true });
    return { count: wb.sheets.length, date1904: wb.date1904, sheets: wb.sheets.slice(0, 200), truncated: wb.sheets.length > 200 };
  },
});

// ══════════════════════════════════════════════════════════ archive ══
const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
const isGz = (b) => b.length >= 3 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8;
const MAXB = { type: 'integer', default: 268435456, minimum: 1, maximum: 2147483647, description: 'Refuse to produce more than this many decompressed bytes in total (zip-bomb guard; default 256 MiB)' };
/** open any supported archive → {format, entries:[{name, dir, size, …}], read(entry, budget) → bytes} */
async function openArchive(path, maxBytes) {
  const ar = await A(); let b = vfs.read(path); let format;
  if (isZip(b)) {
    const entries = ar.zipEntries(b);
    return { format: 'zip', entries, compressedBytes: b.length, read: (e, budget) => ar.zipRead(b, e, budget) };
  }
  if (isGz(b)) {
    try { b = await ar.guardedInflate(b, maxBytes, 'gunzip'); } catch (e) { if (e instanceof ar.LimitError) throw new Error(`refusing to decompress: the gzip stream expands past maxBytes=${maxBytes} (possible decompression bomb) — raise maxBytes if you trust the file`); throw new Error(`gzip: ${e.message}`); }
    if (!ar.isTar(b)) { const name = vfs.stemOf(path) + (/\.t?gz$/i.test(path) && vfs.extOf(vfs.stemOf(path)) === '' && !/\./.test(vfs.stemOf(path)) ? '' : ''); const data = b; return { format: 'gzip', entries: [{ name: path.replace(/^.*\//, '').replace(/\.gz$/i, '') || name, dir: false, size: data.length, compressedSize: vfs.stat(path).bytes, type: 'file' }], compressedBytes: vfs.stat(path).bytes, read: async () => data }; }
    format = 'tar.gz';
  } else if (ar.isTar(b)) format = 'tar';
  else throw new Error(`"${path}" is not a zip, tar, tar.gz or gzip file (use file.identify to see what it is; 7z, rar, xz, bzip2 and zstd are not supported)`);
  const entries = ar.tarEntries(b); const bytes = b;
  return { format, entries, compressedBytes: vfs.stat(path).bytes, read: async (e, budget) => { if (e.size > budget) throw new ar.LimitError('limit'); if (e.dataOffset + e.size > bytes.length) throw new Error('entry data runs past the end of the archive (truncated tar)'); return bytes.slice(e.dataOffset, e.dataOffset + e.size); } };
}
register({
  name: 'archive.list', readOnly: true,
  description: 'List the entries of a zip, tar, tar.gz/tgz or gzip file without extracting: name, size, compressed size, method, modified time, plus flags for directories, encrypted entries and unsafe names (path traversal). Returns totals, the compression ratio and the first 50 entries (filter with glob); pass output to write the full listing as JSON.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of the archive' }, glob: { type: 'array', items: { type: 'string' }, description: 'Only entries matching these globs (* ? ** {a,b}); a pattern without "/" matches base names' }, limit: { type: 'integer', default: INLINE, minimum: 1, maximum: 500, description: 'Entries to return inline' }, maxBytes: MAXB, output: { type: 'string', description: 'Optional VFS path for the complete listing (JSON)' } }, required: ['input'] },
  examples: ['archive.list input=site.zip', 'archive.list input=src.tar.gz glob=*.js'],
  async run(a) {
    const ar = await A(); const arc = await openArchive(a.input, a.maxBytes); const match = ar.globMatcher(a.glob);
    const all = arc.entries.filter((e) => match(e.name.replace(/\\/g, '/').replace(/\/$/, '')));
    const view = all.map((e) => { const sp = ar.safePath(e.name); return { name: e.name, ...(e.dir ? { dir: true } : { size: e.size }), ...(e.compressedSize !== undefined && !e.dir ? { compressedSize: e.compressedSize } : {}), ...(e.method && e.method !== 'deflate' && !e.dir ? { method: e.method } : {}), ...(e.modified ? { modified: e.modified } : {}), ...(e.encrypted ? { encrypted: true } : {}), ...(e.symlink || e.type === 'symlink' ? { symlink: true } : {}), ...(e.type && !['file', 'dir', 'symlink'].includes(e.type) ? { type: e.type } : {}), ...(sp.reason ? { unsafe: sp.reason } : {}) }; });
    const files = all.filter((e) => !e.dir); const total = files.reduce((s, e) => s + e.size, 0);
    const res = { format: arc.format, entries: all.length, files: files.length, directories: all.length - files.length, totalBytes: total, archiveBytes: arc.compressedBytes, ratio: arc.compressedBytes ? round(total / arc.compressedBytes, 4) : null, unsafeNames: view.filter((v) => v.unsafe).length, encrypted: view.filter((v) => v.encrypted).length, list: view.slice(0, a.limit), truncated: view.length > a.limit };
    if (a.output) res.output = await vfs.write(a.output, JSON.stringify(view, null, 1) + '\n');
    return res;
  },
});
register({
  name: 'archive.extract',
  description: 'Extract a zip, tar, tar.gz/tgz or gzip file into the VFS under a prefix — everything, or only entries matching globs. Safe by construction: entries whose names contain ".." or a drive letter are refused (zip-slip) and reported, leading "/" is stripped, CRCs are verified, and extraction stops before exceeding maxBytes / maxFiles (zip-bomb guard, enforced on the real inflated size, not the declared one). Returns the extracted files (first 50), counts and anything refused or failed.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the archive' },
      prefix: { type: 'string', description: 'VFS prefix to extract under (default: "<archive name>/"; "" = VFS root)' },
      glob: { type: 'array', items: { type: 'string' }, description: 'Only extract entries matching these globs, e.g. ["*.csv", "docs/**"]' },
      maxBytes: MAXB,
      maxFiles: { type: 'integer', default: 5000, minimum: 1, maximum: 100000, description: 'Refuse to extract more files than this' },
      strict: { type: 'boolean', default: false, description: 'Fail the whole call if any entry has an unsafe name or cannot be read (default: skip it and report it)' },
      flatten: { type: 'boolean', default: false, description: 'Drop directories and extract by base name' },
    },
    required: ['input'],
  },
  examples: ['archive.extract input=site.zip', 'archive.extract input=data.tar.gz glob=*.csv prefix=csv/'],
  async run(a, ctx) {
    const ar = await A(); const arc = await openArchive(a.input, a.maxBytes); const match = ar.globMatcher(a.glob);
    let prefix = a.prefix !== undefined ? a.prefix : `${vfs.stemOf(a.input).replace(/\.tar$/i, '')}/`; if (prefix && !prefix.endsWith('/')) prefix += '/';
    const sel = arc.entries.filter((e) => !e.dir && (e.type === undefined || e.type === 'file') && match(e.name.replace(/\\/g, '/')));
    const skippedLinks = arc.entries.filter((e) => e.type && !['file', 'dir'].includes(e.type)).length;
    if (sel.length > a.maxFiles) throw new Error(`refusing to extract: ${sel.length} files exceed maxFiles=${a.maxFiles} — narrow with glob or raise maxFiles`);
    const declared = sel.reduce((s, e) => s + e.size, 0);
    if (declared > a.maxBytes) throw new Error(`refusing to extract: entries declare ${declared} bytes, more than maxBytes=${a.maxBytes} (possible zip bomb) — narrow with glob or raise maxBytes`);
    const outputs = []; const refused = []; const failed = []; let budget = a.maxBytes; let total = 0; const used = new Set();
    for (const [i, e] of sel.entries()) {
      const sp = ar.safePath(e.name);
      if (sp.reason) { if (a.strict) throw new Error(`unsafe entry name "${e.name}": ${sp.reason} — nothing further extracted (strict=true)`); refused.push({ name: e.name, reason: sp.reason }); continue; }
      let rel = a.flatten ? sp.path.split('/').pop() : sp.path;
      if (used.has(rel)) { const ext = vfs.extOf(rel); const stem = ext ? rel.slice(0, -ext.length - 1) : rel; let k = 2; while (used.has(ext ? `${stem}-${k}.${ext}` : `${stem}-${k}`)) k++; rel = ext ? `${stem}-${k}.${ext}` : `${stem}-${k}`; }
      used.add(rel);
      let data;
      try { data = await arc.read(e, budget); } catch (err) {
        if (err instanceof ar.LimitError) throw new Error(`refusing to continue: "${e.name}" inflates past the remaining budget (maxBytes=${a.maxBytes}); its declared size was ${e.size} — possible zip bomb. ${outputs.length} file(s) were extracted before stopping`);
        if (a.strict) throw new Error(`cannot extract "${e.name}": ${err.message}`);
        failed.push({ name: e.name, error: err.message }); continue;
      }
      budget -= data.length; total += data.length;
      outputs.push(await vfs.write(prefix + rel, data));
      if (i % 50 === 0) ctx.progress((i + 1) / sel.length, e.name);
    }
    return { format: arc.format, extracted: outputs.length, totalBytes: total, prefix, outputs: outputs.slice(0, INLINE), truncated: outputs.length > INLINE, ...(refused.length ? { refused: refused.slice(0, INLINE), refusedCount: refused.length } : {}), ...(failed.length ? { failed: failed.slice(0, INLINE), failedCount: failed.length } : {}), ...(skippedLinks ? { skippedLinks, note: 'symlinks/hardlinks/devices in the tar were not extracted' } : {}) };
  },
});
register({
  name: 'archive.create',
  description: 'Create a zip, tar or tar.gz archive from VFS files: explicit paths and/or everything under a prefix. Entry names are the VFS paths with stripPrefix removed. Returns the archive file, entry count and compression ratio.',
  schema: {
    properties: {
      inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths to add' },
      prefix: { type: 'string', description: 'Also add every VFS file whose path starts with this prefix' },
      output: { type: 'string', default: 'archive.zip', description: 'VFS path of the archive; .zip, .tar, .tar.gz or .tgz decides the format' },
      format: { type: 'string', enum: ['auto', 'zip', 'tar', 'tar.gz'], default: 'auto', description: 'auto = from the output extension (zip when unknown)' },
      level: { type: 'integer', default: 6, minimum: 0, maximum: 9, description: 'Deflate level: 0 = store, 9 = smallest' },
      stripPrefix: { type: 'string', description: 'Remove this leading text from entry names (default: the prefix argument, when only prefix is used)' },
    },
  },
  examples: ['archive.create prefix=out/ output=out.zip', 'archive.create inputs=a.csv,b.csv output=data.tar.gz level=9'],
  async run(a) {
    const f = await (await F()).libFflate(); const ar = await A();
    const paths = [...new Set([...(a.inputs || []), ...(a.prefix !== undefined ? vfs.list(a.prefix).map((s) => s.path) : [])])].filter((p) => p !== a.output);
    if (!paths.length) throw new Error('nothing to archive: give inputs (VFS paths) and/or a prefix that matches files');
    const format = a.format !== 'auto' ? a.format : /\.(tar\.gz|tgz)$/i.test(a.output) ? 'tar.gz' : /\.tar$/i.test(a.output) ? 'tar' : 'zip';
    const strip = a.stripPrefix ?? (a.prefix && !a.inputs?.length ? a.prefix : '');
    const names = new Set(); const items = paths.map((p) => { const st = vfs.stat(p); let name = (strip && st.path.startsWith(strip) ? st.path.slice(strip.length) : st.path).replace(/^\/+/, ''); if (!name) name = st.path.split('/').pop(); if (names.has(name)) throw new Error(`two inputs map to the same entry name "${name}" — adjust stripPrefix`); names.add(name); return { name, data: vfs.read(p) }; });
    const total = items.reduce((s, i) => s + i.data.length, 0); let bytes;
    if (format === 'zip') { const tree = {}; for (const i of items) tree[i.name] = [i.data, { level: a.level }]; bytes = f.zipSync(tree, { level: a.level }); } else { bytes = ar.tarCreate(items); if (format === 'tar.gz') bytes = f.gzipSync(bytes, { level: a.level }); }
    const stat = await vfs.write(a.output, bytes, { mime: format === 'zip' ? 'application/zip' : format === 'tar' ? 'application/x-tar' : 'application/gzip' });
    return { output: stat, format, entries: items.length, totalBytes: total, ratio: bytes.length ? round(total / bytes.length, 4) : null, names: items.slice(0, 20).map((i) => i.name), truncated: items.length > 20 };
  },
});
register({
  name: 'archive.gzip',
  description: 'Compress one VFS file with gzip (or a raw zlib / deflate stream). Returns the compressed file and the ratio.',
  schema: { properties: { input: { type: 'string', description: 'VFS path to compress' }, output: { type: 'string', description: 'VFS path (default: <input>.gz, .zz for zlib, .deflate for raw deflate)' }, level: { type: 'integer', default: 6, minimum: 0, maximum: 9, description: 'Compression level (9 = smallest)' }, format: { type: 'string', enum: ['gzip', 'zlib', 'deflate'], default: 'gzip', description: 'Container: gzip (RFC 1952), zlib (RFC 1950) or raw deflate (RFC 1951)' } }, required: ['input'] },
  examples: ['archive.gzip input=big.json level=9'],
  async run(a) {
    const f = await (await F()).libFflate(); const src = vfs.read(a.input); const st = vfs.stat(a.input);
    const out = a.format === 'gzip' ? f.gzipSync(src, { level: a.level, filename: st.path.split('/').pop() }) : a.format === 'zlib' ? f.zlibSync(src, { level: a.level }) : f.deflateSync(src, { level: a.level });
    const path = a.output || `${st.path}.${{ gzip: 'gz', zlib: 'zz', deflate: 'deflate' }[a.format]}`;
    return { output: await vfs.write(path, out, { mime: a.format === 'gzip' ? 'application/gzip' : 'application/octet-stream' }), format: a.format, inputBytes: src.length, ratio: out.length ? round(src.length / out.length, 4) : null };
  },
});
register({
  name: 'archive.gunzip',
  description: 'Decompress a gzip file (or a zlib / raw deflate stream) into one VFS file, stopping with an error if the output would exceed maxBytes (decompression-bomb guard). For .tar.gz use archive.extract instead. Returns the decompressed file and what it looks like.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of the compressed file' }, output: { type: 'string', description: 'VFS path (default: input without .gz/.zz, or <input>.out)' }, format: { type: 'string', enum: ['auto', 'gzip', 'zlib', 'deflate'], default: 'auto', description: 'auto = detect gzip/zlib by header, else raw deflate' }, maxBytes: MAXB }, required: ['input'] },
  examples: ['archive.gunzip input=big.json.gz'],
  async run(a) {
    const ar = await A(); const g = await G(); const src = vfs.read(a.input); const st = vfs.stat(a.input);
    const fmt = a.format !== 'auto' ? a.format : isGz(src) ? 'gzip' : src.length > 1 && (src[0] & 15) === 8 && ((src[0] << 8) | src[1]) % 31 === 0 ? 'zlib' : 'deflate';
    let out; try { out = await ar.guardedInflate(src, a.maxBytes, { gzip: 'gunzip', zlib: 'unzlib', deflate: 'inflate' }[fmt]); } catch (e) { if (e instanceof ar.LimitError) throw new Error(`refusing to decompress: output exceeds maxBytes=${a.maxBytes} (possible decompression bomb) — raise maxBytes if you trust the file`); throw new Error(`${fmt}: ${e.message}`); }
    const path = a.output || (/\.(gz|zz|zlib|deflate)$/i.test(st.path) ? st.path.replace(/\.(gz|zz|zlib|deflate)$/i, '') : `${st.path}.out`);
    const id = g.identify(out);
    return { output: await vfs.write(path, out, vfs.extOf(path) ? {} : { mime: id.mime }), format: fmt, inputBytes: src.length, ratio: src.length ? round(out.length / src.length, 4) : null, contains: id.format, ...(id.format === 'tar' ? { note: 'this is a tar archive — archive.extract reads .tar.gz directly' } : {}) };
  },
});

// ═════════════════════════════════════════════════════════════ hash ══
const ALGOS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512', 'crc32', 'adler32', 'xxh32', 'xxh64', 'blake3'];
const outEnc = (bytes, e) => (e === 'base64' ? b64.enc(bytes) : e === 'base64url' ? b64.enc(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : hexOf(bytes));
register({
  name: 'hash.digest', readOnly: true,
  description: 'Hash a VFS file or inline text. Algorithms: md5, sha1, sha256, sha384, sha512 (cryptographic family), blake3 (256-bit), and the checksums crc32 (zip/png polynomial), adler32, xxh32, xxh64 (seed 0). Several algorithms can be computed in one call. Returns each digest as hex (or base64). Use hash.verify to compare against an expected value.',
  schema: { properties: { ...BYTES_SRC, algorithm: { type: 'array', items: { type: 'string' }, default: ['sha256'], description: `One or more of: ${ALGOS.join(', ')}; or "all"` }, encoding: { type: 'string', enum: ['hex', 'base64', 'base64url'], default: 'hex', description: 'Digest text encoding' }, offset: { type: 'integer', default: 0, minimum: 0, description: 'Hash only from this byte offset' }, length: { type: 'integer', minimum: 0, description: 'Hash only this many bytes (default: to the end)' } } },
  examples: ['hash.digest input=file.bin', 'hash.digest text=abc algorithm=md5,sha1,crc32'],
  async run(a) {
    const h = await H(); let { bytes } = source(a);
    if (a.offset || a.length !== undefined) bytes = bytes.subarray(a.offset, a.length !== undefined ? a.offset + a.length : undefined);
    const algos = a.algorithm.length === 1 && a.algorithm[0].toLowerCase() === 'all' ? ALGOS : [...new Set(a.algorithm.map(h.algoName))];
    const digests = {}; for (const al of algos) digests[al] = outEnc(await h.digest(al, bytes), a.encoding);
    return { bytes: bytes.length, encoding: a.encoding, digests };
  },
});
const keyBytes = async (key, e) => { if (e === 'hex') return (await H()).fromHex(key); if (e === 'base64') { try { return b64.dec(key.replace(/-/g, '+').replace(/_/g, '/')); } catch { throw new Error('key is not valid base64'); } } return enc.encode(key); };
register({
  name: 'hash.hmac', readOnly: true,
  description: 'HMAC (RFC 2104) of a VFS file or inline text with a secret key, over md5, sha1, sha256, sha384 or sha512. Returns the MAC as hex or base64. Use it to sign or check webhook payloads and API requests.',
  schema: { properties: { ...BYTES_SRC, key: { type: 'string', description: 'The secret key' }, keyEncoding: { type: 'string', enum: ['text', 'hex', 'base64'], default: 'text', description: 'How the key string is encoded' }, algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha384', 'sha512'], default: 'sha256', description: 'Underlying hash' }, encoding: { type: 'string', enum: ['hex', 'base64', 'base64url'], default: 'hex', description: 'MAC text encoding' } }, required: ['key'] },
  examples: ['hash.hmac text="payload" key=secret'],
  async run(a) { const h = await H(); const { bytes } = source(a); return { algorithm: `hmac-${a.algorithm}`, bytes: bytes.length, encoding: a.encoding, mac: outEnc(await h.hmac(a.algorithm, await keyBytes(a.key, a.keyEncoding), bytes), a.encoding) }; },
});
register({
  name: 'hash.verify', readOnly: true,
  description: 'Check a VFS file or inline text against an expected digest (hex or base64; "sha256:…" prefixes and surrounding whitespace are tolerated). The algorithm is inferred from the digest length when omitted (8 hex = crc32, 16 = xxh64, 32 = md5, 40 = sha1, 64 = sha256, 96 = sha384, 128 = sha512). Returns match true/false with both values.',
  schema: { properties: { ...BYTES_SRC, expected: { type: 'string', description: 'Expected digest, hex or base64' }, algorithm: { type: 'string', description: `One of ${ALGOS.join(', ')} (default: inferred from the digest length; ambiguous 8/64-hex lengths assume crc32/sha256)` } }, required: ['expected'] },
  examples: ['hash.verify input=setup.exe expected=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  async run(a) {
    const h = await H(); const { bytes } = source(a); let exp = a.expected.trim(); let algo = a.algorithm;
    const pre = /^([a-z0-9-]+)[:=]\s*(.+)$/i.exec(exp); if (pre && ALGOS.includes(pre[1].toLowerCase().replace(/-/g, ''))) { algo ||= pre[1].replace(/-/g, ''); exp = pre[2].trim(); }
    exp = exp.split(/\s+/)[0];
    let want; const isHex = /^[0-9a-f]+$/i.test(exp) && exp.length % 2 === 0;
    if (isHex) want = h.fromHex(exp); else { try { want = b64.dec(exp.replace(/-/g, '+').replace(/_/g, '/')); } catch { throw new Error('expected digest is neither hex nor base64'); } }
    if (!algo) { algo = { 4: 'crc32', 8: 'xxh64', 16: 'md5', 20: 'sha1', 32: 'sha256', 48: 'sha384', 64: 'sha512' }[want.length]; if (!algo) throw new Error(`cannot infer the algorithm from a ${want.length}-byte digest — pass algorithm=<${ALGOS.join('|')}>`); }
    algo = h.algoName(algo); const got = await h.digest(algo, bytes);
    let diff = got.length ^ want.length; for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
    return { match: diff === 0, algorithm: algo, expected: hexOf(want), actual: hexOf(got), bytes: bytes.length, ...(got.length !== want.length ? { note: `expected digest is ${want.length} bytes but ${algo} produces ${got.length}` } : {}) };
  },
});
register({
  name: 'hash.uuid', readOnly: true,
  description: 'Generate UUIDs from the browser CSPRNG: version 4 (random) or version 7 (Unix-millisecond timestamp prefix, sortable by creation time; RFC 9562). Returns up to 100 at once.',
  schema: { properties: { version: { type: 'integer', enum: [4, 7], default: 4, description: '4 = random, 7 = time-ordered' }, count: { type: 'integer', default: 1, minimum: 1, maximum: 100, description: 'How many' }, uppercase: { type: 'boolean', default: false, description: 'Upper-case hex' } } },
  examples: ['hash.uuid', 'hash.uuid version=7 count=5'],
  run(a) {
    const uuids = []; let last = 0;
    for (let i = 0; i < a.count; i++) {
      const b = crypto.getRandomValues(new Uint8Array(16));
      if (a.version === 7) { let ms = Date.now(); if (ms <= last) ms = last; last = ms; b[0] = Math.floor(ms / 2 ** 40) & 255; b[1] = Math.floor(ms / 2 ** 32) & 255; b[2] = (ms >>> 24) & 255; b[3] = (ms >>> 16) & 255; b[4] = (ms >>> 8) & 255; b[5] = ms & 255; if (i) { b[6] = (i >> 8) & 15; b[7] = i & 255; } }
      b[6] = (b[6] & 0x0f) | (a.version << 4); b[8] = (b[8] & 0x3f) | 0x80;
      const h = hexOf(b); const u = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; uuids.push(a.uppercase ? u.toUpperCase() : u);
    }
    return { version: a.version, uuids };
  },
});
register({
  name: 'hash.random',
  description: 'Cryptographically secure random bytes from the browser CSPRNG (crypto.getRandomValues) — for keys, salts, nonces, tokens or test files. Returns them inline as hex/base64 (up to 4096 bytes), or writes a binary file when output is given (up to 64 MiB).',
  schema: { properties: { bytes: { type: 'integer', default: 32, minimum: 1, maximum: 67108864, description: 'Number of random bytes' }, encoding: { type: 'string', enum: ['hex', 'base64', 'base64url'], default: 'hex', description: 'Inline text encoding' }, output: { type: 'string', description: 'Write the raw bytes to this VFS path instead of returning them inline' } } },
  examples: ['hash.random bytes=32 encoding=base64url', 'hash.random bytes=1048576 output=noise.bin'],
  async run(a) {
    if (!a.output && a.bytes > 4096) throw new Error('more than 4096 random bytes must go to a file: pass output=<path>');
    const b = new Uint8Array(a.bytes); for (let o = 0; o < b.length; o += 65536) crypto.getRandomValues(b.subarray(o, Math.min(b.length, o + 65536)));
    return a.output ? { output: await vfs.write(a.output, b, { mime: 'application/octet-stream' }) } : { bytes: a.bytes, encoding: a.encoding, value: outEnc(b, a.encoding) };
  },
});

// ═══════════════════════════════════════════════════════════ encode ══
const CODEC_SRC = { input: { type: 'string', description: 'VFS path to read (file → file: the result is written to output)' }, text: { type: 'string', description: 'Inline text to encode, or inline encoded text to decode (instead of input)' }, decode: { type: 'boolean', default: false, description: 'false = encode, true = decode' }, output: { type: 'string', description: 'VFS path to write. Default: derived from input for files; inline text returns the result inline (written to a file only when larger than 64 KiB)' } };
const strictUtf8 = (bytes) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; } };
/** register a text codec: encode(bytes, args) → string, decode(string, args) → bytes */
function codec({ name, description, tag, props = {}, examples, encode, decode }) {
  register({
    name, description, examples,
    schema: { properties: { ...CODEC_SRC, ...props } },
    async run(a) {
      const src = source(a); let outBytes; let outText;
      if (a.decode) { outBytes = await decode(new TextDecoder().decode(src.bytes), a); outText = strictUtf8(outBytes); } else { outText = await encode(src.bytes, a); outBytes = enc.encode(outText); }
      const res = { operation: a.decode ? 'decode' : 'encode', inputBytes: src.bytes.length, outputBytes: outBytes.length };
      if (a.output || src.from === 'file' || outBytes.length > 65536) {
        const path = a.output || (src.from === 'file' ? vfs.out(undefined, a.input, a.decode ? 'decoded' : tag, a.decode ? (outText === null ? 'bin' : 'txt') : 'txt') : vfs.unique(`${tag}.${a.decode ? 'decoded' : 'encoded'}`, a.decode && outText === null ? 'bin' : 'txt'));
        res.output = await vfs.write(path, outBytes, vfs.extOf(path) ? {} : { mime: outText === null ? 'application/octet-stream' : 'text/plain' });
        if (outText !== null && outText.length <= 200) res.text = outText;
      } else if (outText !== null) res.text = outText;
      else { res.binary = true; res.hex = hexOf(outBytes.subarray(0, 4096)); if (outBytes.length > 4096) res.truncated = true; res.note = 'decoded bytes are not valid UTF-8 text — shown as hex; pass output=<path> to save them as a file'; }
      return res;
    },
  });
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; const B32HEX = '0123456789ABCDEFGHIJKLMNOPQRSTUV'; const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
codec({
  name: 'encode.base64', tag: 'b64',
  description: 'Base64 encode or decode (RFC 4648), standard or URL-safe alphabet, with or without padding. Works file → file or on inline text. Decoding tolerates whitespace, missing padding, either alphabet and a data: URL prefix. Returns the result inline for inline text, or the written file.',
  props: { variant: { type: 'string', enum: ['standard', 'url'], default: 'standard', description: 'Alphabet when encoding: standard (+/) or url (-_)' }, pad: { type: 'boolean', default: true, description: 'Emit = padding when encoding (url variant usually omits it)' }, wrap: { type: 'integer', default: 0, minimum: 0, maximum: 1000, description: 'Insert a newline every N characters when encoding (0 = none; 76 = MIME)' } },
  examples: ['encode.base64 text=hello', 'encode.base64 decode=true text=aGVsbG8=', 'encode.base64 input=logo.png output=logo.b64'],
  encode(bytes, a) { let s = b64.enc(bytes); if (a.variant === 'url') s = s.replace(/\+/g, '-').replace(/\//g, '_'); if (!a.pad) s = s.replace(/=+$/, ''); if (a.wrap) s = s.replace(new RegExp(`(.{${a.wrap}})(?=.)`, 'g'), '$1\n'); return s; },
  decode(text) { let s = text.replace(/^data:[^,]*,/, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''); if (/[^A-Za-z0-9+/]/.test(s)) throw new Error(`not base64: unexpected character "${/[^A-Za-z0-9+/]/.exec(s)[0]}"`); if (s.length % 4 === 1) throw new Error('not base64: impossible length (a 4-character group has only 1 character)'); s += '='.repeat((4 - (s.length % 4)) % 4); return b64.dec(s); },
});
codec({
  name: 'encode.base32', tag: 'b32',
  description: 'Base32 encode or decode (RFC 4648): the standard A–Z2–7 alphabet (TOTP secrets, onion addresses) or base32hex. File → file or inline. Decoding is case-insensitive and ignores padding, spaces and dashes.',
  props: { variant: { type: 'string', enum: ['standard', 'hex'], default: 'standard', description: 'Alphabet: standard (A-Z2-7) or hex (0-9A-V)' }, pad: { type: 'boolean', default: true, description: 'Emit = padding when encoding' } },
  examples: ['encode.base32 text=hello', 'encode.base32 decode=true text=NBSWY3DP'],
  encode(bytes, a) { const al = a.variant === 'hex' ? B32HEX : B32; let out = ''; let bits = 0; let v = 0; for (const b of bytes) { v = (v << 8) | b; bits += 8; while (bits >= 5) { out += al[(v >>> (bits - 5)) & 31]; bits -= 5; } v &= (1 << bits) - 1; } if (bits) out += al[(v << (5 - bits)) & 31]; if (a.pad) out += '='.repeat((8 - (out.length % 8)) % 8); return out; },
  decode(text, a) { const al = a.variant === 'hex' ? B32HEX : B32; const s = text.toUpperCase().replace(/[\s=-]/g, ''); const out = new Uint8Array(Math.floor((s.length * 5) / 8)); let bits = 0; let v = 0; let o = 0; for (const ch of s) { const i = al.indexOf(ch); if (i < 0) throw new Error(`not base32 (${a.variant}): unexpected character "${ch}"`); v = (v << 5) | i; bits += 5; if (bits >= 8) { out[o++] = (v >>> (bits - 8)) & 255; bits -= 8; } v &= (1 << bits) - 1; } return out.subarray(0, o); },
});
codec({
  name: 'encode.base58', tag: 'b58',
  description: 'Base58 encode or decode with the Bitcoin alphabet (no 0, O, I, l) — as used by Bitcoin/Solana addresses and IPFS CIDv0. No checksum is added or verified (this is plain Base58, not Base58Check). Input is limited to 64 KiB. File → file or inline.',
  examples: ['encode.base58 text=hello', 'encode.base58 decode=true text=Cn8eVZg'],
  encode(bytes) { if (bytes.length > 65536) throw new Error('base58 input is limited to 64 KiB'); let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++; const digits = []; for (let i = zeros; i < bytes.length; i++) { let carry = bytes[i]; for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; } while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; } } let s = '1'.repeat(zeros); for (let i = digits.length - 1; i >= 0; i--) s += B58[digits[i]]; return s; },
  decode(text) { const s = text.replace(/\s+/g, ''); if (s.length > 90000) throw new Error('base58 input is limited to ~64 KiB of decoded data'); let zeros = 0; while (zeros < s.length && s[zeros] === '1') zeros++; const out = []; for (let i = zeros; i < s.length; i++) { let carry = B58.indexOf(s[i]); if (carry < 0) throw new Error(`not base58: unexpected character "${s[i]}"`); for (let j = 0; j < out.length; j++) { carry += out[j] * 58; out[j] = carry & 255; carry >>= 8; } while (carry) { out.push(carry & 255); carry >>= 8; } } const res = new Uint8Array(zeros + out.length); for (let i = 0; i < out.length; i++) res[zeros + i] = out[out.length - 1 - i]; return res; },
});
codec({
  name: 'encode.hex', tag: 'hex',
  description: 'Hex (base16) encode or decode. Encoding options: upper case and a separator between bytes. Decoding ignores whitespace, colons, commas, dashes and 0x prefixes. File → file or inline.',
  props: { uppercase: { type: 'boolean', default: false, description: 'Upper-case digits when encoding' }, separator: { type: 'string', default: '', description: 'Text between bytes when encoding, e.g. " " or ":"' } },
  examples: ['encode.hex text=hello', 'encode.hex decode=true text="68 65 6c 6c 6f"'],
  encode(bytes, a) { let s; if (a.separator) { const parts = new Array(bytes.length); for (let i = 0; i < bytes.length; i++) parts[i] = hex2(bytes[i]); s = parts.join(a.separator); } else s = hexOf(bytes); return a.uppercase ? s.toUpperCase() : s; },
  async decode(text) { return (await H()).fromHex(text); },
});
codec({
  name: 'encode.url', tag: 'url',
  description: 'Percent-encode or decode text for URLs. mode=component (default) escapes everything except unreserved characters (use for one query value or path segment); mode=form is the same with spaces as "+" (application/x-www-form-urlencoded); mode=uri keeps URL structure characters (:/?#&=) intact. Decoding handles any of them. Inline or file → file.',
  props: { mode: { type: 'string', enum: ['component', 'form', 'uri'], default: 'component', description: 'Encoding flavour' } },
  examples: ['encode.url text="a b&c=d/é"', 'encode.url decode=true text=a%20b%26c'],
  encode(bytes, a) { const s = strictUtf8(bytes); if (s === null) { let out = ''; for (const b of bytes) out += (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e ? String.fromCharCode(b) : `%${hex2(b).toUpperCase()}`; return out; } if (a.mode === 'uri') return encodeURI(s); const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`); return a.mode === 'form' ? e.replace(/%20/g, '+') : e; },
  decode(text, a) { const s = a.mode === 'form' ? text.replace(/\+/g, ' ') : text; const out = []; for (let i = 0; i < s.length; i++) { if (s[i] === '%') { const h = s.slice(i + 1, i + 3); if (!/^[0-9a-fA-F]{2}$/.test(h)) throw new Error(`bad percent-escape "${s.slice(i, i + 3)}" at position ${i}`); out.push(parseInt(h, 16)); i += 2; } else for (const b of enc.encode(s[i] >= '\ud800' && s[i] <= '\udbff' ? s[i] + s[++i] : s[i])) out.push(b); } return Uint8Array.from(out); },
});
codec({
  name: 'encode.html', tag: 'html',
  description: 'Escape text for safe inclusion in HTML (& < > " \' → entities; optionally every non-ASCII character as a numeric reference), or decode HTML entities back to text (all named entities like &eacute; &nbsp; &hellip; plus numeric &#233; / &#xE9;). Decoding does not strip tags. Inline or file → file.',
  props: { nonAscii: { type: 'boolean', default: false, description: 'When encoding, also write non-ASCII characters as &#N; references' } },
  examples: ['encode.html text="<a href=\\"x\\">Tom & Jerry</a>"', 'encode.html decode=true text="caf&eacute; &lt;b&gt;"'],
  encode(bytes, a) { let s = new TextDecoder().decode(bytes).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); if (a.nonAscii) s = s.replace(/[^\x00-\x7f]/gu, (c) => `&#${c.codePointAt(0)};`); return s; },
  decode(text) { const doc = new DOMParser().parseFromString(`<!doctype html><body><textarea>${text.replace(/</g, '&lt;')}</textarea>`, 'text/html'); return enc.encode(doc.querySelector('textarea').value); },
});

register({
  name: 'encode.jwt', readOnly: true,
  description: 'Decode a JSON Web Token: header, payload (claims), signature length, and the time claims (iat, nbf, exp) as ISO timestamps with an expired flag. The signature is NOT verified — this only reads the token; never trust its claims on that basis.',
  schema: { properties: { token: { type: 'string', description: 'The JWT (three base64url parts separated by dots; a "Bearer " prefix is tolerated)' }, input: { type: 'string', description: 'VFS path of a file containing the token (instead of token)' } } },
  examples: ['encode.jwt token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
  run(a) {
    if ((a.token === undefined) === (a.input === undefined)) throw new Error('give exactly one of: token or input');
    const tok = (a.token ?? vfs.text(a.input)).trim().replace(/^Bearer\s+/i, ''); const parts = tok.split('.');
    if (parts.length !== 3 && parts.length !== 5) throw new Error(`not a JWT: expected 3 dot-separated parts (5 for encrypted JWE), found ${parts.length}`);
    const dec = (p, what) => { let bytes; try { bytes = b64.dec(p.replace(/-/g, '+').replace(/_/g, '/')); } catch { throw new Error(`JWT ${what} is not valid base64url`); } try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`JWT ${what} is not JSON`); } };
    const header = dec(parts[0], 'header');
    if (parts.length === 5) return { type: 'JWE', header, verified: false, note: 'encrypted token (JWE): the payload cannot be read without the key' };
    const payload = dec(parts[1], 'payload'); const times = {}; const now = Date.now() / 1000;
    for (const k of ['iat', 'nbf', 'exp', 'auth_time']) if (typeof payload?.[k] === 'number') times[k] = new Date(payload[k] * 1000).toISOString();
    let sig = 0; try { sig = b64.dec(parts[2].replace(/-/g, '+').replace(/_/g, '/')).length; } catch { /* malformed signature */ }
    return { type: 'JWS', header, payload, algorithm: header?.alg ?? null, signatureBytes: sig, times, ...(typeof payload?.exp === 'number' ? { expired: payload.exp < now, secondsToExpiry: Math.round(payload.exp - now) } : {}), ...(typeof payload?.nbf === 'number' && payload.nbf > now ? { notYetValid: true } : {}), verified: false, note: header?.alg === 'none' ? 'alg is "none": this token is unsigned' : 'signature NOT verified — decoded only' };
  },
});

function detectCharset(b) {
  const at = (...sig) => sig.every((v, i) => b[i] === v);
  if (b.length >= 4 && at(0xff, 0xfe, 0, 0)) return { encoding: 'utf-32le', bom: 4, confidence: 0.99, evidence: 'UTF-32LE BOM' };
  if (b.length >= 4 && at(0, 0, 0xfe, 0xff)) return { encoding: 'utf-32be', bom: 4, confidence: 0.99, evidence: 'UTF-32BE BOM' };
  if (b.length >= 3 && at(0xef, 0xbb, 0xbf)) return { encoding: 'utf-8', bom: 3, confidence: 1, evidence: 'UTF-8 BOM' };
  if (b.length >= 2 && at(0xff, 0xfe)) return { encoding: 'utf-16le', bom: 2, confidence: 0.98, evidence: 'UTF-16LE BOM' };
  if (b.length >= 2 && at(0xfe, 0xff)) return { encoding: 'utf-16be', bom: 2, confidence: 0.98, evidence: 'UTF-16BE BOM' };
  const n = Math.min(b.length, 1 << 20); let z0 = 0; let z1 = 0; let high = 0; let c1 = 0;
  for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0) { if (i & 1) z1++; else z0++; } else if (c >= 0x80) { high++; if (c < 0xa0) c1++; } }
  if (n >= 4 && z1 > n * 0.2 && z0 < n * 0.02) return { encoding: 'utf-16le', bom: 0, confidence: 0.8, evidence: 'no BOM; NUL in most odd byte positions' };
  if (n >= 4 && z0 > n * 0.2 && z1 < n * 0.02) return { encoding: 'utf-16be', bom: 0, confidence: 0.8, evidence: 'no BOM; NUL in most even byte positions' };
  if (z0 + z1 > 0) return { encoding: 'binary', bom: 0, confidence: 0.6, evidence: 'contains NUL bytes without a UTF-16 pattern — probably not text' };
  if (!high) return { encoding: 'ascii', bom: 0, confidence: 1, evidence: 'all bytes < 0x80 (valid as UTF-8 too)' };
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return { encoding: 'utf-8', bom: 0, confidence: 0.97, evidence: `valid UTF-8 with ${high} non-ASCII bytes` }; } catch { /* not utf-8 */ }
  return c1 ? { encoding: 'windows-1252', bom: 0, confidence: 0.55, evidence: `not valid UTF-8; ${c1} bytes in 0x80–0x9F (printable in windows-1252, controls in latin1)` } : { encoding: 'iso-8859-1', bom: 0, confidence: 0.5, evidence: 'not valid UTF-8; high bytes only in 0xA0–0xFF (latin1 and windows-1252 agree here; other 8-bit code pages cannot be told apart)' };
}
register({
  name: 'encode.charset',
  description: 'Detect the text encoding of a file (BOMs for UTF-8/16/32, strict UTF-8 validation, UTF-16 without BOM by NUL pattern, otherwise a latin1/windows-1252 guess) and transcode it to UTF-8. Force the source encoding with from= (any WHATWG label: windows-1251, shift_jis, gbk, iso-8859-2 …) when the guess is wrong. Returns the detection with its evidence and confidence and the UTF-8 file. Single-byte code pages other than latin1/1252 cannot be auto-detected.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of the text file' }, from: { type: 'string', default: 'auto', description: 'Source encoding label, or auto to detect' }, detectOnly: { type: 'boolean', default: false, description: 'Only report the detection, write nothing' }, newline: { type: 'string', enum: ['keep', 'lf', 'crlf'], default: 'keep', description: 'Normalise line endings in the output' }, bom: { type: 'boolean', default: false, description: 'Write a UTF-8 BOM at the start of the output' }, output: { type: 'string', description: 'VFS path of the UTF-8 result (default: <input>.utf8.<ext>)' } }, required: ['input'] },
  examples: ['encode.charset input=legacy.csv', 'encode.charset input=notes.txt from=windows-1251'],
  async run(a) {
    const b = vfs.read(a.input); const det = detectCharset(b); const { bom, ...detected } = det;
    const res = { bytes: b.length, detected: { ...detected, bom: bom > 0 } };
    if (a.detectOnly) return res;
    let label = a.from === 'auto' ? det.encoding : a.from.toLowerCase();
    if (label === 'binary') throw new Error('this does not look like text (NUL bytes, no UTF-16 pattern) — pass from=<encoding> to force a decode');
    if (label === 'ascii') label = 'utf-8'; if (label === 'latin1') label = 'iso-8859-1';
    let text; const body = a.from === 'auto' ? b.subarray(bom) : b;
    if (label === 'utf-32le' || label === 'utf-32be') { const dv = new DataView(body.buffer, body.byteOffset, body.byteLength - (body.byteLength % 4)); const cps = []; for (let i = 0; i < dv.byteLength; i += 4) { const cp = dv.getUint32(i, label === 'utf-32le'); cps.push(cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? 0xfffd : cp); } text = ''; for (let i = 0; i < cps.length; i += 8192) text += String.fromCodePoint(...cps.slice(i, i + 8192)); } else {
      // iso-8859-1 is mapped to windows-1252 by TextDecoder; decode true latin1 by hand so 0x80–0x9F stay C1 controls
      if (label === 'iso-8859-1') { text = ''; for (let i = 0; i < body.length; i += 8192) text += String.fromCharCode.apply(null, body.subarray(i, i + 8192)); } else { let td; try { td = new TextDecoder(label); } catch { throw new Error(`unknown encoding label "${a.from}" — use a WHATWG name such as utf-8, utf-16le, windows-1252, iso-8859-2, shift_jis, gbk, euc-kr`); } text = td.decode(body); }
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const replaced = (text.match(/�/g) || []).length;
    if (a.newline !== 'keep') { text = text.replace(/\r\n?/g, '\n'); if (a.newline === 'crlf') text = text.replace(/\n/g, '\r\n'); }
    const ext = vfs.extOf(a.input) || 'txt';
    res.decodedAs = label; res.characters = text.length; if (replaced) { res.replacementCharacters = replaced; res.note = `${replaced} byte sequence(s) were invalid in ${label} and became U+FFFD — the source encoding is probably different`; }
    res.output = await vfs.write(vfs.out(a.output, a.input, 'utf8', ext), (a.bom ? '﻿' : '') + text);
    return res;
  },
});

// ═════════════════════════════════════════════════════════════ file ══
const FILE_IN = { input: { type: 'string', description: 'VFS path of the file to inspect' } };
function shannon(b, start, end) { const c = new Uint32Array(256); for (let i = start; i < end; i++) c[b[i]]++; const n = end - start; if (!n) return 0; let h = 0; for (let i = 0; i < 256; i++) if (c[i]) { const p = c[i] / n; h -= p * Math.log2(p); } return h; }
register({
  name: 'file.identify', readOnly: true,
  description: 'Identify what a file really is from its bytes (magic numbers and light structure checks), ignoring its name: ~150 formats across images, audio, video containers, archives, documents (PDF, Office/OpenDocument inside zip, OLE2), executables (PE, ELF, Mach-O, wasm, class), fonts, databases, and text kinds (JSON, XML, HTML, SVG, CSV, scripts, PEM…). Returns format, mime, usual extensions, category, a confidence 0–1, format details when cheap (PNG size, PE/ELF architecture, zip first entries) and extensionMatches=false with a warning when the file name lies about the content.',
  schema: { properties: { ...FILE_IN } , required: ['input'] },
  examples: ['file.identify input=download.bin'],
  async run(a) {
    const g = await G(); const st = vfs.stat(a.input); const b = vfs.read(a.input); const r = g.identify(b); const ext = vfs.extOf(st.path);
    let matches = null;
    if (ext && r.format !== 'unknown' && r.format !== 'empty') {
      if (r.extensions.includes(ext) || g.EXT_OK[ext] === r.format || g.EXT_OK[ext] === '*') matches = true;
      else if (r.category === 'text') { const m = vfs.mimeOf(st.path); matches = m === 'application/octet-stream' || vfs.isTextMime(m) ? (r.format === 'text' || m === 'application/octet-stream' ? true : null) : false; } else matches = false;
    }
    return { path: st.path, bytes: b.length, ...r, extension: ext || null, extensionMatches: matches, ...(matches === false ? { warning: `the name says .${ext} but the content is ${r.description}` } : {}), magic: hexOf(b.subarray(0, 16)) };
  },
});
register({
  name: 'file.entropy',
  description: 'Shannon entropy of a file in bits per byte (0 = constant, ~4–5 = text/code, >7.5 = compressed, >7.95 = encrypted or random), overall and per block, with the high-entropy regions listed by offset — the standard way to spot packed, compressed or encrypted sections inside a binary. Also renders a PNG strip (entropy against file offset) for a vision model to look at. Returns the numbers, a 32-point profile and the PNG.',
  schema: { properties: { ...FILE_IN, blockSize: { type: 'integer', minimum: 16, maximum: 16777216, description: 'Bytes per block (default: chosen so the file has at most ~1024 blocks, minimum 256)' }, threshold: { type: 'number', default: 7.5, minimum: 0, maximum: 8, description: 'Blocks at or above this entropy are reported as high-entropy regions' }, image: { type: 'boolean', default: true, description: 'Render the entropy strip PNG' }, output: { type: 'string', description: 'VFS path of the PNG (default: <input>.entropy.png)' } }, required: ['input'] },
  examples: ['file.entropy input=firmware.bin'],
  async run(a) {
    const b = vfs.read(a.input); if (!b.length) throw new Error('file is empty');
    const bs = a.blockSize || Math.max(256, 2 ** Math.ceil(Math.log2(b.length / 1024)));
    const n = Math.ceil(b.length / bs); const blocks = new Float32Array(n);
    for (let i = 0; i < n; i++) blocks[i] = shannon(b, i * bs, Math.min(b.length, (i + 1) * bs));
    const overall = shannon(b, 0, b.length); let min = 8; let max = 0; let sum = 0; for (const e of blocks) { if (e < min) min = e; if (e > max) max = e; sum += e; }
    // a short final block cannot reach high entropy; judge it against its own ceiling
    const cap = (i) => Math.min(8, Math.log2(Math.max(1, Math.min(bs, b.length - i * bs))));
    const regions = []; let cur = null;
    for (let i = 0; i < n; i++) { const hi = blocks[i] >= Math.min(a.threshold, cap(i) - 0.3) && bs >= 256; if (hi) { if (!cur) cur = { offset: i * bs, length: 0, sum: 0, k: 0 }; cur.length = Math.min(b.length, (i + 1) * bs) - cur.offset; cur.sum += blocks[i]; cur.k++; } else if (cur) { regions.push(cur); cur = null; } }
    if (cur) regions.push(cur);
    const hiBytes = regions.reduce((s, r) => s + r.length, 0);
    const assess = overall > 7.95 ? 'near-maximal: encrypted or random data (or very well compressed)' : overall > 7.5 ? 'high: compressed or encrypted' : overall > 6 ? 'medium-high: mixed binary, machine code or partly compressed' : overall > 3.5 ? 'medium: text, source code or structured data' : overall > 1 ? 'low: highly repetitive data' : 'very low: almost constant (padding, zeros)';
    const prof = Array.from({ length: Math.min(32, n) }, (_, k) => { const i0 = Math.floor((k * n) / Math.min(32, n)); const i1 = Math.max(i0 + 1, Math.floor(((k + 1) * n) / Math.min(32, n))); let s = 0; for (let i = i0; i < i1; i++) s += blocks[i]; return round(s / (i1 - i0), 3); });
    const res = { bytes: b.length, entropy: round(overall, 5), assessment: assess, blockSize: bs, blocks: n, blockMin: round(min, 4), blockMax: round(max, 4), blockMean: round(sum / n, 4), threshold: a.threshold, highEntropyBytes: hiBytes, highEntropyFraction: round(hiBytes / b.length, 4), highEntropyRegions: regions.slice(0, 20).map((r) => ({ offset: r.offset, hexOffset: `0x${r.offset.toString(16)}`, length: r.length, meanEntropy: round(r.sum / r.k, 3) })), regionsTruncated: regions.length > 20, profile: prof };
    if (a.image) { const d = await D(); const { saveCanvas } = await IMG(); res.output = await saveCanvas(d.entropyStrip({ blocks, blockSize: bs, total: b.length, title: `${vfs.stat(a.input).path} — entropy ${overall.toFixed(3)} bits/byte over ${M.human(b.length)}` }), vfs.out(a.output, a.input, 'entropy', 'png')); }
    return res;
  },
});
register({
  name: 'file.strings',
  description: 'Extract runs of printable characters from a binary, like the Unix `strings` tool: ASCII and/or UTF-16LE runs of at least minLength characters, each with its byte offset. Optionally keep only those matching a regex (e.g. "https?://", "password"). Returns the first matches inline (default 50) and writes the full list to a text file ("offset<TAB>encoding<TAB>text", capped at 200 000 strings).',
  schema: { properties: { ...FILE_IN, minLength: { type: 'integer', default: 4, minimum: 2, maximum: 1000, description: 'Minimum run length in characters' }, encoding: { type: 'string', enum: ['ascii', 'utf16le', 'both'], default: 'both', description: 'Which encodings to scan for' }, filter: { type: 'string', description: 'Optional regular expression (case-insensitive) a string must match' }, limit: { type: 'integer', default: INLINE, minimum: 0, maximum: 500, description: 'Strings to return inline' }, maxLength: { type: 'integer', default: 200, minimum: 10, maximum: 10000, description: 'Truncate each inline string to this many characters' }, output: { type: 'string', description: 'VFS path of the full list (default: <input>.strings.txt)' } }, required: ['input'] },
  examples: ['file.strings input=app.exe minLength=6', 'file.strings input=dump.bin filter="https?://"'],
  async run(a) {
    const b = vfs.read(a.input); const CAP = 200000; let re = null;
    if (a.filter) { if (a.filter.length > 500) throw new Error('filter regex too long (max 500 characters)'); try { re = new RegExp(a.filter, 'i'); } catch (e) { throw new Error(`bad filter regex: ${e.message}`); } }
    const found = []; let total = 0; const pr = (c) => (c >= 0x20 && c < 0x7f) || c === 9;
    const push = (offset, encoding, text) => { if (re && !re.test(text)) return; total++; if (found.length < CAP) found.push({ offset, encoding, text }); };
    if (a.encoding !== 'utf16le') { let s = -1; for (let i = 0; i <= b.length; i++) { if (i < b.length && pr(b[i])) { if (s < 0) s = i; } else if (s >= 0) { if (i - s >= a.minLength) push(s, 'ascii', String.fromCharCode.apply(null, b.subarray(s, Math.min(i, s + 65536)))); s = -1; } } }
    if (a.encoding !== 'ascii') { let i = 0; while (i + 1 < b.length) { if (pr(b[i]) && b[i + 1] === 0) { const s = i; let t = ''; while (i + 1 < b.length && pr(b[i]) && b[i + 1] === 0) { if (t.length < 65536) t += String.fromCharCode(b[i]); i += 2; } if ((i - s) / 2 >= a.minLength) push(s, 'utf16le', t); } else i++; } }
    found.sort((p, q) => p.offset - q.offset);
    const stat = await vfs.write(vfs.out(a.output, a.input, 'strings', 'txt'), found.map((s) => `${s.offset}\t${s.encoding}\t${s.text}`).join('\n') + (found.length ? '\n' : ''));
    return { bytes: b.length, count: total, strings: found.slice(0, a.limit).map((s) => ({ offset: s.offset, encoding: s.encoding, text: s.text.length > a.maxLength ? `${s.text.slice(0, a.maxLength)}…` : s.text })), truncated: total > a.limit, ...(total > CAP ? { fileCapped: CAP } : {}), output: stat };
  },
});
function hexLines(b, base, width) {
  const lines = [];
  for (let i = 0; i < b.length; i += width) { let hx = ''; let as = ''; for (let j = 0; j < width; j++) { if (i + j < b.length) { const c = b[i + j]; hx += hex2(c) + ' '; as += c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; } else hx += '   '; if (j === (width >> 1) - 1) hx += ' '; } lines.push(`${(base + i).toString(16).padStart(8, '0')}  ${hx} |${as}|`); }
  return lines;
}
register({
  name: 'file.hexdump',
  description: 'Write a classic hex dump (offset, hex bytes, ASCII column — like `hexdump -C` / `xxd`) of a file or a byte range to a text file, and return its first lines inline. Dumps at most 4 MiB per call; page through larger files with offset/length.',
  schema: { properties: { ...FILE_IN, offset: { type: 'integer', default: 0, minimum: 0, description: 'First byte to dump' }, length: { type: 'integer', minimum: 1, maximum: 4194304, description: 'Bytes to dump (default: to the end, max 4 MiB)' }, width: { type: 'integer', default: 16, enum: [8, 16, 24, 32], description: 'Bytes per line' }, head: { type: 'integer', default: 16, minimum: 0, maximum: 64, description: 'Lines to return inline' }, output: { type: 'string', description: 'VFS path of the dump (default: <input>.hex.txt)' } }, required: ['input'] },
  examples: ['file.hexdump input=header.bin length=256'],
  async run(a) {
    const all = vfs.read(a.input); if (a.offset > all.length) throw new Error(`offset ${a.offset} is past the end of the file (${all.length} bytes)`);
    const len = Math.min(a.length ?? 4194304, all.length - a.offset, 4194304); const lines = hexLines(all.subarray(a.offset, a.offset + len), a.offset, a.width);
    return { output: await vfs.write(vfs.out(a.output, a.input, 'hex', 'txt'), lines.join('\n') + '\n'), totalBytes: all.length, offset: a.offset, bytesDumped: len, lines: lines.length, truncated: a.offset + len < all.length, head: lines.slice(0, a.head).join('\n') };
  },
});
register({
  name: 'file.byteHistogram',
  description: 'Count how often each byte value 0x00–0xFF occurs in a file and render it as a 256-bar PNG. Flat = random/encrypted; spikes at 0x00/0xFF = padding; mass in 0x20–0x7E = text. Returns the PNG plus the most common bytes, the number of distinct values and the zero / printable-ASCII / high-bit fractions.',
  schema: { properties: { ...FILE_IN, log: { type: 'boolean', default: false, description: 'Logarithmic count axis (shows rare bytes next to dominant ones)' }, output: { type: 'string', description: 'VFS path of the PNG (default: <input>.bytes.png)' } }, required: ['input'] },
  examples: ['file.byteHistogram input=blob.bin log=true'],
  async run(a) {
    const b = vfs.read(a.input); if (!b.length) throw new Error('file is empty'); const d = await D(); const { saveCanvas } = await IMG();
    const counts = new Array(256).fill(0); for (let i = 0; i < b.length; i++) counts[b[i]]++;
    let printable = 0; let high = 0; for (let i = 0; i < 256; i++) { if ((i >= 0x20 && i < 0x7f) || i === 9 || i === 10 || i === 13) printable += counts[i]; if (i >= 0x80) high += counts[i]; }
    const top = counts.map((c, v) => ({ byte: `0x${hex2(v).toUpperCase()}`, char: v >= 0x21 && v < 0x7f ? String.fromCharCode(v) : undefined, count: c, fraction: round(c / b.length, 4) })).sort((p, q) => q.count - p.count).slice(0, 8);
    const chi = counts.reduce((s, c) => s + (c - b.length / 256) ** 2 / (b.length / 256), 0);
    const out = await saveCanvas(d.byteHistChart({ counts, log: a.log, title: `${vfs.stat(a.input).path} — byte histogram (${M.human(b.length)})` }), vfs.out(a.output, a.input, 'bytes', 'png'));
    return { output: out, bytes: b.length, distinctValues: counts.filter(Boolean).length, entropy: round(shannon(b, 0, b.length), 5), zeroFraction: round(counts[0] / b.length, 4), printableAsciiFraction: round(printable / b.length, 4), highBitFraction: round(high / b.length, 4), chiSquare: round(chi, 6), mostCommon: top };
  },
});
register({
  name: 'file.bitmap',
  description: 'Render raw bytes as an image — binary visualisation: each byte becomes a grey pixel (or 3 bytes an RGB pixel, 4 RGBA, or each bit a black/white pixel), laid out in rows of a chosen width. Structure shows up visually: text looks like noise bands, zero padding is black, embedded uncompressed images appear when the width matches their stride. Returns the PNG (at most 16 M pixels; larger inputs are cut and flagged).',
  schema: { properties: { ...FILE_IN, width: { type: 'integer', default: 256, minimum: 1, maximum: 8192, description: 'Pixels per row' }, mode: { type: 'string', enum: ['gray', 'rgb', 'rgba', 'bits'], default: 'gray', description: 'gray = 1 byte/pixel, rgb = 3, rgba = 4, bits = 1 bit/pixel (MSB first)' }, offset: { type: 'integer', default: 0, minimum: 0, description: 'First byte to render' }, length: { type: 'integer', minimum: 1, description: 'Bytes to render (default: to the end)' }, scale: { type: 'integer', default: 1, minimum: 1, maximum: 16, description: 'Integer upscale factor (nearest neighbour) for small inputs' }, output: { type: 'string', description: 'VFS path of the PNG (default: <input>.bitmap.png)' } }, required: ['input'] },
  examples: ['file.bitmap input=firmware.bin width=512', 'file.bitmap input=frame.raw width=640 mode=rgb'],
  async run(a) {
    const { save } = await IMG(); const all = vfs.read(a.input); if (a.offset >= all.length) throw new Error(`offset ${a.offset} is past the end of the file (${all.length} bytes)`);
    let b = all.subarray(a.offset, a.length !== undefined ? a.offset + a.length : undefined);
    const per = { gray: 1, rgb: 3, rgba: 4, bits: 1 / 8 }[a.mode]; const maxPx = Math.floor(16777216 / (a.scale * a.scale)); let px = Math.floor(b.length / per); let truncated = false;
    if (px > maxPx) { px = maxPx - (maxPx % a.width); b = b.subarray(0, Math.ceil(px * per)); truncated = true; }
    if (!px) throw new Error('not enough bytes for a single pixel in this mode');
    const w = a.width; const h = Math.ceil(px / w); const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < px; i++) { const o = i * 4; if (a.mode === 'gray') { data[o] = data[o + 1] = data[o + 2] = b[i]; data[o + 3] = 255; } else if (a.mode === 'rgb') { data[o] = b[i * 3]; data[o + 1] = b[i * 3 + 1]; data[o + 2] = b[i * 3 + 2]; data[o + 3] = 255; } else if (a.mode === 'rgba') { data[o] = b[i * 4]; data[o + 1] = b[i * 4 + 1]; data[o + 2] = b[i * 4 + 2]; data[o + 3] = b[i * 4 + 3]; } else { const v = (b[i >> 3] >> (7 - (i & 7))) & 1 ? 255 : 0; data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255; } }
    for (let i = px; i < w * h; i++) { data[i * 4] = 40; data[i * 4 + 1] = 0; data[i * 4 + 2] = 60; data[i * 4 + 3] = 255; } // filler after the last byte: dark violet
    let img = { width: w, height: h, data };
    if (a.scale > 1) { const s = a.scale; const big = new Uint8ClampedArray(w * s * h * s * 4); for (let y = 0; y < h * s; y++) { const sy = Math.floor(y / s); for (let x = 0; x < w * s; x++) { const so = (sy * w + Math.floor(x / s)) * 4; const o = (y * w * s + x) * 4; big[o] = data[so]; big[o + 1] = data[so + 1]; big[o + 2] = data[so + 2]; big[o + 3] = data[so + 3]; } } img = { width: w * s, height: h * s, data: big }; }
    return { output: await save(img, vfs.out(a.output, a.input, 'bitmap', 'png'), { format: 'png' }), mode: a.mode, bytesRendered: Math.ceil(px * per), pixels: px, rows: h, truncated };
  },
});
register({
  name: 'file.diff', readOnly: true,
  description: 'Byte-level comparison of two files at equal offsets (no insert/delete alignment): identical or not, offset of the first difference, number of differing bytes, similarity (matching bytes / longer length), and the differing ranges with a hex sample from each side (first 50; nearby ranges merge with mergeGap). Use it to see what a patch, a re-save or a corruption changed.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of the first file' }, other: { type: 'string', description: 'VFS path of the second file' }, mergeGap: { type: 'integer', default: 0, minimum: 0, maximum: 65536, description: 'Merge differing ranges separated by at most this many equal bytes' }, limit: { type: 'integer', default: INLINE, minimum: 1, maximum: 500, description: 'Ranges to return inline' } }, required: ['input', 'other'] },
  examples: ['file.diff input=v1.bin other=v2.bin'],
  run(a) {
    const x = vfs.read(a.input); const y = vfs.read(a.other); const n = Math.min(x.length, y.length); const ranges = []; let diff = 0; let cur = null; let count = 0;
    for (let i = 0; i < n; i++) {
      if (x[i] !== y[i]) { diff++; if (cur && i - cur.end <= a.mergeGap) cur.end = i + 1; else { if (cur) { count++; if (ranges.length < a.limit) ranges.push(cur); } cur = { start: i, end: i + 1 }; } }
    }
    if (cur) { count++; if (ranges.length < a.limit) ranges.push(cur); }
    const tail = Math.abs(x.length - y.length); const longer = Math.max(x.length, y.length);
    const first = ranges.length ? ranges[0].start : tail ? n : null;
    return { identical: diff === 0 && tail === 0, bytesA: x.length, bytesB: y.length, sizeDifference: y.length - x.length, firstDifference: first, firstDifferenceHex: first === null ? null : `0x${first.toString(16)}`, differingBytes: diff, ...(tail ? { trailingBytes: tail, trailingIn: x.length > y.length ? 'input' : 'other' } : {}), similarity: longer ? round((n - diff) / longer, 6) : 1, rangeCount: count, ranges: ranges.map((r) => ({ offset: r.start, length: r.end - r.start, a: hexOf(x.subarray(r.start, Math.min(r.end, r.start + 16))), b: hexOf(y.subarray(r.start, Math.min(r.end, r.start + 16))) })), truncated: count > ranges.length };
  },
});
const resolveRange = (a, total) => { let start = a.offset < 0 ? Math.max(0, total + a.offset) : a.offset; if (start > total) throw new Error(`offset ${a.offset} is past the end of the file (${total} bytes)`); let end = a.length !== undefined ? start + a.length : a.end !== undefined ? (a.end < 0 ? total + a.end : a.end) : total; end = Math.max(start, Math.min(total, end)); return [start, end]; };
register({
  name: 'file.slice',
  description: 'Copy a byte range of a file into a new file (carve out a header, an embedded payload, the tail). Negative offset counts from the end. Returns the new file and the exact range taken.',
  schema: { properties: { ...FILE_IN, offset: { type: 'integer', default: 0, description: 'First byte (negative = from the end, e.g. -128 for the last 128 bytes)' }, length: { type: 'integer', minimum: 0, description: 'Number of bytes (default: to the end)' }, end: { type: 'integer', description: 'Exclusive end offset, alternative to length (negative = from the end)' }, output: { type: 'string', description: 'VFS path (default: <input>.slice.bin)' } }, required: ['input'] },
  examples: ['file.slice input=dump.bin offset=512 length=1024', 'file.slice input=song.mp3 offset=-128 output=id3v1.bin'],
  async run(a) { const b = vfs.read(a.input); const [s, e] = resolveRange(a, b.length); return { output: await vfs.write(vfs.out(a.output, a.input, 'slice', 'bin'), b.slice(s, e)), offset: s, end: e, length: e - s, totalBytes: b.length }; },
});
register({
  name: 'file.concat',
  description: 'Concatenate several files byte for byte, in order, into one new file (rejoin split parts, prepend a header). Returns the new file and the offset where each part starts.',
  schema: { properties: { inputs: { type: 'array', items: { type: 'string' }, description: 'VFS paths, in order' }, output: { type: 'string', description: 'VFS path of the result (default: <first>.concat.<ext>)' } }, required: ['inputs'] },
  examples: ['file.concat inputs=part1.bin,part2.bin output=whole.bin'],
  async run(a) { if (!a.inputs.length) throw new Error('inputs is empty'); const parts = a.inputs.map((p) => vfs.read(p)); let o = 0; const offsets = parts.map((p, i) => { const r = { path: a.inputs[i], offset: o, bytes: p.length }; o += p.length; return r; }); return { output: await vfs.write(vfs.out(a.output, a.inputs[0], 'concat', vfs.extOf(a.inputs[0]) || 'bin'), concat(parts)), parts: offsets.slice(0, INLINE), truncated: offsets.length > INLINE }; },
});
register({
  name: 'file.patch',
  description: 'Edit bytes at an offset and write the result as a new file: overwrite in place (default), insert (shifting the rest), or delete a range. The new bytes come as hex, base64 or text. Returns the new file, the bytes that were replaced (hex) and the size change.',
  schema: { properties: { ...FILE_IN, offset: { type: 'integer', minimum: 0, description: 'Byte offset to edit at' }, hex: { type: 'string', description: 'New bytes as hex, e.g. "DE AD BE EF"' }, text: { type: 'string', description: 'New bytes as UTF-8 text' }, base64: { type: 'string', description: 'New bytes as base64' }, mode: { type: 'string', enum: ['overwrite', 'insert', 'delete'], default: 'overwrite', description: 'overwrite = replace bytes in place (may extend the file); insert = add bytes, shifting the rest; delete = remove `length` bytes' }, length: { type: 'integer', minimum: 1, description: 'delete mode: how many bytes to remove' }, output: { type: 'string', description: 'VFS path (default: <input>.patched.<ext>)' } }, required: ['input', 'offset'] },
  examples: ['file.patch input=rom.bin offset=4096 hex="90 90"', 'file.patch input=a.bin offset=0 mode=delete length=16'],
  async run(a) {
    const b = vfs.read(a.input); if (a.offset > b.length) throw new Error(`offset ${a.offset} is past the end of the file (${b.length} bytes)`);
    const given = ['hex', 'text', 'base64'].filter((k) => a[k] !== undefined); let out; let replaced = new Uint8Array(0); let nb = new Uint8Array(0);
    if (a.mode === 'delete') { if (given.length) throw new Error('delete mode takes length, not data'); if (!a.length) throw new Error('delete mode needs length=<bytes to remove>'); const e = Math.min(b.length, a.offset + a.length); replaced = b.slice(a.offset, e); out = concat([b.subarray(0, a.offset), b.subarray(e)]); } else {
      if (given.length !== 1) throw new Error('give exactly one of: hex, text, base64');
      nb = a.hex !== undefined ? (await H()).fromHex(a.hex) : a.text !== undefined ? enc.encode(a.text) : b64.dec(a.base64);
      if (a.mode === 'insert') out = concat([b.subarray(0, a.offset), nb, b.subarray(a.offset)]); else { replaced = b.slice(a.offset, Math.min(b.length, a.offset + nb.length)); out = new Uint8Array(Math.max(b.length, a.offset + nb.length)); out.set(b); out.set(nb, a.offset); }
    }
    const st = vfs.stat(a.input);
    return { output: await vfs.write(vfs.out(a.output, a.input, 'patched', vfs.extOf(a.input) || 'bin'), out, { mime: st.mime }), mode: a.mode, offset: a.offset, bytesWritten: nb.length, bytesReplaced: replaced.length, replacedHex: hexOf(replaced.subarray(0, 64)), sizeBefore: b.length, sizeAfter: out.length };
  },
});
register({
  name: 'file.find', readOnly: true,
  description: 'Search a file for a byte pattern and return the offsets: a hex pattern with ?? wildcards ("89 50 4E 47", "FF D8 ?? E0"), a text string (UTF-8 or UTF-16LE, optionally case-insensitive), or a regular expression evaluated over the bytes as latin1 characters (so \\x00 and [\\x80-\\xff] work). Returns the match count and the first matches with offset, length and a short context dump. Use it to locate signatures, embedded files or strings inside binaries.',
  schema: { properties: { ...FILE_IN, hex: { type: 'string', description: 'Hex byte pattern; ?? matches any byte' }, text: { type: 'string', description: 'Text to search for' }, regex: { type: 'string', description: 'JavaScript regular expression source, matched against the bytes as latin1' }, encoding: { type: 'string', enum: ['utf8', 'utf16le'], default: 'utf8', description: 'text search: how the text is encoded in the file' }, ignoreCase: { type: 'boolean', default: false, description: 'text/regex: ASCII case-insensitive' }, offset: { type: 'integer', default: 0, minimum: 0, description: 'Start searching at this byte' }, limit: { type: 'integer', default: INLINE, minimum: 1, maximum: 500, description: 'Matches to return inline' }, context: { type: 'integer', default: 16, minimum: 0, maximum: 64, description: 'Bytes of context shown after each match start' } }, required: ['input'] },
  examples: ['file.find input=disk.img hex="50 4B 03 04"', 'file.find input=app.bin text=password ignoreCase=true', 'file.find input=dump.bin regex="[A-Z]{3}-\\\\d{4}"'],
  async run(a) {
    const b = vfs.read(a.input); const given = ['hex', 'text', 'regex'].filter((k) => a[k] !== undefined && a[k] !== '');
    if (given.length !== 1) throw new Error('give exactly one of: hex, text, regex');
    const hits = []; let count = 0; const COUNT_CAP = 1000000; const add = (o, len) => { count++; if (hits.length < a.limit) hits.push([o, len]); };
    if (a.regex !== undefined && given[0] === 'regex') {
      if (b.length > 268435456) throw new Error('regex search is limited to files up to 256 MiB');
      let re; try { re = new RegExp(a.regex, a.ignoreCase ? 'gi' : 'g'); } catch (e) { throw new Error(`bad regex: ${e.message}`); }
      let s = ''; for (let i = a.offset; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(b.length, i + 32768)));
      let m; while ((m = re.exec(s)) && count < COUNT_CAP) { if (m[0].length === 0) { re.lastIndex++; continue; } add(a.offset + m.index, m[0].length); }
    } else {
      let pat; let mask = null; let ci = false;
      if (given[0] === 'hex') { const toks = a.hex.replace(/0x/gi, '').replace(/[\s,:_-]/g, ''); if (!toks.length || toks.length % 2 || /[^0-9a-f?]/i.test(toks)) throw new Error('hex pattern must be pairs of hex digits, with ?? for a wildcard byte (e.g. "FF D8 ?? E0")'); pat = new Uint8Array(toks.length / 2); mask = new Uint8Array(pat.length); for (let i = 0; i < pat.length; i++) { const t = toks.substr(i * 2, 2); if (t === '??') mask[i] = 0; else if (t.includes('?')) throw new Error('half-byte wildcards are not supported: use ?? for a whole byte'); else { pat[i] = parseInt(t, 16); mask[i] = 1; } } if (!mask.some(Boolean)) throw new Error('pattern is all wildcards'); } else { ci = a.ignoreCase; if (a.encoding === 'utf16le') { pat = new Uint8Array(a.text.length * 2); for (let i = 0; i < a.text.length; i++) { const c = a.text.charCodeAt(i); pat[i * 2] = c & 255; pat[i * 2 + 1] = c >> 8; } } else pat = enc.encode(a.text); }
      const lower = (c) => (c >= 65 && c <= 90 ? c + 32 : c); const m = pat.length; const p0 = ci ? Array.from(pat, lower) : pat;
      outer: for (let i = a.offset; i + m <= b.length && count < COUNT_CAP; i++) { for (let j = 0; j < m; j++) { if (mask && !mask[j]) continue; if ((ci ? lower(b[i + j]) : b[i + j]) !== p0[j]) continue outer; } add(i, m); }
    }
    return { bytes: b.length, pattern: given[0], count, countCapped: count >= COUNT_CAP, matches: hits.map(([o, len]) => { const c = b.subarray(o, Math.min(b.length, o + Math.max(len, a.context))).subarray(0, 64); return { offset: o, hexOffset: `0x${o.toString(16)}`, length: len, hex: hexOf(c.subarray(0, Math.min(c.length, 32))), ascii: Array.from(c, (v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '.')).join('') }; }), truncated: count > hits.length };
  },
});
