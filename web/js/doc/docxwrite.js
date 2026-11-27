// Markdown → .docx. The OOXML is written by hand (marked gives the token tree, fflate zips the parts).
import { M, vfs } from '../core.js';
import { markedLib } from './html.js';
import { fflate } from './formats.js';

const x = (s) => String(s ?? '').replace(/[^\t\n\r -\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unent = (s) => String(s ?? '').replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: '\u00a0' }[e]));
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const STYLES = `${HEAD}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
${[[1, 32, 360], [2, 28, 280], [3, 26, 240], [4, 24, 200], [5, 22, 200], [6, 22, 200]].map(([n, sz, before]) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:b/><w:bCs/>${n >= 5 ? '<w:i/>' : ''}<w:color w:val="1F3864"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BBBBBB"/></w:pBdr><w:ind w:left="432"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="SourceCode"><w:name w:val="Source Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="HorizontalLine"><w:name w:val="Horizontal Line"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:spacing w:before="120" w:after="240"/></w:pPr></w:style>
<w:style w:type="character" w:styleId="VerbatimChar"><w:name w:val="Verbatim Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const lvlXml = (i, fmt, text, font) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr>` : ''}</w:lvl>`;
function numberingXml(nums) {
  const bullets = Array.from({ length: 9 }, (_, i) => lvlXml(i, 'bullet', ['\u2022', 'o', '\u25aa'][i % 3], ['Symbol', 'Courier New', 'Wingdings'][i % 3] === 'Symbol' ? null : (i % 3 === 1 ? 'Courier New' : null))).join('');
  const decimals = Array.from({ length: 9 }, (_, i) => lvlXml(i, ['decimal', 'lowerLetter', 'lowerRoman'][i % 3], `%${i + 1}.`)).join('');
  return `${HEAD}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${bullets}</w:abstractNum><w:abstractNum w:abstractNumId="2"><w:multiLevelType w:val="hybridMultilevel"/>${decimals}</w:abstractNum>${nums.map((n) => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.ordered ? 2 : 1}"/>${n.ordered ? Array.from({ length: 9 }, (_, i) => `<w:lvlOverride w:ilvl="${i}"><w:startOverride w:val="${i === n.level ? n.start : 1}"/></w:lvlOverride>`).join('') : ''}</w:num>`).join('')}</w:numbering>`;
}

async function imageInfo(bytes, mime) {
  // Word reads png/jpeg/gif/bmp; everything else is re-encoded to PNG through a canvas
  const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
  let out = { bytes, mime, width: bmp.width, height: bmp.height };
  if (!/^image\/(png|jpeg|gif|bmp)$/.test(mime)) {
    const cv = new OffscreenCanvas(bmp.width, bmp.height); cv.getContext('2d').drawImage(bmp, 0, 0);
    out = { bytes: new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer()), mime: 'image/png', width: bmp.width, height: bmp.height };
  }
  bmp.close?.();
  return out;
}

/** markdownToDocx(md, {title, author, mdPath, pageSize}) \u2192 {bytes, stats} */
export async function markdownToDocx(md, opts = {}) {
  const [{ marked }, { zipSync, strToU8 }] = await Promise.all([markedLib(), fflate()]);
  const tokens = marked.lexer(md.replace(/^\ufeff/, ''), { gfm: true });
  const rels = []; const media = []; const nums = [{ id: 1, ordered: false }]; const stats = { headings: 0, paragraphs: 0, listItems: 0, tables: 0, codeBlocks: 0, links: 0, imagesEmbedded: 0, imagesLinked: 0, htmlBlocksFlattened: 0 };
  const warnings = []; let firstH1 = null; let drawingId = 0; const bookmarks = new Set();
  // Word bookmark names: letters/digits/underscore, start with a letter, ≤ 40 chars. "#my-heading" links use the same mapping.
  const anchorName = (slug) => { let n = slug.replace(/[^\p{L}\p{N}_]/gu, '_').slice(0, 40); if (!/^\p{L}/u.test(n)) n = `h_${n}`.slice(0, 40); return n; };
  const rel = (type, target, external) => { const id = `rId${rels.length + 10}`; rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${x(target)}"${external ? ' TargetMode="External"' : ''}/>`); return id; };
  const baseDir = (opts.mdPath || '').split('/').slice(0, -1).join('/');

  const rPr = (f) => { const p = `${f.code ? '<w:rStyle w:val="VerbatimChar"/>' : f.link ? '<w:rStyle w:val="Hyperlink"/>' : ''}${f.bold ? '<w:b/><w:bCs/>' : ''}${f.italic ? '<w:i/><w:iCs/>' : ''}${f.strike ? '<w:strike/>' : ''}`; return p ? `<w:rPr>${p}</w:rPr>` : ''; };
  const run = (text, f) => (text === '' ? '' : `<w:r>${rPr(f)}${String(text).split('\n').map((t, i) => `${i ? '<w:br/>' : ''}${t ? `<w:t xml:space="preserve">${x(t)}</w:t>` : ''}`).join('')}</w:r>`);
  async function image(tok, f) {
    const href = tok.href || ''; const alt = unent(tok.text || '');
    let src = null;
    if (/^data:/i.test(href)) { const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(href); if (m) { try { src = { bytes: m[2] ? M.b64.dec(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])), mime: m[1] || 'image/png' }; } catch { /* bad data uri */ } } } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      let p = href.split(/[?#]/)[0]; try { p = decodeURIComponent(p); } catch { /* raw */ }
      const parts = (baseDir ? baseDir.split('/') : []); for (const seg of p.split('/')) { if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg); }
      const cand = [parts.join('/'), p.replace(/^\.?\/+/, '')].find((c) => c && vfs.exists(c));
      if (cand) src = { bytes: vfs.read(cand), mime: vfs.stat(cand).mime };
    }
    if (src) {
      try {
        const info = await imageInfo(src.bytes, src.mime); const ext = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp' }[info.mime];
        const name = `image${media.length + 1}.${ext}`; media.push({ name, bytes: info.bytes, ext, mime: info.mime });
        const id = rel('image', `media/${name}`); const maxW = 576; const scale = Math.min(1, maxW / info.width);
        const cx = Math.round(info.width * scale * 9525); const cy = Math.round(info.height * scale * 9525); const n = ++drawingId; stats.imagesEmbedded++;
        return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${x(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}" descr="${x(alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
      } catch (e) { warnings.push(`image "${href.slice(0, 80)}" could not be decoded (${e.message || e}); kept as text`); }
    }
    stats.imagesLinked++;
    if (/^https?:/i.test(href)) { if (!warnings.some((w) => w.startsWith('remote images'))) warnings.push('remote images are not downloaded; they are kept as hyperlinks (put the image in the VFS and reference it relatively to embed it)'); const id = rel('hyperlink', href, true); return `<w:hyperlink r:id="${id}">${run(`[image: ${alt || href}]`, { ...f, link: true })}</w:hyperlink>`; }
    return run(`[image: ${alt || href}]`, f);
  }
  async function inline(toks, f = {}) {
    let out = '';
    for (const t of toks || []) {
      switch (t.type) {
        case 'text': case 'escape': out += t.tokens ? await inline(t.tokens, f) : run(unent(t.text).replace(/[ \t]*\n[ \t]*/g, ' '), f); break;
        case 'strong': out += await inline(t.tokens, { ...f, bold: true }); break;
        case 'em': out += await inline(t.tokens, { ...f, italic: true }); break;
        case 'del': out += await inline(t.tokens, { ...f, strike: true }); break;
        case 'codespan': out += run(unent(t.text), { ...f, code: true }); break;
        case 'br': out += '<w:r><w:br/></w:r>'; break;
        case 'link': {
          stats.links++; const body = await inline(t.tokens, { ...f, link: true });
          if (/^#/.test(t.href)) out += `<w:hyperlink w:anchor="${x(anchorName(t.href.slice(1)))}">${body}</w:hyperlink>`; else out += `<w:hyperlink r:id="${rel('hyperlink', t.href, true)}">${body}</w:hyperlink>`;
          break;
        }
        case 'image': out += await image(t, f); break;
        case 'html': { if (/^<br\s*\/?>$/i.test(t.text.trim())) out += '<w:r><w:br/></w:r>'; else { const s = t.text.replace(/<[^>]*>/g, ''); if (s) out += run(unent(s), f); } break; }
        case 'checkbox': break;
        default: if (t.tokens) out += await inline(t.tokens, f); else if (t.text) out += run(unent(t.text), f);
      }
    }
    return out;
  }
  const para = (body, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`;
  async function blocks(toks, ctx) {
    let out = '';
    const pStyle = ctx.quote ? '<w:pStyle w:val="Quote"/>' : '';
    for (const t of toks || []) {
      switch (t.type) {
        case 'space': case 'def': break;
        case 'heading': { stats.headings++; const text = t.text; if (t.depth === 1 && firstH1 === null) firstH1 = unent(text.replace(/[*_`]/g, '')); const id = ++drawingId; let name = anchorName(text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')); if (bookmarks.has(name)) name = `${name.slice(0, 34)}_${id}`; bookmarks.add(name); out += para(`<w:bookmarkStart w:id="${id}" w:name="${x(name)}"/>${await inline(t.tokens)}<w:bookmarkEnd w:id="${id}"/>`, `<w:pStyle w:val="Heading${t.depth}"/>`); break; }
        case 'paragraph': stats.paragraphs++; out += para(await inline(t.tokens), pStyle + (ctx.ind ? `<w:ind w:left="${ctx.ind}"/>` : '')); break;
        case 'text': stats.paragraphs++; out += para(t.tokens ? await inline(t.tokens) : run(unent(t.text), {}), pStyle + (ctx.ind ? `<w:ind w:left="${ctx.ind}"/>` : '')); break;
        case 'code': { stats.codeBlocks++; for (const line of t.text.split('\n')) out += para(run(line, {}), `<w:pStyle w:val="SourceCode"/>${ctx.ind ? `<w:ind w:left="${ctx.ind}"/>` : ''}`); out += para('', '<w:spacing w:after="0" w:line="120" w:lineRule="exact"/>'); break; }
        case 'blockquote': out += await blocks(t.tokens, { ...ctx, quote: true }); break;
        case 'hr': out += para('', '<w:pStyle w:val="HorizontalLine"/>'); break;
        case 'list': out += await list(t, ctx.depth ?? 0, ctx); break;
        case 'table': out += await table(t); break;
        case 'html': { const s = t.text.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').trim(); if (s) { stats.htmlBlocksFlattened++; for (const p of unent(s).split(/\n{2,}/)) out += para(run(p.trim(), {}), pStyle); } break; }
        default: if (t.tokens) out += para(await inline(t.tokens), pStyle); else if (t.text) out += para(run(unent(t.text), {}), pStyle);
      }
    }
    return out;
  }
  async function list(t, depth, ctx) {
    let numId = 1; const lvl = Math.min(8, depth);
    if (t.ordered) { numId = nums.length + 1; nums.push({ id: numId, ordered: true, start: Number.isFinite(+t.start) && t.start !== '' ? +t.start : 1, level: lvl }); }
    let out = '';
    for (const item of t.items) {
      stats.listItems++; let first = true;
      const numPr = `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
      const box = item.task ? run(item.checked ? '\u2611 ' : '\u2610 ', {}) : '';
      for (const b of item.tokens) {
        if (b.type === 'space' || b.type === 'checkbox') continue;
        if (b.type === 'list') { if (first) { out += para(box, numPr); first = false; } out += await list(b, depth + 1, ctx); continue; }
        if (b.type === 'text' || b.type === 'paragraph') {
          const body = b.tokens ? await inline(b.tokens) : run(unent(b.text), {});
          out += first ? para(box + body, numPr) : para(body, `<w:pStyle w:val="ListParagraph"/><w:ind w:left="${720 * (lvl + 1)}"/>`);
          first = false; continue;
        }
        if (first) { out += para(box, numPr); first = false; }
        out += await blocks([b], { ...ctx, depth: depth + 1, ind: 720 * (lvl + 1) });
      }
      if (first) out += para(box, numPr);
    }
    return out;
  }
  async function table(t) {
    stats.tables++; const cols = t.header.length; const jc = (i) => (t.align?.[i] && t.align[i] !== 'left' ? `<w:jc w:val="${t.align[i]}"/>` : '');
    const cell = async (c, i, head) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${para(await inline(c.tokens, head ? { bold: true } : {}), jc(i))}</w:tc>`;
    let rows = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${(await Promise.all(t.header.map((c, i) => cell(c, i, true)))).join('')}</w:tr>`;
    for (const r of t.rows) { const cells = []; for (let i = 0; i < cols; i++) cells.push(await cell(r[i] || { tokens: [] }, i, false)); rows += `<w:tr>${cells.join('')}</w:tr>`; }
    return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(cols)}</w:tblGrid>${rows}</w:tbl>${para('', '<w:spacing w:after="0" w:line="120" w:lineRule="exact"/>')}`;
  }

  let body = await blocks(tokens, {});
  if (!body) body = para('');
  const [pw, ph] = opts.pageSize === 'letter' ? [12240, 15840] : [11906, 16838];
  const documentXml = `${HEAD}<w:document ${NS}><w:body>${body}<w:sectPr><w:pgSz w:w="${pw}" w:h="${ph}"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const title = opts.title || firstH1 || ''; const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const exts = [...new Set(media.map((m) => m.ext))];
  const files = {
    '[Content_Types].xml': `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${exts.map((e) => `<Default Extension="${e}" ContentType="image/${e}"/>`).join('')}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'docProps/core.xml': `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>${x(opts.author || '')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
    'docProps/app.xml': `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>metamorphosis doc.fromMarkdown</Application></Properties>`,
    'word/document.xml': documentXml,
    'word/styles.xml': STYLES,
    'word/numbering.xml': numberingXml(nums),
    'word/_rels/document.xml.rels': `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join('')}</Relationships>`,
  };
  const zipIn = {}; for (const [k, v] of Object.entries(files)) zipIn[k] = strToU8(v);
  for (const m of media) zipIn[`word/media/${m.name}`] = [m.bytes, { level: 0 }];
  return { bytes: zipSync(zipIn, { level: 6 }), stats, warnings, title: title || null };
}
