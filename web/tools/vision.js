// vision.* — machine perception that needs a vendored engine or model:
//   OCR (Tesseract, WASM) · barcodes read/write (ZXing-C++, WASM) · ImageNet classification (ONNX Runtime Web, WebGPU or WASM).
// Every engine is self-hosted under web/vendor/, loaded lazily on first use and cached in a module-level promise.
import { M, vfs, register } from '../js/core.js';
import { decode, canvasOf, canvasBytes, saveCanvas } from '../js/img.js';

const V = (p) => new URL(`../vendor/${p}`, import.meta.url).href;
const now = () => performance.now();
const ms = (t0) => Math.round(performance.now() - t0);
const round = (x, d = 2) => { const k = 10 ** d; return Math.round(x * k) / k; };

// ─────────────────────────────────────────────────────────── shared ──

/** [x, y, width, height] → clamped integer rect inside the image, or the full image when absent. */
function rectOf(region, img) {
  if (!region || !region.length) return { x: 0, y: 0, width: img.width, height: img.height, full: true };
  if (region.length !== 4 || region.some((n) => typeof n !== 'number' || Number.isNaN(n))) throw new Error('region must be four numbers: x,y,width,height (pixels of the input image)');
  // intersect with the image; a rectangle that misses it entirely is an error, not a silent 1-px crop
  const x = Math.max(0, Math.round(region[0])), y = Math.max(0, Math.round(region[1]));
  const width = Math.min(img.width, Math.round(region[0] + region[2])) - x; const height = Math.min(img.height, Math.round(region[1] + region[3])) - y;
  if (width < 1 || height < 1) throw new Error(`region ${region.join(',')} lies outside the ${img.width}×${img.height} image or is empty`);
  return { x, y, width, height, full: false };
}

/** Source bitmap for canvas drawing (keeps the decoded pixels exactly; alpha is flattened by the caller). */
function sourceCanvas(img) {
  const c = canvasOf(img.width, img.height);
  c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  return c;
}

/** Crop + scale onto an opaque white canvas. */
function renderRegion(img, r, scale = 1, smooth = true) {
  const w = Math.max(1, Math.round(r.width * scale)), h = Math.max(1, Math.round(r.height * scale));
  const c = canvasOf(w, h); const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.imageSmoothingEnabled = smooth; g.imageSmoothingQuality = 'high';
  g.drawImage(sourceCanvas(img), r.x, r.y, r.width, r.height, 0, 0, w, h);
  return c;
}

const REGION_SCHEMA = { type: 'array', items: { type: 'number' }, description: 'Only look inside this rectangle: x,y,width,height in input-image pixels (default: whole image). Returned coordinates are still in whole-image pixels.' };

// ────────────────────────────────────────────────────────────── OCR ──
const OCR_LANGS = { eng: 'English', deu: 'German', fra: 'French', spa: 'Spanish' };
const PSM = { auto: 3, column: 4, block: 6, line: 7, word: 8, char: 10, sparse: 11, raw_line: 13 };
const OCR_MAX_PIXELS = 40e6;

const wasmSimd = () => { try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; } };

let tessLib;                      // promise → tesseract.js module
const tessWorkers = new Map();    // 'eng+deu' → promise → {worker, core, loadMs}
let tessProgress = null;          // progress sink of the job currently running
let tessQueue = Promise.resolve(); // one job at a time: parameters are per-worker state

function tessWorker(langs) {
  const key = langs.join('+');
  if (!tessWorkers.has(key)) {
    const p = (async () => {
      const t0 = now();
      tessLib ||= import(V('tesseract/tesseract.esm.min.js')).then((m) => m.default || m);
      const T = await tessLib;
      const core = wasmSimd() ? 'tesseract-core-simd-lstm' : 'tesseract-core-lstm';
      // workerBlobURL:false → the worker is a real same-origin script, so the core's .wasm resolves next to it.
      const worker = await T.createWorker(key, 1, {
        workerPath: V('tesseract/worker.min.js'), corePath: V(`tesseract/${core}.js`), langPath: V('tesseract/lang'),
        workerBlobURL: false, gzip: true, cacheMethod: 'none',
        logger: (m) => { if (tessProgress && m.status === 'recognizing text') tessProgress(m.progress); },
        errorHandler: (e) => console.warn('[vision.ocr] tesseract worker:', e),
      });
      return { worker, core, loadMs: ms(t0), fresh: true };
    })();
    p.catch(() => tessWorkers.delete(key));
    tessWorkers.set(key, p);
  }
  return tessWorkers.get(key);
}

function ocrLangs(language) {
  const langs = [...new Set(language?.length ? language : ['eng'])];
  for (const l of langs) if (!OCR_LANGS[l]) throw new Error(`OCR language "${l}" is not bundled — available: ${Object.entries(OCR_LANGS).map(([k, v]) => `${k} (${v})`).join(', ')}`);
  return langs;
}

/**
 * Run Tesseract on (a region of) an image. Returns text, confidence and — when `structure` — words and lines with
 * boxes mapped back to input-image pixels.
 */
async function ocrRun(args, ctx, { structure = false, hocr = false, tsv = false } = {}) {
  const langs = ocrLangs(args.language);
  const img = await decode(args.input);
  const r = rectOf(args.region, img);
  let scale = args.scale || 1;
  if (r.width * r.height * scale * scale > OCR_MAX_PIXELS) {
    const s = Math.sqrt(OCR_MAX_PIXELS / (r.width * r.height));
    ctx.warn(`image too large at scale ${scale}; using scale ${round(s, 3)}`); scale = s;
  }
  const canvas = renderRegion(img, r, scale, true);
  const { bytes } = await canvasBytes(canvas, 'png');

  const job = tessQueue.then(async () => {
    const t0 = now();
    const w = await tessWorker(langs);
    const loadMs = w.fresh ? w.loadMs : 0; const waited = ms(t0); w.fresh = false;
    tessProgress = (p) => ctx.progress(p, 'recognising');
    try {
      const t1 = now();
      await w.worker.setParameters({
        tessedit_pageseg_mode: String(PSM[args.psm] ?? 3),
        tessedit_char_whitelist: args.whitelist || '',
        preserve_interword_spaces: args.preserveSpaces ? '1' : '0',
        user_defined_dpi: args.dpi ? String(args.dpi) : '0',
        debug_file: '/dev/null',   // keep Tesseract's stderr chatter ("Estimating resolution as …") out of the console
      });
      const { data } = await w.worker.recognize(new Blob([bytes], { type: 'image/png' }), {}, { text: true, blocks: structure, hocr, tsv });
      return { data, core: w.core, loadMs, runMs: ms(t1), waited };
    } finally { tessProgress = null; }
  });
  tessQueue = job.catch(() => {});
  const { data, core, loadMs, runMs } = await job;

  const mapBox = (b) => ({ x: round(r.x + b.x0 / scale, 1), y: round(r.y + b.y0 / scale, 1), width: round((b.x1 - b.x0) / scale, 1), height: round((b.y1 - b.y0) / scale, 1) });
  const words = [], lines = [];
  if (structure) {
    for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
      const lw = (line.words || []).filter((x) => x.text && x.text.trim());
      if (!lw.length) continue;
      lines.push({ text: line.text.replace(/\s+$/, ''), confidence: round(line.confidence, 1), box: mapBox(line.bbox), words: lw.length });
      for (const x of lw) words.push({ text: x.text, confidence: round(x.confidence, 1), box: mapBox(x.bbox), line: lines.length - 1 });
    }
  }
  return {
    img, region: r, scale, langs, core, loadMs, runMs,
    text: (data.text || '').replace(/\s+$/, ''), confidence: round(data.confidence ?? 0, 1),
    words, lines, hocr: data.hocr, tsv: data.tsv, processed: { width: canvas.width, height: canvas.height },
  };
}

const OCR_PROPS = {
  input: { type: 'string', description: 'VFS path of the image (png, jpeg, webp, gif, bmp, avif, svg). For a PDF page, render it to an image first.' },
  language: { type: 'array', items: { type: 'string', enum: Object.keys(OCR_LANGS) }, default: ['eng'], description: `Language model(s) to use; several may be combined (e.g. eng,deu). Bundled: ${Object.entries(OCR_LANGS).map(([k, v]) => `${k}=${v}`).join(', ')}. Other languages are not available.` },
  psm: { type: 'string', enum: Object.keys(PSM), default: 'auto', description: 'Page segmentation mode: auto = full page layout analysis; column = one column of text; block = one uniform block; line = a single text line; word = a single word; char = a single character; sparse = scattered text in no particular order (labels, UI screenshots, diagrams); raw_line = one line, no layout heuristics.' },
  region: REGION_SCHEMA,
  scale: { type: 'number', default: 1, minimum: 0.25, maximum: 6, description: 'Resample the image (or region) by this factor before recognition. Tesseract works best when capital letters are 20–40 px tall: use 2–3 for small screen text, below 1 for very large scans.' },
  whitelist: { type: 'string', description: 'Restrict recognition to these characters, e.g. "0123456789.-" for numbers (default: no restriction). Other characters are dropped, not substituted, and the reported confidence is not meaningful (often 0) when a whitelist is set.' },
  preserveSpaces: { type: 'boolean', default: false, description: 'Keep runs of spaces between words (useful for column-aligned tables)' },
  dpi: { type: 'integer', minimum: 70, maximum: 2400, description: 'Tell Tesseract the resolution of the image (default: let it estimate)' },
};

register({
  name: 'vision.ocr',
  description: 'Optical character recognition: read printed text out of an image with Tesseract 5 (LSTM engine, WebAssembly, CPU only). Use it for scans, screenshots, photos of documents, labels and rendered PDF pages; it is weak on handwriting and on text over busy backgrounds. Returns the recognised text (capped by maxChars, with a `truncated` flag — the complete text is always written to a .txt file in the VFS) and the mean confidence 0–100; optionally word or line boxes (inline, capped at 50, full list in a .json file) and hOCR / TSV files. Tune with psm (layout), region (crop) and scale (upsample small text). First use downloads about 5 MB (worker + 2.9 MB WASM core + 2.0 MB English model; deu 0.9 MB, fra 0.6 MB, spa 1.1 MB when requested); loadMs reports that one-time cost separately from runMs.',
  schema: {
    properties: {
      ...OCR_PROPS,
      boxes: { type: 'string', enum: ['none', 'lines', 'words'], default: 'none', description: 'Also return bounding boxes {x,y,width,height} in input-image pixels with per-item confidence: per text line or per word. Writes the full list to <name>.ocr.json.' },
      formats: { type: 'array', items: { type: 'string', enum: ['hocr', 'tsv'] }, default: [], description: 'Extra output files: hocr (HTML with layout and boxes) and/or tsv (Tesseract table: level, box, confidence, text). Coordinates in these two files are in pixels of the processed image (after region crop and scale), not of the input.' },
      maxChars: { type: 'integer', default: 4000, minimum: 0, maximum: 100000, description: 'Cap on the text returned inline; the .txt file is never capped' },
      output: { type: 'string', description: 'VFS path for the text file (default: <input name>.ocr.txt)' },
    },
    required: ['input'],
  },
  examples: ['vision.ocr input=scan.png', 'vision.ocr input=shot.png psm=sparse scale=2 boxes=words', 'vision.ocr input=meter.jpg region=120,40,300,80 psm=line whitelist=0123456789.'],
  async run(args, ctx) {
    const want = new Set(args.formats);
    const r = await ocrRun(args, ctx, { structure: args.boxes !== 'none', hocr: want.has('hocr'), tsv: want.has('tsv') });
    const txtPath = vfs.out(args.output, args.input, 'ocr', 'txt');
    const base = txtPath.replace(/\.txt$/i, '');
    const outputs = [await vfs.write(txtPath, r.text + (r.text ? '\n' : ''), { mime: 'text/plain' })];
    const res = {
      text: r.text.slice(0, args.maxChars), chars: r.text.length, truncated: r.text.length > args.maxChars,
      confidence: r.confidence, language: r.langs.join('+'), psm: args.psm,
      image: { width: r.img.width, height: r.img.height }, region: r.region.full ? null : { x: r.region.x, y: r.region.y, width: r.region.width, height: r.region.height },
      scale: r.scale, processed: r.processed,
    };
    if (!r.text) res.note = 'no text recognised — try psm=sparse or psm=line, a larger scale for small text, or a tighter region';
    if (args.boxes !== 'none') {
      const list = args.boxes === 'words' ? r.words : r.lines;
      res[args.boxes] = list.slice(0, 50); res.boxCount = list.length; res.boxesTruncated = list.length > 50;
      res.wordCount = r.words.length; res.lineCount = r.lines.length;
      outputs.push(await vfs.write(vfs.out(args.output && `${base}.json`, args.input, 'ocr', 'json'), JSON.stringify({
        source: args.input, width: r.img.width, height: r.img.height, language: res.language, confidence: r.confidence, coordinates: 'input-image pixels', lines: r.lines, words: r.words,
      }), { mime: 'application/json' }));
    }
    if (want.has('hocr')) outputs.push(await vfs.write(vfs.out(args.output && `${base}.hocr.html`, args.input, 'ocr.hocr', 'html'), r.hocr || '', { mime: 'text/html' }));
    if (want.has('tsv')) outputs.push(await vfs.write(vfs.out(args.output && `${base}.tsv`, args.input, 'ocr', 'tsv'), r.tsv || '', { mime: 'text/tab-separated-values' }));
    return { ...res, outputs, backend: 'wasm', engine: `tesseract.js 7 / ${r.core}`, loadMs: r.loadMs, runMs: r.runMs };
  },
});

const confColour = (c) => (c >= 85 ? '#00a651' : c >= 60 ? '#f39200' : '#e2001a');

register({
  name: 'vision.ocrOverlay',
  description: 'Run OCR (same engine and options as vision.ocr) and draw what was found onto a copy of the image: one rectangle per word (or line), coloured by confidence (green ≥ 85, orange 60–84, red < 60), with the recognised text printed above each box. Use it to check visually what the OCR read and where, or to debug a bad result before changing psm/scale/region. Returns the annotated PNG in the VFS plus text, mean confidence and counts. When scale > 1 the picture is enlarged by the same factor (overlayScale) so labels stay legible; on tightly spaced lines the labels cover part of the line above — pass labels=false for boxes only. Same first-use download as vision.ocr (about 5 MB).',
  schema: {
    properties: {
      ...OCR_PROPS,
      level: { type: 'string', enum: ['words', 'lines'], default: 'words', description: 'Draw one box per word or per text line' },
      labels: { type: 'boolean', default: true, description: 'Print the recognised text above each box' },
      minConfidence: { type: 'number', default: 0, minimum: 0, maximum: 100, description: 'Do not draw items below this confidence' },
      maxChars: { type: 'integer', default: 2000, minimum: 0, maximum: 100000, description: 'Cap on the text returned inline' },
      output: { type: 'string', description: 'VFS path for the annotated image (default: <input name>.ocr.png)' },
    },
    required: ['input'],
  },
  examples: ['vision.ocrOverlay input=scan.png', 'vision.ocrOverlay input=shot.png psm=sparse scale=2 level=lines'],
  async run(args, ctx) {
    const r = await ocrRun(args, ctx, { structure: true });
    const items = (args.level === 'lines' ? r.lines : r.words).filter((x) => x.confidence >= args.minConfidence);
    const { img } = r;
    // Small text that needed upscaling to be read also needs it to be inspected: draw at the OCR scale when it is > 1.
    const k = Math.min(Math.max(1, r.scale), Math.sqrt(64e6 / (img.width * img.height)));
    const W = Math.round(img.width * k), H = Math.round(img.height * k);
    const c = canvasOf(W, H); const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.imageSmoothingQuality = 'high'; g.drawImage(sourceCanvas(img), 0, 0, W, H);
    const lw = Math.max(1, Math.round(Math.max(W, H) / 900));
    const R = r.region;
    if (!R.full) { g.setLineDash([6 * lw, 4 * lw]); g.strokeStyle = '#0a6cff'; g.lineWidth = lw; g.strokeRect(R.x * k + 0.5, R.y * k + 0.5, R.width * k - 1, R.height * k - 1); g.setLineDash([]); }
    g.textBaseline = 'bottom';
    for (const it of items) {
      const b = { x: it.box.x * k, y: it.box.y * k, width: it.box.width * k, height: it.box.height * k }; const col = confColour(it.confidence);
      g.globalAlpha = 0.12; g.fillStyle = col; g.fillRect(b.x, b.y, b.width, b.height);
      g.globalAlpha = 1; g.strokeStyle = col; g.lineWidth = lw; g.strokeRect(b.x, b.y, b.width, b.height);
      if (args.labels) {
        const fs = Math.max(9, Math.min(16, Math.round(b.height * 0.45)));
        g.font = `${fs}px ui-monospace, Consolas, monospace`;
        const cap = args.level === 'lines' ? 160 : 40; const label = it.text.length > cap ? it.text.slice(0, cap - 1) + '…' : it.text;
        const tw = g.measureText(label).width + 4; const ty = b.y >= fs + 2 ? b.y : b.y + b.height + fs + 2;
        g.fillStyle = col; g.fillRect(b.x - lw / 2, ty - fs - 2, tw, fs + 2);
        g.fillStyle = '#fff'; g.fillText(label, b.x + 2 - lw / 2, ty);
      }
    }
    const output = await saveCanvas(c, vfs.out(args.output, args.input, 'ocr', 'png'));
    const conf = items.map((x) => x.confidence);
    return {
      output, level: args.level, drawn: items.length, wordCount: r.words.length, lineCount: r.lines.length,
      confidence: r.confidence, lowConfidence: conf.filter((x) => x < 60).length,
      text: r.text.slice(0, args.maxChars), truncated: r.text.length > args.maxChars,
      language: r.langs.join('+'), psm: args.psm, scale: r.scale, overlayScale: round(k, 3), legend: 'green ≥85, orange 60–84, red <60 (confidence)',
      backend: 'wasm', loadMs: r.loadMs, runMs: r.runMs,
    };
  },
});

// ───────────────────────────────────────────────────────── barcodes ──
const BC_READ = ['QRCode', 'MicroQRCode', 'RMQRCode', 'DataMatrix', 'Aztec', 'PDF417', 'MicroPDF417', 'MaxiCode', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'Code128', 'Code39', 'Code93', 'Codabar', 'ITF', 'DataBar', 'DataBarExp', 'DataBarLtd', 'DXFilmEdge'];
const BC_WRITE = ['QRCode', 'DataMatrix', 'AztecCode', 'PDF417', 'Code128', 'Code39', 'Code93', 'Codabar', 'ITF', 'EAN13', 'EAN8', 'UPCA', 'UPCE'];
const BC_2D = new Set(['QRCode', 'DataMatrix', 'AztecCode', 'PDF417']);

let zxLib; let zxFresh = true;
function zxing() {
  zxLib ||= (async () => {
    const t0 = now();
    const zx = await import(V('zxing-wasm/full/index.js'));
    await zx.prepareZXingModule({ overrides: { locateFile: (p) => V(`zxing-wasm/full/${p}`) }, fireImmediately: true });
    return { zx, loadMs: ms(t0) };
  })();
  zxLib.catch(() => { zxLib = null; });
  return zxLib;
}
async function zxingTimed() { const t0 = now(); const z = await zxing(); const loadMs = zxFresh ? Math.max(z.loadMs, ms(t0)) : 0; zxFresh = false; return { zx: z.zx, loadMs }; }

async function barcodeRead(args, ctx, formats) {
  const img = await decode(args.input);
  const r = rectOf(args.region, img);
  const { zx, loadMs } = await zxingTimed();
  const t0 = now();
  let id;
  if (r.full) id = new ImageData(img.data, img.width, img.height);
  else id = renderRegion(img, r, 1, false).getContext('2d').getImageData(0, 0, r.width, r.height);
  const found = await zx.readBarcodes(id, {
    formats: formats || [], tryHarder: args.tryHarder, tryRotate: args.tryHarder, tryInvert: args.tryInvert,
    tryDownscale: args.tryHarder, tryDenoise: !!args.denoise, maxNumberOfSymbols: args.maxCodes, textMode: 'HRI', returnErrors: false,
  });
  const runMs = ms(t0);
  const pt = (p) => [p.x + r.x, p.y + r.y];
  const codes = found.map((c) => {
    const corners = [pt(c.position.topLeft), pt(c.position.topRight), pt(c.position.bottomRight), pt(c.position.bottomLeft)];
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    const text = c.text || ''; const binary = c.contentType === 'Binary' || c.contentType === 'UnknownECI';
    const o = {
      format: c.format, text: text.slice(0, 2000), contentType: c.contentType,
      box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      corners, orientation: c.orientation,
    };
    if (text.length > 2000) { o.textTruncated = true; o.chars = text.length; }
    if (binary || args.bytes) { o.bytes = c.bytes.length; o.base64 = M.b64.enc(c.bytes.subarray(0, 3000)); if (c.bytes.length > 3000) o.base64Truncated = true; }
    if (c.ecLevel) o.ecLevel = c.ecLevel;
    if (c.version) o.version = c.version;
    if (c.symbologyIdentifier) o.symbologyIdentifier = c.symbologyIdentifier;
    if (c.isMirrored) o.mirrored = true;
    if (c.isInverted) o.inverted = true;
    return o;
  });
  const res = { count: codes.length, codes: codes.slice(0, 50), truncated: codes.length > 50, image: { width: img.width, height: img.height }, backend: 'wasm', loadMs, runMs };
  if (!codes.length) res.note = 'no barcode found — check the code is sharp, has a quiet margin and is at least ~2 px per module; try tryInvert=true for light-on-dark codes, denoise=true for noisy photos, or a region around the code';
  if (args.annotate) {
    const c = canvasOf(img.width, img.height); const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, img.width, img.height); g.drawImage(sourceCanvas(img), 0, 0);
    const lw = Math.max(2, Math.round(Math.max(img.width, img.height) / 400)); const fs = Math.max(11, lw * 5);
    g.lineWidth = lw; g.lineJoin = 'round'; g.font = `${fs}px ui-monospace, Consolas, monospace`; g.textBaseline = 'bottom';
    codes.forEach((code, i) => {
      g.strokeStyle = '#e2001a'; g.beginPath(); code.corners.forEach((p, k) => (k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.stroke();
      g.fillStyle = '#00a651'; g.beginPath(); g.arc(code.corners[0][0], code.corners[0][1], lw * 1.5, 0, 7); g.fill();
      const label = `${i + 1} ${code.format}: ${code.text.length > 32 ? code.text.slice(0, 31) + '…' : code.text}`;
      const tw = g.measureText(label).width + 6; const x = Math.max(0, Math.min(img.width - tw, code.box.x)); const y = code.box.y >= fs + 4 ? code.box.y - lw : Math.min(img.height, code.box.y + code.box.height + fs + 4 + lw);
      g.fillStyle = '#e2001a'; g.fillRect(x, y - fs - 4, tw, fs + 4); g.fillStyle = '#fff'; g.fillText(label, x + 3, y - 1);
    });
    res.output = await saveCanvas(c, vfs.out(args.output, args.input, 'barcodes', 'png'));
  }
  return res;
}

const BC_READ_PROPS = {
  input: { type: 'string', description: 'VFS path of the image containing one or more codes' },
  region: REGION_SCHEMA,
  tryHarder: { type: 'boolean', default: true, description: 'Spend more time: also try rotated (90/180/270°) and downscaled versions of the image. Turn off only for speed on clean, upright codes.' },
  tryInvert: { type: 'boolean', default: true, description: 'Also look for inverted (light on dark) codes' },
  denoise: { type: 'boolean', default: false, description: 'Apply a morphological closing before 2D detection — helps with noisy or dotted prints, slower' },
  maxCodes: { type: 'integer', default: 32, minimum: 1, maximum: 255, description: 'Stop after this many codes' },
  bytes: { type: 'boolean', default: false, description: 'Also return the raw payload bytes as base64 (always included for binary payloads; capped at 3000 bytes)' },
  annotate: { type: 'boolean', default: false, description: 'Also write a copy of the image with every detected code outlined and labelled (result.output)' },
  output: { type: 'string', description: 'VFS path for the annotated image when annotate=true (default: <input name>.barcodes.png)' },
};

register({
  name: 'vision.barcodeRead', readOnly: false,
  description: `Find and decode every barcode in an image with ZXing-C++ (WebAssembly, CPU). Reads 2D codes (QR, Micro QR, rMQR, Data Matrix, Aztec, PDF417, MaxiCode) and 1D codes (EAN-13/8, UPC-A/E, Code 128/39/93, Codabar, ITF, GS1 DataBar, DX film edge), at any rotation, several per image. Returns for each code: format, decoded text (binary payloads as base64), content type, bounding box and the four corner points [x,y] (top-left, top-right, bottom-right, bottom-left of the symbol, in input pixels), orientation in degrees, and error-correction level / version where the symbology has them. UPC-A and UPC-E are reported the way ZXing normalises them: UPC-A as format EAN13 with a leading 0, UPC-E with its 13-digit expanded text. count=0 with a note means nothing was found. Writes nothing unless annotate=true. First use downloads 1.5 MB.`,
  schema: {
    properties: {
      ...BC_READ_PROPS,
      formats: { type: 'array', items: { type: 'string', enum: BC_READ }, default: [], description: 'Only look for these symbologies (default: all). Restricting the list is faster and avoids false positives from 1D decoders on noisy images.' },
    },
    required: ['input'],
  },
  examples: ['vision.barcodeRead input=label.jpg', 'vision.barcodeRead input=shelf.png formats=EAN13,UPCA annotate=true'],
  run: (args, ctx) => barcodeRead(args, ctx, args.formats),
});

/** Add a quiet zone of `m` px around a zint SVG by rewriting its root element. */
function padSvg(svg, m, w, h, dark, light) {
  const W = w + 2 * m, H = h + 2 * m;
  let body = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<?xml version="1.0" standalone="no"?>\n<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" version="1.1" xmlns="http://www.w3.org/2000/svg">\n <rect x="0" y="0" width="${W}" height="${H}" fill="${light}"/>\n <g transform="translate(${m} ${m})">${body}</g>\n</svg>\n`;
}

async function barcodeWrite(args) {
  const format = args.format;
  if ((args.text === undefined || args.text === '') === (args.base64 === undefined)) throw new Error('give exactly one of: text (string payload) or base64 (binary payload)');
  const payload = args.base64 !== undefined ? M.b64.dec(args.base64) : args.text;
  const as = args.as || (/\.svg$/i.test(args.output || '') ? 'svg' : 'png');
  const { zx, loadMs } = await zxingTimed();
  const t0 = now();
  const opts = [];
  if (args.ecLevel) opts.push(`ecLevel=${args.ecLevel}`);
  if (args.options) opts.push(args.options);
  const customMargin = args.margin >= 0;
  const base = { format, rotate: args.rotate || 0, invert: !!args.invert, addHRT: !!args.humanReadable, addQuietZones: !customMargin, options: opts.join(',') };
  const make = async (scale) => {
    let r;
    try { r = await zx.writeBarcode(payload, { ...base, scale }); } catch (e) { throw new Error(`cannot encode as ${format}: ${e?.message || e}`); }
    if (r.error || !r.image) throw new Error(`cannot encode as ${format}: ${r.error || 'encoder returned no image'}`);
    return r;
  };
  // scale = pixels per module. When only a target size is given, measure at scale 1 and pick the largest integer scale that fits.
  let scale = args.scale;
  if (!scale) {
    const probe = await createImageBitmap((await make(1)).image);
    const unit = Math.max(probe.width, probe.height) + (customMargin ? 2 * args.margin : 0); probe.close?.();
    scale = Math.max(1, Math.min(64, Math.floor(args.size / unit)));
  }
  const r = await make(scale);
  const bmp = await createImageBitmap(r.image);
  const m = customMargin ? args.margin * scale : 0;
  const W = bmp.width + 2 * m, H = bmp.height + 2 * m;
  if (W * H > 64e6) throw new Error(`barcode would be ${W}×${H} px — lower scale or size`);
  const path = vfs.out(args.output, `${format.toLowerCase()}`, null, as);
  const meta = { width: W, height: H };
  let output;
  if (as === 'svg') {
    const svg = m ? padSvg(r.svg, m, bmp.width, bmp.height, args.invert ? '#fff' : '#000', args.invert ? '#000' : '#fff') : r.svg;
    output = await vfs.write(path, svg, { mime: 'image/svg+xml', meta });
  } else {
    const c = canvasOf(W, H); const g = c.getContext('2d');
    g.fillStyle = args.invert ? '#000' : '#fff'; g.fillRect(0, 0, W, H); g.imageSmoothingEnabled = false; g.drawImage(bmp, m, m);
    const { bytes } = await canvasBytes(c, 'png');
    output = await vfs.write(path, bytes, { mime: 'image/png', meta });
  }
  bmp.close?.();
  return {
    output, format, scale, margin: customMargin ? args.margin : 'standard quiet zone',
    modules: { width: r.symbol?.width ?? null, height: r.symbol?.height ?? null },
    payloadBytes: typeof payload === 'string' ? new TextEncoder().encode(payload).length : payload.length,
    backend: 'wasm', loadMs, runMs: ms(t0),
  };
}

const BC_WRITE_PROPS = {
  text: { type: 'string', description: 'Payload as text (UTF-8). Numeric-only symbologies need digits: EAN13 12–13, EAN8 7–8, UPCA 11–12, UPCE 7–8, ITF an even count; a missing check digit is computed, a wrong one is an error.' },
  base64: { type: 'string', description: 'Binary payload as base64, instead of text (2D symbologies)' },
  size: { type: 'integer', default: 400, minimum: 16, maximum: 8000, description: 'Target size in pixels of the longer side; the largest whole number of pixels per module that fits is used, so the result is at most this size and always crisp. Ignored when scale is given.' },
  scale: { type: 'integer', minimum: 1, maximum: 64, description: 'Exact pixels per module (overrides size)' },
  margin: { type: 'integer', default: -1, minimum: -1, maximum: 64, description: 'Quiet zone around the symbol in modules. -1 = the standard quiet zone of the symbology (QR 4, Data Matrix 1, linear codes 10…); 0 = none (not reliably scannable).' },
  ecLevel: { type: 'string', description: 'Minimum error correction, where the symbology has it (the encoder raises it for free when the symbol has spare capacity). QRCode: L | M | Q | H (≈7/15/25/30 % recoverable; default chosen by the encoder). AztecCode: a percentage such as "33%". PDF417: 0–8. Not applicable to Data Matrix and linear codes.' },
  humanReadable: { type: 'boolean', default: false, description: 'Print the payload as text under the bars (linear codes)' },
  rotate: { type: 'integer', enum: [0, 90, 180, 270], default: 0, description: 'Rotate the symbol clockwise by this many degrees' },
  invert: { type: 'boolean', default: false, description: 'Light modules on a dark background' },
  as: { type: 'string', enum: ['png', 'svg'], description: 'Output file type (default: from the output extension, else png)' },
  output: { type: 'string', description: 'VFS path to write (default: <format>.png, e.g. qrcode.png)' },
};

register({
  name: 'vision.barcodeWrite',
  description: 'Generate a barcode image (PNG or SVG) from text or bytes with ZXing-C++/zint (WebAssembly). 2D: QRCode, DataMatrix, AztecCode, PDF417. 1D: Code128, Code39, Code93, Codabar, ITF, EAN13, EAN8, UPCA, UPCE. Options: pixel size or exact module scale, quiet-zone margin, error-correction level, human-readable text line, rotation, inversion. Returns the file stat with width/height, the module grid size and the scale used. Invalid payloads for a symbology (wrong length, illegal characters, too much data) fail with the encoder\'s message. Read it back with vision.barcodeRead to verify. First use downloads 1.5 MB.',
  schema: {
    properties: {
      format: { type: 'string', enum: BC_WRITE, default: 'QRCode', description: 'Symbology to generate' },
      ...BC_WRITE_PROPS,
      options: { type: 'string', description: 'Advanced: extra comma-separated ZXing creator options, e.g. "gs1", "version=5", "forceSquare", "columns=4", "eci=26"' },
    },
  },
  examples: ['vision.barcodeWrite text="https://example.org" format=QRCode ecLevel=H size=600', 'vision.barcodeWrite text=4006381333931 format=EAN13 humanReadable=true output=ean.svg'],
  run: (args) => barcodeWrite(args),
});

register({
  name: 'vision.qrRead',
  description: 'Decode QR codes in an image (QR, Micro QR and rMQR only — a faster, stricter vision.barcodeRead). Returns each code\'s text, bounding box, corner points, error-correction level and version; several codes per image are supported. Use vision.barcodeRead for other symbologies. First use downloads 1.5 MB.',
  schema: { properties: { ...BC_READ_PROPS }, required: ['input'] },
  examples: ['vision.qrRead input=poster.jpg'],
  run: (args, ctx) => barcodeRead(args, ctx, ['QRCode', 'MicroQRCode', 'RMQRCode']),
});

register({
  name: 'vision.qrWrite',
  description: 'Make a QR code (PNG or SVG) from text or a URL — shorthand for vision.barcodeWrite format=QRCode. Options: size in pixels, quiet-zone margin, error correction L/M/Q/H (use H when the code will be printed small or overlaid with a logo). Returns the file stat, module count and scale. First use downloads 1.5 MB.',
  schema: {
    properties: { ...BC_WRITE_PROPS, ecLevel: { type: 'string', enum: ['L', 'M', 'Q', 'H'], default: 'M', description: 'Minimum error correction (raised for free when the symbol has spare capacity): L ≈ 7 %, M ≈ 15 %, Q ≈ 25 %, H ≈ 30 % of the code can be damaged and still read' }, output: { type: 'string', description: 'VFS path to write (default: qrcode.png)' } },
  },
  examples: ['vision.qrWrite text="https://example.org"', 'vision.qrWrite text="WIFI:T:WPA;S:net;P:secret;;" ecLevel=H size=800 output=wifi.svg'],
  run: (args) => barcodeWrite({ ...args, format: 'QRCode' }),
});

// ──────────────────────────────────────────────────────── classify ──
const MODEL = { id: 'mobilenetv2-12', file: 'models/mobilenetv2/mobilenetv2-12.onnx', labels: 'models/mobilenetv2/synset.txt', size: 224, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };

let ortLib, modelBytes, labelList;
const ortSessions = new Map(); // 'webgpu' | 'wasm' → promise → {session, loadMs, fresh}

function ortRuntime() {
  ortLib ||= (async () => {
    const ort = await import(V('onnxruntime-web/ort.webgpu.min.mjs'));
    ort.env.wasm.wasmPaths = V('onnxruntime-web/');   // .mjs glue + .wasm, same origin
    ort.env.wasm.numThreads = 1;                      // no COOP/COEP on a static host → no SharedArrayBuffer
    ort.env.wasm.proxy = false;
    ort.env.logLevel = 'error';
    return ort;
  })();
  ortLib.catch(() => { ortLib = null; });
  return ortLib;
}
async function fetchBytes(url, what) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot load ${what}: HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}
function ortSession(ep) {
  if (!ortSessions.has(ep)) {
    const p = (async () => {
      const t0 = now();
      const ort = await ortRuntime();
      modelBytes ||= fetchBytes(V(MODEL.file), 'model'); modelBytes.catch(() => { modelBytes = null; });
      labelList ||= fetchBytes(V(MODEL.labels), 'labels').then((b) => new TextDecoder().decode(b).trim().split('\n').map((l) => { const i = l.indexOf(' '); return { wnid: l.slice(0, i), label: l.slice(i + 1).trim() }; }));
      const [bytes, labels] = await Promise.all([modelBytes, labelList]);
      const session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
      return { ort, session, labels, loadMs: ms(t0), fresh: true };
    })();
    p.catch(() => ortSessions.delete(ep));
    ortSessions.set(ep, p);
  }
  return ortSessions.get(ep);
}

// ORT creates its own GPUDevice, so probe for an adapter directly rather than through M.gpu.device()
// (which answers null to callers that arrive while its first probe is still in flight).
let adapterProbe;
const hasAdapter = () => (adapterProbe ||= navigator.gpu.requestAdapter().then((a) => !!a, () => false));

async function pickSession(backend) {
  const t0 = now();
  let why = null;
  if (backend !== 'cpu') {
    if (!globalThis.navigator?.gpu) why = 'navigator.gpu is not available in this browser';
    else if (!(await hasAdapter())) why = 'navigator.gpu.requestAdapter() returned no adapter';
    else {
      try { const s = await ortSession('webgpu'); return { s, backend: 'webgpu', t0 }; } catch (e) { why = `WebGPU session failed: ${e?.message || e}`; }
    }
    if (backend === 'gpu') throw new Error(`backend=gpu requested but ${why}`);
  }
  const s = await ortSession('wasm');
  return { s, backend: 'wasm', t0, fallbackReason: backend === 'auto' ? why : undefined };
}

/** ImageNet preprocessing → Float32Array NCHW [1,3,S,S]: resize (shorter side → S/0.875) + centre crop S, or squash; /255, mean/std. */
function imagenetTensor(img, crop) {
  const S = MODEL.size; let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (crop === 'center') { const side = Math.min(img.width, img.height) * 0.875; sx = (img.width - side) / 2; sy = (img.height - side) / 2; sw = sh = side; }
  const c = canvasOf(S, S); const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, S, S); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  // Step down by halves first: a single big downscale in canvas aliases badly and costs accuracy.
  let src = sourceCanvas(img);
  while (sw / 2 >= S && sh / 2 >= S) {
    const hw = Math.max(S, Math.floor(sw / 2)), hh = Math.max(S, Math.floor(sh / 2));
    const t = canvasOf(hw, hh); const tg = t.getContext('2d'); tg.fillStyle = '#fff'; tg.fillRect(0, 0, hw, hh); tg.imageSmoothingQuality = 'high';
    tg.drawImage(src, sx, sy, sw, sh, 0, 0, hw, hh); src = t; sx = 0; sy = 0; sw = hw; sh = hh;
  }
  g.drawImage(src, sx, sy, sw, sh, 0, 0, S, S);
  const d = g.getImageData(0, 0, S, S).data; const n = S * S; const out = new Float32Array(3 * n);
  for (let i = 0, j = 0; i < n; i++, j += 4) for (let k = 0; k < 3; k++) out[k * n + i] = (d[j + k] / 255 - MODEL.mean[k]) / MODEL.std[k];
  return out;
}

register({
  name: 'vision.classify', gpu: true, readOnly: true,
  description: 'Say what an image shows: ImageNet-1k classification with MobileNetV2 (ONNX, 3.5 M parameters, ~72 % top-1) running on ONNX Runtime Web — WebGPU when available, single-threaded WebAssembly otherwise. Returns the top-k of 1000 everyday object/animal categories with probabilities (softmax), the backend actually used, and load vs inference time. Use it for a quick "what is the main subject" label on a photo; it knows only the 1000 ImageNet classes (no people/faces, no text, no scenes vocabulary), sees one 224×224 centre crop, and a low top probability (< 0.3) means "not sure / not an ImageNet object". Standard preprocessing is applied (resize, centre crop, mean/std). Writes nothing. First use downloads about 43 MB (29 MB runtime WASM + 14 MB model), cached by the browser afterwards.',
  schema: {
    properties: {
      input: { type: 'string', description: 'VFS path of the image' },
      topK: { type: 'integer', default: 5, minimum: 1, maximum: 50, description: 'How many of the most probable classes to return' },
      crop: { type: 'string', enum: ['center', 'full'], default: 'center', description: 'center = standard ImageNet evaluation crop (central 87.5 % square of the shorter side); full = squash the whole image to a square, use when the subject is off-centre or the image is very wide/tall' },
      region: { type: 'array', items: { type: 'number' }, description: 'Classify only this rectangle: x,y,width,height in input pixels (then crop applies inside it)' },
      backend: { type: 'string', enum: ['auto', 'gpu', 'cpu'], default: 'auto', description: 'auto = WebGPU when available, else WASM; gpu = WebGPU or fail; cpu = force single-threaded WASM' },
    },
    required: ['input'],
  },
  examples: ['vision.classify input=photo.jpg', 'vision.classify input=photo.jpg topK=3 backend=cpu'],
  async run(args, ctx) {
    let img = await decode(args.input);
    const full = { width: img.width, height: img.height };
    const r = rectOf(args.region, img);
    if (!r.full) { const c = renderRegion(img, r, 1, false); img = { width: r.width, height: r.height, data: c.getContext('2d').getImageData(0, 0, r.width, r.height).data }; }
    const tp = now(); const data = imagenetTensor(img, args.crop); const preprocessMs = ms(tp);
    const { s, backend, t0, fallbackReason } = await pickSession(args.backend);
    const loadMs = s.fresh ? Math.max(s.loadMs, ms(t0)) : 0; const firstRun = s.fresh; s.fresh = false;
    const t1 = now();
    const { ort, session, labels } = s;
    const feeds = { [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, MODEL.size, MODEL.size]) };
    const out = await session.run(feeds);
    const logits = out[session.outputNames[0]].data;
    const runMs = ms(t1);
    let max = -Infinity; for (const v of logits) if (v > max) max = v;
    let sum = 0; const probs = new Float32Array(logits.length);
    for (let i = 0; i < logits.length; i++) { probs[i] = Math.exp(logits[i] - max); sum += probs[i]; }
    const order = Array.from(probs.keys()).sort((a, b) => probs[b] - probs[a]).slice(0, args.topK);
    const top = order.map((i, k) => ({ rank: k + 1, label: labels[i].label.split(',')[0], probability: round(probs[i] / sum, 4), index: i, wnid: labels[i].wnid, synonyms: labels[i].label }));
    const res = { top, label: top[0].label, probability: top[0].probability, backend, model: MODEL.id, classes: logits.length, image: full, crop: args.crop, loadMs, preprocessMs, runMs };
    if (firstRun) res.note = backend === 'webgpu' ? 'first run on this backend: runMs includes WebGPU shader compilation; later calls are faster' : 'first run on this backend: later calls skip loadMs';
    if (fallbackReason) res.fallbackReason = fallbackReason;
    return res;
  },
});
