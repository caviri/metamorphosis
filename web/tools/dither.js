// dither.* — tone reduction: error diffusion, ordered and blue-noise dithering, palette quantisation, text art and
// print-style halftones. All pixel loops run in the Rust/WASM kernel; the Bayer path can also run on WebGPU.
import { vfs, register, accel } from '../js/core.js';
import { save } from '../js/img.js';
import { kernel, out, open, gpuOr, hex, parseColor, MAX_PIXELS, IN, OUT, BACKEND } from '../js/kernel.js';

const DIFFUSION = { 'floyd-steinberg': 0, atkinson: 1, 'jarvis-judice-ninke': 2, stucki: 3, burkes: 4, sierra: 5, 'sierra-2row': 6, 'sierra-lite': 7 };
const ORDERED = ['bayer2', 'bayer4', 'bayer8', 'clustered-dot', 'blue-noise', 'random'];
const METHODS = [...Object.keys(DIFFUSION), ...ORDERED, 'none'];
const METHOD_DOC = 'Error diffusion (pushes each pixel\'s rounding error onto unvisited neighbours — best tonal accuracy, organic texture): floyd-steinberg (classic, 4 neighbours), atkinson (diffuses only 3/4 of the error: crisp, high-contrast, the early-Macintosh look), jarvis-judice-ninke / stucki (12 neighbours, smoother, slightly blurrier), burkes, sierra, sierra-2row, sierra-lite (cheaper variants). Ordered (a fixed threshold pattern — stable under animation, regular texture): bayer2 / bayer4 / bayer8 (cross-hatch patterns), clustered-dot (newspaper-style dots), blue-noise (void-and-cluster 64×64 mask: grain without visible pattern), random (white noise). none = plain rounding (posterise).';

function bayer(n) {
  let m = [[0]];
  for (let s = 1; s < n; s *= 2) {
    const q = Array.from({ length: s * 2 }, () => new Array(s * 2));
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const v = 4 * m[y][x]; q[y][x] = v; q[y][x + s] = v + 2; q[y + s][x] = v + 3; q[y + s][x + s] = v + 1; }
    m = q;
  }
  const f = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) f[y * n + x] = (m[y][x] + 0.5) / (n * n) - 0.5;
  return f;
}
/** n×n clustered-dot screen from the classic spot function cos(2πx/n) + cos(2πy/n): dots grow from the cell corners, holes close at the centre. */
function clustered(n) {
  const cells = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cells.push({ i: y * n + x, s: Math.cos(2 * Math.PI * (x + 0.5) / n) + Math.cos(2 * Math.PI * (y + 0.5) / n), a: Math.atan2(y + 0.5 - n / 2, x + 0.5 - n / 2) });
  cells.sort((p, q) => p.s - q.s || p.a - q.a);
  const f = new Float32Array(n * n);
  cells.forEach((c, r) => { f[c.i] = (r + 0.5) / (n * n) - 0.5; });
  return f;
}
const blueCache = new Map();
async function blueNoise(K, seed) {
  if (!blueCache.has(seed)) { const o = out(Float32Array, 64 * 64); K.call('blue_noise', o, 64, seed); blueCache.set(seed, o.value); }
  return blueCache.get(seed);
}
/** → {mat: Float32Array|null, size} for an ordered method (null matrix = white noise in the kernel) */
async function matrixFor(K, method, clusterSize, seed) {
  if (method.startsWith('bayer')) { const n = +method.slice(5); return { mat: bayer(n), size: n }; }
  if (method === 'clustered-dot') return { mat: clustered(clusterSize), size: clusterSize };
  if (method === 'blue-noise') return { mat: await blueNoise(K, seed), size: 64 };
  return { mat: null, size: 1 };
}

const COMMON = {
  serpentine: { type: 'boolean', default: true, description: 'Error diffusion only: alternate the scan direction on every row (removes directional "worm" artefacts)' },
  strength: { type: 'number', default: 1, minimum: 0, maximum: 2, description: 'Dither amount: fraction of the error diffused, or amplitude of the ordered threshold (1 = full; lower = flatter, more banding)' },
  clusterSize: { type: 'integer', enum: [4, 6, 8, 12, 16], default: 8, description: 'clustered-dot only: screen cell size in pixels' },
  seed: { type: 'integer', default: 1, minimum: 1, description: 'Seed for blue-noise and random' },
};

register({
  name: 'dither.apply', gpu: true,
  description: `Reduce an image to a few evenly spaced levels per channel while keeping the impression of continuous tone by dithering. levels=2 gives 8 colours (1 bit per channel) — or pure black and white with mono=true; levels=4 gives 64 colours, etc. ${METHOD_DOC} Use it for 1-bit displays (e-paper, thermal printers), retro looks, or to avoid banding when lowering bit depth. Alpha is kept. To map onto specific colours use dither.palette instead. bayer2/4/8 at strength 1 can run on WebGPU.`,
  schema: {
    properties: {
      input: IN,
      method: { type: 'string', enum: METHODS, default: 'floyd-steinberg', description: 'Dither algorithm (see description)' },
      levels: { type: 'integer', default: 2, minimum: 2, maximum: 64, description: 'Output levels per channel' },
      mono: { type: 'boolean', default: false, description: 'Convert to gray (Rec.709 luma) first, so the result is gray levels only' },
      ...COMMON, backend: BACKEND, output: OUT,
    },
    required: ['input'],
  },
  examples: ['dither.apply input=photo.jpg mono=true', 'dither.apply input=photo.jpg method=bayer8 levels=4', 'dither.apply input=photo.jpg method=blue-noise mono=true'],
  async run(args) {
    const img = await open(args.input); const { method, levels, mono } = args; let r;
    if (method in DIFFUSION || method === 'none') {
      if (args.backend === 'gpu') throw new Error('backend=gpu: only bayer2/bayer4/bayer8 have a WebGPU kernel (error diffusion is inherently sequential)');
      const K = await kernel();
      r = { img: method === 'none' ? K.img('dither_ordered', img, new Float32Array([0]), 1, 1, levels, mono, 0, 1) : K.img('dither_ed', img, DIFFUSION[method], levels, args.serpentine, mono, args.strength), backend: 'wasm' };
    } else {
      const wasm = async (K) => { const { mat, size } = await matrixFor(K, method, args.clusterSize, args.seed); return K.img('dither_ordered', img, mat, size, size, levels, mono, args.strength, args.seed); };
      if (method.startsWith('bayer') && args.strength === 1) r = await gpuOr(accel, 'bayer', img, { levels, size: +method.slice(5), mono }, args.backend, wasm);
      else { if (args.backend === 'gpu') throw new Error('backend=gpu: only bayer2/bayer4/bayer8 at strength=1 have a WebGPU kernel'); r = { img: await wasm(await kernel()), backend: 'wasm' }; }
    }
    const output = await save(r.img, vfs.out(args.output, args.input, method, 'png'));
    return { output, method, levels, mono, colors: mono ? levels : levels ** 3, kind: method in DIFFUSION ? 'error-diffusion' : method === 'none' ? 'none' : 'ordered', ...(method in DIFFUSION ? { serpentine: args.serpentine } : {}), strength: args.strength, backend: r.backend };
  },
});

// ───────────────────────────────────────────────────────────── palettes ──
const H = (s) => s.split(' ');
const PALETTES = {
  '1bit': H('000000 ffffff'),
  gameboy: H('0f380f 306230 8bac0f 9bbc0f'),
  'gameboy-pocket': H('000000 555555 aaaaaa ffffff'),
  cga: H('000000 55ffff ff55ff ffffff'),
  cga16: H('000000 0000aa 00aa00 00aaaa aa0000 aa00aa aa5500 aaaaaa 555555 5555ff 55ff55 55ffff ff5555 ff55ff ffff55 ffffff'),
  c64: H('000000 ffffff 68372b 70a4b2 6f3d86 588d43 352879 b8c76f 6f4f25 433900 9a6759 444444 6c6c6c 9ad284 6c5eb5 959595'),
  'pico-8': H('000000 1d2b53 7e2553 008751 ab5236 5f574f c2c3c7 fff1e8 ff004d ffa300 ffec27 00e436 29adff 83769c ff77a8 ffccaa'),
  'zx-spectrum': H('000000 0000d7 d70000 d700d7 00d700 00d7d7 d7d700 d7d7d7 0000ff ff0000 ff00ff 00ff00 00ffff ffff00 ffffff'),
  'rgb-3bit': H('000000 0000ff 00ff00 00ffff ff0000 ff00ff ffff00 ffffff'),
};
const PALETTE_NAMES = [...Object.keys(PALETTES), 'websafe', 'grayscale', 'adaptive', 'custom'];

register({
  name: 'dither.palette',
  description: `Quantise an image to a fixed set of colours: every pixel becomes the nearest palette colour (Euclidean distance in RGB), with optional dithering to simulate the colours in between. Palettes: 1bit (black/white), gameboy (4 greens), gameboy-pocket (4 grays), cga (black/cyan/magenta/white), cga16 (the 16 IBM CGA/EGA colours), c64 (16, Pepto), pico-8 (16), zx-spectrum (15), rgb-3bit (8), websafe (216), grayscale (n evenly spaced grays), adaptive (the n most representative colours of this image, found by median cut — use it for GIF-style 256-colour reduction), custom (your own hex list in \`colors\`). ${METHOD_DOC} For ordered methods on a palette the threshold amplitude is derived from the palette's mean nearest-neighbour spacing (a heuristic; error diffusion is the tonally accurate choice). Returns the palette actually used and how many pixels took each colour. Alpha is kept.`,
  schema: {
    properties: {
      input: IN,
      palette: { type: 'string', enum: PALETTE_NAMES, default: 'adaptive', description: 'Named palette, or adaptive / grayscale (with n), or custom (with colors)' },
      n: { type: 'integer', default: 16, minimum: 2, maximum: 256, description: 'Number of colours for palette=adaptive or grayscale' },
      colors: { type: 'array', items: { type: 'string' }, description: 'palette=custom: 2–256 colours as hex (#rrggbb or rrggbb)' },
      method: { type: 'string', enum: METHODS, default: 'floyd-steinberg', description: 'Dither algorithm (none = nearest colour only)' },
      ...COMMON, output: OUT,
    },
    required: ['input'],
  },
  examples: ['dither.palette input=photo.jpg palette=pico-8', 'dither.palette input=photo.jpg palette=adaptive n=32 method=none', 'dither.palette input=a.png palette=custom colors=#000000,#ff0000,#ffffff method=atkinson'],
  async run(args) {
    const img = await open(args.input); const K = await kernel(); let pal;
    if (args.palette === 'custom') {
      if (!args.colors || args.colors.length < 2 || args.colors.length > 256) throw new Error('palette=custom needs colors: 2 to 256 hex values, e.g. colors=#000000,#ffffff');
      pal = new Uint8Array(args.colors.flatMap((c) => parseColor(c).slice(0, 3)));
    } else if (args.palette === 'adaptive') {
      const o = out(Uint8Array, args.n * 3); const k = K.call('median_cut', img.data, img.width, img.height, args.n, o);
      if (!k) throw new Error('the image has no visible pixels');
      pal = o.value.subarray(0, k * 3);
    } else if (args.palette === 'grayscale') { pal = new Uint8Array(args.n * 3); for (let i = 0; i < args.n; i++) pal.fill(Math.round(i * 255 / (args.n - 1)), i * 3, i * 3 + 3); }
    else if (args.palette === 'websafe') { pal = new Uint8Array(216 * 3); let i = 0; for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) { pal[i++] = r * 51; pal[i++] = g * 51; pal[i++] = b * 51; } }
    else pal = new Uint8Array(PALETTES[args.palette].flatMap((h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]));
    const k = pal.length / 3; const m = args.method; const cnt = out(Uint32Array, k); let res;
    if (m in DIFFUSION || m === 'none') res = K.img('dither_palette', img, pal, k, m === 'none' ? -1 : DIFFUSION[m], args.serpentine, args.strength, null, 1, 1, 0, args.seed, cnt);
    else {
      // threshold amplitude: mean distance from each palette colour to its nearest neighbour, projected on one axis
      let sum = 0, gray = true;
      for (let i = 0; i < k; i++) { let best = Infinity; for (let j = 0; j < k; j++) if (j !== i) { const d = Math.hypot(pal[i * 3] - pal[j * 3], pal[i * 3 + 1] - pal[j * 3 + 1], pal[i * 3 + 2] - pal[j * 3 + 2]); if (d < best) best = d; } sum += best; if (pal[i * 3] !== pal[i * 3 + 1] || pal[i * 3 + 1] !== pal[i * 3 + 2]) gray = false; }
      const spread = sum / k / Math.sqrt(3) * (gray ? 1 : 1.5);
      const { mat, size } = await matrixFor(K, m, args.clusterSize, args.seed);
      res = K.img('dither_palette', img, pal, k, 100, 0, args.strength, mat, size, size, spread, args.seed, cnt);
    }
    const output = await save(res, vfs.out(args.output, args.input, args.palette === 'custom' ? 'pal' : args.palette, 'png'));
    const total = img.width * img.height;
    const used = [...Array(k)].map((_, i) => ({ hex: hex(pal[i * 3], pal[i * 3 + 1], pal[i * 3 + 2]), pixels: cnt.value[i], share: +(cnt.value[i] / total).toFixed(4) })).sort((a, b) => b.pixels - a.pixels);
    return { output, palette: args.palette, colors: k, colorsUsed: used.filter((u) => u.pixels > 0).length, method: m, usage: used.slice(0, 32), truncated: used.length > 32, backend: 'wasm' };
  },
});

// ──────────────────────────────────────────────────────────────── text ──
const RAMPS = {
  ascii: ' .:-=+*#%@',
  'ascii-dense': ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  blocks: ' ░▒▓█',
};
register({
  name: 'dither.ascii',
  description: 'Turn an image into text art and write it as a UTF-8 .txt file (also returned inline when small). charset: ascii (10-step ramp " .:-=+*#%@"), ascii-dense (70 steps, finer tones), blocks (" ░▒▓█"), half-blocks (▀ ▄ █: two pixels per character, 1-bit), braille (U+2800 patterns: 2×4 dots per character — the highest resolution, 1-bit, dithered), or your own `ramp` from darkest to brightest glyph. Each character covers an area-averaged block of the image; `columns` sets the width and the height follows from the image aspect and the character cell shape. Use it to "see" an image through a text-only channel, for terminal previews, or for README art. background=dark (default) means bright pixels get dense glyphs, as on a dark terminal; use light for black-on-white.',
  schema: {
    properties: {
      input: IN,
      columns: { type: 'integer', default: 80, minimum: 4, maximum: 400, description: 'Characters per line' },
      charset: { type: 'string', enum: ['ascii', 'ascii-dense', 'blocks', 'half-blocks', 'braille'], default: 'ascii', description: 'Glyph set' },
      ramp: { type: 'string', description: 'Custom glyph ramp, darkest → brightest (overrides charset; at least 2 characters)' },
      background: { type: 'string', enum: ['dark', 'light'], default: 'dark', description: 'Colour of the surface the text will be shown on' },
      cellAspect: { type: 'number', default: 2, minimum: 0.5, maximum: 4, description: 'Height ÷ width of one character cell in the target font (2 for most monospace fonts; 1 for square cells)' },
      normalize: { type: 'boolean', default: true, description: 'Stretch the brightness range to use the whole ramp' },
      dither: { type: 'string', enum: ['floyd-steinberg', 'atkinson', 'none'], default: 'floyd-steinberg', description: 'braille / half-blocks: how the 1-bit dots are chosen (none = threshold at mid-gray)' },
      output: { type: 'string', description: 'VFS path of the .txt file (default: derived from the input name)' },
    },
    required: ['input'],
  },
  examples: ['dither.ascii input=photo.jpg columns=100', 'dither.ascii input=logo.png charset=braille columns=60 background=light'],
  async run(args) {
    const img = await open(args.input); const K = await kernel(); const cols = args.columns;
    const rows = Math.max(1, Math.round(cols * img.height / img.width / args.cellAspect));
    const bitmap = !args.ramp && (args.charset === 'braille' || args.charset === 'half-blocks');
    const [sx, sy] = bitmap ? (args.charset === 'braille' ? [2, 4] : [1, 2]) : [1, 1];
    const gw = cols * sx, gh = rows * sy;
    // composite on the display background first so transparency reads as background
    const bg = args.background === 'dark' ? [0, 0, 0] : [255, 255, 255];
    let small = K.img('flatten', img, ...bg);
    small = K.imgTo('resize', small, gw, gh, gw < img.width || gh < img.height ? 2 : 3);
    small = K.img('grayscale', small);
    if (args.normalize) {
      const st = out(Float64Array, 32); K.call('stats', small.data, gw, gh, st); const lo = st.value[22], hi = st.value[23];
      if (hi - lo > 8) { const c = 255 / (hi - lo); small = K.img('adjust', small, (0.5 - (lo + hi) / 2 / 255) * c, c, 1, 1, 0); }
    }
    const lines = [];
    if (bitmap) {
      small = args.dither === 'none' ? K.img('threshold', small, 128) : K.img('dither_ed', small, args.dither === 'atkinson' ? 1 : 0, 2, 1, 1, 1);
      const on = (x, y) => (small.data[(y * gw + x) * 4] > 127) === (args.background === 'dark');
      for (let r = 0; r < rows; r++) {
        let s = '';
        for (let c = 0; c < cols; c++) {
          if (args.charset === 'braille') {
            const x = c * 2, y = r * 4; let bits = 0;
            if (on(x, y)) bits |= 1; if (on(x, y + 1)) bits |= 2; if (on(x, y + 2)) bits |= 4; if (on(x + 1, y)) bits |= 8;
            if (on(x + 1, y + 1)) bits |= 16; if (on(x + 1, y + 2)) bits |= 32; if (on(x, y + 3)) bits |= 64; if (on(x + 1, y + 3)) bits |= 128;
            s += String.fromCharCode(0x2800 + bits);
          } else { const t = on(c, r * 2), b = on(c, r * 2 + 1); s += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; }
        }
        lines.push(s);
      }
    } else {
      const ramp = [...(args.ramp || RAMPS[args.charset])];
      if (ramp.length < 2) throw new Error('ramp needs at least 2 characters (darkest → brightest)');
      for (let r = 0; r < rows; r++) {
        let s = '';
        for (let c = 0; c < cols; c++) { let v = small.data[(r * cols + c) * 4] / 255; if (args.background === 'light') v = 1 - v; s += ramp[Math.min(ramp.length - 1, Math.floor(v * ramp.length))]; }
        lines.push(s);
      }
    }
    const text = lines.map((l) => l.replace(/\s+$/, '')).join('\n') + '\n';
    const output = await vfs.write(vfs.out(args.output, args.input, bitmap ? args.charset : 'ascii', 'txt'), text, { mime: 'text/plain', meta: { columns: cols, rows } });
    const res = { output, columns: cols, rows, charset: args.ramp ? 'custom' : args.charset, pixelsPerChar: `${sx}×${sy}`, background: args.background, backend: 'wasm' };
    if (text.length <= 6000) res.text = text; else { res.preview = lines.slice(0, 8).join('\n'); res.truncated = true; }
    return res;
  },
});

// ──────────────────────────────────────────────────────────── halftone ──
register({
  name: 'dither.halftone',
  description: 'Print-style halftone: the image is rebuilt from round dots on a regular screen whose dot size follows the local tone, like newspaper or comic printing. mode=mono: black dots on white, screen rotated by `angle` (45° by default). mode=cmyk: the image is separated into cyan, magenta, yellow and black (full gray-component replacement) and each ink gets its own screen angle (15°, 75°, 0°, 45° by default — the traditional set that minimises moiré); the inks are multiplied back together. `cell` is the screen period in pixels (dot spacing); dot areas are exact (a dot of ink coverage t covers a fraction t of its cell) and edges are antialiased. Set scale > 1 to enlarge the image first so small sources get enough dots. Output is opaque.',
  schema: {
    properties: {
      input: IN,
      mode: { type: 'string', enum: ['mono', 'cmyk'], default: 'mono', description: 'Black dots, or four-colour process' },
      cell: { type: 'number', default: 8, minimum: 2, maximum: 128, description: 'Screen period (dot spacing) in output pixels' },
      angle: { type: 'number', default: 45, minimum: -180, maximum: 180, description: 'mono: screen angle in degrees' },
      angles: { type: 'array', items: { type: 'number' }, default: [15, 75, 0, 45], description: 'cmyk: screen angles for C, M, Y, K in degrees' },
      scale: { type: 'number', default: 1, minimum: 1, maximum: 8, description: 'Enlarge the image by this factor before screening (Lanczos)' },
      output: OUT,
    },
    required: ['input'],
  },
  examples: ['dither.halftone input=photo.jpg cell=6', 'dither.halftone input=photo.jpg mode=cmyk cell=10 scale=2'],
  async run(args) {
    let img = await open(args.input); const K = await kernel();
    if (args.scale > 1) {
      const w = Math.round(img.width * args.scale), h = Math.round(img.height * args.scale);
      if (w * h > MAX_PIXELS || w > 16384 || h > 16384) throw new Error(`scale=${args.scale} would give ${w}×${h}; the limit is ${MAX_PIXELS / 1e6} MP and 16384 px per side`);
      img = K.imgTo('resize', img, w, h, 4);
    }
    const a = args.mode === 'cmyk' ? args.angles : [0, 0, 0, args.angle];
    if (a.length !== 4 || a.some((v) => !Number.isFinite(v))) throw new Error('angles must be four numbers: C, M, Y, K');
    const white = K.img('flatten', img, 255, 255, 255);
    const res = K.img('halftone', white, args.cell, a[0], a[1], a[2], a[3], args.mode === 'cmyk' ? 1 : 0);
    const output = await save(res, vfs.out(args.output, args.input, args.mode === 'cmyk' ? 'cmyk' : 'halftone', 'png'));
    return { output, mode: args.mode, cell: args.cell, angles: args.mode === 'cmyk' ? { c: a[0], m: a[1], y: a[2], k: a[3] } : { k: a[3] }, width: res.width, height: res.height, backend: 'wasm' };
  },
});
