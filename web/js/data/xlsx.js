// data/xlsx — a small SpreadsheetML reader/writer on fflate + DOMParser.
// Reads: sheets, shared + inline strings (rich-text runs joined), numbers, booleans, errors, dates (via number formats, 1900 and 1904 systems),
//        cached formula results. Ignores: styles other than date detection, merged ranges (value stays in the top-left cell), comments, charts.
// Writes: one or more sheets with strings (shared), numbers, booleans, ISO dates/datetimes as real date cells, bold header row.
import { libFflate, escXml } from './formats.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const dec = new TextDecoder();
const xml = (bytes) => new DOMParser().parseFromString(dec.decode(bytes), 'application/xml');
const tags = (node, name) => node.getElementsByTagNameNS('*', name);

export function colIndex(letters) { let n = 0; for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64); return n - 1; }
export function colName(i) { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; }

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 22, 45, 46, 47]);
function fmtKind(id, code) {
  if (code === undefined) { if (!BUILTIN_DATE.has(id)) return null; return { time: BUILTIN_TIME.has(id), date: ![18, 19, 20, 21, 45, 46, 47].includes(id) }; }
  const bare = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_.|\*./g, '');
  if (/general/i.test(bare) || !/[dmyhs]/i.test(bare)) return null;
  const time = /[hs]/i.test(bare) || /AM\/PM/i.test(bare); const date = /[dy]/i.test(bare) || (!time && /m/i.test(bare));
  return { time, date };
}
const p2 = (n) => String(n).padStart(2, '0');
/** Excel serial → ISO text. date1904 workbooks count from 1904-01-01; the 1900 system carries the phantom 1900-02-29. */
export function serialToISO(serial, kind, date1904) {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return serial;
  const ms = Math.round(serial * 86400000);
  if (!kind.date) { // time of day or duration -> HH:MM:SS (hours may exceed 24)
    const neg = ms < 0; const s = Math.round(Math.abs(ms) / 1000);
    return `${neg ? '-' : ''}${p2(Math.floor(s / 3600))}:${p2(Math.floor(s / 60) % 60)}:${p2(s % 60)}`;
  }
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : (serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30));
  const d = new Date(epoch + ms);
  if (Number.isNaN(d.getTime())) return serial;
  const iso = d.toISOString();
  if (((ms % 86400000) + 86400000) % 86400000 === 0) return iso.slice(0, 10);
  return iso.slice(0, d.getUTCMilliseconds() ? 23 : 19);
}

async function unzip(bytes, want) {
  const f = await libFflate();
  try { return f.unzipSync(bytes, { filter: (file) => want(file.name) }); } catch (e) { throw new Error(`xlsx: not a readable zip/xlsx file (${e.message || e})`); }
}
const strOf = (si) => { let s = ''; for (const t of tags(si, 't')) { if (t.parentNode.localName === 'rPh') continue; s += t.textContent; } return s; };

async function openWorkbook(bytes) {
  const files = await unzip(bytes, (n) => /^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|\[Content_Types\]\.xml)$/i.test(n) || /^xl\/worksheets\/[^/]+\.xml$/i.test(n));
  const get = (name) => { const k = Object.keys(files).find((n) => n.toLowerCase() === name.toLowerCase()); return k ? files[k] : null; };
  const wbx = get('xl/workbook.xml');
  if (!wbx) throw new Error('xlsx: xl/workbook.xml is missing — this zip is not an Excel workbook (.xls, .xlsb and .ods are not supported)');
  const wb = xml(wbx);
  const rels = new Map();
  const rx = get('xl/_rels/workbook.xml.rels');
  if (rx) for (const r of tags(xml(rx), 'Relationship')) rels.set(r.getAttribute('Id'), r.getAttribute('Target'));
  const pr = tags(wb, 'workbookPr')[0]; const date1904 = !!pr && ['1', 'true'].includes(pr.getAttribute('date1904'));
  const sheets = [...tags(wb, 'sheet')].map((s, i) => {
    const rid = s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id');
    let target = rels.get(rid) || `worksheets/sheet${i + 1}.xml`;
    target = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name: s.getAttribute('name'), index: i, state: s.getAttribute('state') || 'visible', file: target };
  });
  return { get, sheets, date1904 };
}

function loadStyles(get) {
  const sx = get('xl/styles.xml'); if (!sx) return [];
  const doc = xml(sx); const custom = new Map();
  for (const n of tags(doc, 'numFmt')) custom.set(Number(n.getAttribute('numFmtId')), n.getAttribute('formatCode') || '');
  const cx = tags(doc, 'cellXfs')[0]; if (!cx) return [];
  return [...tags(cx, 'xf')].map((xf) => { const id = Number(xf.getAttribute('numFmtId') || 0); return fmtKind(id, custom.get(id)); });
}

function readSheet(bytes, shared, styles, date1904) {
  const doc = xml(bytes); const grid = []; let formulas = 0; let maxCol = 0; let cells = 0;
  const dim = tags(doc, 'dimension')[0]?.getAttribute('ref') || null;
  let rowNo = 0;
  for (const row of tags(doc, 'row')) {
    const rAttr = Number(row.getAttribute('r')); rowNo = rAttr > 0 ? rAttr : rowNo + 1;
    let colNo = -1; let out = null;
    for (const c of row.children) {
      if (c.localName !== 'c') continue;
      const ref = c.getAttribute('r'); const m = ref && /^([A-Z]+)/.exec(ref);
      colNo = m ? colIndex(m[1]) : colNo + 1;
      const t = c.getAttribute('t') || 'n'; let v = null; let vEl = null; let isEl = null; let hasF = false;
      for (const k of c.children) { if (k.localName === 'v') vEl = k; else if (k.localName === 'is') isEl = k; else if (k.localName === 'f') hasF = true; }
      if (hasF) formulas++;
      if (t === 'inlineStr') v = isEl ? strOf(isEl) : null;
      else if (vEl) {
        const raw = vEl.textContent;
        if (t === 's') v = shared[Number(raw)] ?? null;
        else if (t === 'b') v = raw === '1' || raw === 'true';
        else if (t === 'str' || t === 'e') v = raw;
        else if (t === 'd') v = raw;
        else if (raw !== '') { const num = Number(raw); const kind = styles[Number(c.getAttribute('s') || 0)]; v = Number.isNaN(num) ? raw : kind ? serialToISO(num, kind, date1904) : num; }
      }
      if (v === null || v === '') continue;
      out ||= (grid[rowNo - 1] = []);
      out[colNo] = v; cells++;
      if (colNo + 1 > maxCol) maxCol = colNo + 1;
    }
  }
  // densify: sparse → rectangular, trailing empty rows trimmed
  const dense = [];
  for (let r = 0; r < grid.length; r++) { const src = grid[r]; const o = new Array(maxCol).fill(null); if (src) for (let c = 0; c < src.length; c++) if (src[c] !== undefined) o[c] = src[c]; dense.push(o); }
  return { grid: dense, rows: dense.length, cols: maxCol, cells, formulas, dimension: dim };
}

/** readWorkbook(bytes, {sheet?: name|index, all?: bool}) → {sheets:[{name,index,state,rows,cols,...}], sheet:{name, grid}} */
export async function readWorkbook(bytes, { sheet, all = false } = {}) {
  const wb = await openWorkbook(bytes);
  if (!wb.sheets.length) throw new Error('xlsx: the workbook has no sheets');
  const sst = wb.get('xl/sharedStrings.xml'); const shared = sst ? [...tags(xml(sst), 'si')].map(strOf) : [];
  const styles = loadStyles(wb.get);
  let pick;
  if (sheet === undefined || sheet === null || sheet === '') pick = wb.sheets.find((s) => s.state === 'visible') || wb.sheets[0];
  else {
    pick = wb.sheets.find((s) => s.name === String(sheet)) || wb.sheets.find((s) => s.name.toLowerCase() === String(sheet).toLowerCase()) || (/^\d+$/.test(String(sheet)) ? wb.sheets[Number(sheet)] : null);
    if (!pick) throw new Error(`xlsx: no sheet "${sheet}" — sheets: ${wb.sheets.map((s, i) => `${i}:"${s.name}"`).join(', ')}`);
  }
  const load = (s) => { const b = wb.get(s.file); if (!b) throw new Error(`xlsx: sheet "${s.name}" is not a worksheet (chart sheets are not supported)`); return readSheet(b, shared, styles, wb.date1904); };
  const out = { date1904: wb.date1904, sheets: wb.sheets.map(({ file, ...s }) => s) };
  if (all) out.sheets = wb.sheets.map(({ file, ...s }) => { try { const { grid, ...info } = load({ file, ...s }); return { ...s, ...info, usedRange: info.rows ? `A1:${colName(Math.max(0, info.cols - 1))}${info.rows}` : null }; } catch (e) { return { ...s, error: e.message }; } });
  else out.sheet = { name: pick.name, index: pick.index, ...load(pick) };
  return out;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/; const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
function isoToSerial(s) {
  const m = DATE_ONLY.exec(s) || DATE_TIME.exec(s); if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3] || ms < Date.UTC(1900, 2, 1) || +m[1] > 9999) return null;
  return { serial: (ms - Date.UTC(1899, 11, 30)) / 86400000, style: m[4] === undefined ? 1 : 2 };
}
const safeSheetName = (n, i) => (String(n || `Sheet${i + 1}`).replace(/[\[\]:*?/\\]/g, '_').slice(0, 31) || `Sheet${i + 1}`);

/** writeWorkbook([{name, columns, rows}], {dates=true}) → Uint8Array (.xlsx) */
export async function writeWorkbook(sheets, { dates = true, level = 6 } = {}) {
  const f = await libFflate(); const enc = new TextEncoder();
  const sst = new Map(); const sstList = []; let sstCount = 0;
  const str = (s) => { sstCount++; let i = sst.get(s); if (i === undefined) { i = sstList.length; sst.set(s, i); sstList.push(s); } return i; };
  const names = []; const files = {};
  sheets.forEach((sh, si) => {
    let name = safeSheetName(sh.name, si); let k = 1; while (names.includes(name)) name = `${safeSheetName(sh.name, si).slice(0, 28)}_${++k}`;
    names.push(name);
    const ncol = sh.columns.length; const out = [];
    out.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}"><dimension ref="A1:${colName(Math.max(0, ncol - 1))}${sh.rows.length + 1}"/><sheetViews><sheetView workbookViewId="0"${si === 0 ? ' tabSelected="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>`);
    const letters = sh.columns.map((_, i) => colName(i));
    out.push(`<row r="1">${sh.columns.map((c, i) => `<c r="${letters[i]}1" t="s" s="3"><v>${str(String(c))}</v></c>`).join('')}</row>`);
    for (let r = 0; r < sh.rows.length; r++) {
      const row = sh.rows[r]; const rn = r + 2; let s = `<row r="${rn}">`;
      for (let c = 0; c < ncol; c++) {
        let v = row[c]; if (v === null || v === undefined) continue;
        const ref = `${letters[c]}${rn}`;
        if (typeof v === 'number') { if (Number.isFinite(v)) s += `<c r="${ref}"><v>${v}</v></c>`; else s += `<c r="${ref}" t="s"><v>${str(String(v))}</v></c>`; continue; }
        if (typeof v === 'boolean') { s += `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`; continue; }
        if (typeof v === 'object') v = JSON.stringify(v);
        v = String(v);
        const d = dates && v.length <= 19 ? isoToSerial(v) : null;
        if (d) s += `<c r="${ref}" s="${d.style}"><v>${d.serial}</v></c>`;
        else s += `<c r="${ref}" t="s"><v>${str(v.length > 32767 ? v.slice(0, 32767) : v)}</v></c>`;
      }
      out.push(s + '</row>');
    }
    out.push('</sheetData></worksheet>');
    files[`xl/worksheets/sheet${si + 1}.xml`] = enc.encode(out.join(''));
  });
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const esc = (s) => escXml(s).replace(/"/g, '&quot;');
  files['[Content_Types].xml'] = enc.encode(`${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`);
  files['_rels/.rels'] = enc.encode(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files['xl/workbook.xml'] = enc.encode(`${head}<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = enc.encode(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${names.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  files['xl/styles.xml'] = enc.encode(`${head}<styleSheet xmlns="${NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  files['xl/sharedStrings.xml'] = enc.encode(`${head}<sst xmlns="${NS}" count="${sstCount}" uniqueCount="${sstList.length}">${sstList.map((s) => `<si><t xml:space="preserve">${escXml(s).replace(/\r/g, '&#13;')}</t></si>`).join('')}</sst>`);
  // [Content_Types].xml first, as Office writes it
  const ordered = {}; for (const k of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', ...Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')), 'xl/styles.xml', 'xl/sharedStrings.xml']) ordered[k] = files[k];
  return f.zipSync(ordered, { level });
}
