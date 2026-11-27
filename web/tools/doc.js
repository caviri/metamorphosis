// doc.* and text.* — documents in, clean Markdown / plain text out (and back), plus the text utilities an agent needs to
// decide what to read: outline, chunk, grep, diff, stats. Heavy code (mammoth, turndown, marked, fflate and the converters in
// ../js/doc/) loads lazily on first use.
import { M, vfs, register } from '../js/core.js';

const F = () => import('../js/doc/formats.js');
const H = () => import('../js/doc/html.js');
const T = () => import('../js/doc/text.js');
const S = () => import('../js/doc/subs.js');

const ACCEPTS = 'docx, pptx, odt, odp, epub, html, ipynb (Jupyter), rtf, eml, mbox, md, txt, srt, vtt';
const TYPES = ['auto', 'docx', 'pptx', 'odt', 'odp', 'epub', 'html', 'ipynb', 'rtf', 'eml', 'mbox', 'markdown', 'text', 'srt', 'vtt'];
const MAX_TEXT = 64 * 1024 * 1024;
const cap = (list, n) => ({ items: list.slice(0, n), truncated: list.length > n });

/** Read a VFS file as text for the text.* tools: BOM-aware, refuses binary data with a pointer to the right tool. */
function readText(path) {
  const bytes = vfs.read(path);
  if (bytes.length > MAX_TEXT) throw new Error(`"${path}" is ${M.human(bytes.length)}; text tools accept at most ${M.human(MAX_TEXT)} per file \u2014 split it first`);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const n = Math.min(bytes.length, 8192); let nul = 0; for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
  if (nul > n / 200 || (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw new Error(`"${path}" (${vfs.stat(path).mime}) is not a text file \u2014 convert it first with doc.toMarkdown / doc.toText (office, epub, html, notebooks) or pdf.* (PDF)`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}
const textExt = (path, fallback = 'txt') => { const e = vfs.extOf(path); return e && vfs.isTextMime(vfs.mimeOf(path)) ? e : fallback; };
const summarize = async (text, max = 500) => { const t = await T(); return { ...t.excerpt(text, max), estimatedTokens: t.estimateTokens(text) }; };
const convertArgs = {
  type: { type: 'string', enum: TYPES, default: 'auto', description: 'Force the input type instead of sniffing it from magic bytes, extension and content' },
  notes: { type: 'boolean', default: true, description: 'pptx/odp: include speaker notes under each slide' },
  timestamps: { type: 'string', enum: ['collapse', 'keep', 'none'], default: 'collapse', description: 'srt/vtt: collapse = merge cues into paragraphs with one [hh:mm:ss] stamp each; keep = one line per cue with its time range; none = paragraphs without times' },
  mainContentOnly: { type: 'boolean', default: false, description: 'html: keep only the main article (drops nav/aside/footer/ads, picks the densest article-like container)' },
  baseUrl: { type: 'string', description: 'html: URL the page came from; relative links and image sources are rewritten to absolute URLs against it' },
  maxOutputChars: { type: 'integer', default: 4000, minimum: 0, maximum: 1000000, description: 'ipynb: cut each text output of a cell to this many characters (0 = no limit)' },
  emailBody: { type: 'string', enum: ['auto', 'text', 'html'], default: 'auto', description: 'eml/mbox: which body part to use; auto = text/plain when present, else the HTML part converted to Markdown' },
  maxMessages: { type: 'integer', default: 200, minimum: 1, maximum: 5000, description: 'mbox: convert at most this many messages' },
};

// ═════════════════════════════════════════════════════════════ doc ══
register({
  name: 'doc.info', readOnly: true,
  description: `Identify a document and read its metadata without converting it. Sniffs the real type from magic bytes and content (not just the extension), then reports title/author/dates, counts that are knowable (words, slides, chapters, cells, cues, messages; "pages" only when the authoring app stored it) and the number of embedded media files. Also says which tool converts it: doc.toMarkdown for ${ACCEPTS}; pdf.* for PDF; data.* for spreadsheets/CSV/JSON. Use it first when you are handed an unknown file.`,
  schema: { properties: { input: { type: 'string', description: 'VFS path of the document' } }, required: ['input'] },
  examples: ['doc.info input=report.docx'],
  async run({ input }) {
    const f = await F(); const t = await T(); const s = await f.sniff(input);
    const out = { path: input, bytes: s.bytes.length, type: s.type, convertible: s.family === 'doc', convertWith: s.family === 'doc' ? 'doc.toMarkdown' : s.suggest?.tool || null };
    if (s.suggest) out.note = s.suggest.note;
    const words = (txt) => t.textStats(txt).words;
    const xmlText = (b) => f.decodeText(b).replace(/<\/(w:p|a:p|text:p|text:h|p|div|h\d|li|tr)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|apos);/g, ' ');
    const z = s.zip;
    if (s.type === 'docx' || s.type === 'pptx') {
      const m = s.type === 'docx' ? f.ooxmlMeta(z) : (await f.convert(input, { dry: true, images: 'drop' })).meta;
      const { pagesStored: pages, slides, slidesWithNotes, hiddenSlides, ...meta } = m;
      out.metadata = meta;
      if (s.type === 'docx') { out.words = words(xmlText(z.read('word/document.xml'))); if (pages) out.pagesStored = pages; out.pagesNote = pages ? 'page count as last saved by the authoring application (may be stale); a .docx has no fixed pages until laid out' : 'no stored page count; a .docx has no fixed pages until laid out'; } else { out.slides = slides; out.slidesWithNotes = slidesWithNotes; out.hiddenSlides = hiddenSlides; }
      const media = z.names.filter((n) => /^(word|ppt)\/media\//.test(n)); out.media = { count: media.length, bytes: media.reduce((a, n) => a + z.entries.get(n).size, 0) };
      out.parts = { comments: z.has('word/comments.xml') || z.names.some((n) => /^ppt\/comments\//.test(n)), footnotes: z.has('word/footnotes.xml'), macros: z.names.some((n) => /vbaProject\.bin$/.test(n)), embeddedObjects: z.names.filter((n) => /\/embeddings\//.test(n)).length };
    } else if (s.type === 'odt' || s.type === 'odp') {
      const r = await f.convert(input, { dry: true, images: 'drop' }); const { images, ...meta } = r.meta; out.metadata = meta; out.words = words(r.markdown);
      const media = z.names.filter((n) => /^(Pictures|media)\//i.test(n)); out.media = { count: media.length, bytes: media.reduce((a, n) => a + z.entries.get(n).size, 0) };
    } else if (s.type === 'epub') {
      const pkg = f.epubPackage(z); out.metadata = pkg.meta; out.spineItems = pkg.spine.length;
      let w = 0; for (const it of pkg.spine) { const b = z.read(it.href); if (b) { w += words(xmlText(b)); z.drop(it.href); } } out.words = w;
      const media = [...pkg.manifest.values()].filter((i) => /^(image|audio|video)\//.test(i.type)); out.media = { count: media.length, bytes: media.reduce((a, i) => a + (z.entries.get(i.href)?.size || 0), 0) };
    } else if (s.type === 'html') {
      const h = await H(); const doc = h.parseHtml(s.text);
      out.metadata = { title: doc.title || null, lang: doc.documentElement.getAttribute('lang') || null, description: doc.querySelector('meta[name="description"]')?.getAttribute('content') || null, author: doc.querySelector('meta[name="author"]')?.getAttribute('content') || null, published: doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') || null };
      const media = doc.querySelectorAll('img, video, audio, picture source').length; h.cleanDom(doc.body);
      out.words = words(doc.body.textContent || ''); out.headings = doc.querySelectorAll('h1,h2,h3,h4,h5,h6').length; out.links = doc.querySelectorAll('a[href]').length; out.tables = doc.querySelectorAll('table').length; out.media = { count: media, note: 'referenced, not embedded (data: URIs excepted)' };
    } else if (s.type === 'ipynb') { const r = await f.convert(input, { dry: true, images: 'alt' }); out.metadata = { title: r.title, ...r.meta }; out.media = { count: r.meta.imageOutputs }; out.words = words(r.markdown); } else if (s.type === 'eml' || s.type === 'mbox') { const e = await f.emailInfo(s); const { attachments, attachmentList, ...meta } = e; out.metadata = meta; if (attachments !== undefined) { out.media = { count: attachments }; out.attachments = attachmentList; } } else if (s.type === 'rtf') { const r = f.rtfToMd(s.bytes, {}); const { pages, words: w0, ...meta } = r.meta; out.metadata = meta; if (pages) out.pagesStored = +pages; out.words = words(r.markdown); out.media = { count: (f.binStr(s.bytes).match(/\\pict\b/g) || []).length, note: 'pictures are counted but not extracted from RTF' }; } else if (s.type === 'srt' || s.type === 'vtt') {
      const sub = await S(); const p = sub.parseSubs(s.text); out.cues = p.cues.length; out.durationSeconds = p.cues.length ? +(p.cues[p.cues.length - 1].end / 1000).toFixed(3) : 0; out.words = words(p.cues.map((c) => sub.stripTags(c.text)).join(' '));
    } else if (s.type === 'markdown' || s.type === 'text') {
      const st = t.textStats(s.text); out.words = st.words; out.lines = st.lines; out.characters = st.characters;
      if (s.type === 'markdown') { const hs = t.scanHeadings(s.text); out.headings = hs.length; out.metadata = { title: hs.find((h) => h.level === 1)?.text || null }; out.media = { count: (s.text.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length, note: 'image references' }; }
    }
    if (out.words !== undefined) out.estimatedTokensNote = 'run text.stats on the converted Markdown for a token estimate';
    return out;
  },
});

register({
  name: 'doc.toMarkdown',
  description: `Convert a document to clean Markdown an LLM can read, written to a .md file. One entry point for: ${ACCEPTS}. docx keeps headings, bold/italic, lists, tables, links, footnotes and images; pptx/odp become one "## Slide N: title" section per slide with bullets, tables, pictures and speaker notes; epub chapters follow spine order; ipynb cells keep code fenced with the kernel language, text outputs and image outputs; eml/mbox give headers + body and extract attachments; srt/vtt become a readable transcript. Embedded images are written next to the .md (images=extract) and linked relatively. Returns the output file stat, detected type, title, metadata, an estimated token count and a short excerpt \u2014 read the file itself with fs.read, or plan with text.outline / text.chunk. Not for PDF (pdf.toMarkdown / pdf.* tools) or spreadsheets, CSV, JSON (data.convert / data.* tools): for those it fails with the tool to use.`,
  schema: {
    properties: {
      input: { type: 'string', description: `VFS path of the source document (${ACCEPTS})` },
      output: { type: 'string', description: 'VFS path of the .md file to write (default: <input stem>.md)' },
      images: { type: 'string', enum: ['extract', 'inline', 'alt', 'drop'], default: 'extract', description: 'extract = write embedded images to imagesDir and link them relatively; inline = keep them as data: URIs inside the Markdown (large); alt = replace each image by its alt text; drop = remove images' },
      imagesDir: { type: 'string', description: 'VFS prefix for extracted images and email attachments (default: <output stem>_media)' },
      tables: { type: 'string', enum: ['markdown', 'html', 'csv', 'drop'], default: 'markdown', description: 'markdown = GFM pipe tables (first row becomes the header, merged cells are un-merged, line breaks become <br>); html = keep raw <table> HTML (html/docx/epub only); csv = fenced csv blocks; drop = omit tables' },
      headingOffset: { type: 'integer', default: 0, minimum: -5, maximum: 5, description: 'Shift every heading level by this amount (clamped to 1..6), e.g. 1 to nest the document under an existing H1' },
      attachments: { type: 'string', enum: ['extract', 'list'], default: 'extract', description: 'eml/mbox: extract = write attachments to imagesDir and link them; list = only name them' },
      stripLinks: { type: 'boolean', default: false, description: 'Keep link text but drop the URLs (html-based inputs: html, docx, epub, email HTML bodies)' },
      ...convertArgs,
    },
    required: ['input'],
  },
  examples: ['doc.toMarkdown input=report.docx', 'doc.toMarkdown input=deck.pptx images=drop', 'doc.toMarkdown input=page.html mainContentOnly=true baseUrl=https://example.org/post'],
  async run(args, ctx) {
    const f = await F();
    const mdPath = vfs.out(args.output, args.input, vfs.extOf(args.input) === 'md' ? 'converted' : '', 'md');
    const r = await f.convert(args.input, { ...args, mdPath, tool: 'doc.toMarkdown' }, ctx);
    const output = await vfs.write(mdPath, r.markdown, { mime: 'text/markdown' });
    const t = await T(); const st = t.textStats(r.markdown); const o = cap(r.outputs, 50);
    const res = { output, type: r.type, title: r.title, metadata: r.meta, words: st.words, lines: st.lines, headings: t.scanHeadings(r.markdown).length, ...(await summarize(r.markdown)) };
    if (r.mainContent) res.mainContent = r.mainContent;
    if (r.outputs.length) { res.extractedFiles = r.outputs.length; res.outputs = o.items; if (o.truncated) res.outputsTruncated = true; }
    if (r.warnings.length) res.warnings = r.warnings;
    return res;
  },
});

register({
  name: 'doc.toText',
  description: `Flatten a document to plain text (no Markdown syntax) and write a .txt file. Same inputs as doc.toMarkdown (${ACCEPTS}); headings become plain lines, list items keep "- " / "1. " markers, table rows become tab-separated lines, images are dropped (or replaced by "[image: alt]"). Use it for search indexing, embeddings or word counts where markup is noise; use doc.toMarkdown when structure matters. Returns the output stat, word/line counts, an estimated token count and a short excerpt.`,
  schema: {
    properties: {
      input: { type: 'string', description: `VFS path of the source document (${ACCEPTS})` },
      output: { type: 'string', description: 'VFS path of the .txt file to write (default: <input stem>.txt)' },
      imageAlt: { type: 'boolean', default: false, description: 'Keep "[image: alt text]" markers where images were' },
      linkUrls: { type: 'boolean', default: false, description: 'Append " (url)" after link text instead of dropping link targets' },
      ...convertArgs,
    },
    required: ['input'],
  },
  examples: ['doc.toText input=book.epub', 'doc.toText input=talk.vtt timestamps=none'],
  async run(args, ctx) {
    const f = await F(); const t = await T();
    const outPath = vfs.out(args.output, args.input, vfs.extOf(args.input) === 'txt' ? 'plain' : '', 'txt');
    const s = await f.sniff(args.input); const type = args.type !== 'auto' ? args.type : s.type; let text; let warnings = []; let title = null;
    if (type === 'text') text = (s.text ?? f.decodeText(s.bytes)).replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
    else if (type === 'srt' || type === 'vtt') { const sub = await S(); const p = sub.parseSubs(s.text ?? f.decodeText(s.bytes)); if (!p.cues.length) throw new Error(`no subtitle cues found in "${args.input}"`); text = sub.toTranscript(p.cues, { timestamps: args.timestamps }); } else {
      const { imageAlt, linkUrls, ...rest } = args;
      const r = await f.convert(args.input, { ...rest, images: imageAlt ? 'alt' : 'drop', attachments: 'list', tables: 'markdown', dry: true, mdPath: outPath, tool: 'doc.toText' }, ctx);
      const h = await H(); const doc = h.parseHtml(await h.markdownToHtml(r.markdown, { breaks: true }));
      text = h.domToText(doc.body, { linkUrls }) + '\n'; warnings = r.warnings; title = r.title;
    }
    const output = await vfs.write(outPath, text, { mime: 'text/plain' }); const st = t.textStats(text);
    const res = { output, type, title, words: st.words, lines: st.lines, characters: st.characters, ...(await summarize(text)) };
    if (warnings.length) res.warnings = warnings;
    return res;
  },
});

register({
  name: 'doc.toHtml',
  description: 'Render a document as HTML. Markdown \u2192 HTML with GFM tables/task lists/strikethrough (marked); docx \u2192 HTML directly (mammoth, images embedded as data: URIs by default); every other doc.toMarkdown input goes through Markdown first. By default the result is a standalone page with a small embedded stylesheet \u2014 theme=light, or theme=terminal for a dark monospace look \u2014 and no external requests. Raw HTML inside Markdown is sanitised (scripts, iframes, event handlers and javascript: URLs removed) unless sanitize=false. Returns the output stat and title. For PDF output see pdf.fromMarkdown / pdf.* if registered.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path: a Markdown file, a .docx, or anything doc.toMarkdown accepts' },
      output: { type: 'string', description: 'VFS path of the .html file to write (default: <input stem>.html)' },
      theme: { type: 'string', enum: ['light', 'terminal', 'none'], default: 'light', description: 'Embedded stylesheet: light (serif-less reading page), terminal (dark, monospace, green headings), none (no CSS)' },
      standalone: { type: 'boolean', default: true, description: 'true = full <!doctype html> page with <head>, charset and CSS; false = body fragment only' },
      title: { type: 'string', description: 'Page <title> (default: document title or first heading)' },
      sanitize: { type: 'boolean', default: true, description: 'Strip scripts, iframes, forms, on* handlers and javascript: URLs from the generated HTML' },
      images: { type: 'string', enum: ['inline', 'extract', 'drop'], default: 'inline', description: 'Embedded images of docx/pptx/epub\u2026: inline = data: URIs (self-contained file), extract = separate files linked relatively, drop = removed. Image links in a Markdown input are left as they are.' },
    },
    required: ['input'],
  },
  examples: ['doc.toHtml input=README.md theme=terminal', 'doc.toHtml input=report.docx'],
  async run(args, ctx) {
    const f = await F(); const h = await H();
    const outPath = vfs.out(args.output, args.input, /^html?$/.test(vfs.extOf(args.input)) ? 'page' : '', 'html');
    const s = await f.sniff(args.input); let body; let title = args.title || null; let via; let warnings = []; let outputs = [];
    if (s.type === 'html') throw new Error(`"${args.input}" is already HTML \u2014 use doc.htmlToMarkdown to convert it, or doc.htmlExtract to pull data out of it`);
    if (s.type === 'docx') {
      const r = await f.docxToHtml(s.bytes, { images: args.images !== 'drop' }); const doc = h.parseHtml(r.html); const sink = f.makeSink(outPath, null);
      for (const img of [...doc.querySelectorAll('img')]) { const e = r.store.get(img.getAttribute('src')); if (!e) { img.remove(); continue; } img.setAttribute('src', args.images === 'extract' ? await sink.put(e.name, e.bytes, e.mime, e.key) : `data:${e.mime};base64,${M.b64.enc(e.bytes)}`); }
      body = doc.body.innerHTML; via = 'mammoth (docx \u2192 html)'; warnings = r.warnings; outputs = sink.outputs; title ||= doc.querySelector('h1')?.textContent.trim() || null;
    } else {
      let md;
      if (s.type === 'markdown' || s.type === 'text') { md = (s.text ?? f.decodeText(s.bytes)).replace(/^\ufeff/, ''); via = 'marked (markdown \u2192 html)'; } else { const r = await f.convert(args.input, { images: args.images, mdPath: outPath.replace(/\.html?$/, '.md'), tool: 'doc.toHtml' }, ctx); md = r.markdown; title ||= r.title; warnings = r.warnings; outputs = r.outputs; via = `${r.type} \u2192 markdown \u2192 html`; }
      body = await h.markdownToHtml(md); title ||= (/^#\s+(.+)$/m.exec(md) || [])[1]?.replace(/[*_`]/g, '') || null;
    }
    let removed = 0; if (args.sanitize) { const r = h.sanitizeHtml(body); body = r.html; removed = r.removed; }
    const html = args.standalone ? h.standaloneHtml(body, { title: title || vfs.stemOf(args.input), theme: args.theme }) : body.trim() + '\n';
    const output = await vfs.write(outPath, html, { mime: 'text/html' });
    const res = { output, title, via, theme: args.standalone ? args.theme : 'none', standalone: args.standalone };
    if (args.sanitize) res.sanitizedNodesOrAttributes = removed;
    if (outputs.length) { const o = cap(outputs, 50); res.outputs = o.items; if (o.truncated) res.outputsTruncated = true; }
    if (warnings.length) res.warnings = warnings;
    return res;
  },
});

register({
  name: 'doc.htmlToMarkdown',
  description: 'Convert an HTML file (a saved web page or fragment) to Markdown. mainContentOnly=true runs a readability-style extraction first: removes script/style/nav/aside/footer/forms, hidden nodes and elements whose class or id marks them as chrome (menu, sidebar, cookie, share, related, comments\u2026), then keeps the densest article-like container (paragraph text scored by length and punctuation, penalised by link density); the result reports which element was kept and what fraction of the page text survived, so you can fall back to mainContentOnly=false if it cut too much. baseUrl rewrites relative links and image sources to absolute URLs. Returns the .md stat, title, estimated tokens and a short excerpt. For structured data (links, meta tags, tables, JSON-LD) use doc.htmlExtract.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the HTML file' },
      output: { type: 'string', description: 'VFS path of the .md file to write (default: <input stem>.md)' },
      mainContentOnly: { type: 'boolean', default: false, description: 'Keep only the main article and drop page chrome (heuristic; inspect result.mainContent)' },
      baseUrl: { type: 'string', description: 'URL the page was fetched from; relative href/src are resolved against it (a <base href> in the page is honoured)' },
      images: { type: 'string', enum: ['extract', 'inline', 'alt', 'drop'], default: 'extract', description: 'extract = keep image links, writing data: URI images out as files; inline = leave everything as is (data: URIs stay inline); alt = alt text only; drop = remove images' },
      imagesDir: { type: 'string', description: 'VFS prefix for images extracted from data: URIs (default: <output stem>_media)' },
      tables: { type: 'string', enum: ['markdown', 'html', 'csv', 'drop'], default: 'markdown', description: 'How to render <table>: GFM pipe table, raw HTML, fenced csv, or omitted. Tables that contain other tables are treated as layout and flattened.' },
      headingOffset: { type: 'integer', default: 0, minimum: -5, maximum: 5, description: 'Shift heading levels (clamped to 1..6)' },
      stripLinks: { type: 'boolean', default: false, description: 'Keep link text, drop URLs' },
    },
    required: ['input'],
  },
  examples: ['doc.htmlToMarkdown input=article.html mainContentOnly=true baseUrl=https://example.org/a/b'],
  async run(args, ctx) {
    const f = await F(); const bytes = vfs.read(args.input);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b || bytes[0] === 0x25 && bytes[1] === 0x50) throw new Error(`"${args.input}" is not HTML \u2014 use doc.toMarkdown (office/epub) or pdf.* (PDF)`);
    if (args.baseUrl) { try { new URL(args.baseUrl); } catch { throw new Error(`baseUrl "${args.baseUrl}" is not an absolute URL (expected e.g. https://example.org/page)`); } }
    const mdPath = vfs.out(args.output, args.input, '', 'md');
    const r = await f.convert(args.input, { ...args, type: 'html', mdPath, tool: 'doc.htmlToMarkdown' }, ctx);
    const output = await vfs.write(mdPath, r.markdown, { mime: 'text/markdown' }); const t = await T();
    const res = { output, title: r.title, metadata: r.meta, words: t.textStats(r.markdown).words, headings: t.scanHeadings(r.markdown).length, ...(await summarize(r.markdown)) };
    if (r.mainContent) res.mainContent = r.mainContent;
    if (r.outputs.length) { const o = cap(r.outputs, 50); res.outputs = o.items; if (o.truncated) res.outputsTruncated = true; }
    if (r.warnings.length) res.warnings = r.warnings;
    return res;
  },
});

const EXTRACT_PARTS = ['meta', 'headings', 'links', 'images', 'tables', 'jsonLd'];
register({
  name: 'doc.htmlExtract',
  description: 'Pull structured data out of an HTML file as JSON: page info (title, lang, canonical, feeds), meta / OpenGraph / Twitter tags, the heading outline, links (absolute URL, text, internal/external/anchor/mailto), images (src, alt, size, caption), tables rendered as Markdown, and parsed JSON-LD. Lists in the result are capped (limit) with per-section totals and truncated flags; pass output to also write the complete, uncapped JSON to a file. Use it to map a page before deciding what to fetch or read; use doc.htmlToMarkdown for the prose.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the HTML file' },
      baseUrl: { type: 'string', description: 'URL the page came from: makes link/image URLs absolute and classifies links as internal or external' },
      include: { type: 'array', items: { type: 'string', enum: EXTRACT_PARTS }, default: EXTRACT_PARTS, description: 'Sections to return' },
      limit: { type: 'integer', default: 50, minimum: 1, maximum: 500, description: 'Max entries returned per list (links, images, headings, tables, JSON-LD objects)' },
      output: { type: 'string', description: 'Optional VFS path for the full uncapped JSON' },
    },
    required: ['input'],
  },
  examples: ['doc.htmlExtract input=page.html baseUrl=https://example.org/ include=links,meta'],
  async run({ input, baseUrl, include, limit, output }) {
    const f = await F(); const h = await H();
    if (baseUrl) { try { new URL(baseUrl); } catch { throw new Error(`baseUrl "${baseUrl}" is not an absolute URL`); } }
    const doc = h.parseHtml(f.decodeHtmlBytes(vfs.read(input))); const full = await h.extractStructure(doc, h.effectiveBase(doc, baseUrl));
    const want = new Set(include); const res = { page: full.page };
    const list = (key, arr, map = (v) => v) => { res[key] = arr.slice(0, limit).map(map); res.counts[key] = arr.length; if (arr.length > limit) (res.truncated ||= []).push(key); };
    res.counts = {};
    if (want.has('meta')) { res.meta = full.meta; res.openGraph = full.openGraph; res.twitter = full.twitter; const om = Object.entries(full.otherMeta); res.otherMeta = Object.fromEntries(om.slice(0, limit)); if (om.length > limit) (res.truncated ||= []).push('otherMeta'); for (const o of [res.meta, res.openGraph, res.twitter, res.otherMeta]) for (const k in o) if (typeof o[k] === 'string' && o[k].length > 500) o[k] = o[k].slice(0, 500) + '\u2026'; }
    if (want.has('headings')) list('headings', full.headings, (x) => ({ ...x, text: x.text.slice(0, 200) }));
    if (want.has('links')) { list('links', full.links); const kinds = {}; for (const l of full.links) kinds[l.kind] = (kinds[l.kind] || 0) + 1; res.linkKinds = kinds; }
    if (want.has('images')) list('images', full.images);
    if (want.has('tables')) list('tables', full.tables, (t) => (t.markdown.length > 2000 ? { ...t, markdown: t.markdown.slice(0, 2000) + '\n\u2026', markdownTruncated: true } : t));
    if (want.has('jsonLd')) { let budget = 12000; const kept = []; for (const j of full.jsonLd.slice(0, limit)) { const sz = JSON.stringify(j).length; if (sz > budget) { (res.truncated ||= []).push('jsonLd'); break; } budget -= sz; kept.push(j); } res.jsonLd = kept; res.counts.jsonLd = full.jsonLd.length; if (full.jsonLd.length > kept.length && !res.truncated?.includes('jsonLd')) (res.truncated ||= []).push('jsonLd'); if (full.jsonLdErrors.length) res.jsonLdErrors = full.jsonLdErrors.slice(0, 5); }
    if (output) res.output = await vfs.write(output, JSON.stringify(full, null, 1), { mime: 'application/json' }); else if (res.truncated) res.hint = 'lists were capped \u2014 pass output=<path>.json to write everything, or raise limit';
    return res;
  },
});

register({
  name: 'doc.fromMarkdown',
  description: 'Build a document from a Markdown file. to=docx writes a real Word file (OOXML generated here, no template): headings 1\u20136 with Word heading styles, paragraphs, bold/italic/strikethrough/inline code, links, nested bullet and numbered lists, task lists, tables with a header row and column alignment, fenced code blocks, block quotes, horizontal rules, and images that exist in the VFS (embedded; remote images become hyperlinks). Not carried over: raw HTML blocks (flattened to text), footnote syntax, math, syntax highlighting. to=html writes a standalone themed page (same as doc.toHtml). to=pdf delegates to pdf.fromMarkdown when that tool is registered. Returns the output stat and counts of what was written.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the Markdown file' },
      to: { type: 'string', enum: ['docx', 'html', 'pdf'], default: 'docx', description: 'Target format (pdf only works if pdf.fromMarkdown is registered)' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.<to>)' },
      title: { type: 'string', description: 'Document title property / HTML <title> (default: first H1)' },
      author: { type: 'string', description: 'docx: author property' },
      pageSize: { type: 'string', enum: ['a4', 'letter'], default: 'a4', description: 'docx: page size' },
      theme: { type: 'string', enum: ['light', 'terminal', 'none'], default: 'light', description: 'html: embedded stylesheet' },
    },
    required: ['input'],
  },
  examples: ['doc.fromMarkdown input=notes.md', 'doc.fromMarkdown input=notes.md to=html theme=terminal'],
  async run({ input, to, output, title, author, pageSize, theme }) {
    if (to === 'pdf') {
      if (!M.tools.has('pdf.fromMarkdown')) throw new Error('to=pdf needs the tool pdf.fromMarkdown, which is not registered in this page \u2014 use to=html (then print to PDF) or to=docx');
      const a = { input }; if (output) a.output = output;
      return { delegatedTo: 'pdf.fromMarkdown', ...(await M.run('pdf.fromMarkdown', a)) };
    }
    if (to === 'html') { const a = { input, theme }; if (output) a.output = output; if (title) a.title = title; return M.run('doc.toHtml', a); }
    const md = readText(input); const w = await import('../js/doc/docxwrite.js');
    const r = await w.markdownToDocx(md, { title, author, pageSize, mdPath: input });
    const out = await vfs.write(vfs.out(output, input, '', 'docx'), r.bytes, { mime: vfs.mimeOf('x.docx') });
    const res = { output: out, title: r.title, written: r.stats };
    if (r.warnings.length) res.warnings = r.warnings.slice(0, 20);
    return res;
  },
});

register({
  name: 'doc.subtitles',
  description: 'Convert and retime subtitles: SRT \u21c4 WebVTT, or to a plain transcript (txt / md) or a JSON cue list. Times can be shifted (shiftSeconds, negative = earlier; cues that end before 0 are dropped) and scaled (scale, e.g. 25/23.976 = 1.04271 to fix a frame-rate mismatch; applied before the shift). Transcripts merge cues into paragraphs, remove rolling duplicate lines from auto-captions and strip inline tags. Returns the output stat, cue count and duration.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of an .srt or .vtt file (format is sniffed from content)' },
      to: { type: 'string', enum: ['srt', 'vtt', 'txt', 'md', 'json'], default: 'vtt', description: 'Target: srt, vtt, txt (plain transcript), md (transcript with bold time stamps), json (array of {index,start,end,text} with times in seconds)' },
      output: { type: 'string', description: 'VFS path to write (default: derived from input)' },
      shiftSeconds: { type: 'number', default: 0, minimum: -86400, maximum: 86400, description: 'Add this many seconds to every time stamp (after scaling)' },
      scale: { type: 'number', default: 1, minimum: 0.1, maximum: 10, description: 'Multiply every time stamp by this factor (before shifting)' },
      stripTags: { type: 'boolean', default: false, description: 'srt/vtt output: remove inline formatting tags (<i>, <b>, <c.class>, {\\an8}\u2026)' },
      timestamps: { type: 'string', enum: ['collapse', 'keep', 'none'], default: 'collapse', description: 'txt/md output: collapse = one [hh:mm:ss] per paragraph, keep = one line per cue with its range, none = text only' },
    },
    required: ['input'],
  },
  examples: ['doc.subtitles input=talk.srt to=vtt', 'doc.subtitles input=talk.vtt to=srt shiftSeconds=-1.5', 'doc.subtitles input=talk.srt to=txt timestamps=none'],
  async run({ input, to, output, shiftSeconds, scale, stripTags, timestamps }) {
    const sub = await S(); const text = readText(input); const p = sub.parseSubs(text);
    if (!p.cues.length) throw new Error(`no cues found in "${input}" \u2014 expected SRT or WebVTT timing lines like "00:00:01,000 --> 00:00:04,000"`);
    const { cues, dropped } = sub.retime(p.cues, { shiftMs: shiftSeconds * 1000, scale });
    let body; let mime;
    if (to === 'srt') { body = sub.toSrt(cues, { strip: stripTags }); mime = vfs.mimeOf('x.srt'); } else if (to === 'vtt') { body = sub.toVtt(cues, { strip: stripTags, header: p.header }); mime = 'text/vtt'; } else if (to === 'json') { body = JSON.stringify(cues.map((c, i) => ({ index: i + 1, start: c.start / 1000, end: c.end / 1000, text: sub.stripTags(c.text) })), null, 1); mime = 'application/json'; } else { body = sub.toTranscript(cues, { timestamps, markdown: to === 'md' }); mime = to === 'md' ? 'text/markdown' : 'text/plain'; }
    const out = await vfs.write(vfs.out(output, input, to === p.format ? 'retimed' : to === 'txt' || to === 'md' ? 'transcript' : '', to), body, { mime });
    const res = { output: out, from: p.format, to, cues: cues.length, firstCueSeconds: cues.length ? cues[0].start / 1000 : null, durationSeconds: cues.length ? cues[cues.length - 1].end / 1000 : 0 };
    if (dropped) res.droppedCues = dropped; if (p.skipped) res.unparsedBlocks = p.skipped;
    const t = await T(); if (to === 'txt' || to === 'md') Object.assign(res, t.excerpt(body, 400));
    return res;
  },
});

register({
  name: 'doc.media',
  description: 'List, and optionally extract, the media files embedded in a zip-based document: docx, pptx, xlsx, odt/odp/ods, epub. Lists name, mime type and size of each embedded image/audio/video (fonts and other embedded objects on request). With extract=true the files are written under a VFS prefix so image.* / vision.* / audio.* tools can work on them. For images in reading order next to the text use doc.toMarkdown images=extract instead.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the container document' },
      extract: { type: 'boolean', default: false, description: 'false = list only; true = also write the files to the VFS' },
      kinds: { type: 'array', items: { type: 'string', enum: ['image', 'audio', 'video', 'font', 'other'] }, default: ['image', 'audio', 'video'], description: 'Which kinds of embedded files to include' },
      prefix: { type: 'string', description: 'VFS prefix for extracted files (default: <input stem>_media)' },
      limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000, description: 'Max files listed / extracted' },
    },
    required: ['input'],
  },
  examples: ['doc.media input=deck.pptx', 'doc.media input=book.epub extract=true kinds=image'],
  async run({ input, extract, kinds, prefix, limit }) {
    const f = await F(); const s = await f.sniff(input);
    if (!s.zip) throw new Error(`"${input}" (detected: ${s.type}) is not a zip-based document \u2014 doc.media reads docx, pptx, xlsx, odt, odp, ods and epub. For email attachments use doc.toMarkdown; for PDF images use pdf.*`);
    const z = s.zip; const want = new Set(kinds);
    const kindOf = (name, mime) => (/^image\//.test(mime) ? 'image' : /^audio\//.test(mime) ? 'audio' : /^video\//.test(mime) ? 'video' : /^font\/|\.(ttf|otf|woff2?|odttf)$/i.test(mime + name) ? 'font' : 'other');
    let cands;
    if (s.type === 'epub') { const pkg = f.epubPackage(z); cands = [...pkg.manifest.values()].filter((i) => !/html|css|ncx|opf|javascript|smil/.test(i.type) && z.has(i.href)).map((i) => ({ name: i.href, mime: i.type || f.mimeFor(i.href) })); } else {
      const re = { docx: /^word\/(media|embeddings|fonts)\//, pptx: /^ppt\/(media|embeddings|fonts)\//, xlsx: /^xl\/(media|embeddings)\//, odt: /^(Pictures|media|Object[^/]*)\//i, odp: /^(Pictures|media|Object[^/]*)\//i, ods: /^(Pictures|media|Object[^/]*)\//i }[s.type];
      cands = z.names.filter((n) => (re ? re.test(n) : !/\.(xml|rels|html?|css|txt|json|js|opf|ncx)$/i.test(n) && n !== 'mimetype')).map((n) => ({ name: n, mime: f.mimeFor(n) }));
    }
    const all = cands.map((c) => ({ ...c, kind: kindOf(c.name, c.mime), bytes: z.entries.get(c.name).size })).filter((c) => want.has(c.kind));
    const byKind = {}; for (const c of all) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    const picked = all.slice(0, limit); const res = { type: s.type, count: all.length, byKind, totalBytes: all.reduce((a, c) => a + c.bytes, 0) };
    if (all.length > limit) res.truncated = true;
    if (!extract) { res.files = picked; if (all.length) res.hint = 'extract=true writes these files to the VFS'; return res; }
    const dir = (prefix || `${vfs.stemOf(input)}_media`).replace(/\/+$/, ''); const used = new Set(); const outputs = [];
    const data = z.readMany(picked.map((p) => p.name));
    for (let i = 0; i < picked.length; i++) {
      let name = picked[i].name.split('/').pop().replace(/[^\w.\-()+ ]+/g, '_') || `file-${i + 1}`; let k = 1; const base = name;
      while (used.has(name.toLowerCase())) name = base.replace(/(\.[A-Za-z0-9]+)?$/, `-${++k}$1`);
      used.add(name.toLowerCase());
      const mime = f.mimeFor(name, data[i]);
      outputs.push({ ...(await vfs.write(`${dir}/${name}`, data[i], { mime: mime !== 'application/octet-stream' ? mime : picked[i].mime })), source: picked[i].name });
    }
    res.outputs = outputs; res.prefix = dir;
    return res;
  },
});

// ════════════════════════════════════════════════════════════ text ══
register({
  name: 'text.stats', readOnly: true,
  description: 'Measure a text file: bytes, characters, words, lines, paragraphs, sentences (approximate), reading time, a language and script guess, and an estimated LLM token count. The token figure is a character-class heuristic, NOT a real tokenizer: its weights were fitted to OpenAI cl100k/o200k counts on ten sample texts, where it landed within \u00b15% on English prose and between \u221219% (JSON) and +19% (code-heavy docs) overall; it was not measured against Claude tokenizers, which usually count more tokens \u2014 use it to budget context with headroom, not to bill. Language is guessed from scripts plus stop-word frequency for 13 Latin-script languages; null when unsure.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of a text file (txt, md, csv, json, code\u2026)' } }, required: ['input'] },
  examples: ['text.stats input=report.md'],
  async run({ input }) {
    const t = await T(); const text = readText(input); const lang = t.guessLanguage(text);
    return { ...t.textStats(text), language: lang.language, languageConfidence: lang.confidence, languageMethod: lang.method, script: lang.script, scripts: lang.scripts, estimatedTokens: t.estimateTokens(text), tokenEstimate: { method: t.TOKEN_HEURISTIC, charsPer4: Math.ceil([...text].length / 4) } };
  },
});

register({
  name: 'text.chunk',
  description: 'Split a text or Markdown file into chunks that each fit a token budget, for retrieval or for feeding a long document to a model piece by piece. Cuts prefer, in order: a heading, a paragraph / code-block / table boundary, a line, a sentence, a word \u2014 a hard character cut happens only inside a single unbroken token run longer than a quarter of the budget. Fenced code blocks are kept whole when they fit. Optional overlap repeats the tail of each chunk at the start of the next. Every chunk is an exact byte slice of the source, so concatenating the chunks (each minus its first overlapBytes bytes) reproduces the file. Writes NNNN.<ext> chunk files plus manifest.json under a prefix; returns the manifest head (index, path, heading path, estimated tokens, byte range). Token counts use the text.stats heuristic (not a real tokenizer \u2014 leave ~30% headroom below a hard model limit).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the text/Markdown file' },
      maxTokens: { type: 'integer', default: 800, minimum: 16, maximum: 500000, description: 'Budget per chunk in estimated tokens (overlap included); no chunk exceeds it' },
      overlapTokens: { type: 'integer', default: 0, minimum: 0, maximum: 250000, description: 'Estimated tokens repeated from the end of the previous chunk (at most half of maxTokens; aligned to sentence/line boundaries, so the actual overlap is \u2264 this)' },
      markdown: { type: 'string', enum: ['auto', 'true', 'false'], default: 'auto', description: 'Treat # headings, fenced code and tables as structure. auto = yes for .md/.markdown files, and for other files that contain ATX headings' },
      prefix: { type: 'string', description: 'VFS prefix for the chunk files (default: <input stem>.chunks)' },
    },
    required: ['input'],
  },
  examples: ['text.chunk input=book.md maxTokens=1500 overlapTokens=150'],
  async run({ input, maxTokens, overlapTokens, markdown, prefix }, ctx) {
    const t = await T(); const text = readText(input);
    if (!text.length) throw new Error(`"${input}" is empty \u2014 nothing to chunk`);
    if (overlapTokens > maxTokens / 2) throw new Error(`overlapTokens (${overlapTokens}) must be at most half of maxTokens (${maxTokens})`);
    const isMd = markdown === 'true' || (markdown === 'auto' && (/^(md|markdown|mdown)$/.test(vfs.extOf(input)) || /^#{1,6} \S/m.test(text.slice(0, 200000))));
    const { chunks } = t.chunkText(text, { budget: maxTokens, overlap: overlapTokens, markdown: isMd });
    const dir = (prefix || `${vfs.stemOf(input)}.chunks`).replace(/\/+$/, ''); const ext = textExt(input, isMd ? 'md' : 'txt'); const width = Math.max(4, String(chunks.length).length);
    for (const old of vfs.list(dir + '/')) if (/\/(\d{4,}\.[a-z0-9]+|manifest\.json)$/.test(old.path)) vfs.rm(old.path); // a re-run must not leave stale chunks behind
    const manifest = []; const outputs = []; let bytePos = 0; let charPos = 0; let maxSeen = 0; let overlapped = 0;
    const byteAt = (pos) => { bytePos += pos >= charPos ? t.utf8Length(text.slice(charPos, pos)) : -t.utf8Length(text.slice(pos, charPos)); charPos = pos; return bytePos; };
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]; const body = text.slice(c.start, c.end); const path = `${dir}/${String(i + 1).padStart(width, '0')}.${ext}`;
      const byteStart = byteAt(c.start); const newByte = byteAt(c.newStart); const byteEnd = byteAt(c.end);
      const st = await vfs.write(path, body, { mime: vfs.mimeOf(path) });
      if (outputs.length < 50) outputs.push(st);
      maxSeen = Math.max(maxSeen, c.tokens); if (newByte > byteStart) overlapped++;
      manifest.push({ index: i + 1, path, headingPath: c.headingPath, estimatedTokens: c.tokens, byteStart, byteEnd, bytes: byteEnd - byteStart, overlapBytes: newByte - byteStart });
      if (i % 200 === 0) ctx.progress(i / chunks.length, `chunk ${i + 1}/${chunks.length}`);
    }
    const mf = await vfs.write(`${dir}/manifest.json`, JSON.stringify({ source: input, sourceBytes: bytePos, maxTokens, overlapTokens, markdown: isMd, tokenEstimate: 'heuristic (see text.stats)', reassemble: 'concatenate every chunk file after dropping its first overlapBytes bytes', chunks: manifest }, null, 1), { mime: 'application/json' });
    const res = { output: mf, count: chunks.length, prefix: dir, markdown: isMd, maxTokens, maxEstimatedTokensInAChunk: maxSeen, totalEstimatedTokens: t.estimateTokens(text), chunksWithOverlap: overlapped, chunks: manifest.slice(0, 50), outputs };
    if (manifest.length > 50) { res.truncated = true; res.hint = `only the first 50 of ${manifest.length} chunks are listed here; the full list is in ${mf.path}`; }
    return res;
  },
});

register({
  name: 'text.diff',
  description: 'Line-based unified diff of two text files (Myers algorithm), written as a .diff file that `patch` / `git apply` understand. Returns added/removed/unchanged line counts, hunk count, a 0\u20131 similarity ratio and the head of the diff. Line endings are compared as LF. If the files differ by more than 3000 edit steps in their changed middle the diff falls back to one big replace hunk and sets approximate=true. Use ignoreWhitespace / ignoreCase to hide noise.',
  schema: {
    properties: {
      a: { type: 'string', description: 'VFS path of the old / left file' },
      b: { type: 'string', description: 'VFS path of the new / right file' },
      context: { type: 'integer', default: 3, minimum: 0, maximum: 100, description: 'Unchanged lines shown around each change' },
      ignoreWhitespace: { type: 'boolean', default: false, description: 'Treat lines that differ only in whitespace as equal' },
      ignoreCase: { type: 'boolean', default: false, description: 'Compare case-insensitively' },
      output: { type: 'string', description: 'VFS path of the .diff file (default: <a stem>.diff; not written when the files are identical)' },
    },
    required: ['a', 'b'],
  },
  examples: ['text.diff a=v1.md b=v2.md'],
  async run({ a, b, context, ignoreWhitespace, ignoreCase, output }) {
    const t = await T(); const ta = readText(a); const tb = readText(b);
    const r = t.unifiedDiff(ta, tb, { nameA: `a/${a}`, nameB: `b/${b}`, context, ignoreWhitespace, ignoreCase });
    const { diff, ...stats } = r; const res = { ...stats };
    if (!r.identical) { res.output = await vfs.write(vfs.out(output, a, '', 'diff'), diff, { mime: 'text/x-diff' }); const lines = diff.split('\n'); const head = lines.slice(0, 60).join('\n'); const e = t.excerpt(head, 3000); res.excerpt = e.excerpt; res.truncated = e.truncated || lines.length > 61; }
    if (r.approximate) res.note = 'files differ too much for a minimal diff; the changed region is shown as one replace hunk';
    return res;
  },
});

const regexArgs = {
  pattern: { type: 'string', description: 'JavaScript regular expression source (no slashes), or plain text when literal=true. Max 2000 characters.' },
  literal: { type: 'boolean', default: false, description: 'Treat pattern as plain text, not a regex' },
  ignoreCase: { type: 'boolean', default: false, description: 'Case-insensitive match' },
  flags: { type: 'string', default: '', description: 'Extra regex flags: m (^/$ match per line), s (dot matches newline), u (unicode). i via ignoreCase; g is managed by the tool' },
  timeoutMs: { type: 'integer', default: 5000, minimum: 100, maximum: 60000, description: 'Kill the search after this long. The regex runs in a Worker that is terminated at the deadline, so a catastrophically backtracking pattern fails with an error instead of freezing the page.' },
};
register({
  name: 'text.grep', readOnly: true,
  description: 'Search text files with a regular expression (or literal text), line by line, like grep -n. Give one file (input), several (inputs), or every text file under a VFS prefix. Returns up to maxMatches matching lines with path, line and column, the matched text, capture groups and optional context lines, plus total and per-file counts. Lines longer than 10 000 characters are searched only in their first 10 000. Guard against runaway regexes: the search runs in a Worker killed after timeoutMs; binary files are skipped; at most 64 MiB of text per call.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of one text file' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'Several VFS paths' },
      prefix: { type: 'string', description: 'Search every text file whose path starts with this prefix' },
      ...regexArgs,
      context: { type: 'integer', default: 0, minimum: 0, maximum: 10, description: 'Lines of context before and after each match' },
      invert: { type: 'boolean', default: false, description: 'Return lines that do NOT match' },
      maxMatches: { type: 'integer', default: 50, minimum: 1, maximum: 500, description: 'Max matching lines returned (counting continues past the cap)' },
    },
    required: ['pattern'],
  },
  examples: ['text.grep input=log.txt pattern="ERROR|FATAL" context=1', 'text.grep prefix=book.chunks/ pattern=whale ignoreCase=true'],
  async run({ input, inputs, prefix, pattern, literal, ignoreCase, flags, timeoutMs, context, invert, maxMatches }) {
    const t = await T(); const { source, flags: fl } = t.buildRegex(pattern, { flags, literal, ignoreCase });
    const paths = [...new Set([...(input ? [input] : []), ...(inputs || []), ...(prefix !== undefined ? vfs.list(prefix).map((f) => f.path) : [])])];
    if (!paths.length) throw new Error('give input, inputs or prefix (no files to search)');
    const files = []; const skipped = []; let total = 0;
    for (const p of paths) {
      try { const text = readText(p); total += text.length; if (total > MAX_TEXT) throw new Error(`more than ${M.human(MAX_TEXT)} of text selected \u2014 narrow the prefix`); files.push({ path: p, text }); } catch (e) { if (paths.length === 1 || /more than/.test(e.message)) throw e; skipped.push(p); }
    }
    if (!files.length) throw new Error(`none of the ${paths.length} selected files is a text file`);
    const r = await t.runRegexJob({ kind: 'grep', files, source, flags: fl, context, invert, max: maxMatches, maxLine: 10000, maxText: 300 }, timeoutMs);
    const res = { pattern: source, flags: fl, filesSearched: files.length, filesWithMatches: r.filesWithMatches, totalMatchingLines: r.total, returned: r.matches.length, truncated: r.total > r.matches.length, matches: r.matches };
    if (files.length > 1) { res.perFile = r.perFile.slice(0, 50); if (r.perFile.length > 50) res.perFileTruncated = true; }
    if (skipped.length) { res.skippedNonText = skipped.length; res.skippedSample = skipped.slice(0, 5); }
    if (r.guard !== 'worker') res.guardNote = `regex ran without a kill switch: ${r.guard}`;
    return res;
  },
});

register({
  name: 'text.replace',
  description: 'Regex (or literal) search-and-replace over a whole text file, written to a new file; the source is left untouched unless output names it. The replacement supports $1\u2026$99, $<name>, $& (whole match) and $$ like JavaScript String.replace; all matches are replaced. Returns the number of replacements and the output stat. Same runaway-regex guard as text.grep: runs in a Worker killed after timeoutMs.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the text file' },
      ...regexArgs,
      replacement: { type: 'string', default: '', description: 'Replacement text; $1, $<name>, $& and $$ are expanded unless literal=true. Empty string deletes the matches.' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.replaced.<ext>)' },
    },
    required: ['input', 'pattern'],
  },
  examples: ['text.replace input=notes.md pattern="(\\d{2})/(\\d{2})/(\\d{4})" replacement="$3-$2-$1"', 'text.replace input=a.txt pattern=colour replacement=color literal=true'],
  async run({ input, pattern, literal, ignoreCase, flags, timeoutMs, replacement, output }) {
    const t = await T(); const text = readText(input); const { source, flags: fl } = t.buildRegex(pattern, { flags, literal, ignoreCase, global: true });
    const r = await t.runRegexJob({ kind: 'replace', text, source, flags: fl, replacement, literalReplacement: literal }, timeoutMs);
    const out = await vfs.write(vfs.out(output, input, 'replaced', textExt(input)), r.text, { mime: vfs.stat(input).mime });
    const res = { output: out, replacements: r.count, pattern: source, flags: fl, charsBefore: text.length, charsAfter: r.text.length };
    if (r.guard !== 'worker') res.guardNote = `regex ran without a kill switch: ${r.guard}`;
    return res;
  },
});

register({
  name: 'text.normalize',
  description: 'Clean up a text file: unify line endings, apply Unicode normalisation (NFC by default; NFKC also folds full-width forms, ligatures and superscripts), strip control and zero-width characters, optionally turn smart quotes, dashes, ellipses and non-breaking spaces into plain ASCII, collapse runs of spaces and blank lines, trim trailing whitespace, expand tabs. Returns the output stat and a count of each kind of change, so you can see what was wrong with the file.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the text file' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.normalized.<ext>)' },
      eol: { type: 'string', enum: ['lf', 'crlf', 'keep'], default: 'lf', description: 'Line endings to write' },
      unicode: { type: 'string', enum: ['NFC', 'NFKC', 'NFD', 'NFKD', 'none'], default: 'NFC', description: 'Unicode normalisation form' },
      stripControl: { type: 'boolean', default: true, description: 'Remove C0/C1 control characters (except tab and newlines), zero-width and bidi marks, soft hyphens, stray BOMs' },
      asciiQuotes: { type: 'boolean', default: false, description: 'Curly quotes \u2192 \' and ", en/em dashes \u2192 - and --, \u2026 \u2192 ..., non-breaking and thin spaces \u2192 space' },
      collapseWhitespace: { type: 'boolean', default: false, description: 'Runs of spaces/tabs inside a line \u2192 one space (indentation is kept), 3+ line breaks \u2192 one blank line, trailing whitespace trimmed' },
      trimTrailing: { type: 'boolean', default: true, description: 'Remove spaces and tabs at line ends' },
      tabs: { type: 'integer', default: 0, minimum: 0, maximum: 16, description: 'Replace each tab with this many spaces (0 = keep tabs)' },
      finalNewline: { type: 'boolean', default: false, description: 'Make sure the file ends with a line break' },
    },
    required: ['input'],
  },
  examples: ['text.normalize input=scraped.txt asciiQuotes=true collapseWhitespace=true'],
  async run({ input, output, ...o }) {
    const t = await T(); const bytes = vfs.read(input); const text = readText(input);
    const hadBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const r = t.normalizeText(text, { ...o, stripBom: true });
    const out = await vfs.write(vfs.out(output, input, 'normalized', textExt(input)), r.text, { mime: vfs.stat(input).mime });
    return { output: out, changed: r.text !== text || hadBom, changes: r.changes, bytesBefore: bytes.length, bytesAfter: out.bytes, encodingNote: 'output is UTF-8 without BOM' };
  },
});

const splitLines = (text) => { const eol = /\r\n/.test(text) ? '\r\n' : '\n'; const lines = text.split(/\r\n|\r|\n/); const final = lines[lines.length - 1] === ''; if (final) lines.pop(); return { lines, eol, final }; };
register({
  name: 'text.dedupe',
  description: 'Remove duplicate lines from a text file, keeping the first occurrence and the original order (unlike sort -u). Options: compare case-insensitively, ignore surrounding whitespace, only collapse adjacent repeats (like uniq), keep blank lines. Returns lines in/out, how many were removed and the most repeated lines.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the text file' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.dedupe.<ext>)' },
      ignoreCase: { type: 'boolean', default: false, description: 'Lines differing only in case are duplicates' },
      trim: { type: 'boolean', default: false, description: 'Ignore leading/trailing whitespace when comparing (the first occurrence is kept as written)' },
      adjacent: { type: 'boolean', default: false, description: 'Only remove a line when it repeats the line directly before it' },
      keepBlank: { type: 'boolean', default: true, description: 'Never remove blank lines (keeps paragraph structure)' },
    },
    required: ['input'],
  },
  examples: ['text.dedupe input=urls.txt trim=true'],
  async run({ input, output, ignoreCase, trim, adjacent, keepBlank }) {
    const text = readText(input); const { lines, eol, final } = splitLines(text);
    const key = (l) => { let k = trim ? l.trim() : l; if (ignoreCase) k = k.toLowerCase(); return k; };
    const seen = new Map(); const out = []; let prev = null;
    for (const l of lines) {
      const k = key(l);
      if (keepBlank && !l.trim()) { out.push(l); prev = null; continue; }
      if (adjacent) { if (k === prev) { seen.set(k, (seen.get(k) || 1) + 1); continue; } prev = k; out.push(l); continue; }
      if (seen.has(k)) { seen.set(k, seen.get(k) + 1); continue; }
      seen.set(k, 1); out.push(l);
    }
    const st = await vfs.write(vfs.out(output, input, 'dedupe', textExt(input)), out.join(eol) + (final ? eol : ''), { mime: vfs.stat(input).mime });
    const top = [...seen.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([line, count]) => ({ line: line.length > 200 ? line.slice(0, 200) + '\u2026' : line, count }));
    return { output: st, linesIn: lines.length, linesOut: out.length, removed: lines.length - out.length, mostRepeated: top };
  },
});

register({
  name: 'text.sort',
  description: 'Sort the lines of a text file. Modes: alpha (Unicode code-point order, or locale-aware with ignoreCase), natural ("file2" before "file10"), numeric (by the first number on each line; lines without a number go last), length. Options: reverse, unique (drop exact duplicates after sorting), keep a number of header lines in place, drop blank lines. The sort is stable. Returns the output stat and line counts.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the text file' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.sorted.<ext>)' },
      mode: { type: 'string', enum: ['alpha', 'natural', 'numeric', 'length'], default: 'alpha', description: 'Comparison used' },
      reverse: { type: 'boolean', default: false, description: 'Descending order' },
      ignoreCase: { type: 'boolean', default: false, description: 'Case-insensitive comparison (alpha and natural modes)' },
      unique: { type: 'boolean', default: false, description: 'Remove duplicate lines (after case folding when ignoreCase=true)' },
      headerLines: { type: 'integer', default: 0, minimum: 0, maximum: 1000, description: 'Leave this many leading lines unsorted at the top' },
      dropBlank: { type: 'boolean', default: false, description: 'Remove blank lines' },
    },
    required: ['input'],
  },
  examples: ['text.sort input=names.txt ignoreCase=true unique=true', 'text.sort input=sizes.txt mode=numeric reverse=true'],
  async run({ input, output, mode, reverse, ignoreCase, unique, headerLines, dropBlank }) {
    const text = readText(input); const { lines, eol, final } = splitLines(text);
    const head = lines.slice(0, headerLines); let body = lines.slice(headerLines); const n0 = body.length;
    if (dropBlank) body = body.filter((l) => l.trim());
    const coll = new Intl.Collator(undefined, { numeric: mode === 'natural', sensitivity: ignoreCase ? 'accent' : 'variant' });
    const num = (l) => { const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(l.replace(/(\d),(?=\d{3})/g, '$1')); return m ? parseFloat(m[0]) : NaN; };
    let cmp;
    if (mode === 'numeric') { const keys = new Map(body.map((l) => [l, num(l)])); cmp = (a, b) => { const x = keys.get(a); const y = keys.get(b); if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) - Number.isNaN(y); return x - y; }; } else if (mode === 'length') cmp = (a, b) => a.length - b.length;
    else if (mode === 'natural' || ignoreCase) cmp = (a, b) => coll.compare(a, b);
    else cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const withNaNLast = mode === 'numeric';
    body = body.map((l, i) => [l, i]).sort((p, q) => { let c = cmp(p[0], q[0]); if (reverse && !(withNaNLast && (Number.isNaN(num(p[0])) || Number.isNaN(num(q[0]))))) c = -c; return c || p[1] - q[1]; }).map((p) => p[0]);
    let dupes = 0;
    if (unique) { const seen = new Set(); body = body.filter((l) => { const k = ignoreCase ? l.toLowerCase() : l; if (seen.has(k)) { dupes++; return false; } seen.add(k); return true; }); }
    const outLines = [...head, ...body];
    const st = await vfs.write(vfs.out(output, input, 'sorted', textExt(input)), outLines.join(eol) + (final ? eol : ''), { mime: vfs.stat(input).mime });
    return { output: st, linesIn: lines.length, linesOut: outLines.length, sorted: body.length, blankDropped: dropBlank ? n0 - body.length - dupes : 0, duplicatesRemoved: dupes, first: (body[0] || '').slice(0, 120), last: (body[body.length - 1] || '').slice(0, 120) };
  },
});

register({
  name: 'text.outline', readOnly: true,
  description: 'Heading tree of a Markdown file with an estimated token count per section \u2014 use it to decide which parts of a long document to read. Each entry has level, title, line number, ownTokens (the section body up to the next heading), tokens (including its sub-sections) and a byte range you can pass straight to fs.read (offset=byteStart, length=byteEnd-byteStart). Recognises ATX (#) and setext (=== / ---) headings and ignores fenced code. Token counts are the text.stats heuristic, not a real tokenizer.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the Markdown file' },
      maxDepth: { type: 'integer', default: 6, minimum: 1, maximum: 6, description: 'Deepest heading level to list (deeper sections still count in their parents)' },
      limit: { type: 'integer', default: 200, minimum: 1, maximum: 2000, description: 'Max sections returned' },
    },
    required: ['input'],
  },
  examples: ['text.outline input=book.md maxDepth=2'],
  async run({ input, maxDepth, limit }) {
    const t = await T(); const text = readText(input); const o = t.outline(text);
    const shown = o.nodes.filter((n) => n.level <= maxDepth);
    const sections = shown.slice(0, limit).map((n) => ({ index: n.index, level: n.level, title: n.title.length > 160 ? n.title.slice(0, 160) + '\u2026' : n.title, line: n.line, tokens: n.tokens, ownTokens: n.ownTokens, byteStart: n.byteStart, byteEnd: n.byteEnd }));
    const res = { headings: o.nodes.length, totalEstimatedTokens: t.estimateTokens(text), bytes: t.utf8Length(text), preamble: o.preamble, sections };
    if (shown.length > limit) res.truncated = true;
    if (!o.nodes.length) res.hint = 'no Markdown headings found \u2014 use text.chunk to split by size, or text.grep to locate passages';
    return res;
  },
});

const KINDS = ['emails', 'urls', 'dates', 'numbers', 'hashes', 'ips', 'uuids', 'phones'];
register({
  name: 'text.extract',
  description: 'Find entities in a text file by pattern: emails, urls (http/https/ftp), dates (ISO 8601, 31/12/2024-style, English month names), numbers (with thousands separators, decimals, exponents, %), hashes (hex strings of MD5/SHA-1/SHA-256/SHA-512 length), ips (IPv4 and IPv6, validated), uuids, phones (7\u201315 digits with common separators). Returns, per kind, the total and unique counts and the values with their frequencies, most frequent first, capped at limit. Pattern-based: expect some false positives (e.g. version numbers among numbers, order numbers among phones) and no understanding of context.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the text file' },
      kinds: { type: 'array', items: { type: 'string', enum: KINDS }, default: ['emails', 'urls', 'dates', 'hashes', 'ips'], description: 'Which entity kinds to look for' },
      limit: { type: 'integer', default: 100, minimum: 1, maximum: 1000, description: 'Max distinct values returned per kind' },
      output: { type: 'string', description: 'Optional VFS path for the full uncapped result as JSON' },
    },
    required: ['input'],
  },
  examples: ['text.extract input=mail.txt kinds=emails,urls'],
  async run({ input, kinds, limit, output }) {
    const t = await T(); const text = readText(input); const res = { found: {} }; const full = {};
    const hashName = { 32: 'md5-length', 40: 'sha1-length', 64: 'sha256-length', 128: 'sha512-length' };
    for (const k of kinds) {
      const hits = t.findAll(text, k); const freq = new Map();
      for (const h of hits) { const v = k === 'emails' || k === 'hashes' || k === 'uuids' ? h.value.toLowerCase() : h.value; freq.set(v, (freq.get(v) || 0) + 1); }
      const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => (k === 'hashes' ? { value, count, kind: hashName[value.length] } : { value, count }));
      full[k] = ranked;
      res.found[k] = { total: hits.length, unique: ranked.length, values: ranked.slice(0, limit) }; if (ranked.length > limit) res.found[k].truncated = true;
    }
    res.note = 'pattern-based extraction; verify before relying on it';
    if (output) res.output = await vfs.write(output, JSON.stringify(full, null, 1), { mime: 'application/json' });
    return res;
  },
});

register({
  name: 'text.redact',
  description: 'Mask personal-looking data in a text file and write the redacted copy: email addresses, phone numbers, credit-card-like numbers (13\u201319 digits passing the Luhn check), IPv4/IPv6 addresses. Returns a count per kind. This is PATTERN-BASED redaction: it does not find names, postal addresses, IDs, or anything phrased unusually, and it can mask look-alikes (order numbers, version strings). Treat the output as reduced-risk, not anonymised; review before sharing.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the text file' },
      output: { type: 'string', description: 'VFS path to write (default: <input stem>.redacted.<ext>)' },
      kinds: { type: 'array', items: { type: 'string', enum: ['emails', 'phones', 'cards', 'ips'] }, default: ['emails', 'phones', 'cards', 'ips'], description: 'What to mask' },
      mask: { type: 'string', enum: ['label', 'stars', 'numbered'], default: 'label', description: 'label = [EMAIL] / [PHONE] / [CARD] / [IP]; stars = same-length ****; numbered = [EMAIL_1], [EMAIL_2]\u2026 with the same value always getting the same number (keeps who-is-who readable)' },
    },
    required: ['input'],
  },
  examples: ['text.redact input=ticket.txt', 'text.redact input=chat.txt kinds=emails,phones mask=numbered'],
  async run({ input, output, kinds, mask }) {
    const t = await T(); const text = readText(input); const LABEL = { emails: 'EMAIL', cards: 'CARD', ips: 'IP', phones: 'PHONE' };
    const spans = [];
    for (const k of ['emails', 'cards', 'ips', 'phones']) { if (!kinds.includes(k)) continue; for (const h of t.findAll(text, k)) spans.push({ s: h.index, e: h.index + h.value.length, k, v: h.value }); }
    const order = { emails: 0, cards: 1, ips: 2, phones: 3 };
    spans.sort((a, b) => a.s - b.s || order[a.k] - order[b.k]);
    const kept = []; let end = -1; for (const sp of spans.slice().sort((a, b) => order[a.k] - order[b.k] || a.s - b.s)) { if (!kept.some((q) => sp.s < q.e && q.s < sp.e)) kept.push(sp); }
    kept.sort((a, b) => a.s - b.s);
    const counts = {}; const ids = {}; let out = ''; let pos = 0;
    for (const sp of kept) {
      if (sp.s < end) continue; counts[sp.k] = (counts[sp.k] || 0) + 1;
      let rep = `[${LABEL[sp.k]}]`;
      if (mask === 'stars') rep = sp.v.replace(/[^\s]/g, '*'); else if (mask === 'numbered') { const m = (ids[sp.k] ||= new Map()); const key = sp.v.toLowerCase(); if (!m.has(key)) m.set(key, m.size + 1); rep = `[${LABEL[sp.k]}_${m.get(key)}]`; }
      out += text.slice(pos, sp.s) + rep; pos = sp.e; end = sp.e;
    }
    out += text.slice(pos);
    const st = await vfs.write(vfs.out(output, input, 'redacted', textExt(input)), out, { mime: vfs.stat(input).mime });
    const res = { output: st, redactions: kept.length, counts, method: 'regular-expression patterns only (cards additionally Luhn-checked); names, addresses and free-form identifiers are NOT detected' };
    if (mask === 'numbered') res.distinct = Object.fromEntries(Object.entries(ids).map(([k, m]) => [k, m.size]));
    return res;
  },
});
