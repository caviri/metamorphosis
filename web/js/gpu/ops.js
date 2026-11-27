// μεταμόρφωσις :: gpu/ops — the contract of the accelerated image kernels: parameters, defaults, validation.
// Shared by the WebGPU kernels (tools/gpu.js) and the plain-JS reference (gpu/reference.js) so both read params identically.
//
// Common semantics: img = {width, height, data RGBA8}; bytes are plain linear values (no sRGB anywhere); edges clamp;
// alpha is copied from the source pixel unless the op says otherwise; a result byte is floor(clamp(v, 0, 255) + 0.5).

const num = (v, name, lo, hi, def) => {
  if (v === undefined || v === null) { if (def === undefined) throw new Error(`param "${name}" is required`); v = def; }
  v = Number(v);
  if (!Number.isFinite(v)) throw new Error(`param "${name}" must be a number`);
  if (v < lo || v > hi) throw new Error(`param "${name}" must be in ${lo}..${hi} (got ${v})`);
  return v;
};
const int = (v, name, lo, hi, def) => {
  const n = num(v, name, lo, hi, def);
  if (!Number.isInteger(n)) throw new Error(`param "${name}" must be an integer (got ${n})`);
  return n;
};
const oneOf = (v, name, list, def) => { v = v ?? def; if (!list.includes(v)) throw new Error(`param "${name}" must be one of: ${list.join(' | ')} (got ${JSON.stringify(v)})`); return v; };
const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
const nums = (v, name, n) => {
  if (typeof v === 'string') v = v.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!Array.isArray(v) && !ArrayBuffer.isView(v)) throw new Error(`param "${name}" must be an array of ${n} numbers`);
  const a = Array.from(v, Number);
  if (a.length !== n || a.some((x) => !Number.isFinite(x))) throw new Error(`param "${name}" must be ${n} finite numbers (got ${a.length})`);
  return a;
};

export const OPS = {
  gaussian: {
    doc: '{sigma} — separable Gaussian blur of R,G,B; radius = ceil(3·sigma), weights normalised; the two passes are joined in floating point (no rounding in between).',
    example: { sigma: 2 },
    norm: (p) => ({ sigma: num(p.sigma, 'sigma', 0.05, 100) }),
    taps: (p) => 2 * Math.ceil(3 * p.sigma) + 1,
  },
  convolve: {
    doc: '{kernel:number[size·size] row-major, size (odd, ≤25; default sqrt(kernel.length)), divisor=1, bias=0 (0..255 units)} — correlation (kernel not flipped): out = Σ k[j·size+i]·in(x+i−h, y+j−h) / divisor + bias on R,G,B.',
    example: { kernel: [0, -1, 0, -1, 5, -1, 0, -1, 0], size: 3 },
    norm(p) {
      if (p.kernel === undefined) throw new Error('param "kernel" is required (size·size numbers, row-major)');
      const len = typeof p.kernel === 'string' ? p.kernel.split(/[\s,]+/).filter(Boolean).length : p.kernel.length;
      const size = int(p.size, 'size', 1, 25, Math.round(Math.sqrt(len)));
      if (size % 2 !== 1) throw new Error(`param "size" must be odd (got ${size})`);
      const kernel = nums(p.kernel, 'kernel', size * size);
      const divisor = num(p.divisor, 'divisor', -1e9, 1e9, 1);
      if (divisor === 0) throw new Error('param "divisor" must not be 0');
      return { kernel, size, divisor, bias: num(p.bias, 'bias', -255, 255, 0) };
    },
    taps: (p) => p.size * p.size,
  },
  sobel: {
    doc: '{} — Sobel gradient magnitude of Rec.709 luma (unrounded): sqrt(gx²+gy²) clamped to 255, written to R=G=B, alpha 255.',
    example: {}, norm: () => ({}), taps: () => 9,
  },
  grayscale: {
    doc: '{} — Rec.709 luma 0.2126R+0.7152G+0.0722B, rounded, written to R=G=B (computed exactly as (2126R+7152G+722B+5000) div 10000).',
    example: {}, norm: () => ({}), taps: () => 1,
  },
  invert: { doc: '{} — 255−v on R,G,B.', example: {}, norm: () => ({}), taps: () => 1 },
  threshold: {
    doc: '{t:0..255} — Rec.709 luma ≥ t → white, else black; alpha 255 (compared exactly as 2126R+7152G+722B ≥ 10000·t).',
    example: { t: 128 },
    norm: (p) => ({ t: num(p.t, 't', 0, 255, 128) }), taps: () => 1,
  },
  colorMatrix: {
    doc: '{matrix:number[20]} — 4×5 row-major like SVG feColorMatrix on straight 0..1 RGBA; column 5 is an offset in 0..1; alpha is computed by row 4.',
    example: { matrix: [0.393, 0.769, 0.189, 0, 0, 0.349, 0.686, 0.168, 0, 0, 0.272, 0.534, 0.131, 0, 0, 0, 0, 0, 1, 0] },
    norm: (p) => ({ matrix: nums(p.matrix, 'matrix', 20) }), taps: () => 1,
  },
  resize: {
    doc: '{width, height, filter:"nearest"|"bilinear"} — pixel-centre aligned: source coordinate = (x+0.5)·sw/dw−0.5; nearest takes floor((x+0.5)·sw/dw); bilinear interpolates all four channels (no prefilter when shrinking).',
    example: { width: 256, height: 256, filter: 'bilinear' },
    norm: (p) => ({ width: int(p.width, 'width', 1, 16384), height: int(p.height, 'height', 1, 16384), filter: oneOf(p.filter, 'filter', ['nearest', 'bilinear'], 'bilinear') }),
    taps: () => 4,
  },
  morph: {
    doc: '{op:"erode"|"dilate", radius:int 1..128} — min (erode) or max (dilate) over a (2r+1)² square, per channel R,G,B.',
    example: { op: 'dilate', radius: 2 },
    norm: (p) => ({ op: oneOf(p.op, 'op', ['erode', 'dilate'], 'dilate'), radius: int(p.radius, 'radius', 0, 128, 1) }),
    taps: (p) => 2 * p.radius + 1,
  },
  bayer: {
    doc: '{levels:int 2..256, size:2|4|8, mono:bool} — ordered dither: threshold = (B[y%n][x%n]+0.5)/n²−0.5; out = round(clamp(v/255+threshold/(levels−1),0,1)·(levels−1))/(levels−1)·255; mono dithers Rec.709 luma and writes gray. Evaluated in exact integer arithmetic.',
    example: { levels: 2, size: 4, mono: true },
    norm: (p) => ({ levels: int(p.levels, 'levels', 2, 256, 2), size: Number(oneOf(Number(p.size ?? 4), 'size', [2, 4, 8], 4)), mono: bool(p.mono) }),
    taps: () => 1,
  },
  bilateral: {
    doc: '{sigmaSpace 0.5..16, sigmaColor 1..255} — edge-preserving blur, radius = ceil(2·sigmaSpace); weight = exp(−d²/(2σs²))·exp(−(ΔR²+ΔG²+ΔB²)/(2σc²)) with colour differences in 0..255 units.',
    example: { sigmaSpace: 3, sigmaColor: 30 },
    norm: (p) => ({ sigmaSpace: num(p.sigmaSpace, 'sigmaSpace', 0.5, 16, 3), sigmaColor: num(p.sigmaColor, 'sigmaColor', 1, 255, 30) }),
    taps: (p) => (2 * Math.ceil(2 * p.sigmaSpace) + 1) ** 2,
  },
};
export const OP_NAMES = Object.keys(OPS);

export function normParams(op, params) {
  const spec = OPS[op];
  if (!spec) throw new Error(`unknown gpu op "${op}" — have: ${OP_NAMES.join(', ')}`);
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { throw new Error(`params must be a JSON object, e.g. ${JSON.stringify(spec.example)}`); } }
  if (params === null || params === undefined) params = {};
  if (typeof params !== 'object' || Array.isArray(params)) throw new Error(`params must be an object, e.g. ${JSON.stringify(spec.example)}`);
  return spec.norm(params);
}

/** half kernel w[0..radius], normalised so that w[0] + 2·Σ w[1..] = 1 */
export function gaussWeights(sigma) {
  const radius = Math.ceil(3 * sigma); const w = new Float64Array(radius + 1); let sum = 0;
  for (let i = 0; i <= radius; i++) { w[i] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += i ? 2 * w[i] : w[i]; }
  for (let i = 0; i <= radius; i++) w[i] /= sum;
  return { radius, w };
}

/** Bayer index matrix B (values 0..n²−1), row-major, n = 2 | 4 | 8. B2 = [[0,2],[3,1]], B2n = [[4B, 4B+2],[4B+3, 4B+1]]. */
export function bayerMatrix(n) {
  let m = [[0, 2], [3, 1]];
  while (m.length < n) {
    const s = m.length; const b = Array.from({ length: 2 * s }, () => new Array(2 * s));
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) { const v = 4 * m[y][x]; b[y][x] = v; b[y][x + s] = v + 2; b[y + s][x] = v + 3; b[y + s][x + s] = v + 1; }
    m = b;
  }
  return Float32Array.from(m.flat());
}
