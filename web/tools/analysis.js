// analysis.* — measurements and forensics on raster images. Numbers come from the Rust/WASM kernel; JS decodes,
// orchestrates and draws the small charts/overlays. Results are compact JSON; any picture goes to the VFS.
import { vfs, register } from '../js/core.js';
import { save, encode, decode, toCanvas, canvasOf, saveCanvas } from '../js/img.js';
import { kernel, out, io, open, decodeExact, encodePngExact, colormapLut, COLORMAPS, hex, MAX_PIXELS, IN } from '../js/kernel.js';

const r2 = (v, d = 2) => +Number(v).toFixed(d);
const OUTP = (what) => ({ type: 'string', description: `VFS path for ${what} (PNG; default: derived from the input name)` });

// ─────────────────────────────────────────────────────────── histogram ──
register({
  name: 'analysis.histogram',
  description: 'Brightness distribution of an image: per-channel histograms of R, G, B and Rec.709 luma (returned reduced to `bins` buckets), with mean, median, mode, the 1st/99th percentiles and the share of pixels clipped at 0 and 255 for each channel, plus a rendered chart PNG. Use it to judge exposure (clipped shadows/highlights), contrast (how much of the range is used) and colour casts (channels offset from each other).',
  schema: {
    properties: {
      input: IN,
      bins: { type: 'integer', default: 32, minimum: 4, maximum: 256, description: 'Buckets per channel in the returned JSON (the chart always uses all 256 levels)' },
      scale: { type: 'string', enum: ['linear', 'log'], default: 'linear', description: 'Vertical axis of the chart; log reveals sparsely populated levels' },
      chart: { type: 'boolean', default: true, description: 'Render the chart PNG' },
      output: OUTP('the chart'),
    },
    required: ['input'],
  },
  examples: ['analysis.histogram input=photo.jpg', 'analysis.histogram input=photo.jpg bins=16 scale=log'],
  async run(args) {
    const img = await open(args.input); const K = await kernel(); const o = out(Uint32Array, 1280);
    K.call('histogram', img.data, img.width, img.height, o);
    const n = img.width * img.height; const names = ['r', 'g', 'b', 'a', 'luma']; const res = { width: img.width, height: img.height, pixels: n, bins: args.bins, channels: {} };
    for (const ci of [0, 1, 2, 4]) {
      const h = o.value.subarray(ci * 256, ci * 256 + 256);
      let acc = 0, sum = 0, mode = 0, p1 = null, med = null, p99 = null;
      for (let v = 0; v < 256; v++) { acc += h[v]; sum += v * h[v]; if (h[v] > h[mode]) mode = v; if (p1 === null && acc >= n * 0.01) p1 = v; if (med === null && acc >= n * 0.5) med = v; if (p99 === null && acc >= n * 0.99) p99 = v; }
      const step = 256 / args.bins; const b = new Array(args.bins).fill(0);
      for (let v = 0; v < 256; v++) b[Math.min(args.bins - 1, Math.floor(v / step))] += h[v];
      res.channels[names[ci]] = { mean: r2(sum / n), median: med, mode, p1, p99, clippedLow: r2(h[0] / n, 5), clippedHigh: r2(h[255] / n, 5), histogram: b };
    }
    const L = res.channels.luma;
    res.exposure = L.clippedHigh > 0.05 ? 'highlights clipped' : L.clippedLow > 0.05 ? 'shadows clipped' : L.mean < 60 ? 'dark' : L.mean > 195 ? 'bright' : 'balanced';
    res.dynamicRange = L.p99 - L.p1;
    if (args.chart) {
      const W = 600, H = 320, pl = 36, pr = 12, pt = 14, pb = 28, cw = W - pl - pr, chh = H - pt - pb;
      const c = canvasOf(W, H); const g = c.getContext('2d');
      g.fillStyle = '#16171b'; g.fillRect(0, 0, W, H);
      const f = (v) => (args.scale === 'log' ? Math.log1p(v) : v);
      let peak = 1; for (const ci of [0, 1, 2, 4]) for (let v = 0; v < 256; v++) peak = Math.max(peak, f(o.value[ci * 256 + v]));
      g.strokeStyle = '#2c2e36'; g.lineWidth = 1; g.fillStyle = '#8b8e98'; g.font = '11px sans-serif'; g.textAlign = 'center';
      for (const v of [0, 64, 128, 192, 255]) { const x = pl + v / 255 * cw; g.beginPath(); g.moveTo(x + 0.5, pt); g.lineTo(x + 0.5, pt + chh); g.stroke(); g.fillText(String(v), x, H - 10); }
      g.globalCompositeOperation = 'lighter';
      const draw = (ci, fill, stroke) => {
        g.beginPath(); g.moveTo(pl, pt + chh);
        for (let v = 0; v < 256; v++) g.lineTo(pl + v / 255 * cw, pt + chh - f(o.value[ci * 256 + v]) / peak * chh);
        g.lineTo(pl + cw, pt + chh); g.closePath();
        if (fill) { g.fillStyle = fill; g.fill(); }
        if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke(); }
      };
      draw(0, 'rgba(230,60,60,0.55)'); draw(1, 'rgba(60,200,80,0.55)'); draw(2, 'rgba(70,110,255,0.6)');
      g.globalCompositeOperation = 'source-over'; draw(4, null, '#e8e8ec');
      g.textAlign = 'left'; g.fillStyle = '#8b8e98'; g.fillText(`${args.scale} scale · peak ${args.scale === 'log' ? Math.round(Math.expm1(peak)) : peak} px · white line = luma`, pl, 11);
      res.output = await saveCanvas(c, vfs.out(args.output, args.input, 'hist', 'png'));
    }
    return res;
  },
});

// ─────────────────────────────────────────────────────────────── stats ──
register({
  name: 'analysis.stats', readOnly: true,
  description: 'Summary statistics of an image: for R, G, B, alpha and Rec.709 luma the mean, standard deviation, min, max and Shannon entropy (bits, 0–8; low = flat, high = detailed/noisy); plus colourfulness (Hasler–Süsstrunk metric: <15 nearly gray, ~33 moderately, >80 very colourful), mean HSV saturation, and the share of near-black and near-white pixels. Use it for quick quality gates (is the image blank, washed out, monochrome?) and to compare images numerically.',
  schema: { properties: { input: IN }, required: ['input'] },
  examples: ['analysis.stats input=photo.jpg'],
  async run({ input }) {
    const img = await open(input); const K = await kernel(); const o = out(Float64Array, 32);
    K.call('stats', img.data, img.width, img.height, o); const v = o.value;
    const ch = (i) => ({ mean: r2(v[i * 5]), std: r2(v[i * 5 + 1]), min: v[i * 5 + 2], max: v[i * 5 + 3], entropy: r2(v[i * 5 + 4], 3) });
    const res = { width: img.width, height: img.height, pixels: img.width * img.height, r: ch(0), g: ch(1), b: ch(2), alpha: ch(3), luma: ch(4), colorfulness: r2(v[25]), meanSaturation: r2(v[26], 4), darkFraction: r2(v[27], 5), brightFraction: r2(v[28], 5) };
    res.contrast = r2(v[21] / 127.5, 4); // luma std relative to mid-scale
    res.isBlank = v[21] < 2; res.isGrayscale = v[25] < 1e-9; res.hasTransparency = v[17] < 255;
    res.colorfulnessVerdict = v[25] < 15 ? 'nearly gray' : v[25] < 33 ? 'slightly colourful' : v[25] < 59 ? 'moderately colourful' : v[25] < 82 ? 'quite colourful' : 'highly colourful';
    return res;
  },
});

// ───────────────────────────────────────────────────────────── palette ──
register({
  name: 'analysis.palette',
  description: 'Dominant colours of an image by k-means clustering (k-means++ seeding, deterministic for a given seed) in CIE L*a*b* (perceptual, default) or RGB. Returns up to k colours sorted by share: hex, RGB, proportion of pixels; and writes a swatch PNG whose bar widths are proportional to the shares. Fully transparent pixels are ignored. Large images are sampled evenly (≤ 200 000 pixels), which does not change the answer materially. Use to describe an image\'s colour scheme, pick theme colours, or check brand colours.',
  schema: {
    properties: {
      input: IN,
      k: { type: 'integer', default: 5, minimum: 1, maximum: 32, description: 'Number of colours' },
      space: { type: 'string', enum: ['lab', 'rgb'], default: 'lab', description: 'Clustering space' },
      seed: { type: 'integer', default: 1, minimum: 1, description: 'Seed for the k-means++ initialisation' },
      swatch: { type: 'boolean', default: true, description: 'Write the swatch PNG' },
      output: OUTP('the swatch'),
    },
    required: ['input'],
  },
  examples: ['analysis.palette input=photo.jpg k=6'],
  async run(args) {
    const img = await open(args.input); const K = await kernel();
    const cent = out(Float32Array, args.k * 3), cnt = out(Uint32Array, args.k);
    const samples = K.call('kmeans', img.data, img.width, img.height, args.k, 40, args.seed, args.space === 'lab' ? 1 : 0, 200000, cent, cnt);
    if (!samples) throw new Error('the image has no visible pixels (everything is fully transparent)');
    const total = cnt.value.reduce((a, v) => a + v, 0);
    const colors = [];
    for (let i = 0; i < args.k; i++) if (cnt.value[i] > 0) { const [r, g, b] = [0, 1, 2].map((c) => Math.round(cent.value[i * 3 + c])); colors.push({ hex: hex(r, g, b), rgb: [r, g, b], proportion: r2(cnt.value[i] / total, 4) }); }
    colors.sort((a, b) => b.proportion - a.proportion);
    const res = { colors, k: colors.length, space: args.space, samples, backend: 'wasm' };
    if (args.swatch) {
      const W = 600, H = 96; const c = canvasOf(W, H); const g = c.getContext('2d'); let x = 0;
      colors.forEach((col, i) => { const w = i === colors.length - 1 ? W - x : Math.max(1, Math.round(col.proportion * W)); g.fillStyle = col.hex; g.fillRect(x, 0, w, H); x += w; });
      res.output = await saveCanvas(c, vfs.out(args.output, args.input, 'palette', 'png'));
    }
    return res;
  },
});

// ─────────────────────────────────────────────────── sharpness & noise ──
register({
  name: 'analysis.sharpness', readOnly: true,
  description: 'Focus / blur measurement on luma: variance of the Laplacian (the standard blur detector — higher is sharper) and Tenengrad (mean squared Sobel gradient), plus a verdict. Thresholds are rules of thumb for natural photos near 1–2 MP (variance of Laplacian < 50 blurry, 50–150 soft, > 150 sharp); they depend on content and resolution, so to compare images use the same `maxSide`. By default the image is analysed at a normalised size (longer side ≤ 1024) so the numbers are comparable between files.',
  schema: { properties: { input: IN, maxSide: { type: 'integer', default: 1024, minimum: 0, maximum: 8192, description: 'Analyse at this longer-side size (0 = full resolution)' } }, required: ['input'] },
  examples: ['analysis.sharpness input=photo.jpg'],
  async run({ input, maxSide }) {
    let img = await open(input); const K = await kernel(); const full = { width: img.width, height: img.height };
    if (maxSide && Math.max(img.width, img.height) > maxSide) { const k = maxSide / Math.max(img.width, img.height); img = K.imgTo('resize', img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)), 2); }
    const o = out(Float64Array, 4); K.call('sharpness', img.data, img.width, img.height, o); const v = o.value;
    return { laplacianVariance: r2(v[0]), tenengrad: r2(v[1]), meanGradient: r2(v[2], 3), verdict: v[0] < 50 ? 'blurry' : v[0] < 150 ? 'soft' : 'sharp', analysedAt: { width: img.width, height: img.height }, source: full, backend: 'wasm' };
  },
});

register({
  name: 'analysis.noise', readOnly: true,
  description: 'Estimate the noise level (standard deviation, in 0–255 levels) of an image\'s luma with two classical estimators: Immerkær\'s fast method (Laplacian-difference mask; slightly high on heavily textured images) and the robust wavelet MAD estimator of Donoho (median of the finest diagonal Haar detail / 0.6745; resistant to edges). Both assume additive, roughly white noise; JPEG compression and denoising make them read low. Returns both values, a combined sigma (the smaller, as texture only inflates them) and a verdict.',
  schema: { properties: { input: IN }, required: ['input'] },
  examples: ['analysis.noise input=photo.png'],
  async run({ input }) {
    const img = await open(input); const K = await kernel(); const o = out(Float64Array, 2);
    K.call('noise', img.data, img.width, img.height, o); const [a, b] = o.value; const s = Math.min(a, b);
    return { sigma: r2(s), sigmaImmerkaer: r2(a), sigmaMad: r2(b), snrDb: s > 0 ? r2(20 * Math.log10(255 / s), 1) : null, verdict: s < 1 ? 'clean' : s < 3 ? 'low noise' : s < 8 ? 'moderate noise' : 'heavy noise', width: img.width, height: img.height, backend: 'wasm' };
  },
});

// ───────────────────────────────────────────────────────────── compare ──
register({
  name: 'analysis.compare',
  description: 'Compare two images of the same size pixel by pixel. Returns MSE and PSNR (dB, over RGB; the string "Infinity" when the images are identical), mean SSIM on luma (structural similarity, 1 = identical; Wang et al. 11×11 gaussian window), the maximum channel difference, and the number and share of differing pixels; and writes a heat-map PNG showing where they differ (map=diff: largest channel difference per pixel, amplified; map=ssim: local SSIM, dark = dissimilar). Use for regression checks (did the render change?), to quantify compression loss, or to locate edits. If the sizes differ, pass resize=true to scale `b` to `a` first (Lanczos).',
  schema: {
    properties: {
      a: { type: 'string', description: 'VFS path of the reference image' },
      b: { type: 'string', description: 'VFS path of the image to compare against it' },
      resize: { type: 'boolean', default: false, description: 'Resize b to the size of a when they differ (otherwise that is an error)' },
      map: { type: 'string', enum: ['diff', 'ssim', 'none'], default: 'diff', description: 'Which heat-map to write' },
      gain: { type: 'number', default: 0, minimum: 0, maximum: 255, description: 'Amplification of the diff map; 0 = automatic (largest difference becomes full scale)' },
      colormap: { type: 'string', enum: COLORMAPS, default: 'inferno', description: 'Colour scale of the diff map' },
      output: OUTP('the heat-map'),
    },
    required: ['a', 'b'],
  },
  examples: ['analysis.compare a=original.png b=compressed.jpg', 'analysis.compare a=v1.png b=v2.png map=ssim'],
  async run(args) {
    const A = await open(args.a); let B = await open(args.b); const K = await kernel(); let resized = false;
    if (A.width !== B.width || A.height !== B.height) {
      if (!args.resize) throw new Error(`sizes differ: a is ${A.width}×${A.height}, b is ${B.width}×${B.height} — pass resize=true to scale b to a, or resize/crop them first`);
      B = K.imgTo('resize', B, A.width, A.height, 4); resized = true;
    }
    const { width: w, height: h } = A; const n = w * h;
    const m = out(Float64Array, 8); K.call('mse', A.data, B.data, w, h, m); const v = m.value;
    const mseRgb = (v[0] + v[1] + v[2]) / 3; const psnr = (x) => (x === 0 ? 'Infinity' : r2(10 * Math.log10(255 * 255 / x), 3));
    const wantSsimMap = args.map === 'ssim'; const sm = wantSsimMap ? out(Uint8ClampedArray, n * 4) : null;
    const ssim = K.call('ssim', A.data, B.data, w, h, sm);
    const res = { identical: v[5] === 0, mse: r2(mseRgb, 4), psnr: psnr(mseRgb), psnrLuma: psnr(v[6]), ssim: r2(ssim, 6), meanAbsError: r2(v[7], 4), maxDiff: v[4], differingPixels: v[5], differingFraction: r2(v[5] / n, 6), perChannelMse: { r: r2(v[0], 4), g: r2(v[1], 4), b: r2(v[2], 4), a: r2(v[3], 4) }, width: w, height: h, resized, backend: 'wasm' };
    res.verdict = res.identical ? 'identical' : ssim > 0.99 ? 'visually indistinguishable' : ssim > 0.95 ? 'very similar' : ssim > 0.8 ? 'similar with visible differences' : 'substantially different';
    if (args.map === 'diff') {
      const gain = args.gain || (v[4] > 0 ? 255 / v[4] : 1); const o = out(Uint8ClampedArray, n * 4);
      K.call('diffmap', A.data, B.data, w, h, o, gain, colormapLut(args.colormap));
      res.output = await save({ width: w, height: h, data: o.value }, vfs.out(args.output, args.a, 'diff', 'png')); res.gain = r2(gain, 3);
    } else if (wantSsimMap) res.output = await save({ width: w, height: h, data: sm.value }, vfs.out(args.output, args.a, 'ssim', 'png'));
    return res;
  },
});

// ─────────────────────────────────────────────────────────────── hashes ──
const hexOf = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hamming = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { let x = a[i] ^ b[i]; while (x) { d += x & 1; x >>= 1; } } return d; };
async function hashesOf(path) {
  const img = await open(path); const K = await kernel(); const o = out(Uint8Array, 24);
  K.call('hashes', img.data, img.width, img.height, o);
  return { a: o.value.subarray(0, 8), d: o.value.subarray(8, 16), p: o.value.subarray(16, 24) };
}
register({
  name: 'analysis.phash', readOnly: true,
  description: 'Perceptual fingerprints of an image, 64 bits each as 16 hex digits: aHash (8×8 average), dHash (9×8 horizontal gradient) and pHash (32×32 DCT, low 8×8 frequencies vs. their median). Unlike cryptographic hashes they change little under resizing, recompression and small edits. Give `compare` to also get the Hamming distance (0–64 differing bits) between the two images for each hash and a verdict (pHash distance ≤ 5 near-duplicate, ≤ 12 similar, else different — rules of thumb). Use for duplicate detection and "is this the same picture?" questions. The bit layout is this tool\'s own (row-major, MSB first); hashes are comparable with each other, not with other libraries.',
  schema: { properties: { input: IN, compare: { type: 'string', description: 'VFS path of a second image to measure the distance to' } }, required: ['input'] },
  examples: ['analysis.phash input=a.jpg compare=b.jpg'],
  async run({ input, compare }) {
    const h = await hashesOf(input);
    const res = { ahash: hexOf(h.a), dhash: hexOf(h.d), phash: hexOf(h.p), backend: 'wasm' };
    if (compare) {
      const g = await hashesOf(compare);
      res.other = { ahash: hexOf(g.a), dhash: hexOf(g.d), phash: hexOf(g.p) };
      res.distance = { ahash: hamming(h.a, g.a), dhash: hamming(h.d, g.d), phash: hamming(h.p, g.p) };
      res.similarity = r2(1 - res.distance.phash / 64, 4);
      res.verdict = res.distance.phash <= 5 && res.distance.dhash <= 10 ? 'near-duplicate' : res.distance.phash <= 12 ? 'similar' : 'different';
    }
    return res;
  },
});

// ───────────────────────────────────────────────────────────────── fft ──
register({
  name: 'analysis.fft',
  description: 'Two-dimensional Fourier spectrum of an image\'s luma, written as a PNG of log-magnitude with the zero frequency in the centre. The transform is exact for any width and height — no padding or cropping: power-of-two sides use radix-2 FFT, all other sides use Bluestein\'s chirp-z algorithm (the result says which). Bright spots away from the centre reveal periodic structure (halftone screens, moiré, sensor banding, JPEG 8-px blocking, repeating textures); the tool lists the most prominent spectral peaks with their frequency (cycles/pixel), period in pixels and orientation, and reports how much energy lies at high frequencies (low = blurry or upscaled). Images larger than `maxSide` are downscaled first (reported; periods are given in original pixels).',
  schema: {
    properties: {
      input: IN,
      maxSide: { type: 'integer', default: 1024, minimum: 16, maximum: 2048, description: 'Analyse at this longer-side size at most (memory: two f64 planes of that size)' },
      window: { type: 'boolean', default: true, description: 'Apply a Hann window first (removes the bright cross caused by the image borders; slightly widens peaks)' },
      peaks: { type: 'integer', default: 8, minimum: 0, maximum: 32, description: 'How many spectral peaks to report' },
      output: OUTP('the spectrum image'),
    },
    required: ['input'],
  },
  examples: ['analysis.fft input=scan.png', 'analysis.fft input=texture.png window=false peaks=4'],
  async run(args) {
    let img = await open(args.input); const K = await kernel(); const src = { width: img.width, height: img.height }; let scale = 1;
    if (Math.max(img.width, img.height) > args.maxSide) { scale = Math.max(img.width, img.height) / args.maxSide; img = K.imgTo('resize', img, Math.max(1, Math.round(img.width / scale)), Math.max(1, Math.round(img.height / scale)), 2); }
    const { width: w, height: h } = img;
    const o = out(Uint8ClampedArray, w * h * 4), pk = out(Float32Array, Math.max(1, args.peaks) * 4), info = out(Float64Array, 4);
    const n = K.call('fft2', img.data, w, h, o, args.window, pk, args.peaks, info);
    const pow2 = (x) => (x & (x - 1)) === 0;
    const peaks = [];
    for (let i = 0; i < n; i++) {
      const fx = pk.value[i * 4], fy = pk.value[i * 4 + 1]; const f = Math.hypot(fx, fy);
      peaks.push({ fx: r2(fx, 5), fy: r2(fy, 5), frequency: r2(f, 5), periodPx: r2(scale / f, 2), angleDeg: r2(Math.atan2(fy, fx) * 180 / Math.PI, 1), magnitude: r2(pk.value[i * 4 + 2], 5), prominence: r2(pk.value[i * 4 + 3], 1) });
    }
    const output = await save({ width: w, height: h, data: o.value }, vfs.out(args.output, args.input, 'fft', 'png'));
    return {
      output, analysedAt: { width: w, height: h }, source: src, downscale: r2(scale, 4),
      algorithm: { x: pow2(w) ? 'radix-2' : 'bluestein', y: pow2(h) ? 'radix-2' : 'bluestein', padding: 'none' }, window: args.window ? 'hann' : 'none',
      meanLuma: r2(info.value[0]), highFrequencyEnergy: r2(info.value[1], 6), midHighFrequencyEnergy: r2(info.value[2], 6),
      peaks, periodic: peaks.some((p) => p.prominence > 20 && p.magnitude > 0.005),
      note: 'peaks: frequency in cycles per analysed pixel; periodPx in original pixels; angleDeg is the direction of the wave vector (0 = pattern repeats horizontally, 90 = vertically); prominence = magnitude relative to the average at that radius (> 20 means a clear periodic component).',
      backend: 'wasm',
    };
  },
});

// ───────────────────────────────────────────────────────────────── ela ──
register({
  name: 'analysis.ela',
  description: 'Error Level Analysis for tamper screening: the image is re-saved as JPEG at a known quality and the per-pixel difference from the original is amplified and written as a PNG. In an untouched JPEG the error level is fairly uniform for similar textures; regions pasted in or edited after the last save often stand out brighter (or darker). It is a hint, not proof: sharp edges and fine texture are always brighter, and PNG/lossless sources or heavily recompressed images are not informative. Returns the mean and maximum error and the grid cells with the highest error (as rectangles) so you can look closer.',
  schema: {
    properties: {
      input: IN,
      quality: { type: 'number', default: 90, minimum: 1, maximum: 100, description: 'JPEG quality of the re-save, in percent (90–95 is customary)' },
      scale: { type: 'number', default: 0, minimum: 0, maximum: 255, description: 'Amplification of the difference; 0 = automatic (so the largest error is full scale)' },
      output: OUTP('the error-level image'),
    },
    required: ['input'],
  },
  examples: ['analysis.ela input=photo.jpg quality=90'],
  async run(args) {
    const img = await open(args.input); const K = await kernel(); const { width: w, height: h } = img;
    const { bytes } = await encode(img, { format: 'jpeg', quality: args.quality / 100 });
    const re = await decode(bytes);
    if (re.width !== w || re.height !== h) throw new Error('re-encoded image changed size (unexpected)');
    const G = 8; const st = out(Float64Array, 2), grid = out(Float32Array, G * G);
    // first pass to learn the maximum when scale is automatic
    let scale = args.scale; let o = out(Uint8ClampedArray, w * h * 4);
    K.call('ela_diff', img.data, re.data, w, h, o, scale || 1, st, grid, G, G);
    if (!scale) { scale = st.value[1] > 0 ? 255 / st.value[1] : 1; o = out(Uint8ClampedArray, w * h * 4); K.call('ela_diff', img.data, re.data, w, h, o, scale, st, grid, G, G); }
    const cells = [...grid.value].map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
    const mean = st.value[0]; const gm = [...grid.value]; const gmean = gm.reduce((a, v) => a + v, 0) / gm.length; const gstd = Math.sqrt(gm.reduce((a, v) => a + (v - gmean) ** 2, 0) / gm.length);
    const hot = cells.slice(0, 3).map(({ v, i }) => { const gx = i % G, gy = Math.floor(i / G); const x0 = Math.floor(gx * w / G), y0 = Math.floor(gy * h / G); return { x: x0, y: y0, width: Math.floor((gx + 1) * w / G) - x0, height: Math.floor((gy + 1) * h / G) - y0, meanError: r2(v, 3), zScore: gstd > 0 ? r2((v - gmean) / gstd, 2) : 0 }; });
    const output = await save({ width: w, height: h, data: o.value }, vfs.out(args.output, args.input, 'ela', 'png'));
    const srcFmt = /\.jpe?g$/i.test(args.input) || (vfs.read(args.input)[0] === 0xff && vfs.read(args.input)[1] === 0xd8) ? 'jpeg' : 'non-jpeg';
    return { output, quality: args.quality, scale: r2(scale, 2), meanError: r2(mean, 4), maxError: st.value[1], gridUniformity: gmean > 0 ? r2(gstd / gmean, 3) : 0, hottestCells: hot, sourceIsJpeg: srcFmt === 'jpeg', note: srcFmt === 'jpeg' ? 'look for regions whose error level differs from similar-textured surroundings; zScore > 3 on a smooth region deserves a closer look' : 'the source is not a JPEG, so error levels mostly reflect image detail, not editing history', backend: 'wasm' };
  },
});

// ────────────────────────────────────────────────────────── components ──
register({
  name: 'analysis.components',
  description: 'Count and measure the separate objects in an image. The image is binarised (Otsu by default, or a fixed luma threshold; set dark=true when the objects are darker than the background), connected regions are labelled (8- or 4-connectivity, two-pass union-find), and for each region you get its area in pixels, bounding box, centroid and extent (area ÷ bounding-box area). Writes a label map PNG with every component in its own colour. Use to count cells, coins, particles, stars, glyphs; to find the largest object; or to locate blobs for cropping. Clean the mask first with image.morph op=open if noise inflates the count, or raise minArea. The 50 largest components are listed.',
  schema: {
    properties: {
      input: IN,
      threshold: { type: 'number', minimum: 0, maximum: 255, description: 'Luma threshold; omit for Otsu\'s automatic choice' },
      dark: { type: 'boolean', default: false, description: 'Objects are darker than the background (foreground = luma below the threshold)' },
      connectivity: { type: 'integer', enum: [4, 8], default: 8, description: '8 joins diagonal neighbours, 4 does not' },
      minArea: { type: 'integer', default: 1, minimum: 1, description: 'Ignore components smaller than this many pixels (they are drawn dark gray in the label map)' },
      output: OUTP('the label map'),
    },
    required: ['input'],
  },
  examples: ['analysis.components input=cells.png minArea=20', 'analysis.components input=text.png dark=true'],
  async run(args) {
    const img = await open(args.input); const K = await kernel(); const { width: w, height: h } = img; const n = w * h;
    const t = args.threshold ?? K.call('otsu', img.data, w, h);
    const p = K.alloc(n * 4); let found, st, o;
    try {
      found = K.call('cc_label', img.data, w, h, p, t, args.dark, args.connectivity);
      st = out(Float64Array, found * 7); K.call('cc_stats', p, w, h, found, st);
      const keep = new Uint8Array(found + 1);
      for (let i = 0; i < found; i++) keep[i + 1] = st.value[i * 7] >= args.minArea ? 1 : 0;
      o = out(Uint8ClampedArray, n * 4); K.call('cc_render', p, w, h, o, keep);
    } finally { K.x.k_free(p, n * 4); }
    const comps = []; let fg = 0;
    for (let i = 0; i < found; i++) {
      const s = st.value.subarray(i * 7, i * 7 + 7); fg += s[0];
      if (s[0] < args.minArea) continue;
      const bw = s[3] - s[1] + 1, bh = s[4] - s[2] + 1;
      comps.push({ id: i + 1, area: s[0], bbox: { x: s[1], y: s[2], width: bw, height: bh }, centroid: { x: r2(s[5] / s[0]), y: r2(s[6] / s[0]) }, extent: r2(s[0] / (bw * bh), 3) });
    }
    comps.sort((a, b) => b.area - a.area);
    const areas = comps.map((c) => c.area);
    const output = await save({ width: w, height: h, data: o.value }, vfs.out(args.output, args.input, 'labels', 'png'));
    return {
      output, count: comps.length, rejectedSmall: found - comps.length, threshold: t, thresholdMethod: args.threshold === undefined ? 'otsu' : 'fixed', foreground: args.dark ? 'dark' : 'bright', connectivity: args.connectivity,
      foregroundFraction: r2(fg / n, 5), totalArea: areas.reduce((a, v) => a + v, 0), meanArea: areas.length ? r2(areas.reduce((a, v) => a + v, 0) / areas.length) : 0, medianArea: areas.length ? areas[areas.length >> 1] : 0,
      components: comps.slice(0, 50), truncated: comps.length > 50, width: w, height: h, backend: 'wasm',
    };
  },
});

// ──────────────────────────────────────────────────── corners & lines ──
async function analysisSize(path, maxSide) {
  let img = await open(path); const K = await kernel(); const src = img; let scale = 1;
  if (maxSide && Math.max(img.width, img.height) > maxSide) { scale = Math.max(img.width, img.height) / maxSide; img = K.imgTo('resize', img, Math.max(1, Math.round(img.width / scale)), Math.max(1, Math.round(img.height / scale)), 2); }
  return { img, src, scale, K };
}

register({
  name: 'analysis.corners',
  description: 'Detect corner points — places where the image changes strongly in two directions (junctions, tips, checkerboard crossings). method=shi-tomasi ("good features to track": smaller eigenvalue of the structure tensor, default) or harris (det − k·trace²). Returns the strongest corners with coordinates (in original pixels) and response, and writes an overlay PNG with the corners marked. Use for feature points to align or track images, to find the corners of a document or chart, or as a texture/detail measure. Images larger than maxSide are analysed downscaled.',
  schema: {
    properties: {
      input: IN,
      method: { type: 'string', enum: ['shi-tomasi', 'harris'], default: 'shi-tomasi', description: 'Corner response' },
      max: { type: 'integer', default: 100, minimum: 1, maximum: 5000, description: 'Maximum number of corners to detect (the JSON lists at most 100; all are drawn)' },
      quality: { type: 'number', default: 0.02, minimum: 0.0001, maximum: 1, description: 'Minimum response as a fraction of the strongest corner' },
      minDistance: { type: 'integer', default: 10, minimum: 1, maximum: 1000, description: 'Minimum spacing between corners in (analysed) pixels' },
      sigma: { type: 'number', default: 1.5, minimum: 0.5, maximum: 10, description: 'Gaussian integration scale of the structure tensor' },
      k: { type: 'number', default: 0.04, minimum: 0.01, maximum: 0.3, description: 'Harris constant (harris only)' },
      maxSide: { type: 'integer', default: 1600, minimum: 64, maximum: 4096, description: 'Analyse at this longer-side size at most' },
      output: OUTP('the overlay'),
    },
    required: ['input'],
  },
  examples: ['analysis.corners input=board.png max=50'],
  async run(args) {
    const { img, src, scale, K } = await analysisSize(args.input, args.maxSide);
    const o = out(Float32Array, args.max * 3);
    const n = K.call('corners', img.data, img.width, img.height, args.method === 'harris' ? 0 : 1, args.sigma, args.k, args.quality, args.minDistance, args.max, o);
    const pts = []; for (let i = 0; i < n; i++) pts.push({ x: r2((o.value[i * 3] + 0.5) * scale - 0.5, 1), y: r2((o.value[i * 3 + 1] + 0.5) * scale - 0.5, 1), response: r2(o.value[i * 3 + 2], 2) });
    const c = toCanvas(src); const g = c.getContext('2d'); const rad = Math.max(3, Math.round(Math.max(src.width, src.height) / 250));
    g.lineWidth = Math.max(1.5, rad / 2.5);
    for (const p of pts) { g.strokeStyle = '#000000'; g.beginPath(); g.arc(p.x + 0.5, p.y + 0.5, rad + 1, 0, 7); g.stroke(); g.strokeStyle = '#00ff66'; g.beginPath(); g.arc(p.x + 0.5, p.y + 0.5, rad, 0, 7); g.stroke(); }
    const output = await saveCanvas(c, vfs.out(args.output, args.input, 'corners', 'png'));
    return { output, count: n, method: args.method, corners: pts.slice(0, 100), truncated: n > 100, analysedAt: { width: img.width, height: img.height }, downscale: r2(scale, 4), backend: 'wasm' };
  },
});

register({
  name: 'analysis.lines',
  description: 'Find straight lines with the Hough transform: Canny edges vote in (rho, theta) space (theta resolution 180/thetaSteps degrees, rho resolution 1 px) and local maxima of the vote count are lines. For each line you get rho/theta, the vote count, its direction angle (0° = horizontal, 90° = vertical, measured clockwise in image coordinates), and the endpoints and length of the longest stretch of edge pixels actually lying on it (in original pixels). Writes an overlay PNG with the segments drawn. Use to measure skew of a scanned page (take the dominant angle), find horizon/table/axis lines, or detect grid structure. Images larger than maxSide are analysed downscaled.',
  schema: {
    properties: {
      input: IN,
      max: { type: 'integer', default: 20, minimum: 1, maximum: 200, description: 'Maximum number of lines' },
      minVotes: { type: 'number', default: 0, minimum: 0, description: 'Minimum votes (edge pixels on the line); 0 = 30 % of the strongest line' },
      thetaSteps: { type: 'integer', default: 360, minimum: 45, maximum: 1440, description: 'Angular bins over 180° (360 → 0.5° resolution)' },
      sigma: { type: 'number', default: 1.4, minimum: 0, maximum: 10, description: 'Canny gaussian pre-blur' },
      low: { type: 'number', minimum: 0, maximum: 360, description: 'Canny low threshold (default automatic)' },
      high: { type: 'number', minimum: 0, maximum: 360, description: 'Canny high threshold (default automatic)' },
      maxGap: { type: 'integer', default: 5, minimum: 0, maximum: 200, description: 'Largest gap in pixels bridged when measuring the supported segment' },
      maxSide: { type: 'integer', default: 1200, minimum: 64, maximum: 4096, description: 'Analyse at this longer-side size at most' },
      output: OUTP('the overlay'),
    },
    required: ['input'],
  },
  examples: ['analysis.lines input=scan.png max=10'],
  async run(args) {
    const { img, src, scale, K } = await analysisSize(args.input, args.maxSide);
    const o = out(Float32Array, args.max * 7), info = out(Float32Array, 4);
    const ts = args.thetaSteps;
    const n = K.call('hough', img.data, img.width, img.height, args.sigma, args.low ?? -1, args.high ?? -1, ts, args.minVotes, 4, Math.max(2, Math.round(ts / 45)), args.maxGap, args.max, o, null, info);
    const lines = [];
    for (let i = 0; i < n; i++) {
      const v = o.value.subarray(i * 7, i * 7 + 7); const sc = (q) => r2((q + 0.5) * scale - 0.5, 1);
      const [x1, y1, x2, y2] = [sc(v[3]), sc(v[4]), sc(v[5]), sc(v[6])];
      let ang = v[1] * 180 / Math.PI + 90; if (ang >= 180) ang -= 180; // line direction is perpendicular to the normal angle theta
      lines.push({ angleDeg: r2(ang, 2), votes: v[2], rho: r2(v[0] * scale, 1), thetaDeg: r2(v[1] * 180 / Math.PI, 2), x1, y1, x2, y2, length: r2(Math.hypot(x2 - x1, y2 - y1), 1) });
    }
    const c = toCanvas(src); const g = c.getContext('2d'); const lw = Math.max(2, Math.round(Math.max(src.width, src.height) / 400)); g.lineCap = 'round';
    lines.forEach((l, i) => { g.strokeStyle = '#000000'; g.lineWidth = lw + 2; g.beginPath(); g.moveTo(l.x1 + 0.5, l.y1 + 0.5); g.lineTo(l.x2 + 0.5, l.y2 + 0.5); g.stroke(); g.strokeStyle = `hsl(${(i * 47) % 360} 100% 55%)`; g.lineWidth = lw; g.stroke(); });
    const output = await saveCanvas(c, vfs.out(args.output, args.input, 'lines', 'png'));
    // dominant orientation: vote-weighted circular mean over 180°
    let sx = 0, sy = 0; for (const l of lines) { const a = l.angleDeg * Math.PI / 90; sx += l.votes * Math.cos(a); sy += l.votes * Math.sin(a); }
    let dom = lines.length ? Math.atan2(sy, sx) * 90 / Math.PI : null; if (dom !== null && dom < 0) dom += 180;
    return { output, count: n, lines, dominantAngleDeg: dom === null ? null : r2(dom, 2), canny: { low: r2(info.value[0]), high: r2(info.value[1]), edgePixels: info.value[2] }, strongestVotes: info.value[3], analysedAt: { width: img.width, height: img.height }, downscale: r2(scale, 4), backend: 'wasm' };
  },
});

// ───────────────────────────────────────────────── bit planes and LSB ──
const CHMASK = (s) => { const t = String(s).toLowerCase(); if (!/^[rgba]{1,4}$/.test(t) || new Set(t).size !== t.length) throw new Error(`channels must be a combination of r, g, b, a without repeats (got "${s}")`); return [...t].reduce((m, c) => m | (1 << 'rgba'.indexOf(c)), 0); };
const lsbCapacity = (img, mask, bits) => Math.floor(img.width * img.height * [...Array(4)].filter((_, i) => mask & (1 << i)).length * bits / 8);

register({
  name: 'analysis.bitplane',
  description: 'Show one bit plane of an image: every pixel becomes white if the chosen bit (0 = least significant … 7 = most significant) of the chosen channel is set, black otherwise (channel=rgb keeps the three channels\' bits in their own colours). In a natural image the low planes look like uniform noise; visible shapes, text, or a sharp boundary between "noisy" and "flat" areas in plane 0 indicate hidden data or synthetic editing (steganography inspection). With sheet=true all eight planes are written as one contact sheet (bit 7 top-left … bit 0 bottom-right). Also returns, per channel, the share of set LSBs and a pairs-of-values chi-square statistic (sequential LSB embedding pushes the share to 0.5 and chi-square per degree of freedom well below 1). PNGs with transparency are decoded bit-exactly.',
  schema: {
    properties: {
      input: IN,
      bit: { type: 'integer', default: 0, minimum: 0, maximum: 7, description: 'Bit index, 0 = LSB' },
      channel: { type: 'string', enum: ['r', 'g', 'b', 'a', 'rgb'], default: 'rgb', description: 'Channel to view' },
      sheet: { type: 'boolean', default: false, description: 'Write all 8 planes of the channel as a 4×2 contact sheet instead of a single plane' },
      output: OUTP('the bit-plane image'),
    },
    required: ['input'],
  },
  examples: ['analysis.bitplane input=suspect.png', 'analysis.bitplane input=suspect.png channel=b sheet=true'],
  async run(args) {
    const { img, exact } = await decodeExact(args.input); const K = await kernel(); const { width: w, height: h } = img;
    const code = { r: 0, g: 1, b: 2, a: 3, rgb: 4 }[args.channel];
    const st = out(Float64Array, 12); K.call('lsb_stats', img.data, w, h, st);
    const lsb = {}; ['r', 'g', 'b', 'a'].forEach((c, i) => { lsb[c] = { onesFraction: r2(st.value[4 + i], 4), chiSquare: r2(st.value[i], 1), chiSquarePerDf: st.value[8 + i] > 0 ? r2(st.value[i] / st.value[8 + i], 3) : null }; });
    let output;
    if (args.sheet) {
      const cols = 4, rows = 2, k = Math.min(1, 512 / Math.max(w, h)); const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k)), gap = 6;
      const W = cols * tw + (cols + 1) * gap, H = rows * th + (rows + 1) * gap; const n = W * H * 4; const p = K.alloc(n);
      try {
        K.call('fill', p, W, H, 40, 40, 48, 255);
        for (let i = 0; i < 8; i++) { let pl = K.img('bitplane', img, 7 - i, code); if (k < 1) pl = K.imgTo('resize', pl, tw, th, 0); K.call('blit', pl.data, tw, th, p, W, H, gap + (i % cols) * (tw + gap), gap + Math.floor(i / cols) * (th + gap), 0); }
        output = await save({ width: W, height: H, data: new Uint8ClampedArray(K.x.memory.buffer.slice(p, p + n)) }, vfs.out(args.output, args.input, `bits-${args.channel}`, 'png'));
      } finally { K.x.k_free(p, n); }
    } else output = await save(K.img('bitplane', img, args.bit, code), vfs.out(args.output, args.input, `bit${args.bit}-${args.channel}`, 'png'));
    return { output, bit: args.sheet ? 'all (7…0, row-major)' : args.bit, channel: args.channel, lsb, exactDecode: exact, note: 'onesFraction ≈ 0.5 together with chiSquarePerDf ≪ 1 over a whole channel suggests sequential LSB embedding; natural images usually give chiSquarePerDf ≫ 1.', backend: 'wasm' };
  },
});

const FRAMING = { type: 'string', enum: ['length', 'nul', 'raw'], default: 'length', description: 'How the message end is marked: length = 4-byte big-endian byte count before the data (this tool\'s default); nul = data ends at the first 0x00 byte (common in CTF tools); raw = no marker (extract reads maxBytes)' };
const CHANNELS = { type: 'string', default: 'rgb', description: 'Channels carrying data, in R,G,B,A order: any of r g b a, e.g. "rgb", "b", "rgba"' };
const BITS = { type: 'integer', default: 1, minimum: 1, maximum: 4, description: 'Low bits used per channel value (1 = classic LSB)' };

register({
  name: 'analysis.lsbEmbed',
  description: 'Hide a message in the least significant bits of an image (LSB steganography). Bits are written pixel by pixel in raster order, channels in R,G,B,A order, message bits most-significant first; by default a 4-byte big-endian length precedes the data. The output is always a lossless PNG (any lossy re-save destroys the message) and visually identical to the input (each used channel value changes by at most 2^bits − 1). The tool reads the result back and confirms the round trip. Capacity = pixels × channels × bits ÷ 8 bytes. Use analysis.lsbExtract with the same channels/bits/framing to recover it. This is concealment, not encryption.',
  schema: {
    properties: {
      input: IN,
      message: { type: 'string', description: 'UTF-8 text to hide' },
      messageFile: { type: 'string', description: 'VFS path of a file whose bytes to hide instead of `message`' },
      channels: CHANNELS, bits: BITS, framing: FRAMING,
      output: { type: 'string', description: 'VFS path to write; must end in .png (default: <name>.stego.png)' },
    },
    required: ['input'],
  },
  examples: ['analysis.lsbEmbed input=cover.png message="meet at dawn"'],
  async run(args) {
    if ((args.message === undefined) === (args.messageFile === undefined)) throw new Error('give exactly one of: message, messageFile');
    const path = vfs.out(args.output, args.input, 'stego', 'png');
    if (vfs.extOf(path) !== 'png') throw new Error('output must be a .png — LSB data does not survive lossy formats');
    const payload = args.message !== undefined ? new TextEncoder().encode(args.message) : vfs.read(args.messageFile);
    const mask = CHMASK(args.channels);
    let data;
    if (args.framing === 'length') { data = new Uint8Array(payload.length + 4); new DataView(data.buffer).setUint32(0, payload.length); data.set(payload, 4); }
    else if (args.framing === 'nul') { if (payload.includes(0)) throw new Error('framing=nul cannot carry a message that contains a 0x00 byte; use framing=length'); data = new Uint8Array(payload.length + 1); data.set(payload); }
    else data = payload;
    if (!data.length) throw new Error('the message is empty');
    const { img } = await decodeExact(args.input); const K = await kernel(); const { width: w, height: h } = img;
    const cap = lsbCapacity(img, mask, args.bits);
    if (data.length > cap) throw new Error(`message needs ${data.length} bytes but this image holds ${cap} with channels=${args.channels} bits=${args.bits} — use a larger image, more channels or more bits`);
    const buf = io(img.data);
    if (!K.call('lsb_embed', buf, w, h, data, data.length, mask, args.bits)) throw new Error('embedding failed (capacity)');
    const res = { width: w, height: h, data: buf.value };
    const alpha = out(Uint32Array, 5); K.call('alpha_info', res.data, w, h, alpha);
    // the canvas PNG encoder is exact only for opaque images; otherwise write the PNG ourselves
    const check = async () => { const back = (await decodeExact(path)).img; const o = out(Uint8Array, data.length); K.call('lsb_extract', back.data, w, h, o, data.length, mask, args.bits); return o.value.every((v, i) => v === data[i]); };
    let encoder = 'canvas', stat, ok = false;
    if (alpha.value[2] === 0 && !(mask & 8)) { stat = await save(res, path); ok = await check(); }
    if (!ok) { encoder = 'exact'; stat = await vfs.write(path, await encodePngExact(res), { mime: 'image/png', meta: { width: w, height: h } }); ok = await check(); }
    if (!ok) throw new Error('round-trip verification failed: the written PNG does not return the embedded bits');
    return { output: stat, payloadBytes: payload.length, embeddedBytes: data.length, capacityBytes: cap, usedFraction: r2(data.length / cap, 5), channels: args.channels.toLowerCase(), bits: args.bits, framing: args.framing, verified: true, pngEncoder: encoder, backend: 'wasm' };
  },
});

register({
  name: 'analysis.lsbExtract',
  description: 'Recover data hidden in the least significant bits of an image (the inverse of analysis.lsbEmbed; also reads the common "sequential RGB LSB, MSB-first" layout of other tools with framing=nul or raw). Returns the message as text when it is valid UTF-8 (first 2000 characters), its byte length and the share of printable characters, and can write the raw bytes to a file. If framing=length finds an impossible length the image probably holds no message in that layout — try other channels/bits, or framing=raw to inspect the first bytes. PNGs with transparency are decoded bit-exactly.',
  schema: {
    properties: {
      input: IN, channels: CHANNELS, bits: BITS, framing: FRAMING,
      maxBytes: { type: 'integer', default: 4096, minimum: 1, maximum: 16777216, description: 'Upper bound on bytes to read (the amount read for framing=raw; a cap for nul)' },
      output: { type: 'string', description: 'Optional VFS path to write the extracted bytes to' },
    },
    required: ['input'],
  },
  examples: ['analysis.lsbExtract input=cover.stego.png', 'analysis.lsbExtract input=ctf.png framing=nul channels=rgb'],
  async run(args) {
    const { img, exact } = await decodeExact(args.input); const K = await kernel(); const { width: w, height: h } = img;
    const mask = CHMASK(args.channels); const cap = lsbCapacity(img, mask, args.bits);
    const read = (n) => { const o = out(Uint8Array, n); const got = K.call('lsb_extract', img.data, w, h, o, n, mask, args.bits); return o.value.subarray(0, got); };
    let payload;
    if (args.framing === 'length') {
      const head = read(4); const len = head.length === 4 ? new DataView(head.buffer, head.byteOffset, 4).getUint32(0) : 0;
      if (head.length < 4 || len === 0 || len > cap - 4) throw new Error(`no length-framed message found with channels=${args.channels} bits=${args.bits} (header says ${len} bytes, capacity is ${Math.max(0, cap - 4)}) — try other channels/bits, or framing=nul / framing=raw`);
      payload = read(4 + len).subarray(4);
    } else if (args.framing === 'nul') {
      const all = read(Math.min(cap, args.maxBytes)); const z = all.indexOf(0);
      if (z < 0) throw new Error(`no 0x00 terminator within the first ${all.length} bytes — raise maxBytes, or use framing=raw to inspect the data`);
      payload = all.subarray(0, z);
    } else payload = read(Math.min(cap, args.maxBytes));
    let text = null; try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); } catch { /* binary */ }
    let printable = 0; for (const b of payload) if ((b >= 32 && b < 127) || b === 10 || b === 13 || b === 9 || b >= 0x80) printable++;
    const res = { bytes: payload.length, isText: text !== null, printableFraction: payload.length ? r2(printable / payload.length, 4) : 0, capacityBytes: cap, channels: args.channels.toLowerCase(), bits: args.bits, framing: args.framing, exactDecode: exact, backend: 'wasm' };
    if (text !== null) { res.text = text.slice(0, 2000); res.truncated = text.length > 2000; } else res.hexPreview = hexOf(payload.subarray(0, 64));
    if (args.output) res.output = await vfs.write(args.output, payload.slice());
    return res;
  },
});

// ─────────────────────────────────────────────────────────────── probe ──
register({
  name: 'analysis.pixel', readOnly: true,
  description: 'Read the colour at a point, or the average colour of a rectangle: RGBA mean, hex, luma, and (for a rectangle) the per-channel min/max and standard deviation. Coordinates are pixels from the top-left corner. Use to verify a rendering ("is the button really #1a73e8?"), sample a background colour, or check whether a region is uniform.',
  schema: {
    properties: {
      input: IN,
      x: { type: 'integer', minimum: 0, description: 'Left / point x' }, y: { type: 'integer', minimum: 0, description: 'Top / point y' },
      width: { type: 'integer', default: 1, minimum: 1, description: 'Rectangle width (1 = single pixel)' }, height: { type: 'integer', default: 1, minimum: 1, description: 'Rectangle height' },
    },
    required: ['input', 'x', 'y'],
  },
  examples: ['analysis.pixel input=ui.png x=120 y=48', 'analysis.pixel input=ui.png x=0 y=0 width=32 height=32'],
  async run(args) {
    const img = await open(args.input);
    if (args.x >= img.width || args.y >= img.height) throw new Error(`point (${args.x}, ${args.y}) is outside the ${img.width}×${img.height} image`);
    const w = Math.min(args.width, img.width - args.x), h = Math.min(args.height, img.height - args.y);
    const K = await kernel(); const c = out(Uint8ClampedArray, w * h * 4); K.call('crop', img.data, img.width, img.height, c, args.x, args.y, w, h);
    const s = out(Float64Array, 32); K.call('stats', c.value, w, h, s); const v = s.value;
    const res = { rect: { x: args.x, y: args.y, width: w, height: h }, rgba: [r2(v[0]), r2(v[5]), r2(v[10]), r2(v[15])], hex: hex(v[0], v[5], v[10]), luma: r2(v[20]) };
    if (w * h > 1) { res.min = [v[2], v[7], v[12], v[17]]; res.max = [v[3], v[8], v[13], v[18]]; res.std = [r2(v[1]), r2(v[6]), r2(v[11]), r2(v[16])]; res.uniform = Math.max(v[1], v[6], v[11]) < 1.5; }
    return res;
  },
});

export { MAX_PIXELS };
