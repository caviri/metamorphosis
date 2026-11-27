// claude.* — make any file ready for a Claude model: what it accepts natively, what must be converted, and the
// conversion itself. Limits are from platform.claude.com/docs (vision, pdf-support), checked 2026-11.
import { M, vfs, register } from '../js/core.js';
import { decode, canvasOf, canvasBytes, toCanvas } from '../js/img.js';

const MB = 1024 * 1024;
export const LIMITS = {
  checked: '2026-11',
  sources: ['https://platform.claude.com/docs/en/build-with-claude/vision', 'https://platform.claude.com/docs/en/build-with-claude/pdf-support'],
  image: {
    formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    animation: 'unsupported — only the first frame of a GIF/WebP is seen',
    maxDimension: 8000,
    manyImagesMaxDimension: 3000, // applies to every image once a request holds more than 20
    maxBase64Bytes: { api: 10 * MB, bedrock: 5 * MB, 'claude.ai': 10 * MB },
    perRequest: { api: 600, api200k: 100, 'claude.ai': 20 },
    patch: 28, // visual tokens = ceil(w/28) * ceil(h/28)
    tiers: {
      high: { models: 'Claude 4.7 and later', maxLongEdge: 2576, maxTokens: 4784 },
      standard: { models: 'all earlier models', maxLongEdge: 1568, maxTokens: 1568 },
    },
    note: 'larger images are downscaled server-side (wasted upload, no extra detail); images under ~200 px are read poorly; metadata is never seen',
  },
  pdf: { maxRequestBytes: 128 * MB, maxPages: 600, maxPagesUnder1MContext: 100, encrypted: 'not accepted', perPage: 'each page = extracted text (≈1,500–3,000 tokens) + a page image (≤1,568 visual tokens)' },
  text: { native: ['txt', 'md', 'csv', 'json', 'xml', 'html', 'yaml', 'source code'], note: 'plain text goes in directly (or as a text/plain document block); cost is its token count' },
  notNative: { 'xlsx/docx/pptx/odt/epub': 'convert to text/markdown or PDF', 'audio (wav/mp3/…)': 'not an input type — send a spectrogram + waveform image and measured stats, or a transcript', 'video (mp4/webm/…)': 'not an input type — send a contact sheet / key frames (+ the audio track as above)', 'geo (geojson/kml/gpx/shp)': 'text formats are readable as text but large; send a rendered map + a summary + simplified GeoJSON', 'svg/bmp/tiff/avif/heic': 'rasterise or re-encode to png/jpeg/webp' },
};

const visualTokens = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);
/** largest size ≤ (w,h) with the same aspect ratio that the tier will not downscale */
function fit(w, h, tier, maxLongEdge) {
  const t = LIMITS.image.tiers[tier];
  const edge = Math.min(t.maxLongEdge, maxLongEdge || Infinity);
  let k = Math.min(1, edge / Math.max(w, h));
  let W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  while (visualTokens(W, H) > t.maxTokens) { k *= 0.99; W = Math.max(1, Math.round(w * k)); H = Math.max(1, Math.round(h * k)); }
  return { width: W, height: H, scale: W / w };
}
/** rough text token estimate: ~4 chars/token for Latin prose, denser for CJK and code-like punctuation. ±20%. */
function textTokens(s) {
  let cjk = 0, other = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c >= 0x2e80) cjk++; else other++; }
  return Math.ceil(other / 3.7 + cjk * 1.1);
}
const b64len = (n) => Math.ceil(n / 3) * 4;

function kindOf(stat) {
  const m = stat.mime, e = vfs.extOf(stat.path);
  if (m === 'application/pdf') return 'pdf';
  if (/geo\+json|kml|gpx/.test(m) || ['geojson', 'topojson', 'kml', 'kmz', 'gpx', 'shp', 'wkt'].includes(e)) return 'geo';
  if (/^image\//.test(m)) return 'image';
  if (/^video\//.test(m)) return 'video';
  if (/^audio\//.test(m)) return 'audio';
  if (['xlsx', 'xls', 'ods'].includes(e)) return 'sheet';
  if (['csv', 'tsv', 'jsonl', 'ndjson'].includes(e)) return 'table';
  if (['docx', 'pptx', 'odt', 'odp', 'epub', 'rtf', 'ipynb', 'eml', 'mbox', 'html', 'htm'].includes(e)) return 'doc';
  if (['zip', 'tar', 'gz', 'tgz'].includes(e)) return 'archive';
  if (vfs.isTextMime(m)) return 'text';
  return 'binary';
}
const TIER = { type: 'string', enum: ['high', 'standard'], default: 'high', description: 'high = Claude 4.7 and later (2576 px long edge, 4784 visual tokens); standard = earlier models (1568 px, 1568 tokens)' };
const PLATFORM = { type: 'string', enum: ['api', 'bedrock', 'claude.ai'], default: 'api', description: 'Where the file will be sent; sets the per-image byte limit (api/claude.ai 10 MB, bedrock 5 MB, both base64-encoded)' };

register({
  name: 'claude.limits', readOnly: true,
  description: 'The input limits of Claude models that the other claude.* tools enforce: image formats, bytes, dimensions, resolution tiers and visual-token formula; PDF size and page limits; which file types are accepted natively and what to convert the others into.',
  schema: { properties: {} },
  run: () => LIMITS,
});

register({
  name: 'claude.tokens', readOnly: true,
  description: 'Estimate what a file costs in input tokens: exact visual-token formula for images (after the tier\'s downscale), a character-based estimate (±20%, not a tokenizer) for text, pages × per-page range for PDFs.',
  schema: { properties: { input: { type: 'string', description: 'VFS path' }, tier: TIER }, required: ['input'] },
  async run({ input, tier }) {
    const stat = vfs.stat(input); const kind = kindOf(stat);
    if (kind === 'image') {
      const img = await decode(input); const f = fit(img.width, img.height, tier);
      return { kind, width: img.width, height: img.height, seenAs: `${f.width}×${f.height}`, tokens: visualTokens(f.width, f.height), exact: true, formula: '⌈w/28⌉ × ⌈h/28⌉ after downscale' };
    }
    if (kind === 'pdf') {
      const info = await M.run('pdf.info', { input }); const pages = info.pages ?? info.pageCount;
      return { kind, pages, tokens: { low: pages * 1500, high: pages * (3000 + 1568) }, exact: false, note: 'per page: 1,500–3,000 text tokens plus a page image of up to 1,568 visual tokens' };
    }
    if (['text', 'table', 'geo'].includes(kind) || vfs.isTextMime(stat.mime)) { const t = textTokens(vfs.text(input)); return { kind, bytes: stat.bytes, tokens: t, exact: false, note: 'character-based estimate, ±20%' }; }
    return { kind, tokens: null, note: `${kind} is not a native input — run claude.inspect for what to convert it into` };
  },
});

register({
  name: 'claude.inspect', readOnly: true,
  description: 'Verdict on one file: can a Claude model take it as is? Returns its kind, whether it is native, every limit it breaks (bytes, pixels, pages, format, animation), an estimated token cost, and the exact tool call that fixes it. Start here when unsure what to do with a file.',
  schema: { properties: { input: { type: 'string', description: 'VFS path' }, tier: TIER, platform: PLATFORM }, required: ['input'] },
  async run({ input, tier, platform }) {
    const stat = vfs.stat(input); const kind = kindOf(stat); const issues = []; let native = false, tokens = null, fix = null; const facts = { bytes: stat.bytes, mime: stat.mime };
    if (kind === 'image') {
      native = LIMITS.image.formats.includes(stat.mime);
      if (!native) issues.push(`format ${stat.mime} is not accepted (jpeg, png, gif, webp only)`);
      const img = await decode(input).catch(() => null);
      if (!img) issues.push('the browser cannot decode this image'); else {
        Object.assign(facts, { width: img.width, height: img.height });
        const f = fit(img.width, img.height, tier); tokens = visualTokens(f.width, f.height);
        if (Math.max(img.width, img.height) > LIMITS.image.maxDimension) issues.push(`exceeds ${LIMITS.image.maxDimension} px — rejected`);
        if (f.scale < 1) issues.push(`will be downscaled server-side to ${f.width}×${f.height} (${tier} tier) — resize first to save upload and control quality`);
        if (Math.max(img.width, img.height) < 200) issues.push('under 200 px — models read very small images poorly; upscale with nearest-neighbour or provide a larger source');
      }
      const lim = LIMITS.image.maxBase64Bytes[platform];
      if (b64len(stat.bytes) > lim) issues.push(`${M.human(b64len(stat.bytes))} base64 exceeds the ${M.human(lim)} per-image limit on ${platform}`);
      if (stat.mime === 'image/gif') issues.push('if this GIF is animated only its first frame is seen — use claude.video for a contact sheet of the frames');
      if (issues.length) fix = `claude.image input=${input} tier=${tier} platform=${platform}`;
    } else if (kind === 'pdf') {
      native = true;
      try {
        const info = await M.run('pdf.info', { input }); const pages = info.pages ?? info.pageCount; facts.pages = pages; tokens = { low: pages * 1500, high: pages * 4568 };
        if (info.encrypted) { native = false; issues.push('encrypted / password-protected PDFs are not accepted'); }
        if (pages > LIMITS.pdf.maxPages) issues.push(`${pages} pages exceeds the ${LIMITS.pdf.maxPages}-page limit`); else if (pages > LIMITS.pdf.maxPagesUnder1MContext) issues.push(`${pages} pages: fine with a 1M-token context, over the ${LIMITS.pdf.maxPagesUnder1MContext}-page limit otherwise`);
      } catch (e) { issues.push(`could not read the PDF: ${e.message}`); }
      if (b64len(stat.bytes) > LIMITS.pdf.maxRequestBytes * 0.9) issues.push(`${M.human(stat.bytes)} is at the request size limit (${M.human(LIMITS.pdf.maxRequestBytes)} for the whole request, base64 included)`);
      if (issues.length) fix = `claude.pdf input=${input}`;
    } else if (kind === 'text' || kind === 'table') {
      native = true; tokens = textTokens(vfs.text(input));
      if (tokens > 150000) { issues.push(`≈${tokens} tokens — a large share of the context window; chunk it or extract what matters`); fix = kind === 'table' ? `claude.table input=${input}` : `text.chunk input=${input}`; }
    } else {
      fix = { geo: `claude.map input=${input}`, video: `claude.video input=${input}`, audio: `claude.audio input=${input}`, sheet: `claude.table input=${input}`, doc: `claude.doc input=${input}`, archive: `archive.list input=${input}` }[kind] || `file.identify input=${input}`;
      issues.push({ geo: 'map data: readable as text only when small; a rendered map + summary is what a model can actually use', video: 'video is not an input type', audio: 'audio is not an input type', sheet: 'spreadsheets are not accepted in document blocks', doc: 'this document format is not accepted in document blocks', archive: 'archives must be unpacked and their members converted individually', binary: 'unknown binary — identify it first' }[kind]);
    }
    return { input: stat.path, kind, native, ready: native && !issues.length, ...facts, tokens, issues, fix, or: fix ? `claude.pack input=${input}` : undefined };
  },
});

async function scaled(img, w, h) {
  // stepwise halving keeps the browser's bilinear filter from aliasing on big reductions
  let c = toCanvas(img);
  while (c.width / 2 >= w && c.height / 2 >= h) { const n = canvasOf(Math.ceil(c.width / 2), Math.ceil(c.height / 2)); const g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, n.width, n.height); c = n; }
  if (c.width !== w || c.height !== h) { const n = canvasOf(w, h); const g = n.getContext('2d'); g.imageSmoothingEnabled = !(w > c.width); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, w, h); c = n; }
  return c;
}
const hasAlpha = (img) => { const d = img.data; for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true; return false; };

async function fitImage(input, { tier = 'high', platform = 'api', format = 'auto', maxLongEdge, output, tag = 'claude' }) {
  const src = vfs.stat(input); const img = await decode(input);
  const f = fit(img.width, img.height, tier, maxLongEdge);
  const limit = LIMITS.image.maxBase64Bytes[platform]; const alpha = hasAlpha(img);
  let { width: w, height: h } = f; let best = null; const notes = [];
  if (Math.max(img.width, img.height) < 200) notes.push('source is under 200 px; not upscaled — consider image.resize with filter=nearest');
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = await scaled(img, w, h); const cands = [];
    if (format === 'auto' || format === 'png') cands.push({ ...(await canvasBytes(c, 'png')), ext: 'png' });
    if (format === 'jpeg' || (format === 'auto' && !alpha)) for (const q of [0.92, 0.85, 0.75]) cands.push({ ...(await canvasBytes(c, 'jpeg', q)), ext: 'jpg', quality: q });
    if (format === 'webp' || (format === 'auto' && alpha)) for (const q of [0.92, 0.8]) cands.push({ ...(await canvasBytes(c, 'webp', q)), ext: 'webp', quality: q });
    const ok = cands.filter((x) => b64len(x.bytes.length) <= limit);
    if (ok.length) {
      // lossless wins unless a lossy encode is less than 60% of its size (photographs); among lossy, highest quality that fits
      const png = ok.find((x) => x.ext === 'png'); const lossy = ok.find((x) => x.ext !== 'png');
      best = png && (!lossy || lossy.bytes.length > png.bytes.length * 0.6) ? png : lossy || png; break;
    }
    w = Math.max(1, Math.round(w * 0.8)); h = Math.max(1, Math.round(h * 0.8)); notes.push(`over the ${M.human(limit)} byte limit; shrinking to ${w}×${h}`);
  }
  if (!best) throw new Error(`could not fit the image under ${M.human(limit)} (base64) for ${platform}`);
  const unchanged = f.scale === 1 && w === img.width && LIMITS.image.formats.includes(src.mime) && b64len(src.bytes) <= limit && src.mime !== 'image/gif' && format === 'auto';
  if (unchanged) return { output: src, unchanged: true, width: img.width, height: img.height, tokens: visualTokens(w, h), tier, notes: ['already Claude-ready; nothing written'] };
  const out = await vfs.write(vfs.out(output, input, tag, best.ext), best.bytes, { mime: best.mime, meta: { width: w, height: h } });
  return { output: out, from: { width: img.width, height: img.height, bytes: src.bytes, mime: src.mime }, width: w, height: h, scale: +(w / img.width).toFixed(4), quality: best.quality, tokens: visualTokens(w, h), tier, base64Bytes: b64len(best.bytes.length), notes };
}

register({
  name: 'claude.image',
  description: 'Fit an image to what a Claude model actually sees: downscale to the tier\'s limit (2576 px / 4784 visual tokens on Claude 4.7+, 1568 / 1568 before) so nothing is resized server-side, re-encode unsupported formats (svg, bmp, avif, tiff…) to png/jpeg/webp, and keep it under the per-image byte limit. Never upscales. Returns the new file and its exact visual-token cost; reports unchanged=true when the input was already fine.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the image' },
      tier: TIER, platform: PLATFORM,
      format: { type: 'string', enum: ['auto', 'png', 'jpeg', 'webp'], default: 'auto', description: 'auto = lossless PNG unless a JPEG/WebP is much smaller (photographs); alpha is preserved' },
      maxLongEdge: { type: 'integer', minimum: 64, maximum: 8000, description: 'Tighter long-edge cap than the tier (e.g. 1024 to spend fewer tokens)' },
      output: { type: 'string', description: 'VFS path to write (default: <name>.claude.<ext>)' },
    },
    required: ['input'],
  },
  run: (a) => fitImage(a.input, a),
});

async function has(tool) { if (M.tools.has(tool)) return true; const mod = (await import('../js/rooms.js')).DOMAIN_MODULE[tool.split('.')[0]]; if (mod) await M.summon(mod); return M.tools.has(tool); }
const outs = (r) => M.outputsOf(r);

register({
  name: 'claude.pdf',
  description: 'Make a PDF acceptable to a Claude model: checks pages and bytes against the limits (600 pages, 100 without a 1M context; 128 MB request), splits it into parts that fit, and optionally compresses. Scanned PDFs (no text layer) are flagged. Returns the part files, or unchanged=true if the PDF was already fine.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the PDF' },
      maxPages: { type: 'integer', default: 100, minimum: 1, maximum: 600, description: 'Pages per part: 100 is safe for every model; up to 600 with a 1M-token context' },
      maxMB: { type: 'number', default: 24, minimum: 1, maximum: 90, description: 'Target bytes per part (base64 adds 33%; the whole request must stay under 128 MB)' },
      compress: { type: 'boolean', default: false, description: 'Also run pdf.compress on parts that are over maxMB' },
    },
    required: ['input'],
  },
  async run({ input, maxPages, maxMB, compress }, ctx) {
    const stat = vfs.stat(input); const info = await M.run('pdf.info', { input }); const pages = info.pages ?? info.pageCount; const notes = [];
    if (info.encrypted) throw new Error('this PDF is encrypted; Claude does not accept password-protected PDFs — decrypt it first');
    if (info.hasText === false || info.hasTextLayer === false) notes.push('no text layer (a scan): the model will rely on the page images alone — fine for vision; run vision.ocr on pdf.render output if you need the text');
    let parts = [stat];
    if (pages > maxPages) { const r = await M.run('pdf.split', { input, every: maxPages }); parts = outs(r); notes.push(`split ${pages} pages into ${parts.length} parts of ≤ ${maxPages}`); }
    if (compress) {
      for (let i = 0; i < parts.length; i++) if (parts[i].bytes > maxMB * MB) { try { const r = await M.run('pdf.compress', { input: parts[i].path }); const o = outs(r)[0]; if (o && o.bytes < parts[i].bytes) { notes.push(`${parts[i].path}: ${M.human(parts[i].bytes)} → ${M.human(o.bytes)}`); parts[i] = o; } } catch (e) { ctx.warn(`compress failed for ${parts[i].path}: ${e.message}`); } }
    }
    for (const p of parts) if (p.bytes > maxMB * MB) notes.push(`${p.path} is ${M.human(p.bytes)}, over the ${maxMB} MB target — try compress=true, a smaller maxPages, or pdf.render the pages you need`);
    const unchanged = parts.length === 1 && parts[0].path === stat.path;
    return { ...(unchanged ? { output: stat, unchanged: true } : { outputs: parts }), pages, tokens: { low: pages * 1500, high: pages * 4568 }, notes };
  },
});

register({
  name: 'claude.video',
  description: 'Turn a video (or animated GIF) into what a vision model can read: a contact sheet of evenly spaced, timestamped frames fitted to the model\'s resolution tier, optional individual key frames, and — if it has sound — a spectrogram of the audio track. Returns the image files with their token costs and the probe data (duration, resolution, codecs).',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the video' },
      frames: { type: 'integer', default: 16, minimum: 1, maximum: 64, description: 'Frames on the contact sheet' },
      keyframes: { type: 'integer', default: 0, minimum: 0, maximum: 20, description: 'Also write this many evenly spaced frames as separate full-size images' },
      audio: { type: 'boolean', default: true, description: 'Include a spectrogram of the audio track when there is one' },
      tier: TIER,
    },
    required: ['input'],
  },
  async run({ input, frames, keyframes, audio, tier }, ctx) {
    const result = { outputs: [], notes: [] }; const add = async (path, role) => { const r = await fitImage(path, { tier, tag: 'claude' }); result.outputs.push({ ...r.output, role, tokens: r.tokens }); };
    try { result.probe = await M.run('video.probe', { input }); } catch (e) { result.notes.push(`probe failed: ${e.message}`); }
    const sheet = await M.run('video.contactSheet', { input, count: frames }); await add(outs(sheet)[0].path, 'contact-sheet');
    if (keyframes) { const r = await M.run('video.frames', { input, count: keyframes }); for (const o of outs(r)) await add(o.path, 'frame'); }
    if (audio) {
      try { const a = await M.run('video.extractAudio', { input, format: 'wav' }); const s = await M.run('audio.spectrogram', { input: outs(a)[0].path }); await add(outs(s)[0].path, 'audio-spectrogram'); vfs.rm(outs(a)[0].path); } catch (e) { result.notes.push(`no audio spectrogram: ${e.message}`); }
    }
    result.tokens = result.outputs.reduce((n, o) => n + o.tokens, 0);
    return result;
  },
});

register({
  name: 'claude.audio',
  description: 'Turn audio into what a model can read: a labelled spectrogram and a waveform image (fitted to the resolution tier) plus measured numbers — duration, loudness, peaks, dominant frequencies, tempo and pitch where detectable. There is no speech-to-text here: for spoken content supply a transcript. Returns the image files, token costs and the measurements.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of the audio file' }, tier: TIER }, required: ['input'] },
  async run({ input, tier }) {
    const result = { outputs: [], measurements: {}, notes: ['no speech recognition is available in this forge — a spectrogram shows structure, not words'] };
    for (const [tool, role] of [['audio.spectrogram', 'spectrogram'], ['audio.waveform', 'waveform']]) { try { const r = await M.run(tool, { input }); const f = await fitImage(outs(r)[0].path, { tier }); result.outputs.push({ ...f.output, role, tokens: f.tokens }); } catch (e) { result.notes.push(`${tool}: ${e.message}`); } }
    for (const tool of ['audio.info', 'audio.stats', 'audio.spectrum', 'audio.tempo']) { try { const r = await M.run(tool, { input }); delete r.output; delete r.outputs; result.measurements[tool.split('.')[1]] = r; } catch (e) { result.notes.push(`${tool}: ${e.message}`); } }
    result.tokens = result.outputs.reduce((n, o) => n + o.tokens, 0);
    return result;
  },
});

register({
  name: 'claude.map',
  description: 'Turn map data (GeoJSON, TopoJSON, KML, GPX, WKT, shapefile…) into what a model can use: a rendered map image fitted to the resolution tier, a compact Markdown summary (what, where, how much, properties), and a simplified GeoJSON small enough to read as text. Returns the three files with token costs.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the geo file' },
      maxTokens: { type: 'integer', default: 20000, minimum: 1000, description: 'Token budget for the simplified GeoJSON; geometry is simplified and coordinates rounded until it fits' },
      tier: TIER,
    },
    required: ['input'],
  },
  async run({ input, maxTokens, tier }) {
    const result = { outputs: [], notes: [] };
    try { const r = await M.run('geo.render', { input }); const f = await fitImage(outs(r)[0].path, { tier }); result.outputs.push({ ...f.output, role: 'map', tokens: f.tokens }); } catch (e) { result.notes.push(`render: ${e.message}`); }
    try { const r = await M.run('geo.summary', { input }); const o = outs(r)[0]; result.outputs.push({ ...o, role: 'summary', tokens: textTokens(vfs.text(o.path)) }); } catch (e) { result.notes.push(`summary: ${e.message}`); }
    try {
      let cur = outs(await M.run('geo.convert', { input, to: 'geojson' }))[0]; let t = textTokens(vfs.text(cur.path));
      for (const ratio of [0.5, 0.2, 0.08, 0.03, 0.01]) { if (t <= maxTokens) break; const r = await M.run('geo.simplify', { input: cur.path, ratio }); const p = await M.run('geo.precision', { input: outs(r)[0].path, decimals: 4 }); cur = outs(p)[0]; t = textTokens(vfs.text(cur.path)); result.notes.push(`simplified to ${Math.round(ratio * 100)}% of vertices → ≈${t} tokens`); }
      if (t > maxTokens) result.notes.push(`simplified GeoJSON is still ≈${t} tokens (budget ${maxTokens}) — rely on the map and summary, or geo.filter to a region`);
      result.outputs.push({ ...cur, role: 'geojson', tokens: t });
    } catch (e) { result.notes.push(`geojson: ${e.message}`); }
    if (!result.outputs.length) throw new Error(`could not process map data: ${result.notes.join('; ')}`);
    result.tokens = result.outputs.reduce((n, o) => n + o.tokens, 0);
    return result;
  },
});

register({
  name: 'claude.table',
  description: 'Turn tabular data (xlsx, csv, tsv, json, jsonl…) into text a model reads well: a profile of every column, and the rows as CSV (compact — best for many rows) or a Markdown table (best for small tables). Tables over the token budget are cut to the first rows and the result says how many were dropped. Returns the text file(s) and token estimates.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the table file' },
      sheet: { type: 'string', description: 'Sheet name or index for xlsx (default: first)' },
      format: { type: 'string', enum: ['auto', 'csv', 'markdown'], default: 'auto', description: 'auto = markdown up to ~200 rows, csv beyond' },
      maxTokens: { type: 'integer', default: 50000, minimum: 500, description: 'Token budget for the rows' },
    },
    required: ['input'],
  },
  async run({ input, sheet, format, maxTokens }) {
    const result = { outputs: [], notes: [] }; const extra = sheet !== undefined ? { sheet } : {};
    let info = null; try { info = await M.run('data.info', { input, ...extra }); delete info.output; result.profile = info; } catch (e) { result.notes.push(`profile: ${e.message}`); }
    const rows = info?.rows ?? info?.rowCount;
    const fmt = format === 'auto' ? (rows !== undefined && rows <= 200 ? 'markdown' : 'csv') : format;
    let out = outs(await M.run('data.convert', { input, to: fmt, ...extra }))[0]; let text = vfs.text(out.path); let t = textTokens(text);
    if (t > maxTokens) {
      const lines = text.split('\n'); const keep = Math.max(2, Math.floor(lines.length * (maxTokens / t) * 0.97)); const head = fmt === 'markdown' ? 2 : 1;
      text = lines.slice(0, keep).join('\n') + `\n`; result.notes.push(`over budget: kept the first ${keep - head} of ${lines.length - head} rows (${lines.length - keep} dropped) — use data.query to select what matters`);
      out = await vfs.write(out.path, text); t = textTokens(text); result.truncated = true;
    }
    result.outputs.push({ ...out, role: 'rows', tokens: t }); result.tokens = t;
    return result;
  },
});

register({
  name: 'claude.doc',
  description: 'Turn a document (docx, pptx, odt, epub, html, ipynb, rtf, eml…) into Markdown a model can read, with embedded images extracted and fitted to the resolution tier. Returns the .md file, the image files and token estimates; long documents get a note pointing to text.chunk.',
  schema: { properties: { input: { type: 'string', description: 'VFS path of the document' }, images: { type: 'boolean', default: true, description: 'Extract embedded images and fit them for vision' }, tier: TIER }, required: ['input'] },
  async run({ input, images, tier }) {
    const result = { outputs: [], notes: [] };
    const r = await M.run('doc.toMarkdown', { input }); const all = outs(r); const md = all.find((o) => /\.md$/.test(o.path)) || all[0];
    const t = textTokens(vfs.text(md.path)); result.outputs.push({ ...md, role: 'markdown', tokens: t });
    if (images) for (const o of all.filter((x) => x !== md && /^image\//.test(x.mime)).slice(0, 40)) { try { const f = await fitImage(o.path, { tier }); result.outputs.push({ ...f.output, role: 'image', tokens: f.tokens }); } catch (e) { result.notes.push(`${o.path}: ${e.message}`); } }
    if (t > 150000) result.notes.push(`≈${t} tokens of text — consider text.outline then text.chunk`);
    result.tokens = result.outputs.reduce((n, o) => n + o.tokens, 0);
    return result;
  },
});

register({
  name: 'claude.pack',
  description: 'One call for any file: detect what it is and produce the model-ready version — images fitted, PDFs split, video → contact sheet, audio → spectrogram + measurements, maps → picture + summary + simplified GeoJSON, spreadsheets → CSV/Markdown, documents → Markdown, archives → each member packed. Writes a manifest (<name>.claude.md) listing every part, its role and token cost, in the order to hand them to the model.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of any file' },
      tier: TIER, platform: PLATFORM,
      maxMembers: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: 'For archives: how many members to pack' },
    },
    required: ['input'],
  },
  async run({ input, tier, platform, maxMembers }, ctx) {
    const packOne = async (path) => {
      const stat = vfs.stat(path); const kind = kindOf(stat);
      switch (kind) {
        case 'image': { const r = await fitImage(path, { tier, platform }); return { kind, parts: [{ ...r.output, role: 'image', tokens: r.tokens }], notes: r.notes }; }
        case 'pdf': { const r = await M.run('claude.pdf', { input: path }); return { kind, parts: outs(r).map((o) => ({ ...o, role: 'pdf' })), tokens: r.tokens.high, notes: r.notes }; }
        case 'video': case 'audio': case 'geo': case 'doc': { const r = await M.run({ video: 'claude.video', audio: 'claude.audio', geo: 'claude.map', doc: 'claude.doc' }[kind], { input: path, tier }); return { kind, parts: r.outputs, notes: r.notes, measurements: r.measurements || r.probe }; }
        case 'sheet': case 'table': { const r = await M.run('claude.table', { input: path }); return { kind, parts: r.outputs, notes: r.notes }; }
        case 'text': return { kind, parts: [{ ...stat, role: 'text', tokens: textTokens(vfs.text(path)) }], notes: [] };
        default: throw new Error(`${kind} file: nothing a model can read directly — try file.identify / file.strings / file.hexdump`);
      }
    };
    const stat = vfs.stat(input); const items = [];
    if (kindOf(stat) === 'archive') {
      const prefix = `${vfs.stemOf(input)}/`; const r = await M.run('archive.extract', { input, prefix }); const members = outs(r).slice(0, maxMembers);
      for (const m of members) { try { items.push({ source: m.path, ...(await packOne(m.path)) }); } catch (e) { items.push({ source: m.path, kind: 'skipped', parts: [], notes: [e.message] }); } }
      if (outs(r).length > members.length) ctx.warn(`archive has ${outs(r).length} members; packed the first ${members.length}`);
    } else items.push({ source: stat.path, ...(await packOne(input)) });
    const parts = items.flatMap((i) => i.parts); const tokens = parts.reduce((n, p) => n + (p.tokens || 0), 0) + items.reduce((n, i) => n + (i.tokens || 0), 0);
    const md = [`# ${stat.path} → model-ready`, '', `tier: ${tier} · platform: ${platform} · ≈${tokens} input tokens`, ''];
    for (const it of items) {
      md.push(`## ${it.source} (${it.kind})`, '', '| part | role | type | size | tokens |', '|---|---|---|---|---|');
      for (const p of it.parts) md.push(`| ${p.path} | ${p.role || ''} | ${p.mime} | ${p.width ? `${p.width}×${p.height}, ` : ''}${M.human(p.bytes)} | ${p.tokens ?? (it.tokens ? `≤${it.tokens}` : '')} |`);
      if (it.notes?.length) md.push('', ...it.notes.map((n) => `- ${n}`));
      if (it.measurements) md.push('', '```json', JSON.stringify(it.measurements, null, 1).slice(0, 6000), '```');
      md.push('');
    }
    const manifest = await vfs.write(vfs.out(null, input, 'claude', 'md'), md.join('\n'));
    return { outputs: [...parts.map(({ role, tokens: _t, ...s }) => s), manifest], manifest: manifest.path, kinds: items.map((i) => i.kind), tokens, notes: items.flatMap((i) => i.notes || []).slice(0, 20) };
  },
});
