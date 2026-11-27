// HTML side of doc.*: DOM → Markdown (turndown), readability-style main-content pick, structured extraction, DOM → plain text,
// Markdown → HTML (marked) and the standalone page template. Browser only (DOMParser).

let tdP; let markedP;
const turndownLib = () => (tdP ||= Promise.all([
  import(new URL('../../vendor/turndown/turndown.js', import.meta.url)),
  import(new URL('../../vendor/turndown/turndown-plugin-gfm.js', import.meta.url)),
]).then(([a, b]) => ({ TurndownService: a.default, gfm: b })).catch((e) => { tdP = null; throw new Error(`could not load the vendored turndown library: ${e.message}`); }));
export const markedLib = () => (markedP ||= import(new URL('../../vendor/marked/marked.js', import.meta.url)).catch((e) => { markedP = null; throw new Error(`could not load the vendored marked library: ${e.message}`); }));

export const parseHtml = (text) => new DOMParser().parseFromString(text, 'text/html');
/** Parse XHTML strictly, fall back to the lenient HTML parser; always returns an HTML Document whose body holds the content. */
export function parseXhtml(text) {
  const x = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (x.getElementsByTagName('parsererror').length || !x.documentElement) return parseHtml(text);
  const doc = document.implementation.createHTMLDocument('');
  const srcBody = x.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'body')[0] || x.documentElement;
  for (const n of [...srcBody.childNodes]) doc.body.appendChild(doc.importNode(n, true));
  const t = x.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'title')[0]; if (t) doc.title = t.textContent;
  return doc;
}

const JUNK = 'script, style, noscript, template, link, meta, head > *, object, embed, applet, canvas, dialog, select, button, input, textarea';
export function cleanDom(root, { keepFrames = false } = {}) {
  for (const el of root.querySelectorAll(JUNK + (keepFrames ? '' : ', iframe, frame'))) el.remove();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT); const comments = []; while (walker.nextNode()) comments.push(walker.currentNode); for (const c of comments) c.remove();
  return root;
}

export function effectiveBase(doc, baseUrl) {
  const b = doc.querySelector('base[href]')?.getAttribute('href');
  try { if (b) return new URL(b, baseUrl || undefined).href; } catch { /* relative base without a base URL */ }
  return baseUrl || null;
}
const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];
export function fixLazyImages(root) {
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!src || /^data:image\/(gif|svg)/.test(src) && src.length < 400) {
      const alt = LAZY.map((a) => img.getAttribute(a)).find(Boolean) || (img.getAttribute('srcset') || img.getAttribute('data-srcset') || '').split(',')[0].trim().split(/\s+/)[0];
      if (alt) img.setAttribute('src', alt);
    }
  }
}
export function absolutize(root, base) {
  if (!base) return 0;
  let n = 0;
  const fix = (el, attr) => { const v = el.getAttribute(attr); if (!v || /^(#|data:|javascript:|mailto:|tel:|blob:)/i.test(v.trim())) return; try { const u = new URL(v.trim(), base).href; if (u !== v) { el.setAttribute(attr, u); n++; } } catch { /* leave as is */ } };
  for (const a of root.querySelectorAll('a[href], area[href]')) fix(a, 'href');
  for (const el of root.querySelectorAll('img[src], video[src], audio[src], source[src], iframe[src]')) fix(el, 'src');
  for (const el of root.querySelectorAll('video[poster]')) fix(el, 'poster');
  return n;
}
/** fn(src, img) → new src string, or null to drop the image, or {alt:true} to keep only its alt text. */
export async function rewriteImages(root, fn) {
  for (const img of [...root.querySelectorAll('img, image')]) {
    const src = img.getAttribute('src') || img.getAttribute('xlink:href') || img.getAttribute('href') || '';
    const r = await fn(src, img);
    if (typeof r === 'string') { if (img.localName === 'img') img.setAttribute('src', r); else { const n = root.ownerDocument.createElement('img'); n.setAttribute('src', r); (img.closest('svg') || img).replaceWith(n); } } else if (r && r.alt) { const alt = (img.getAttribute('alt') || '').trim(); img.replaceWith(root.ownerDocument.createTextNode(alt ? `[image: ${alt}]` : '')); } else img.remove();
  }
}

// ─────────────────────────────────────────────── main-content extraction ──
const NEG = /(?:^|[-_\s])(nav|navbar|navigation|navbox|menu|sidebar|side-bar|footer|masthead|comments?|disqus|share|sharing|social|related|recommended|promo|advert|advertisement|ads?|sponsor|sponsored|cookies?|consent|banner|breadcrumbs?|popup|modal|newsletter|subscribe|signup|toolbar|pagination|pager|skip|skip-link|toc|outbrain|taboola|widget|noprint|catlinks|editsection|mw-editsection|mw-jump-link|printfooter|sr-only|visually-hidden|screen-reader-text|hidden)(?:[-_\s]|$)/i;
const POS = /(?:^|[-_\s])(article|body|content|entry|main|page|post|text|blog|story|prose|markdown)(?:[-_\s]|$)/i;
const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DETAILS', 'DIV', 'DL', 'DD', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'UL', 'TR', 'TD', 'TH', 'TBODY', 'THEAD', 'TFOOT', 'CAPTION', 'BODY']);
const textLen = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().length;
const linkLen = (el) => { let n = 0; for (const a of el.querySelectorAll('a')) n += textLen(a); return n; };
const describe = (el) => { let s = el.localName; if (el.id) s += `#${el.id}`; const c = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3); if (c.length) s += '.' + c.join('.'); return s.slice(0, 120); };

/** Remove page chrome in place and return the densest article-like container. → {el, info} */
export function pickMain(doc) {
  const body = doc.body; const removed = { byTag: 0, byRole: 0, byClass: 0, hidden: 0 };
  const total0 = textLen(body) || 1;
  for (const el of [...body.querySelectorAll('nav, aside, footer, form, menu, [role=navigation], [role=banner], [role=contentinfo], [role=complementary], [role=search], [role=dialog], [role=alert], [role=menu], [role=menubar], [role=toolbar]')]) {
    if (!el.isConnected) continue;
    if (el.localName === 'form' && textLen(el) > total0 * 0.5) continue; // some CMSs wrap the whole page in a form
    if (el.hasAttribute('role')) removed.byRole++; else removed.byTag++;
    el.remove();
  }
  for (const el of [...body.querySelectorAll('header')]) { if (!el.isConnected || el.closest('article, main, [role=main]')) continue; if (el.querySelector('h1') && !doc.querySelector('article h1, main h1')) continue; removed.byTag++; el.remove(); }
  for (const el of [...body.querySelectorAll('[hidden], [aria-hidden=true], [style]')]) {
    if (!el.isConnected) continue;
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') || '')) { if (el.localName === 'img' || el.querySelector('img') && textLen(el) === 0) continue; removed.hidden++; el.remove(); }
  }
  for (const el of [...body.querySelectorAll('[class], [id]')]) {
    if (!el.isConnected || el === body || /^(article|main|html|body)$/.test(el.localName)) continue;
    const sig = `${el.getAttribute('class') || ''} ${el.id || ''}`;
    if (!NEG.test(sig)) continue;
    if (el.querySelector('h1') || textLen(el) > total0 * 0.25) continue;
    removed.byClass++; el.remove();
  }
  const total = textLen(body) || 1;
  // score leaf blocks, push scores up to ancestors
  const score = new Map(); const deep = new Map();
  const units = body.querySelectorAll('p, pre, blockquote, li, td, dd, div, section, article, main');
  for (const u of units) {
    let leaf = true; for (const c of u.children) if (BLOCK.has(c.nodeName)) { leaf = false; break; }
    if (!leaf && u.nodeName !== 'P') continue;
    const len = textLen(u); if (len < 25) continue;
    const ld = linkLen(u) / len;
    const s = (1 + Math.min(3, Math.floor(len / 100)) + Math.min(10, ((u.textContent || '').match(/[,，、;]/g) || []).length)) * (1 - ld) * (u.nodeName === 'LI' || u.nodeName === 'TD' ? 0.5 : 1);
    if (s <= 0) continue;
    let level = 0;
    for (let a = u.parentElement; a && a !== body.parentElement; a = a.parentElement, level++) {
      deep.set(a, (deep.get(a) || 0) + s);
      if (level < 5) score.set(a, (score.get(a) || 0) + s / (level === 0 ? 1 : level === 1 ? 2 : level * 3));
    }
  }
  const weight = (el) => {
    let w = 1; const len = textLen(el) || 1; w *= 1 - Math.min(1, linkLen(el) / len);
    if (/^(article|main)$/.test(el.localName) || el.getAttribute('role') === 'main' || el.getAttribute('itemprop') === 'articleBody') w *= 1.3;
    if (POS.test(`${el.getAttribute('class') || ''} ${el.id || ''}`)) w *= 1.15;
    return w;
  };
  let top = null; let best = 0;
  for (const [el, s] of score) { const v = s * weight(el); if (v > best) { best = v; top = el; } }
  let reason = 'top-scoring text container';
  if (!top) { top = body; reason = 'no paragraph-like text found; whole body kept'; } else {
    // climb while an ancestor holds substantially more article-like text (content split over sibling sections)
    for (let p = top.parentElement; p && p !== body.parentElement; p = p.parentElement) {
      const len = textLen(p) || 1;
      if ((deep.get(p) || 0) >= 1.25 * (deep.get(top) || 0) && linkLen(p) / len < 0.4) { top = p; reason = 'top-scoring container widened to an ancestor holding sibling sections'; }
    }
  }
  const kept = textLen(top);
  const info = { selector: describe(top), reason, textChars: kept, pageTextChars: total0, keptFraction: +(kept / total0).toFixed(3), removed };
  return { el: top, info };
}

// ───────────────────────────────────────────────────── DOM → Markdown ──
const fenceFor = (text) => { let n = 3; for (const m of text.matchAll(/`{3,}/g)) n = Math.max(n, m[0].length + 1); return '`'.repeat(n); };
const langOf = (node) => {
  for (const el of [node.querySelector?.('code'), node, node.parentElement, node.parentElement?.parentElement]) {
    if (!el?.getAttribute) continue;
    const m = /(?:^|\s)(?:language|lang|highlight-source|brush:\s*|highlight)-?([A-Za-z0-9_+#-]+)/.exec(el.getAttribute('class') || '') || (el.getAttribute('data-lang') || el.getAttribute('data-language') ? [0, el.getAttribute('data-lang') || el.getAttribute('data-language')] : null);
    if (m && !/^(none|plain|text|plaintext|highlight|notranslate)$/i.test(m[1])) return m[1].toLowerCase();
  }
  return '';
};
function tableGrid(table, cellText) {
  const grid = []; let hasHeader = false;
  const rows = [...table.rows];
  rows.forEach((tr, r) => {
    grid[r] ||= []; let c = 0;
    for (const cell of tr.cells) {
      while (grid[r][c] !== undefined) c++;
      const text = cellText(cell);
      const cs = Math.min(50, Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1)); const rs = Math.min(500, Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1));
      for (let i = 0; i < rs && r + i < rows.length; i++) { grid[r + i] ||= []; for (let j = 0; j < cs; j++) grid[r + i][c + j] = i === 0 && j === 0 ? text : ''; }
      c += cs;
    }
    if (r === 0 && tr.cells.length && [...tr.cells].every((x) => x.nodeName === 'TH')) hasHeader = true;
  });
  const width = Math.max(0, ...grid.map((g) => g.length));
  for (const g of grid) for (let i = 0; i < width; i++) if (g[i] === undefined) g[i] = '';
  return { grid: grid.filter((g) => g.length), width, hasHeader: hasHeader || !!table.tHead };
}
export function gridToMarkdown(grid, width) {
  if (!grid.length || !width) return '';
  const esc = (s) => s.replace(/\|/g, '\\|');
  const line = (cells) => `| ${cells.map(esc).join(' | ')} |`;
  return [line(grid[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...grid.slice(1).map(line)].join('\n');
}
const csvCell = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** Convert a DOM subtree (HTML document nodes) to Markdown. opts: {tables: markdown|html|csv|drop, stripLinks} */
export async function domToMarkdown(root, opts = {}) {
  const { TurndownService, gfm } = await turndownLib();
  const tables = opts.tables || 'markdown';
  const td = new TurndownService({ headingStyle: 'atx', hr: '---', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', strongDelimiter: '**', linkStyle: 'inlined' });
  td.use([gfm.strikethrough, gfm.taskListItems]);
  td.remove(['script', 'style', 'noscript', 'template', 'head', 'title']);
  td.addRule('pre', { filter: 'pre', replacement: (content, node) => { const text = (node.textContent || '').replace(/\n+$/, '').replace(/^\n/, ''); if (!text.trim()) return ''; const f = fenceFor(text); return `\n\n${f}${langOf(node)}\n${text}\n${f}\n\n`; } });
  td.addRule('figcaption', { filter: 'figcaption', replacement: (content) => (content.trim() ? `\n\n*${content.trim().replace(/\n+/g, ' ')}*\n\n` : '') });
  td.addRule('dt', { filter: 'dt', replacement: (content) => `\n\n**${content.trim()}**\n` });
  td.addRule('dd', { filter: 'dd', replacement: (content) => `\n: ${content.trim().replace(/\n+/g, ' ')}\n` });
  td.addRule('mark', { filter: ['mark'], replacement: (content) => content });
  td.addRule('linkSafe', {
    filter: (node) => node.nodeName === 'A' && node.getAttribute('href') !== null,
    replacement: (content, node) => {
      const href = (node.getAttribute('href') || '').trim(); const text = content.replace(/\n{2,}/g, ' ').trim();
      if (!text) return '';
      if (opts.stripLinks || !href || /^javascript:/i.test(href) || href === '#') return text;
      const title = (node.getAttribute('title') || '').trim();
      return `[${text}](${href.replace(/\s/g, '%20').replace(/([()])/g, '\\$1')}${title && title !== text ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
    },
  });
  td.addRule('img', {
    filter: 'img',
    replacement: (content, node) => { const src = (node.getAttribute('src') || '').trim(); if (!src) return ''; const alt = (node.getAttribute('alt') || '').replace(/[\r\n]+/g, ' ').replace(/([[\]])/g, '\\$1').trim(); return `![${alt}](${src.replace(/\s/g, '%20').replace(/([()])/g, '\\$1')})`; },
  });
  const inner = (cell) => td.turndown(cell).replace(/\s*\n\s*\n\s*/g, '<br>').replace(/\s*\n\s*/g, ' ').trim();
  if (tables === 'html') td.keep(['table']);
  else if (tables === 'drop') td.remove(['table']);
  else {
    td.addRule('table', {
      filter: 'table',
      replacement: (content, node) => {
        if (node.querySelector('table')) return `\n\n${content}\n\n`; // layout table: keep the flow of its cells
        const cap = node.caption ? td.turndown(node.caption).replace(/\s+/g, ' ').trim() : '';
        const { grid, width } = tableGrid(node, tables === 'csv' ? (c) => (c.textContent || '').replace(/\s+/g, ' ').trim() : inner);
        if (!grid.length) return '';
        if (grid.length === 1 && width === 1) return `\n\n${td.turndown(node.rows[0].cells[0])}\n\n`;
        const bodyMd = tables === 'csv' ? '```csv\n' + grid.map((r) => r.map(csvCell).join(',')).join('\n') + '\n```' : gridToMarkdown(grid, width);
        return `\n\n${cap ? `*${cap}*\n\n` : ''}${bodyMd}\n\n`;
      },
    });
    // cells of layout tables (the only ones whose children are processed) flow as blocks
    td.addRule('cells', { filter: ['td', 'th'], replacement: (content) => `\n\n${content}\n\n` });
    td.addRule('caption', { filter: 'caption', replacement: () => '' });
  }
  let md = td.turndown(root);
  md = md.replace(/ /g, ' ').replace(/[ \t]+\n/g, (m) => (m.length >= 3 && m.endsWith('  \n') ? '  \n' : '\n')).replace(/\n{3,}/g, '\n\n').trim();
  return md ? md + '\n' : '';
}

/** Tables of a document as markdown: [{caption, rows, columns, markdown}] */
export async function tablesOf(root) {
  const { TurndownService } = await turndownLib();
  const td = new TurndownService({ emDelimiter: '*' });
  const out = [];
  for (const t of root.querySelectorAll('table')) {
    if (t.querySelector('table')) continue;
    const { grid, width, hasHeader } = tableGrid(t, (c) => td.turndown(c.cloneNode(true)).replace(/\s*\n\s*/g, ' ').trim());
    if (grid.length < 2 && width < 2) continue;
    out.push({ caption: t.caption ? t.caption.textContent.replace(/\s+/g, ' ').trim() : null, rows: grid.length, columns: width, headerRow: hasHeader, markdown: gridToMarkdown(grid, width) });
  }
  return out;
}

// ─────────────────────────────────────────────────────── DOM → text ──
export function domToText(root, { linkUrls = false } = {}) {
  let out = '';
  const nl = (n) => { const m = /\n*$/.exec(out)[0].length; if (out && m < n) out += '\n'.repeat(n - m); };
  const walk = (node, ctx) => {
    if (node.nodeType === 3) { let t = node.nodeValue; if (!ctx.pre) { t = t.replace(/\s+/g, ' '); if (/(^|\n)$/.test(out) || out.endsWith(' ')) t = t.replace(/^ /, ''); } out += t; return; }
    if (node.nodeType !== 1) return;
    const n = node.nodeName;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|TITLE)$/.test(n)) return;
    if (n === 'BR') { out += '\n'; return; }
    if (n === 'HR') { nl(2); return; }
    if (n === 'IMG') { const alt = (node.getAttribute('alt') || '').trim(); if (alt) out += `[image: ${alt}]`; return; }
    if (n === 'TABLE') {
      nl(2);
      for (const tr of node.rows) { out += [...tr.cells].map((c) => domToText(c, { linkUrls }).replace(/\s*\n\s*/g, ' ').trim()).join('\t') + '\n'; }
      nl(2); return;
    }
    if (n === 'LI') {
      nl(1); const depth = ctx.depth || 0; const p = node.parentElement;
      let bullet = '- ';
      if (p && p.nodeName === 'OL') { const start = parseInt(p.getAttribute('start') || '1', 10) || 1; bullet = `${start + [...p.children].filter((c) => c.nodeName === 'LI').indexOf(node)}. `; }
      out += '  '.repeat(Math.max(0, depth - 1)) + bullet;
      for (const c of node.childNodes) walk(c, ctx);
      nl(1); return;
    }
    const block = BLOCK.has(n); const para = /^(P|H[1-6]|BLOCKQUOTE|PRE|TABLE|FIGURE|SECTION|ARTICLE|DL)$/.test(n);
    const sub = { pre: ctx.pre || n === 'PRE', depth: (ctx.depth || 0) + (n === 'UL' || n === 'OL' ? 1 : 0) };
    if (block) nl(para || ((n === 'UL' || n === 'OL') && !ctx.depth) ? 2 : 1);
    for (const c of node.childNodes) walk(c, sub);
    if (n === 'A' && linkUrls) { const h = node.getAttribute('href'); if (h && !/^(#|javascript:)/i.test(h) && h !== node.textContent.trim()) out += ` (${h})`; }
    if (block) nl(para || ((n === 'UL' || n === 'OL') && !ctx.depth) ? 2 : 1);
  };
  walk(root, {});
  return out.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ─────────────────────────────────────────────────── Markdown → HTML ──
export async function markdownToHtml(md) {
  const { marked } = await markedLib();
  return marked.parse(md.replace(/^﻿/, ''), { gfm: true, async: false });
}
export function sanitizeHtml(html) {
  const doc = parseHtml(`<body>${html}</body>`); let removed = 0;
  for (const el of doc.body.querySelectorAll('script, iframe, frame, object, embed, applet, link, meta, base, form, style')) { el.remove(); removed++; }
  for (const el of doc.body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || a.name === 'srcdoc' || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*(javascript|vbscript):/i.test(a.value)) || (/^(href|src)$/i.test(a.name) && /^\s*data:text\/html/i.test(a.value))) { el.removeAttribute(a.name); removed++; }
    }
  }
  return { html: doc.body.innerHTML, removed };
}
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CSS = {
  light: `:root{color-scheme:light}body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1c1c;background:#fff;max-width:46rem;margin:2.5rem auto;padding:0 1.25rem}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.6em 0 .5em}h1{font-size:1.9em}h2{font-size:1.45em;border-bottom:1px solid #ddd;padding-bottom:.2em}h3{font-size:1.2em}
a{color:#0b57d0}code,pre{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.9em}code{background:#f1f1f1;padding:.1em .3em;border-radius:3px}
pre{background:#f5f5f5;padding:.9em 1em;overflow:auto;border-radius:4px}pre code{background:none;padding:0}
blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid #bbb;color:#444}table{border-collapse:collapse;margin:1em 0;display:block;overflow-x:auto}
th,td{border:1px solid #ccc;padding:.35em .7em;text-align:left}th{background:#f1f1f1}img{max-width:100%}hr{border:0;border-top:1px solid #ccc;margin:2em 0}`,
  terminal: `:root{color-scheme:dark}body{font:15px/1.6 ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;color:#c8d3c8;background:#0b0e0b;max-width:52rem;margin:2.5rem auto;padding:0 1.25rem}
h1,h2,h3,h4,h5,h6{color:#7ee787;line-height:1.25;margin:1.6em 0 .5em;font-weight:600}h1{font-size:1.6em}h1::before{content:"# ";color:#3f6f45}h2{font-size:1.3em;border-bottom:1px dashed #2c3a2c;padding-bottom:.2em}h2::before{content:"## ";color:#3f6f45}h3{font-size:1.1em}
a{color:#79c0ff}code{color:#e3b341;background:#161b16;padding:.1em .3em}pre{background:#121712;border:1px solid #223022;padding:.9em 1em;overflow:auto}pre code{background:none;padding:0;color:#c8d3c8}
blockquote{margin:1em 0;padding:.1em 1em;border-left:2px solid #3f6f45;color:#8fa08f}table{border-collapse:collapse;margin:1em 0;display:block;overflow-x:auto}
th,td{border:1px solid #2c3a2c;padding:.35em .7em;text-align:left}th{color:#7ee787;background:#121712}img{max-width:100%}hr{border:0;border-top:1px dashed #2c3a2c;margin:2em 0}::selection{background:#264f2a}`,
};
export function standaloneHtml(bodyHtml, { title = 'Document', theme = 'light', lang = '' } = {}) {
  const css = theme === 'none' ? '' : `<style>\n${CSS[theme] || CSS.light}\n</style>\n`;
  return `<!doctype html>\n<html${lang ? ` lang="${escHtml(lang)}"` : ''}>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escHtml(title)}</title>\n${css}</head>\n<body>\n${bodyHtml.trim()}\n</body>\n</html>\n`;
}

// ───────────────────────────────────────────────── structured extract ──
export async function extractStructure(doc, base) {
  const abs = (u) => { if (!u) return u; try { return base ? new URL(u, base).href : u; } catch { return u; } };
  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const meta = {}; const og = {}; const twitter = {}; const other = {};
  for (const m of doc.querySelectorAll('meta')) {
    const k = m.getAttribute('property') || m.getAttribute('name') || m.getAttribute('itemprop') || (m.getAttribute('http-equiv') ? `http-equiv:${m.getAttribute('http-equiv')}` : null); const v = m.getAttribute('content');
    if (!k || v === null) continue;
    const put = (o, key) => { if (o[key] === undefined) o[key] = v; else if (Array.isArray(o[key])) o[key].push(v); else o[key] = [o[key], v]; };
    if (/^og:|^article:|^book:|^profile:|^video:|^music:/i.test(k)) put(og, k); else if (/^twitter:/i.test(k)) put(twitter, k); else put(/^(description|keywords|author|robots|generator|viewport|theme-color|date|application-name)$/i.test(k) ? meta : other, k.toLowerCase());
  }
  const linkRel = (rel) => doc.querySelector(`link[rel~="${rel}"]`)?.getAttribute('href');
  const page = {
    title: txt(doc.querySelector('title')) || null, lang: doc.documentElement.getAttribute('lang') || null, charset: doc.querySelector('meta[charset]')?.getAttribute('charset') || null,
    canonical: abs(linkRel('canonical')) || null, icon: abs(linkRel('icon')) || null,
    feeds: [...doc.querySelectorAll('link[rel~="alternate"][type*="xml"], link[rel~="alternate"][type*="json"]')].map((l) => ({ type: l.getAttribute('type'), title: l.getAttribute('title') || null, href: abs(l.getAttribute('href')) })),
    alternates: [...doc.querySelectorAll('link[rel~="alternate"][hreflang]')].map((l) => ({ hreflang: l.getAttribute('hreflang'), href: abs(l.getAttribute('href')) })),
  };
  const headings = [...doc.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => ({ level: +h.nodeName[1], text: txt(h), id: h.id || h.querySelector('[id]')?.id || null })).filter((h) => h.text);
  let host = null; try { host = base ? new URL(base).host : null; } catch { /* no base */ }
  const links = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const raw = a.getAttribute('href').trim(); if (!raw || /^javascript:/i.test(raw)) continue;
    const href = /^(#|mailto:|tel:|data:)/i.test(raw) ? raw : abs(raw);
    let kind = 'relative'; if (raw.startsWith('#')) kind = 'anchor'; else if (/^mailto:/i.test(raw)) kind = 'mailto'; else if (/^tel:/i.test(raw)) kind = 'tel'; else { try { const u = new URL(href); kind = host ? (u.host === host ? 'internal' : 'external') : 'absolute'; } catch { kind = 'relative'; } }
    const e = { href, text: txt(a).slice(0, 200) || (a.querySelector('img') ? `[image: ${a.querySelector('img').getAttribute('alt') || ''}]` : ''), kind };
    const rel = a.getAttribute('rel'); if (rel) e.rel = rel;
    links.push(e);
  }
  const images = [...doc.querySelectorAll('img')].map((img) => {
    const src = img.getAttribute('src') || ''; const e = { src: src.startsWith('data:') ? `${src.slice(0, 40)}… (data URI, ${src.length} chars)` : abs(src), alt: img.getAttribute('alt') };
    for (const k of ['width', 'height']) { const v = parseInt(img.getAttribute(k) || '', 10); if (v) e[k] = v; }
    const t = img.getAttribute('title'); if (t) e.title = t; if (img.getAttribute('srcset')) e.srcset = true;
    const fc = img.closest('figure')?.querySelector('figcaption'); if (fc) e.caption = txt(fc).slice(0, 300);
    return e;
  }).filter((e) => e.src);
  const jsonLd = []; const jsonLdErrors = [];
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) { try { const v = JSON.parse(s.textContent); if (Array.isArray(v)) jsonLd.push(...v); else jsonLd.push(v); } catch (e) { jsonLdErrors.push(e.message.slice(0, 120)); } }
  const tables = await tablesOf(doc.body);
  return { page, meta, openGraph: og, twitter, otherMeta: other, headings, links, images, tables, jsonLd, jsonLdErrors };
}
