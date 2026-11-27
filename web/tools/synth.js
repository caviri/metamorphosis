// synth.* — synthetic images: noise, fractals, automata, test charts, ground-truth scenes. Nothing to upload: an agent
// can make its own material to play with and to test the analysis tools against known answers.
// Everything is deterministic for a given `seed`. Plain JS always works; fractals, lattice noise and reaction-diffusion
// also have a WebGPU path (backend=auto|gpu|cpu, the result reports which one ran).
import { M, vfs, register } from '../js/core.js';
import { save, canvasOf } from '../js/img.js';
import { bayerMatrix } from '../js/gpu/ops.js';
import * as rt from '../js/gpu/rt.js';

const TAU = Math.PI * 2;
const MAX = 4096;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** mulberry32 — the one PRNG used for every seeded choice */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (R) => Math.sqrt(-2 * Math.log(1 - R())) * Math.cos(TAU * R());

// ───────────────────────────────────────────────────────── palettes ──
const PALETTES = {
  gray: { stops: ['#000000', '#ffffff'] },
  phosphor: { stops: ['#010a02', '#0a3b12', '#1fae3a', '#7dff8e', '#eaffea'] },
  amber: { stops: ['#080300', '#5a2c00', '#d17a00', '#ffc14a', '#fff3d6'] },
  fire: { stops: ['#000000', '#5a0000', '#d42a00', '#ff9a00', '#ffe45a', '#ffffff'] },
  ice: { stops: ['#00020f', '#06307a', '#2a8ad4', '#9fe0ff', '#ffffff'] },
  viridis: { stops: ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'] },
  magma: { stops: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'] },
  turbo: { stops: ['#30123b', '#4686fb', '#1ae4b6', '#a2fc3c', '#fabb39', '#e4460a', '#7a0403'] },
  sunset: { stops: ['#0b1026', '#3a1c5c', '#b5375c', '#f78c4a', '#ffe9a8'] },
  earth: { stops: ['#0b2a5c', '#1f6fa8', '#d9c98f', '#3f8f3a', '#6b4a2b', '#ffffff'] },
  rainbow: { hsv: true },
  mono1: { stops: ['#000000', '#ffffff'], dither: true },
  phosphor1: { stops: ['#031206', '#5dff7a'], dither: true },
  amber1: { stops: ['#120800', '#ffb52e'], dither: true },
};
const PALETTE_NAMES = Object.keys(PALETTES);
const hex = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
  return [r * 255, g * 255, b * 255];
}
const luts = new Map();
function lutOf(name) {
  let l = luts.get(name);
  if (!l) {
    const P = PALETTES[name]; l = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      let c;
      if (P.hsv) c = hsv((i / 256) * 0.999, 0.85, 1);
      else { const s = P.stops.map(hex); const f = (i / 255) * (s.length - 1); const k = Math.min(s.length - 2, Math.floor(f)); c = s[k].map((v, j) => lerp(v, s[k + 1][j], f - k)); }
      l[i * 3] = Math.round(c[0]); l[i * 3 + 1] = Math.round(c[1]); l[i * 3 + 2] = Math.round(c[2]);
    }
    luts.set(name, l);
  }
  return l;
}
let B8;
/** scalar field (0..1; values < 0 mean "inside/void" → black) → img through a palette. *1 palettes are 1-bit Bayer-dithered. */
function colorize(field, w, h, name) {
  const P = PALETTES[name], lut = lutOf(name), data = new Uint8ClampedArray(w * h * 4);
  if (P.dither) B8 ||= bayerMatrix(8);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const t = field[i], q = i * 4; data[q + 3] = 255;
    if (!(t >= 0)) continue;                                   // negative or NaN → black
    const k = (P.dither ? (t > (B8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 ? 255 : 0) : ((t > 1 ? 1 : t) * 255 + 0.5) | 0) * 3;
    data[q] = lut[k]; data[q + 1] = lut[k + 1]; data[q + 2] = lut[k + 2];
  }
  return { width: w, height: h, data };
}
function normalize(field) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < field.length; i++) { const v = field[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const k = hi > lo ? 1 / (hi - lo) : 0;
  for (let i = 0; i < field.length; i++) field[i] = (field[i] - lo) * k;
  return field;
}
function fill(w, h, fn) { const f = new Float32Array(w * h); for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) f[i] = fn(x, y); return f; }

// colours given by the caller: anything CSS understands, normalised by a canvas
let cctx;
function parseColor(str) {
  cctx ||= canvasOf(1, 1).getContext('2d');
  const probe = (sentinel) => { cctx.fillStyle = sentinel; cctx.fillStyle = String(str).trim(); return cctx.fillStyle; };
  const v = probe('#010203');
  if (v === '#010203' && probe('#040506') === '#040506') throw new Error(`cannot parse colour "${str}" — use CSS colours such as #ff8800, #f80, rgb(255 136 0), rgba(0,0,0,0.5), orange`);
  if (v[0] === '#') return [...hex(v), 255];
  const m = v.match(/[\d.]+/g).map(Number);
  return [m[0], m[1], m[2], Math.round((m[3] ?? 1) * 255)];
}

// ──────────────────────────────────────────────────── shared schema ──
const size = (dw = 512, dh = dw, max = MAX) => ({
  width: { type: 'integer', default: dw, minimum: 1, maximum: max, description: `Image width in pixels (max ${max})` },
  height: { type: 'integer', default: dh, minimum: 1, maximum: max, description: `Image height in pixels (max ${max})` },
});
const SEED = { seed: { type: 'integer', default: 1, minimum: 0, maximum: 4294967295, description: 'Seed — the same seed and arguments always give the same image' } };
const pal = (def = 'gray') => ({ palette: { type: 'string', enum: PALETTE_NAMES, default: def, description: 'Colour map applied to the scalar result. gray · phosphor (green CRT) · amber · fire · ice · viridis · magma · turbo · sunset · earth · rainbow · mono1 / phosphor1 / amber1 (1-bit, 8×8 Bayer-dithered)' } });
const OUT = { output: { type: 'string', description: 'VFS path to write; the extension picks png (default, lossless), jpg or webp. Default: <generator>.png, numbered if taken' } };
const BACKEND = { backend: { type: 'string', enum: ['auto', 'gpu', 'cpu'], default: 'auto', description: 'auto = WebGPU when available else plain JS; gpu = fail if WebGPU is missing; cpu = force plain JS' } };

async function finish(name, args, img, extra = {}) {
  return { output: await save(img, vfs.out(args.output, name, '', 'png')), ...extra };
}
/** choose and run a backend for a scalar field: gpuFn(device) → Float32Array, cpuFn() → Float32Array */
async function onBackend(args, ctx, gpuFn, cpuFn, gpuOk = true) {
  if (args.backend !== 'cpu' && (gpuOk || args.backend === 'gpu')) {
    const device = await rt.acquire(M.gpu);
    if (!device && args.backend === 'gpu') throw new Error('backend=gpu requested but WebGPU is not available in this browser — use backend=auto or cpu');
    if (device) {
      try { return { field: await gpuFn(device), backend: 'webgpu' }; } catch (e) {
        if (args.backend === 'gpu') throw e;
        ctx.warn(`gpu path failed (${e.message}); falling back to js`);
      }
    }
  }
  return { field: cpuFn(), backend: 'js' };
}
const U_HEAD = '@group(0) @binding(0) var<uniform> U: array<vec4f, 8>;\n';
/** one fragment pass producing a float per pixel (r32float) → Float32Array(w·h). `uints` = {index: u32} overlays raw u32 bits. */
async function gpuField(device, w, h, code, floats, uints = {}, cost = 1) {
  rt.checkSize(device, w, h);
  return rt.scoped(device, async () => {
    const u = new Float32Array(32); u.set(floats); const ui = new Uint32Array(u.buffer);
    for (const [i, v] of Object.entries(uints)) ui[i] = v >>> 0;
    const { pipeline, layout } = rt.renderPipeline(device, { code: U_HEAD + code, kinds: ['uniform'], format: 'r32float' });
    const ub = rt.uniformOf(device, u); const target = rt.makeTarget(device, w, h, 'r32float');
    try {
      await rt.draw(device, { pipeline, bindGroup: rt.bind(device, layout, [ub]), target, width: w, height: h, cost });
      return await rt.readFloats(device, target, w, h, 1);
    } finally { ub.destroy(); target.destroy(); }
  });
}

// ──────────────────────────────────────────────────────────── noise ──
// The integer hash and every noise basis exist twice, in JS and in WGSL, written to be the same function.
function hash(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h ^= h >>> 12;
  return h >>> 0;
}
const u01 = (h) => (h >>> 8) / 16777216;
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
function valueN(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), u = fade(x - ix), v = fade(y - iy);
  const a = u01(hash(ix, iy, s)), b = u01(hash(ix + 1, iy, s)), c = u01(hash(ix, iy + 1, s)), d = u01(hash(ix + 1, iy + 1, s));
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
function gdot(ix, iy, s, dx, dy) { const a = u01(hash(ix, iy, s)) * TAU; return Math.cos(a) * dx + Math.sin(a) * dy; }
function perlinN(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fade(fx), v = fade(fy);
  const n = lerp(lerp(gdot(ix, iy, s, fx, fy), gdot(ix + 1, iy, s, fx - 1, fy), u), lerp(gdot(ix, iy + 1, s, fx, fy - 1), gdot(ix + 1, iy + 1, s, fx - 1, fy - 1), u), v);
  return clamp01(0.5 + n * 0.70710678);
}
const F2 = 0.36602540378, G2 = 0.21132486540;
function simplexN(x, y, s) {
  const sk = (x + y) * F2, i = Math.floor(x + sk), j = Math.floor(y + sk), t = (i + j) * G2;
  const x0 = x - (i - t), y0 = y - (j - t), i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  let n = 0, a = 0.5 - x0 * x0 - y0 * y0;
  if (a > 0) { a *= a; n += a * a * gdot(i, j, s, x0, y0); }
  a = 0.5 - x1 * x1 - y1 * y1; if (a > 0) { a *= a; n += a * a * gdot(i + i1, j + j1, s, x1, y1); }
  a = 0.5 - x2 * x2 - y2 * y2; if (a > 0) { a *= a; n += a * a * gdot(i + 1, j + 1, s, x2, y2); }
  return clamp01(0.5 + n * 49.6);
}
function worleyN(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y); let best = 9;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, px = cx + u01(hash(cx, cy, s)) - x, py = cy + u01(hash(cx, cy, s + 0x68bc21eb)) - y, d = px * px + py * py;
    if (d < best) best = d;
  }
  return Math.min(1, Math.sqrt(best));
}
const BASIS = { value: valueN, perlin: perlinN, simplex: simplexN, worley: worleyN };
const NOISE_TYPES = ['white', 'value', 'perlin', 'simplex', 'worley'];
function fbm(fn, x, y, s, octaves, lac, gain) {
  let amp = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) { sum += amp * fn(x, y, s + o * 1013); norm += amp; amp *= gain; x *= lac; y *= lac; }
  return sum / norm;
}
const NOISE_WGSL = /* wgsl */`
fn hash(x: i32, y: i32, s: u32) -> u32 {
  var h = bitcast<u32>(x) * 374761393u + bitcast<u32>(y) * 668265263u + s * 1274126177u;
  h = (h ^ (h >> 13u)) * 1274126177u; h ^= h >> 16u;
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du; h ^= h >> 12u;
  return h;
}
fn u01(h: u32) -> f32 { return f32(h >> 8u) / 16777216.0; }
fn fade(t: vec2f) -> vec2f { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
fn gdot(i: vec2i, s: u32, d: vec2f) -> f32 { let a = u01(hash(i.x, i.y, s)) * 6.283185307; return cos(a) * d.x + sin(a) * d.y; }
fn vnoise(p: vec2f, s: u32) -> f32 {
  let i = vec2i(floor(p)); let w = fade(p - floor(p));
  let a = u01(hash(i.x, i.y, s)); let b = u01(hash(i.x + 1, i.y, s)); let c = u01(hash(i.x, i.y + 1, s)); let d = u01(hash(i.x + 1, i.y + 1, s));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}
fn pnoise(p: vec2f, s: u32) -> f32 {
  let i = vec2i(floor(p)); let f = p - floor(p); let w = fade(f);
  let n = mix(mix(gdot(i, s, f), gdot(i + vec2i(1, 0), s, f - vec2f(1.0, 0.0)), w.x), mix(gdot(i + vec2i(0, 1), s, f - vec2f(0.0, 1.0)), gdot(i + vec2i(1, 1), s, f - vec2f(1.0, 1.0)), w.x), w.y);
  return clamp(0.5 + n * 0.70710678, 0.0, 1.0);
}
fn corner(i: vec2i, s: u32, d: vec2f) -> f32 { let a = 0.5 - dot(d, d); if (a <= 0.0) { return 0.0; } let b = a * a; return b * b * gdot(i, s, d); }
fn snoise(p: vec2f, s: u32) -> f32 {
  let F2 = 0.36602540378; let G2 = 0.21132486540;
  let ij = floor(p + (p.x + p.y) * F2); let i = vec2i(ij);
  let d0 = p - (ij - (ij.x + ij.y) * G2);
  let o = select(vec2i(0, 1), vec2i(1, 0), d0.x > d0.y);
  let n = corner(i, s, d0) + corner(i + o, s, d0 - vec2f(o) + G2) + corner(i + vec2i(1, 1), s, d0 - 1.0 + 2.0 * G2);
  return clamp(0.5 + n * 49.6, 0.0, 1.0);
}
fn wnoise(p: vec2f, s: u32) -> f32 {
  let i = vec2i(floor(p)); var best = 9.0;
  for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
    let c = i + vec2i(dx, dy);
    let q = vec2f(c) + vec2f(u01(hash(c.x, c.y, s)), u01(hash(c.x, c.y, s + 0x68bc21ebu))) - p;
    best = min(best, dot(q, q));
  } }
  return min(1.0, sqrt(best));
}
// U[0] = (scale, octaves, lacunarity, gain)  U[1] = (kind, seed:u32 bits, offsetX, offsetY)
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let kind = i32(U[1].x); let seed = bitcast<u32>(U[1].y);
  if (kind == 0) { let q = vec2i(pos.xy); return vec4f(u01(hash(q.x, q.y, seed)), 0.0, 0.0, 1.0); }
  var p = (pos.xy + U[1].zw) / U[0].x;
  var amp = 1.0; var sum = 0.0; var total = 0.0;
  for (var o = 0; o < i32(U[0].y); o++) {
    let s = seed + u32(o) * 1013u; var n = 0.0;
    switch kind { case 1 { n = vnoise(p, s); } case 2 { n = pnoise(p, s); } case 3 { n = snoise(p, s); } default { n = wnoise(p, s); } }
    sum += amp * n; total += amp; amp *= U[0].w; p *= U[0].z;
  }
  return vec4f(sum / total, 0.0, 0.0, 1.0);
}`;
function noiseField(a) {
  const { width: w, height: h, type, scale, octaves, lacunarity, gain, offsetX, offsetY } = a; const S = a.seed >>> 0;
  if (type === 'white') return fill(w, h, (x, y) => u01(hash(x, y, S)));
  const fn = BASIS[type];
  return fill(w, h, (x, y) => fbm(fn, (x + 0.5 + offsetX) / scale, (y + 0.5 + offsetY) / scale, S, octaves, lacunarity, gain));
}

register({
  name: 'synth.noise', gpu: true,
  description: 'Generate a noise image: white (independent per pixel), value, perlin (gradient), simplex or worley (cellular, distance to the nearest feature point), with fractal octaves (fBm). Use it as texture, as a test input for blur/denoise/FFT-style analysis, or as raw material for other tools. The JS and WebGPU paths implement the same hash and bases, so both backends give the same picture (within float rounding). Returns the output stat, the backend used and the field min/max/mean before normalisation.',
  schema: {
    properties: {
      type: { type: 'string', enum: NOISE_TYPES, default: 'perlin', description: 'Noise basis. white ignores scale/octaves' },
      ...size(),
      scale: { type: 'number', default: 64, minimum: 1, maximum: 4096, description: 'Feature size: pixels per lattice cell of the first octave' },
      octaves: { type: 'integer', default: 4, minimum: 1, maximum: 10, description: 'Number of fBm octaves summed (1 = the plain basis)' },
      lacunarity: { type: 'number', default: 2, minimum: 1, maximum: 4, description: 'Frequency multiplier between octaves' },
      gain: { type: 'number', default: 0.5, minimum: 0, maximum: 1, description: 'Amplitude multiplier between octaves (persistence)' },
      offsetX: { type: 'number', default: 0, description: 'Pan in pixels (scroll the infinite noise plane horizontally)' },
      offsetY: { type: 'number', default: 0, description: 'Pan in pixels, vertical' },
      normalize: { type: 'boolean', default: true, description: 'Stretch the result to the full 0..1 range (ignored for white)' },
      ...SEED, ...pal(), ...BACKEND, ...OUT,
    },
  },
  examples: ['synth.noise type=perlin scale=96 octaves=5 seed=7', 'synth.noise type=worley scale=40 octaves=1 palette=phosphor width=1024 height=1024', 'synth.noise type=white width=256 height=256 palette=mono1'],
  async run(a, ctx) {
    const kind = NOISE_TYPES.indexOf(a.type);
    const { field, backend } = await onBackend(a, ctx,
      (dev) => gpuField(dev, a.width, a.height, NOISE_WGSL, [a.scale, a.octaves, a.lacunarity, a.gain, kind, 0, a.offsetX, a.offsetY], { 5: a.seed }, a.type === 'white' ? 1 : a.octaves * 9),
      () => noiseField(a));
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let i = 0; i < field.length; i++) { const v = field[i]; if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
    if (a.normalize && a.type !== 'white') normalize(field);
    return finish('noise', a, colorize(field, a.width, a.height, a.palette), { backend, type: a.type, seed: a.seed, raw: { min: +lo.toFixed(4), max: +hi.toFixed(4), mean: +(sum / field.length).toFixed(4) } });
  },
});

register({
  name: 'synth.plasma',
  description: 'Classic demo-scene plasma: a sum of four sine waves (horizontal, vertical, diagonal, radial) with seeded phases, pushed through a palette. Smooth, band-limited and colourful — good for testing colour conversions, quantisation, dithering and palette extraction. Step `time` to get animation frames. Returns the output stat.',
  schema: { properties: { ...size(), frequency: { type: 'number', default: 3, minimum: 0.1, maximum: 64, description: 'Roughly the number of waves across the image' }, time: { type: 'number', default: 0, description: 'Phase offset in radians; increase it frame by frame to animate' }, ...SEED, ...pal('rainbow'), ...OUT } },
  examples: ['synth.plasma', 'synth.plasma frequency=6 palette=fire time=1.5'],
  async run(a) {
    const R = rng(a.seed), ph = [R() * TAU, R() * TAU, R() * TAU, R() * TAU], cx = 0.2 + 0.6 * R(), cy = 0.2 + 0.6 * R();
    const { width: w, height: h } = a, k = a.frequency * TAU, m = Math.max(w, h);
    const f = fill(w, h, (x, y) => {
      const u = x / m, v = y / m, r = Math.hypot(u - cx * w / m, v - cy * h / m);
      return 0.5 + 0.125 * (Math.sin(u * k + ph[0] + a.time) + Math.sin(v * k * 1.3 + ph[1] - a.time * 0.7) + Math.sin((u + v) * k * 0.7 + ph[2] + a.time * 0.5) + Math.sin(r * k * 1.7 + ph[3] - a.time));
    });
    return finish('plasma', a, colorize(f, w, h, a.palette), { seed: a.seed });
  },
});

// ───────────────────────────────────────────────────────── gradient ──
function parseStops(stops) {
  if (stops.length < 2) throw new Error('stops needs at least two colours, e.g. ["#000", "#f80 0.5", "#fff"]');
  const out = stops.map((s) => {
    const str = String(s).trim(), m = /^(.*\S)\s+(-?[\d.]+%?)$/.exec(str);
    try { return { c: parseColor(str), pos: null }; } catch (e) { if (!m) throw e; }
    return { c: parseColor(m[1]), pos: m[2].endsWith('%') ? parseFloat(m[2]) / 100 : parseFloat(m[2]) };
  });
  if (out[0].pos === null) out[0].pos = 0;
  if (out[out.length - 1].pos === null) out[out.length - 1].pos = 1;
  for (let i = 1; i < out.length - 1; i++) if (out[i].pos === null) { let j = i; while (out[j].pos === null) j++; const a = out[i - 1].pos, n = j - i + 1; for (let k = i; k < j; k++) out[k].pos = a + ((out[j].pos - a) * (k - i + 1)) / n; }
  for (let i = 1; i < out.length; i++) if (out[i].pos < out[i - 1].pos) out[i].pos = out[i - 1].pos;
  return out;
}
function sampleStops(st, t) {
  if (t <= st[0].pos) return st[0].c;
  for (let i = 1; i < st.length; i++) if (t <= st[i].pos) { const a = st[i - 1], b = st[i], f = b.pos > a.pos ? (t - a.pos) / (b.pos - a.pos) : 1; return a.c.map((v, j) => lerp(v, b.c[j], f)); }
  return st[st.length - 1].c;
}

register({
  name: 'synth.gradient',
  description: 'Colour gradient: linear (any angle), radial (any centre/radius) or conic (angular sweep), through any number of colour stops, optionally repeated. Interpolation is plain per-channel RGBA on byte values (no gamma), computed exactly — a clean ramp for testing banding, dithering, quantisation and colour-space conversions. Returns the output stat and the resolved stops.',
  schema: {
    properties: {
      type: { type: 'string', enum: ['linear', 'radial', 'conic'], default: 'linear', description: 'Gradient geometry' },
      ...size(),
      stops: { type: 'array', items: { type: 'string' }, default: ['#000000', '#ffffff'], description: 'Colour stops in order: CSS colours, each optionally followed by a position 0..1 or a percentage, e.g. ["#000", "#f80 0.3", "white 100%"]. Unpositioned stops are spread evenly' },
      angle: { type: 'number', default: 0, description: 'linear: direction in degrees (0 = left→right, 90 = top→bottom). conic: start angle (0 = +x axis, clockwise on screen)' },
      centerX: { type: 'number', default: 0.5, description: 'radial/conic centre x as a fraction of the width' },
      centerY: { type: 'number', default: 0.5, description: 'radial/conic centre y as a fraction of the height' },
      radius: { type: 'number', minimum: 0.001, description: 'radial: radius where the last stop is reached, as a fraction of min(width,height)/2 (default: reach the farthest corner)' },
      repeat: { type: 'number', default: 1, minimum: 0.01, maximum: 1000, description: 'Number of times the stop sequence repeats across the gradient extent' },
      mirror: { type: 'boolean', default: false, description: 'When repeating, reflect every other repetition (no seams)' },
      ...OUT,
    },
  },
  examples: ['synth.gradient', 'synth.gradient type=radial stops=["#fff","#08f 0.4","#001"]', 'synth.gradient type=conic stops=red,yellow,lime,cyan,blue,magenta,red', 'synth.gradient angle=90 repeat=8 mirror=true'],
  async run(a) {
    const st = parseStops(a.stops), { width: w, height: h } = a, cx = a.centerX * w, cy = a.centerY * h, ang = (a.angle * Math.PI) / 180;
    const dx = Math.cos(ang), dy = Math.sin(ang), L = Math.abs(w * dx) + Math.abs(h * dy) || 1;
    const R = a.radius ? (a.radius * Math.min(w, h)) / 2 : Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy));
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, q = 0; y < h; y++) for (let x = 0; x < w; x++, q += 4) {
      const px = x + 0.5, py = y + 0.5; let t;
      if (a.type === 'linear') t = ((px - w / 2) * dx + (py - h / 2) * dy) / L + 0.5;
      else if (a.type === 'radial') t = Math.hypot(px - cx, py - cy) / R;
      else { t = (Math.atan2(py - cy, px - cx) - ang) / TAU; t -= Math.floor(t); }
      t *= a.repeat;
      if (a.repeat !== 1 || a.type === 'conic') { if (t >= a.repeat) t = a.repeat - 1e-9; const k = Math.floor(t); t -= k; if (a.mirror && (k & 1)) t = 1 - t; }
      const c = sampleStops(st, t); data[q] = Math.round(c[0]); data[q + 1] = Math.round(c[1]); data[q + 2] = Math.round(c[2]); data[q + 3] = Math.round(c[3]);
    }
    return finish('gradient', a, { width: w, height: h, data }, { type: a.type, stops: st.map((s) => ({ rgba: s.c, pos: +s.pos.toFixed(4) })) });
  },
});

// ─────────────────────────────────────────────── regular test patterns ──
const twoColours = { colorA: { type: 'string', default: '#000000', description: 'First colour (any CSS colour)' }, colorB: { type: 'string', default: '#ffffff', description: 'Second colour (any CSS colour)' } };
function blend2(field, w, h, ca, cb) {
  const A = parseColor(ca), B = parseColor(cb), data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, q = 0; i < field.length; i++, q += 4) { const t = field[i]; data[q] = Math.round(lerp(A[0], B[0], t)); data[q + 1] = Math.round(lerp(A[1], B[1], t)); data[q + 2] = Math.round(lerp(A[2], B[2], t)); data[q + 3] = Math.round(lerp(A[3], B[3], t)); }
  return { width: w, height: h, data };
}

register({
  name: 'synth.checker',
  description: 'Checkerboard with exact, unantialiased cells of a given pixel size and two colours. Known geometry for testing resizing (aliasing), corner/edge detection, camera-style calibration, and as a transparency background. Returns the output stat and the number of columns/rows of cells.',
  schema: { properties: { ...size(), cell: { type: 'integer', default: 32, minimum: 1, maximum: 2048, description: 'Cell side in pixels (1 gives the highest-frequency pattern an image can hold)' }, cellHeight: { type: 'integer', minimum: 1, maximum: 2048, description: 'Cell height if different from cell' }, offsetX: { type: 'integer', default: 0, description: 'Horizontal shift of the pattern in pixels' }, offsetY: { type: 'integer', default: 0, description: 'Vertical shift in pixels' }, ...twoColours, ...OUT } },
  examples: ['synth.checker cell=16', 'synth.checker cell=1 width=256 height=256', 'synth.checker cell=8 colorA=#ccc colorB=#fff'],
  async run(a) {
    const cw = a.cell, ch = a.cellHeight || a.cell, { width: w, height: h } = a;
    const f = fill(w, h, (x, y) => (Math.floor((x + a.offsetX) / cw) + Math.floor((y + a.offsetY) / ch)) & 1);
    return finish('checker', a, blend2(f, w, h, a.colorA, a.colorB), { cols: Math.ceil(w / cw), rows: Math.ceil(h / ch), cell: [cw, ch] });
  },
});

register({
  name: 'synth.stripes',
  description: 'Periodic stripes (a grating) at any angle: square, sine, triangle or sawtooth profile, with a chosen period in pixels and duty cycle. A single known spatial frequency — use it to test blur strength (contrast loss), resampling, edge detectors and moiré. Returns the output stat and the frequency in cycles/pixel.',
  schema: { properties: { ...size(), period: { type: 'number', default: 32, minimum: 0.5, maximum: 4096, description: 'Stripe period in pixels (one colorA band plus one colorB band)' }, angle: { type: 'number', default: 0, description: 'Rotation in degrees: 0 = vertical stripes varying along x, 90 = horizontal stripes' }, profile: { type: 'string', enum: ['square', 'sine', 'triangle', 'saw'], default: 'square', description: 'Intensity profile across one period' }, duty: { type: 'number', default: 0.5, minimum: 0.01, maximum: 0.99, description: 'square only: fraction of the period that is colorB' }, phase: { type: 'number', default: 0, description: 'Shift of the pattern as a fraction of a period' }, antialias: { type: 'boolean', default: false, description: 'square only: smooth the edges over one pixel instead of hard 0/1 steps' }, ...twoColours, ...OUT } },
  examples: ['synth.stripes period=16', 'synth.stripes period=24 angle=30 profile=sine', 'synth.stripes period=2 angle=90'],
  async run(a) {
    const { width: w, height: h } = a, ang = (a.angle * Math.PI) / 180, dx = Math.cos(ang), dy = Math.sin(ang);
    const f = fill(w, h, (x, y) => {
      let u = ((x + 0.5) * dx + (y + 0.5) * dy) / a.period + a.phase; u -= Math.floor(u);
      if (a.profile === 'sine') return 0.5 - 0.5 * Math.cos(u * TAU);
      if (a.profile === 'triangle') return 1 - Math.abs(2 * u - 1);
      if (a.profile === 'saw') return u;
      if (!a.antialias) return u < a.duty ? 1 : 0;
      const d = u < a.duty ? Math.min(u, a.duty - u) : -Math.min(u - a.duty, 1 - u);      // signed distance to the band edge, in periods
      return clamp01(d * a.period + 0.5);
    });
    return finish('stripes', a, blend2(f, w, h, a.colorA, a.colorB), { period: a.period, cyclesPerPixel: +(1 / a.period).toFixed(5), angle: a.angle });
  },
});

register({
  name: 'synth.zoneplate',
  description: 'Circular zone plate: v = 0.5 + 0.5·cos(π·k·r²), concentric rings whose spatial frequency grows linearly with the distance from the centre, reaching `frequency` cycles/pixel at the nearest image edge. Every frequency and orientation in one image — the standard chart for judging resizers and filters: aliasing shows up as phantom ring systems, blur as grey-out from the rim inward. Returns the output stat and the radius at which a given frequency is reached.',
  schema: { properties: { ...size(), frequency: { type: 'number', default: 0.5, minimum: 0.001, maximum: 2, description: 'Local frequency in cycles/pixel reached at the nearest edge (0.5 = Nyquist; above it the pattern aliases on purpose)' }, phase: { type: 'number', default: 0, description: 'Phase offset in radians' }, centerX: { type: 'number', default: 0.5, description: 'Centre x as a fraction of the width' }, centerY: { type: 'number', default: 0.5, description: 'Centre y as a fraction of the height' }, ...pal(), ...OUT } },
  examples: ['synth.zoneplate', 'synth.zoneplate width=1024 height=1024 frequency=0.25'],
  async run(a) {
    const { width: w, height: h } = a, cx = a.centerX * w, cy = a.centerY * h, R = Math.min(w, h) / 2, k = a.frequency / R;
    const f = fill(w, h, (x, y) => { const dx = x + 0.5 - cx, dy = y + 0.5 - cy; return 0.5 + 0.5 * Math.cos(Math.PI * k * (dx * dx + dy * dy) + a.phase); });
    return finish('zoneplate', a, colorize(f, w, h, a.palette), { edgeRadius: R, cyclesPerPixelAtEdge: a.frequency, law: 'cycles/pixel at radius r = frequency · r / edgeRadius' });
  },
});

register({
  name: 'synth.moire',
  description: 'Moiré interference: two overlaid gratings (straight lines, concentric circles, or radial spokes) multiplied together; the second is rotated, rescaled and shifted relative to the first, which produces the low-frequency beat fringes. Use it to study aliasing/beat patterns, as a hard case for descreening and frequency filters, or simply as op-art. Returns the output stat and the predicted beat period for line gratings.',
  schema: { properties: { ...size(), type: { type: 'string', enum: ['lines', 'circles', 'radial'], default: 'lines', description: 'Grating geometry' }, period: { type: 'number', default: 8, minimum: 1, maximum: 512, description: 'Period of the first grating in pixels (radial: number of spokes = 360/period·… see spokes)' }, period2: { type: 'number', description: 'Period of the second grating (default: same as period)' }, angle: { type: 'number', default: 5, description: 'Rotation of the second grating in degrees (lines), ignored for circles' }, offsetX: { type: 'number', default: 0.15, description: 'Shift of the second grating centre, fraction of the width (circles/radial)' }, offsetY: { type: 'number', default: 0, description: 'Shift of the second grating centre, fraction of the height' }, spokes: { type: 'integer', default: 90, minimum: 2, maximum: 720, description: 'radial: number of spokes' }, profile: { type: 'string', enum: ['sine', 'square'], default: 'sine', description: 'Grating profile' }, ...pal(), ...OUT } },
  examples: ['synth.moire', 'synth.moire type=circles period=6 offsetX=0.1', 'synth.moire type=radial spokes=120 palette=phosphor'],
  async run(a) {
    const { width: w, height: h } = a, p1 = a.period, p2 = a.period2 || a.period, ang = (a.angle * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
    const prof = a.profile === 'sine' ? (u) => 0.5 + 0.5 * Math.cos(u * TAU) : (u) => (u - Math.floor(u) < 0.5 ? 1 : 0);
    const cx = w / 2, cy = h / 2, ox = cx + a.offsetX * w, oy = cy + a.offsetY * h;
    const f = fill(w, h, (x, y) => {
      const px = x + 0.5, py = y + 0.5;
      if (a.type === 'lines') return prof(px / p1) * prof((px * c + py * s) / p2);
      if (a.type === 'circles') return prof(Math.hypot(px - cx, py - cy) / p1) * prof(Math.hypot(px - ox, py - oy) / p2);
      return prof((Math.atan2(py - cy, px - cx) / TAU) * a.spokes) * prof((Math.atan2(py - oy, px - ox) / TAU) * a.spokes);
    });
    const extra = { type: a.type };
    if (a.type === 'lines') { const fx = c / p2 - 1 / p1, fy = s / p2, fb = Math.hypot(fx, fy); extra.beatPeriodPx = fb > 1e-9 ? +(1 / fb).toFixed(2) : null; }
    return finish('moire', a, colorize(f, w, h, a.palette), extra);
  },
});

// ──────────────────────────────────────────────────────── test card ──
register({
  name: 'synth.testcard',
  description: 'Television-style test card with known content, for checking any conversion, filter or codec: 8 colour bars (white, yellow, cyan, green, magenta, red, blue, black at 100% or 75%), a continuous gray ramp, a stepped gray wedge, line gratings of period 2–16 px (vertical and horizontal), a Siemens star, R/G/B/gray ramps, 1-px and 2-px checkerboards, a zone plate and a 1-px white frame. The result lists every region as {name, x, y, w, h} and the exact bar colours, so you can sample the processed image and compare numerically.',
  schema: { properties: { ...size(640, 480), intensity: { type: 'number', default: 1, minimum: 0.1, maximum: 1, description: 'Colour bar amplitude: 1 = 100% bars, 0.75 = 75% bars' }, steps: { type: 'integer', default: 16, minimum: 2, maximum: 64, description: 'Number of patches in the stepped gray wedge' }, spokes: { type: 'integer', default: 36, minimum: 4, maximum: 180, description: 'Number of black/white spoke pairs in the Siemens star' }, frame: { type: 'boolean', default: true, description: 'Draw a 1-pixel white frame on the outermost pixels (shows cropping or padding)' }, ...OUT } },
  examples: ['synth.testcard', 'synth.testcard width=1280 height=720 intensity=0.75'],
  async run(a) {
    const { width: w, height: h } = a, data = new Uint8ClampedArray(w * h * 4), regions = [];
    const rect = (name, x0, y0, x1, y1, fn) => {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      if (name) regions.push({ name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const c = fn(x - x0, y - y0, x1 - x0, y1 - y0), q = (y * w + x) * 4; if (typeof c === 'number') { data[q] = data[q + 1] = data[q + 2] = c; } else { data[q] = c[0]; data[q + 1] = c[1]; data[q + 2] = c[2]; } data[q + 3] = 255; }
    };
    const yA = 0.34 * h, yB = 0.44 * h, yC = 0.54 * h, yD = 0.8 * h, V = Math.round(255 * a.intensity);
    const BARS = [['white', 1, 1, 1], ['yellow', 1, 1, 0], ['cyan', 0, 1, 1], ['green', 0, 1, 0], ['magenta', 1, 0, 1], ['red', 1, 0, 0], ['blue', 0, 0, 1], ['black', 0, 0, 0]];
    const bars = BARS.map(([name, r, g, b], i) => { const rgb = [r * V, g * V, b * V]; rect(`bar.${name}`, (i * w) / 8, 0, ((i + 1) * w) / 8, yA, () => rgb); return { name, rgb }; });
    rect('ramp.gray', 0, yA, w, yB, (x, _y, rw) => Math.round((255 * x) / Math.max(1, rw - 1)));
    for (let i = 0; i < a.steps; i++) rect(`step.${i}`, (i * w) / a.steps, yB, ((i + 1) * w) / a.steps, yC, () => Math.round((255 * i) / (a.steps - 1)));
    const gw = 0.6 * w, yDm = (yC + yD) / 2, PERIODS = [2, 4, 6, 8, 12, 16];
    PERIODS.forEach((p, i) => {
      rect(`grating.v.${p}px`, (i * gw) / 6, yC, ((i + 1) * gw) / 6, yDm, (x) => (x % p < p / 2 ? 255 : 0));
      rect(`grating.h.${p}px`, (i * gw) / 6, yDm, ((i + 1) * gw) / 6, yD, (_x, y) => (y % p < p / 2 ? 255 : 0));
    });
    rect('siemens', gw, yC, w, yD, (x, y, rw, rh) => { const dx = x + 0.5 - rw / 2, dy = y + 0.5 - rh / 2, r = Math.hypot(dx, dy); if (r > Math.min(rw, rh) / 2 - 2) return 128; return Math.floor(((Math.atan2(dy, dx) + Math.PI) / TAU) * a.spokes * 2) & 1 ? 255 : 0; });
    const x1 = w / 3, x2 = (2 * w) / 3, sh = (h - yD) / 4;
    [['red', 0], ['green', 1], ['blue', 2], ['gray', -1]].forEach(([n, ch], i) => rect(`ramp.${n}`, 0, yD + i * sh, x1, yD + (i + 1) * sh, (x, _y, rw) => { const v = Math.round((255 * x) / Math.max(1, rw - 1)); if (ch < 0) return v; const c = [0, 0, 0]; c[ch] = v; return c; }));
    rect('checker.1px', x1, yD, (x1 + x2) / 2, h, (x, y) => ((x + y) & 1 ? 255 : 0));
    rect('checker.2px', (x1 + x2) / 2, yD, x2, h, (x, y) => (((x >> 1) + (y >> 1)) & 1 ? 255 : 0));
    rect('zoneplate', x2, yD, w, h, (x, y, rw, rh) => { const dx = x + 0.5 - rw / 2, dy = y + 0.5 - rh / 2; return Math.round(127.5 + 127.5 * Math.cos((Math.PI * 0.5 * (dx * dx + dy * dy)) / (Math.max(rw, rh) / 2))); });
    if (a.frame) for (let x = 0; x < w; x++) for (const y of [0, h - 1]) data.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 4);
    if (a.frame) for (let y = 0; y < h; y++) for (const x of [0, w - 1]) data.fill(255, (y * w + x) * 4, (y * w + x) * 4 + 4);
    return finish('testcard', a, { width: w, height: h, data }, { bars, gratingPeriodsPx: PERIODS, steps: a.steps, frame: a.frame, regions });
  },
});

// ───────────────────────────────────────────────────────── fractals ──
const FRACTAL_WGSL = /* wgsl */`
// U[0] = (centreX, centreY, unitsPerPixel, maxIter)  U[1] = (cRe, cIm, isJulia)  U[2] = (width, height)
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let q = vec2f(U[0].x + (pos.x - U[2].x * 0.5) * U[0].z, U[0].y - (pos.y - U[2].y * 0.5) * U[0].z);
  var z = q; var c = q;
  if (U[1].z > 0.5) { c = U[1].xy; } else { z = vec2f(0.0); }
  let n = i32(U[0].w); var i = 0; var r2 = dot(z, z);
  for (; i < n; i++) {
    if (r2 > 65536.0) { break; }
    z = vec2f(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c; r2 = dot(z, z);
  }
  if (r2 <= 65536.0) { return vec4f(-1.0, 0.0, 0.0, 1.0); }
  return vec4f(f32(i) - log2(0.5 * log2(r2)), 0.0, 0.0, 1.0);
}`;
function fractalCPU(a, julia) {
  const { width: w, height: h, iterations: n } = a, s = 3 / (a.zoom * h), f = new Float32Array(w * h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const qx = a.centerX + (x + 0.5 - w / 2) * s, qy = a.centerY - (y + 0.5 - h / 2) * s;
    let zx = julia ? qx : 0, zy = julia ? qy : 0; const cx = julia ? a.cRe : qx, cy = julia ? a.cIm : qy;
    let k = 0, r2 = zx * zx + zy * zy;
    for (; k < n && r2 <= 65536; k++) { const t = zx * zx - zy * zy + cx; zy = 2 * zx * zy + cy; zx = t; r2 = zx * zx + zy * zy; }
    f[i] = r2 <= 65536 ? -1 : k - Math.log2(0.5 * Math.log2(r2));
  }
  return f;
}
const fractalProps = (cx, cy) => ({
  ...size(768, 512),
  centerX: { type: 'number', default: cx, description: 'Real coordinate at the image centre' },
  centerY: { type: 'number', default: cy, description: 'Imaginary coordinate at the image centre (positive is up)' },
  zoom: { type: 'number', default: 1, minimum: 0.01, maximum: 1e13, description: 'Magnification: the image height spans 3/zoom units of the complex plane' },
  iterations: { type: 'integer', default: 300, minimum: 1, maximum: 20000, description: 'Maximum iterations; raise it when zooming in (boundaries stay blobby otherwise)' },
  period: { type: 'number', default: 32, minimum: 0.5, maximum: 20000, description: 'Colouring: iterations per palette sweep. The smooth escape count runs through the palette forward then backward every 2·period iterations' },
  ...pal('magma'), ...BACKEND, ...OUT,
});
async function fractal(a, ctx, julia) {
  const { width: w, height: h } = a, s = 3 / (a.zoom * h);
  const f32ok = s > 2e-6 * Math.max(1, Math.abs(a.centerX), Math.abs(a.centerY));          // pixel pitch still resolvable in f32
  if (a.backend === 'cpu' || !f32ok) { if (w * h * a.iterations > 8e9 && a.backend !== 'gpu') throw new Error(`too heavy for the JS path (${w}×${h}×${a.iterations} iterations)${f32ok ? ' — use backend=gpu' : ' and this zoom is beyond the GPU\'s 32-bit float precision'}; reduce size or iterations`); }
  const { field, backend } = await onBackend(a, ctx,
    (dev) => gpuField(dev, w, h, FRACTAL_WGSL, [a.centerX, a.centerY, s, a.iterations, julia ? a.cRe : 0, julia ? a.cIm : 0, julia ? 1 : 0, 0, w, h], {}, a.iterations),
    () => fractalCPU(a, julia), f32ok);
  let inside = 0;
  for (let i = 0; i < field.length; i++) { const m = field[i]; if (m < 0) { inside++; continue; } const t = Math.max(0, m) / a.period, k = Math.floor(t); field[i] = k & 1 ? 1 - (t - k) : t - k; }
  const extra = { backend, precision: backend === 'webgpu' ? 'f32' : 'f64', centerX: a.centerX, centerY: a.centerY, zoom: a.zoom, iterations: a.iterations, insideFraction: +(inside / field.length).toFixed(4) };
  if (backend === 'webgpu' && !f32ok) extra.warning = 'zoom is beyond 32-bit float precision on the GPU; expect blocky pixels — use backend=cpu (float64)';
  if (backend === 'js' && !f32ok && a.backend === 'auto') extra.note = 'ran on the JS path (float64) because this zoom exceeds GPU float32 precision';
  return finish(julia ? 'julia' : 'mandelbrot', a, colorize(field, w, h, a.palette), extra);
}
register({
  name: 'synth.mandelbrot', gpu: true,
  description: 'Render the Mandelbrot set (z → z² + c from z = 0) around any centre at any zoom, with smooth (continuous) escape-time colouring through a palette; points inside the set are black. Endless fine structure with sharp filaments next to flat areas — a good stress image for compression, scaling and edge detection. WebGPU computes in 32-bit floats (fast, fine up to a zoom of a few thousand); past that, backend=auto switches to the float64 JS path. Returns the output stat, the backend and precision used, and the fraction of pixels inside the set.',
  schema: { properties: fractalProps(-0.6, 0) },
  examples: ['synth.mandelbrot', 'synth.mandelbrot centerX=-0.7436 centerY=0.1318 zoom=400 iterations=1000 palette=fire', 'synth.mandelbrot width=1920 height=1080 palette=phosphor period=16'],
  run: (a, ctx) => fractal(a, ctx, false),
});
register({
  name: 'synth.julia', gpu: true,
  description: 'Render the Julia set of z → z² + c for a chosen constant c = cRe + i·cIm, with smooth escape-time colouring; points that never escape are black. Different c give dust, dendrites, spirals or connected blobs (try −0.8+0.156i, 0.285+0.01i, −0.4+0.6i, −0.7269+0.1889i). Same options and backends as synth.mandelbrot. Returns the output stat, backend, precision and inside fraction.',
  schema: { properties: { cRe: { type: 'number', default: -0.8, description: 'Real part of the constant c' }, cIm: { type: 'number', default: 0.156, description: 'Imaginary part of the constant c' }, ...fractalProps(0, 0) } },
  examples: ['synth.julia', 'synth.julia cRe=0.285 cIm=0.01 palette=ice iterations=500', 'synth.julia cRe=-0.4 cIm=0.6 zoom=1.5 palette=amber'],
  run: (a, ctx) => fractal(a, ctx, true),
});

// ────────────────────────────────────────────────────────── voronoi ──
register({
  name: 'synth.voronoi',
  description: 'Voronoi diagram of N seeded random sites: flat random-valued cells, the distance to the nearest site (F1), or cell borders (F2−F1). Metric can be Euclidean, Manhattan or Chebyshev. Use cells as a segmentation / colour-quantisation test with a known number of regions, edges as a crack or network texture. Returns the output stat, the number of sites and the first 50 site coordinates.',
  schema: { properties: { ...size(), sites: { type: 'integer', default: 48, minimum: 1, maximum: 20000, description: 'Number of random sites (= number of cells)' }, mode: { type: 'string', enum: ['cells', 'distance', 'edges'], default: 'cells', description: 'cells = one flat value per cell; distance = distance to the nearest site; edges = dark lines on cell borders' }, metric: { type: 'string', enum: ['euclidean', 'manhattan', 'chebyshev'], default: 'euclidean', description: 'Distance metric' }, edgeWidth: { type: 'number', default: 3, minimum: 0.5, maximum: 100, description: 'edges mode: border thickness in pixels' }, ...SEED, ...pal('viridis'), ...OUT } },
  examples: ['synth.voronoi', 'synth.voronoi sites=200 mode=edges palette=gray', 'synth.voronoi sites=30 mode=distance metric=manhattan palette=ice'],
  async run(a) {
    const { width: w, height: h, sites: n } = a, R = rng(a.seed);
    const sx = new Float32Array(n), sy = new Float32Array(n), sv = new Float32Array(n);
    for (let i = 0; i < n; i++) { sx[i] = R() * w; sy[i] = R() * h; sv[i] = R(); }
    const g = Math.max(1, Math.floor(Math.sqrt(n / 2))), cw = w / g, ch = h / g, minCell = Math.min(cw, ch), buckets = Array.from({ length: g * g }, () => []);
    for (let i = 0; i < n; i++) buckets[Math.min(g - 1, Math.floor(sy[i] / ch)) * g + Math.min(g - 1, Math.floor(sx[i] / cw))].push(i);
    const dist = a.metric === 'euclidean' ? Math.hypot : a.metric === 'manhattan' ? (x, y) => Math.abs(x) + Math.abs(y) : (x, y) => Math.max(Math.abs(x), Math.abs(y));
    const norm = Math.sqrt((w * h) / n), needTwo = a.mode === 'edges';
    const f = fill(w, h, (x, y) => {
      const px = x + 0.5, py = y + 0.5, gx0 = Math.min(g - 1, Math.floor(px / cw)), gy0 = Math.min(g - 1, Math.floor(py / ch));
      let d1 = Infinity, d2 = Infinity, who = 0, who2 = 0;
      for (let r = 0; r <= g; r++) {
        const xa = gx0 - r, xb = gx0 + r, ya = gy0 - r, yb = gy0 + r;
        for (let gy = ya; gy <= yb; gy++) {
          if (gy < 0 || gy >= g) continue;
          const step = gy === ya || gy === yb ? 1 : Math.max(1, xb - xa);
          for (let gx = xa; gx <= xb; gx += step) {
            if (gx < 0 || gx >= g) continue;
            for (const i of buckets[gy * g + gx]) { const d = dist(sx[i] - px, sy[i] - py); if (d < d1) { d2 = d1; who2 = who; d1 = d; who = i; } else if (d < d2) { d2 = d; who2 = i; } }
          }
        }
        if ((needTwo ? d2 : d1) <= r * minCell) break;
      }
      if (a.mode === 'cells') return sv[who];
      if (a.mode === 'distance') return clamp01(d1 / norm);
      if (d2 === Infinity) return 1;
      // euclidean: true distance to the bisector between the two nearest sites; other metrics: F2−F1
      const e = a.metric === 'euclidean' ? (d2 * d2 - d1 * d1) / (2 * Math.hypot(sx[who] - sx[who2], sy[who] - sy[who2]) || 1) : (d2 - d1) / 2;
      return clamp01(e / (a.edgeWidth / 2));
    });
    const list = []; for (let i = 0; i < Math.min(n, 50); i++) list.push([+sx[i].toFixed(1), +sy[i].toFixed(1)]);
    return finish('voronoi', a, colorize(f, w, h, a.palette), { sites: n, mode: a.mode, metric: a.metric, siteCoords: list, truncated: n > 50 });
  },
});

// ──────────────────────────────────────────────────────── automata ──
register({
  name: 'synth.automaton',
  description: 'Cellular automata as images. type=elementary: a 1-D Wolfram rule (0–255) drawn as a space-time diagram, one generation per row from the top (rule 30 chaos, 90 Sierpinski, 110 complex, 184 traffic). type=life: a 2-D life-like automaton (default Conway B3/S23, any B…/S… rule) started from seeded random soup and shown after N steps. Cells are drawn as `cell`-pixel squares, live = palette top, dead = palette bottom. Binary, structured, exactly reproducible — good for testing morphology, connected components and lossless compression. Returns the output stat, the grid size and the number of live cells in the final image.',
  schema: {
    properties: {
      type: { type: 'string', enum: ['elementary', 'life'], default: 'elementary', description: 'elementary = 1-D rule over time; life = 2-D life-like rule after `steps` generations' },
      ...size(),
      cell: { type: 'integer', default: 2, minimum: 1, maximum: 64, description: 'Pixel size of one cell; the grid is width/cell × height/cell cells' },
      rule: { type: 'integer', default: 30, minimum: 0, maximum: 255, description: 'elementary: Wolfram rule number' },
      lifeRule: { type: 'string', default: 'B3/S23', description: 'life: birth/survival rule in B/S notation, e.g. B3/S23 (Conway), B36/S23 (HighLife), B2/S (Seeds), B3/S12345 (Maze)' },
      steps: { type: 'integer', default: 100, minimum: 0, maximum: 100000, description: 'life: number of generations to run' },
      init: { type: 'string', enum: ['single', 'random'], default: 'single', description: 'elementary: first row is a single live cell in the middle, or random. life always starts random' },
      density: { type: 'number', default: 0.35, minimum: 0, maximum: 1, description: 'Probability that a cell starts alive in random initial states' },
      wrap: { type: 'boolean', default: true, description: 'Wrap around the edges (torus); otherwise cells outside are dead' },
      ...SEED, ...pal(), ...OUT,
    },
  },
  examples: ['synth.automaton rule=30', 'synth.automaton rule=110 init=random cell=3 palette=phosphor', 'synth.automaton type=life steps=200 cell=4 seed=5', 'synth.automaton type=life lifeRule=B3/S12345 steps=300 density=0.1'],
  async run(a) {
    const { width: w, height: h, cell } = a, cols = Math.max(1, Math.floor(w / cell)), rows = Math.max(1, Math.floor(h / cell)), R = rng(a.seed);
    const grid = new Uint8Array(cols * rows); let extra;
    if (a.type === 'elementary') {
      if (a.init === 'single') grid[cols >> 1] = 1; else for (let x = 0; x < cols; x++) grid[x] = R() < a.density ? 1 : 0;
      for (let y = 1; y < rows; y++) for (let x = 0; x < cols; x++) {
        const p = (y - 1) * cols, l = x > 0 ? grid[p + x - 1] : a.wrap ? grid[p + cols - 1] : 0, r = x < cols - 1 ? grid[p + x + 1] : a.wrap ? grid[p] : 0;
        grid[y * cols + x] = (a.rule >> ((l << 2) | (grid[p + x] << 1) | r)) & 1;
      }
      extra = { type: 'elementary', rule: a.rule, generations: rows };
    } else {
      const m = /^B(\d*)\/S(\d*)$/i.exec(a.lifeRule.trim());
      if (!m) throw new Error(`lifeRule "${a.lifeRule}" is not B…/S… notation — e.g. B3/S23`);
      if (cols * rows * a.steps > 2e9) throw new Error(`too heavy: ${cols}×${rows} cells × ${a.steps} steps — reduce steps, or raise cell`);
      const born = new Uint8Array(9), keep = new Uint8Array(9); for (const c of m[1]) born[+c] = 1; for (const c of m[2]) keep[+c] = 1;
      for (let i = 0; i < grid.length; i++) grid[i] = R() < a.density ? 1 : 0;
      let cur = grid, nxt = new Uint8Array(grid.length);
      for (let s = 0; s < a.steps; s++) {
        for (let y = 0; y < rows; y++) {
          const ym = y > 0 ? y - 1 : a.wrap ? rows - 1 : -1, yp = y < rows - 1 ? y + 1 : a.wrap ? 0 : -1;
          for (let x = 0; x < cols; x++) {
            const xm = x > 0 ? x - 1 : a.wrap ? cols - 1 : -1, xp = x < cols - 1 ? x + 1 : a.wrap ? 0 : -1; let n = 0;
            if (ym >= 0) { if (xm >= 0) n += cur[ym * cols + xm]; n += cur[ym * cols + x]; if (xp >= 0) n += cur[ym * cols + xp]; }
            if (xm >= 0) n += cur[y * cols + xm]; if (xp >= 0) n += cur[y * cols + xp];
            if (yp >= 0) { if (xm >= 0) n += cur[yp * cols + xm]; n += cur[yp * cols + x]; if (xp >= 0) n += cur[yp * cols + xp]; }
            nxt[y * cols + x] = cur[y * cols + x] ? keep[n] : born[n];
          }
        }
        [cur, nxt] = [nxt, cur];
      }
      grid.set(cur); extra = { type: 'life', lifeRule: a.lifeRule.toUpperCase(), steps: a.steps };
    }
    let alive = 0; for (let i = 0; i < grid.length; i++) alive += grid[i];
    const f = fill(w, h, (x, y) => { const cx = Math.floor(x / cell), cy = Math.floor(y / cell); return cx < cols && cy < rows ? grid[cy * cols + cx] : 0; });
    return finish('automaton', a, colorize(f, w, h, a.palette), { ...extra, cols, rows, cell, alive, aliveFraction: +(alive / grid.length).toFixed(4) });
  },
});

// ───────────────────────────────────────────────── reaction-diffusion ──
const RD_PRESETS = { coral: [0.0545, 0.062], mitosis: [0.0367, 0.0649], spots: [0.03, 0.062], maze: [0.029, 0.057], worms: [0.078, 0.061], holes: [0.039, 0.058], waves: [0.014, 0.045], fingerprint: [0.037, 0.06] };
const RD_WGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<uniform> U: array<vec4f, 8>;   // U[0] = (Du, Dv, feed, kill)  U[1].x = dt
fn at(p: vec2i) -> vec2f { let d = vec2i(textureDimensions(src)); return textureLoad(src, ((p % d) + d) % d, 0).rg; }
@fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = vec2i(pos.xy); let c = at(p);
  let lap = 0.2 * (at(p + vec2i(1, 0)) + at(p - vec2i(1, 0)) + at(p + vec2i(0, 1)) + at(p - vec2i(0, 1)))
          + 0.05 * (at(p + vec2i(1, 1)) + at(p + vec2i(-1, 1)) + at(p + vec2i(1, -1)) + at(p + vec2i(-1, -1))) - c;
  let uvv = c.x * c.y * c.y; let dt = U[1].x;
  return vec4f(c.x + dt * (U[0].x * lap.x - uvv + U[0].z * (1.0 - c.x)), c.y + dt * (U[0].y * lap.y + uvv - (U[0].z + U[0].w) * c.y), 0.0, 1.0);
}`;
function rdInit(w, h, spots, seed) {
  const R = rng(seed), s = new Float32Array(w * h * 2);
  for (let i = 0; i < w * h; i++) s[i * 2] = 1;
  const side = Math.max(3, Math.round(Math.min(w, h) / 24));
  for (let k = 0; k < spots; k++) {
    const cx = Math.floor(R() * w), cy = Math.floor(R() * h), sw = side + Math.floor(R() * side), sh = side + Math.floor(R() * side);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) { const i = (((cy + y) % h) * w + ((cx + x) % w)) * 2; s[i] = 0.5 + 0.02 * (R() - 0.5); s[i + 1] = 0.25 + 0.02 * (R() - 0.5); }
  }
  return s;
}
async function rdGPU(device, w, h, init, P, steps, ctx) {
  rt.checkSize(device, w, h);
  return rt.scoped(device, async () => {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT;
    const tex = [0, 1].map(() => device.createTexture({ size: [w, h], format: 'rg32float', usage }));
    const ub = rt.uniformOf(device, Float32Array.from({ length: 32 }, (_, i) => [P.du, P.dv, P.feed, P.kill, P.dt][i] ?? 0));
    try {
      device.queue.writeTexture({ texture: tex[0] }, init, { bytesPerRow: w * 8, rowsPerImage: h }, [w, h]);
      const { pipeline, layout } = rt.renderPipeline(device, { code: RD_WGSL, kinds: ['utex', 'uniform'], format: 'rg32float' });
      const bg = tex.map((t) => rt.bind(device, layout, [t, ub])), view = tex.map((t) => t.createView());
      const batch = Math.max(1, Math.min(64, Math.floor(6e8 / (w * h * 9))));
      let cur = 0;
      for (let s = 0, b = 0; s < steps; b++) {
        const enc = device.createCommandEncoder(), n = Math.min(batch, steps - s);
        for (let k = 0; k < n; k++) { rt.pass(enc, pipeline, bg[cur], view[1 - cur]); cur = 1 - cur; }
        device.queue.submit([enc.finish()]); s += n;
        if (b % 8 === 7) { await device.queue.onSubmittedWorkDone(); ctx.progress(s / steps, 'gray-scott'); }
      }
      return await rt.readFloats(device, tex[cur], w, h, 2);
    } finally { tex[0].destroy(); tex[1].destroy(); ub.destroy(); }
  });
}
function rdCPU(w, h, init, P, steps) {
  const n = w * h; let u = new Float32Array(n), v = new Float32Array(n), u2 = new Float32Array(n), v2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { u[i] = init[i * 2]; v[i] = init[i * 2 + 1]; }
  const { du, dv, feed, kill, dt } = P, fk = feed + kill;
  for (let s = 0; s < steps; s++) {
    for (let y = 0; y < h; y++) {
      const yc = y * w, ym = (y ? y - 1 : h - 1) * w, yp = (y < h - 1 ? y + 1 : 0) * w;
      for (let x = 0; x < w; x++) {
        const l = x ? x - 1 : w - 1, r = x < w - 1 ? x + 1 : 0, i = yc + x, a = u[i], b = v[i];
        const lu = 0.2 * (u[yc + l] + u[yc + r] + u[ym + x] + u[yp + x]) + 0.05 * (u[ym + l] + u[ym + r] + u[yp + l] + u[yp + r]) - a;
        const lv = 0.2 * (v[yc + l] + v[yc + r] + v[ym + x] + v[yp + x]) + 0.05 * (v[ym + l] + v[ym + r] + v[yp + l] + v[yp + r]) - b;
        const uvv = a * b * b;
        u2[i] = a + dt * (du * lu - uvv + feed * (1 - a)); v2[i] = b + dt * (dv * lv + uvv - fk * b);
      }
    }
    [u, u2] = [u2, u]; [v, v2] = [v2, v];
  }
  const out = new Float32Array(n * 2); for (let i = 0; i < n; i++) { out[i * 2] = u[i]; out[i * 2 + 1] = v[i]; }
  return out;
}
register({
  name: 'synth.reactionDiffusion', gpu: true,
  description: `Gray-Scott reaction-diffusion: two virtual chemicals U and V diffuse and react (U + 2V → 3V) on a torus, growing organic Turing patterns — corals, dividing spots, mazes, worms — from a few seeded squares. The image shows the concentration of V after \`steps\` iterations. Presets (feed, kill): ${Object.entries(RD_PRESETS).map(([k, v]) => `${k} (${v[0]}, ${v[1]})`).join(', ')}; or set feed/kill yourself. Patterns need a few thousand steps; WebGPU runs them in well under a second, the JS path takes seconds (it refuses jobs above ~3·10⁹ cell-steps). Both paths run the same float32 scheme, but the system amplifies rounding differences, so backends agree in character, not pixel for pixel. Returns the output stat, backend, the parameters used and the mean of V.`,
  schema: {
    properties: {
      ...size(256, 256, 2048),
      preset: { type: 'string', enum: Object.keys(RD_PRESETS), default: 'coral', description: 'Named (feed, kill) pair; explicit feed/kill override it' },
      feed: { type: 'number', minimum: 0, maximum: 0.12, description: 'Feed rate F of U (overrides the preset)' },
      kill: { type: 'number', minimum: 0, maximum: 0.08, description: 'Kill rate k of V (overrides the preset)' },
      du: { type: 'number', default: 1, minimum: 0, maximum: 1.2, description: 'Diffusion rate of U' },
      dv: { type: 'number', default: 0.5, minimum: 0, maximum: 1.2, description: 'Diffusion rate of V' },
      dt: { type: 'number', default: 1, minimum: 0.05, maximum: 1.2, description: 'Time step (1 is stable for the default diffusion rates)' },
      steps: { type: 'integer', default: 4000, minimum: 0, maximum: 200000, description: 'Number of simulation steps' },
      spots: { type: 'integer', default: 12, minimum: 1, maximum: 2000, description: 'Number of random seed squares of V placed at the start' },
      ...SEED, ...pal('ice'), ...BACKEND, ...OUT,
    },
  },
  examples: ['synth.reactionDiffusion', 'synth.reactionDiffusion preset=mitosis steps=8000 width=512 height=512 palette=phosphor', 'synth.reactionDiffusion feed=0.029 kill=0.057 steps=10000 palette=mono1'],
  async run(a, ctx) {
    const { width: w, height: h } = a, [pf, pk] = RD_PRESETS[a.preset];
    const P = { du: a.du, dv: a.dv, feed: a.feed ?? pf, kill: a.kill ?? pk, dt: a.dt }, init = rdInit(w, h, a.spots, a.seed);
    const cpuTooHeavy = w * h * a.steps > 3e9;
    if (a.backend === 'cpu' && cpuTooHeavy) throw new Error(`too heavy for the JS path: ${w}×${h} × ${a.steps} steps — use backend=gpu/auto, or fewer steps / a smaller image`);
    const { field: uv, backend } = await onBackend(a, ctx, (dev) => rdGPU(dev, w, h, init, P, a.steps, ctx), () => {
      if (cpuTooHeavy) throw new Error(`WebGPU is unavailable and ${w}×${h} × ${a.steps} steps is too heavy for the JS path — use fewer steps or a smaller image`);
      return rdCPU(w, h, init, P, a.steps);
    });
    const f = new Float32Array(w * h); let sum = 0;
    for (let i = 0; i < f.length; i++) { const v = uv[i * 2 + 1]; sum += v; f[i] = clamp01(v / 0.4); }
    return finish('reactionDiffusion', a, colorize(f, w, h, a.palette), { backend, feed: P.feed, kill: P.kill, du: P.du, dv: P.dv, dt: P.dt, steps: a.steps, meanV: +(sum / f.length).toFixed(5) });
  },
});

// ─────────────────────────────────────────────────── truchet / maze ──
register({
  name: 'synth.truchet',
  description: 'Truchet tiling: a grid of square tiles, each randomly put in one of two orientations (seeded). style=arcs gives the classic meandering quarter-circle paths, lines the diagonal labyrinth ("10 PRINT"), triangles the original half-filled tiles. Curved and diagonal antialiased strokes on a regular grid — useful for testing line/contour tracing, thinning and texture analysis. Returns the output stat and the tile grid size.',
  schema: { properties: { ...size(), tile: { type: 'integer', default: 32, minimum: 4, maximum: 1024, description: 'Tile side in pixels' }, style: { type: 'string', enum: ['arcs', 'lines', 'triangles'], default: 'arcs', description: 'Tile motif' }, lineWidth: { type: 'number', default: 4, minimum: 0.5, maximum: 512, description: 'Stroke width in pixels (arcs, lines)' }, bias: { type: 'number', default: 0.5, minimum: 0, maximum: 1, description: 'Probability of the second orientation (0 or 1 gives a perfectly regular pattern)' }, ...SEED, ...pal(), ...OUT } },
  examples: ['synth.truchet', 'synth.truchet style=lines tile=16 lineWidth=2 palette=phosphor', 'synth.truchet style=triangles tile=24 seed=9'],
  async run(a) {
    const { width: w, height: h, tile: T } = a, S = a.seed >>> 0, hw = a.lineWidth / 2;
    const f = fill(w, h, (x, y) => {
      const tx = Math.floor(x / T), ty = Math.floor(y / T); let u = x + 0.5 - tx * T; const v = y + 0.5 - ty * T;
      if (u01(hash(tx, ty, S)) < a.bias) u = T - u;                    // mirror the tile
      if (a.style === 'triangles') return u + v < T ? 1 : 0;
      const d = a.style === 'arcs' ? Math.min(Math.abs(Math.hypot(u, v) - T / 2), Math.abs(Math.hypot(T - u, T - v) - T / 2)) : Math.abs(u - v) / Math.SQRT2;
      return clamp01(hw - d + 0.5);
    });
    return finish('truchet', a, colorize(f, w, h, a.palette), { style: a.style, cols: Math.ceil(w / T), rows: Math.ceil(h / T), tile: T });
  },
});

register({
  name: 'synth.maze',
  description: 'Perfect maze (exactly one path between any two cells) carved by a seeded depth-first search: white corridors, black walls, entrance at the top-left, exit at the bottom-right. Optionally draws the solution in mid-gray. Hard-edged orthogonal structure with a known answer — use it for path-finding, skeleton/thinning, morphology and connected-component tests (the corridors form exactly one component). Returns the output stat, grid size, pixel geometry and the length of the solution path in cells.',
  schema: { properties: { ...size(), cell: { type: 'integer', default: 16, minimum: 2, maximum: 512, description: 'Pitch of the grid in pixels (corridor + one wall)' }, wall: { type: 'integer', default: 2, minimum: 1, maximum: 256, description: 'Wall thickness in pixels (must be smaller than cell)' }, solution: { type: 'boolean', default: false, description: 'Paint the entrance→exit path at palette midpoint' }, ...SEED, ...pal(), ...OUT } },
  examples: ['synth.maze', 'synth.maze cell=8 wall=1 width=400 height=300 seed=3', 'synth.maze cell=24 wall=4 solution=true palette=amber'],
  async run(a) {
    const { width: w, height: h, cell: C, wall: W } = a;
    if (W >= C) throw new Error(`wall (${W}) must be smaller than cell (${C})`);
    const cols = Math.floor((w - W) / C), rows = Math.floor((h - W) / C);
    if (cols < 2 || rows < 2) throw new Error(`image ${w}×${h} is too small for cell=${C}: need at least 2×2 cells (${2 * C + W} px each way)`);
    const R = rng(a.seed), n = cols * rows, right = new Uint8Array(n), down = new Uint8Array(n), seen = new Uint8Array(n), stack = [0]; seen[0] = 1;
    while (stack.length) {
      const c = stack[stack.length - 1], cx = c % cols, cy = (c - cx) / cols, opt = [];
      if (cx > 0 && !seen[c - 1]) opt.push(c - 1); if (cx < cols - 1 && !seen[c + 1]) opt.push(c + 1);
      if (cy > 0 && !seen[c - cols]) opt.push(c - cols); if (cy < rows - 1 && !seen[c + cols]) opt.push(c + cols);
      if (!opt.length) { stack.pop(); continue; }
      const t = opt[Math.floor(R() * opt.length)];
      if (t === c + 1) right[c] = 1; else if (t === c - 1) right[t] = 1; else if (t === c + cols) down[c] = 1; else down[t] = 1;
      seen[t] = 1; stack.push(t);
    }
    // breadth-first solution from cell 0 to the last cell
    const prev = new Int32Array(n).fill(-1), queue = [0]; prev[0] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi], cx = c % cols;
      const go = (t) => { if (prev[t] < 0) { prev[t] = c; queue.push(t); } };
      if (cx < cols - 1 && right[c]) go(c + 1); if (cx > 0 && right[c - 1]) go(c - 1);
      if (c + cols < n && down[c]) go(c + cols); if (c >= cols && down[c - cols]) go(c - cols);
    }
    const path = []; for (let c = n - 1; ; c = prev[c]) { path.push(c); if (c === 0) break; }
    const ox = Math.floor((w - (cols * C + W)) / 2), oy = Math.floor((h - (rows * C + W)) / 2), f = new Float32Array(w * h);
    const carve = (x0, y0, cw, chh, v) => { for (let y = y0; y < y0 + chh; y++) for (let x = x0; x < x0 + cw; x++) if (x >= 0 && y >= 0 && x < w && y < h) f[y * w + x] = v; };
    const K = C - W;
    for (let c = 0; c < n; c++) {
      const cx = c % cols, cy = (c - cx) / cols, x0 = ox + W + cx * C, y0 = oy + W + cy * C;
      carve(x0, y0, K, K, 1); if (right[c]) carve(x0 + K, y0, W, K, 1); if (down[c]) carve(x0, y0 + K, K, W, 1);
    }
    carve(ox + W, oy, K, W, 1); carve(ox + W + (cols - 1) * C, oy + W + (rows - 1) * C + K, K, W, 1);         // entrance, exit
    if (a.solution) {
      const m = Math.max(1, Math.floor(K / 3)), o = Math.floor((K - m) / 2);
      for (let i = 0; i < path.length; i++) {
        const c = path[i], cx = c % cols, cy = (c - cx) / cols, x0 = ox + W + cx * C + o, y0 = oy + W + cy * C + o; carve(x0, y0, m, m, 0.5);
        if (i + 1 < path.length) { const t = path[i + 1], d = t - c; if (d === 1) carve(x0 + m, y0, C - m, m, 0.5); else if (d === -1) carve(x0 - (C - m), y0, C - m, m, 0.5); else if (d === cols) carve(x0, y0 + m, m, C - m, 0.5); else carve(x0, y0 - (C - m), m, C - m, 0.5); }
      }
    }
    const centre = (c) => { const cx = c % cols, cy = (c - cx) / cols; return [ox + W + cx * C + K / 2, oy + W + cy * C + K / 2]; };
    return finish('maze', a, colorize(f, w, h, a.palette), { cols, rows, cell: C, wall: W, corridor: K, origin: [ox, oy], start: centre(0), end: centre(n - 1), solutionCells: path.length, solutionDrawn: a.solution });
  },
});

// ─────────────────────────────────────────────── shapes (ground truth) ──
register({
  name: 'synth.shapes',
  description: 'Scatter separate solid shapes — circles, axis-aligned rectangles, irregular blobs — on a flat background, and return the ground truth: the exact number of shapes and, for each, its kind, pixel area, centroid and bounding box. Shapes are unantialiased and never touch each other or the border (at least `gap` pixels apart), so a correct connected-components / blob-counting / object-detection run on this image must find exactly `count` objects. Use it to validate analysis.components, thresholding, contour and measurement tools. If the canvas is too crowded to place every requested shape, `count` is the number actually drawn (and `requested` the number asked for). Optional Gaussian noise makes the task harder.',
  schema: {
    properties: {
      ...size(),
      count: { type: 'integer', default: 12, minimum: 1, maximum: 2000, description: 'Number of shapes to place' },
      kinds: { type: 'array', items: { type: 'string', enum: ['circle', 'rect', 'blob'] }, default: ['circle', 'rect', 'blob'], description: 'Shape kinds to draw (chosen at random per shape)' },
      minSize: { type: 'number', default: 20, minimum: 3, maximum: 2048, description: 'Smallest shape diameter in pixels' },
      maxSize: { type: 'number', default: 70, minimum: 3, maximum: 2048, description: 'Largest shape diameter in pixels' },
      gap: { type: 'integer', default: 4, minimum: 2, maximum: 512, description: 'Minimum empty distance between shapes and to the border, in pixels' },
      color: { type: 'string', default: 'white', description: 'Shape colour: any CSS colour, or "random" for a different bright colour per shape (each has Rec.709 luma ≥ 80)' },
      background: { type: 'string', default: '#000000', description: 'Background colour (any CSS colour)' },
      noise: { type: 'number', default: 0, minimum: 0, maximum: 100, description: 'Standard deviation of Gaussian noise added to every pixel (0 = clean)' },
      ...SEED, ...OUT,
    },
  },
  examples: ['synth.shapes', 'synth.shapes count=40 kinds=circle minSize=10 maxSize=30 seed=4', 'synth.shapes count=8 color=random noise=12'],
  async run(a) {
    const { width: w, height: h } = a, R = rng(a.seed);
    if (a.maxSize < a.minSize) throw new Error(`maxSize (${a.maxSize}) must be ≥ minSize (${a.minSize})`);
    if (!a.kinds.length) throw new Error('kinds must list at least one of: circle, rect, blob');
    const bg = parseColor(a.background), fixed = a.color === 'random' ? null : parseColor(a.color);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let q = 0; q < data.length; q += 4) { data[q] = bg[0]; data[q + 1] = bg[1]; data[q + 2] = bg[2]; data[q + 3] = 255; }
    const placed = [], shapes = [];
    for (let tries = 0; shapes.length < a.count && tries < a.count * 300; tries++) {
      const r = (a.minSize + R() * (a.maxSize - a.minSize)) / 2, kind = a.kinds[Math.floor(R() * a.kinds.length)];
      const cx = r + a.gap + R() * (w - 2 * (r + a.gap)), cy = r + a.gap + R() * (h - 2 * (r + a.gap)), q1 = R(), q2 = R(), q3 = R(), q4 = R(), q5 = R(), q6 = R();
      if (w < 2 * (r + a.gap) + 1 || h < 2 * (r + a.gap) + 1) continue;
      if (placed.some((p) => Math.hypot(p.cx - cx, p.cy - cy) < p.r + r + a.gap + 1)) continue;
      let inside;
      if (kind === 'circle') inside = (dx, dy) => dx * dx + dy * dy <= r * r;
      else if (kind === 'rect') { const t = 0.35 + 0.8 * q1, hw = Math.max(1, r * Math.cos(t)), hh = Math.max(1, r * Math.sin(t)); inside = (dx, dy) => Math.abs(dx) <= hw && Math.abs(dy) <= hh; } else {
        const amp = [0.17 * q1, 0.12 * q2, 0.06 * q3], ph = [q4 * TAU, q5 * TAU, q6 * TAU];
        inside = (dx, dy) => { const th = Math.atan2(dy, dx), rr = r * (0.64 + amp[0] * Math.cos(2 * th + ph[0]) + amp[1] * Math.cos(3 * th + ph[1]) + amp[2] * Math.cos(5 * th + ph[2])); return dx * dx + dy * dy <= rr * rr; };
      }
      let col = fixed;
      if (!col) { col = hsv(R(), 0.55 + 0.45 * R(), 0.8 + 0.2 * R()).map(Math.round); let g = 0; while (0.2126 * col[0] + 0.7152 * col[1] + 0.0722 * col[2] < 80 && g++ < 20) col = col.map((v) => Math.round(v + (255 - v) * 0.2)); }
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
      let area = 0, sx = 0, sy = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(x + 0.5 - cx, y + 0.5 - cy)) { const q = (y * w + x) * 4; data[q] = col[0]; data[q + 1] = col[1]; data[q + 2] = col[2]; area++; sx += x; sy += y; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
      if (!area) continue;
      placed.push({ cx, cy, r });
      shapes.push({ id: shapes.length + 1, kind, area, centroid: [+(sx / area).toFixed(2), +(sy / area).toFixed(2)], bbox: [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1], rgb: col.slice(0, 3) });
    }
    if (a.noise > 0) for (let q = 0; q < data.length; q += 4) { data[q] += gauss(R) * a.noise; data[q + 1] += gauss(R) * a.noise; data[q + 2] += gauss(R) * a.noise; }
    const byKind = {}; for (const s of shapes) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
    return finish('shapes', a, { width: w, height: h, data }, { count: shapes.length, requested: a.count, byKind, totalArea: shapes.reduce((t, s) => t + s.area, 0), background: bg.slice(0, 3), noise: a.noise, connectivity: 'shapes are ≥ gap px apart: 4- and 8-connected labelling both give `count` components', shapes: shapes.slice(0, 100), truncated: shapes.length > 100 });
  },
});

// ──────────────────────────────────────────────────────────── scene ──
register({
  name: 'synth.scene',
  description: 'A photo-like landscape composite built to exercise filters the way a real photograph does: a smooth sky gradient with a glowing sun and soft fractal clouds (low frequencies, banding-prone), layered mountain silhouettes (strong irregular edges, atmospheric haze), a textured field with perspective furrows (fine detail, frequency sweep), a building with a regular window grid, a round sign on a pole and thin wires (hard edges, periodic detail, 1-px lines), lens vignetting and Gaussian sensor noise. Fully seeded; the result reports where the main elements are (horizon, sun, building, sign) so you can crop them or check detectors. Use it wherever you would otherwise need "some photo".',
  schema: {
    properties: {
      ...size(768, 512),
      sunHeight: { type: 'number', default: 0.35, minimum: 0, maximum: 1, description: 'Sun elevation: 0 = on the horizon (warm sunset colours), 1 = high (blue daylight)' },
      clouds: { type: 'number', default: 0.5, minimum: 0, maximum: 1, description: 'Cloud cover' },
      layers: { type: 'integer', default: 3, minimum: 0, maximum: 6, description: 'Number of mountain ridges' },
      noise: { type: 'number', default: 3, minimum: 0, maximum: 60, description: 'Sensor noise: standard deviation of per-channel Gaussian noise (0 = clean)' },
      vignette: { type: 'number', default: 0.35, minimum: 0, maximum: 1, description: 'Corner darkening strength' },
      objects: { type: 'boolean', default: true, description: 'Draw the man-made objects (building, sign, wires)' },
      ...SEED, ...OUT,
    },
  },
  examples: ['synth.scene', 'synth.scene seed=8 sunHeight=0.05 clouds=0.8', 'synth.scene width=1920 height=1080 noise=0 vignette=0'],
  async run(a) {
    const { width: w, height: h } = a, R = rng(a.seed), S = a.seed >>> 0, m = Math.min(w, h);
    const hz = Math.round(h * (0.56 + 0.08 * R())), sunX = w * (0.15 + 0.7 * R()), sunY = hz * (0.92 - 0.75 * a.sunHeight), sunR = m * 0.04;
    const mix3 = (A, B, t) => [lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t)];
    const top = mix3([24, 28, 78], [38, 96, 196], a.sunHeight), low = mix3([250, 150, 84], [186, 216, 246], a.sunHeight), sunC = mix3([255, 214, 150], [255, 252, 236], a.sunHeight);
    const ridges = [];
    for (let l = 0; l < a.layers; l++) {
      const amp = h * (0.3 - 0.06 * l) * (0.7 + 0.5 * R()), base = hz - h * 0.02 * (a.layers - l), sc = w * (0.42 - 0.07 * l), off = R() * 1000, ys = new Float32Array(w);
      for (let x = 0; x < w; x++) ys[x] = base - amp * Math.pow(fbm(valueN, x / sc + off, l * 7.3, S + 100 + l, 6, 2, 0.5), 1.6);
      const k = (l + 1) / (a.layers + 0.6); ridges.push({ ys, col: mix3(mix3(low, [120, 130, 160], 0.6), [26, 34, 44], k) });
    }
    const bw = Math.round(w * (0.11 + 0.06 * R())), bh = Math.round(h * (0.22 + 0.12 * R())), bx = Math.round(w * (0.08 + 0.55 * R())), by1 = Math.round(hz + (h - hz) * 0.28), by0 = by1 - bh;
    const nx = Math.max(2, Math.round(bw / (m * 0.028))), ny = Math.max(2, Math.round(bh / (m * 0.036))), lit = Array.from({ length: nx * ny }, () => R() < 0.3);
    const sgX = Math.round(bx + bw + w * (0.08 + 0.12 * R())), sgR = Math.round(m * 0.045), sgY = Math.round(hz + (h - hz) * 0.12 - sgR), poleB = Math.round(hz + (h - hz) * 0.55), poleW = Math.max(2, Math.round(m * 0.006));
    const wire = (x, sag) => { const t = x / Math.max(1, bx); return lerp(hz * 0.55, by0 + 2, t) + sag * 4 * t * (1 - t); };
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, q = 0; y < h; y++) for (let x = 0; x < w; x++, q += 4) {
      let c;
      if (y < hz) {
        c = mix3(top, low, Math.pow(y / hz, 1.4));
        const d = Math.hypot(x - sunX, y - sunY), glow = Math.exp(-d / (sunR * 5)) * 0.75;
        c = [c[0] + sunC[0] * glow, c[1] + sunC[1] * glow * 0.85, c[2] + sunC[2] * glow * 0.6];
        if (d < sunR + 1) c = mix3(c, sunC, clamp01(sunR + 0.5 - d));
        if (a.clouds > 0) { const n = fbm(perlinN, x / (m * 0.45), y / (m * 0.14), S + 7, 5, 2, 0.55), cv = smooth(0.62 - 0.3 * a.clouds, 0.86 - 0.3 * a.clouds, n) * (0.35 + 0.65 * (1 - y / hz)); c = mix3(c, mix3([255, 246, 236], low, 0.25), cv * 0.9); }
      } else {
        const d = (y - hz) / Math.max(1, h - hz), tex = fbm(perlinN, x / (3 + 26 * d), y / (2 + 12 * d), S + 31, 3, 2, 0.5);
        const fur = 0.5 + 0.5 * Math.sin(((x - w / 2) / (d + 0.04)) * (38 / w)), g = 0.55 + 0.45 * d;
        c = mix3([96, 132, 62], [44, 78, 38], tex * 0.8 + fur * 0.2); c = mix3(mix3(low, [120, 130, 160], 0.6), [c[0] * g, c[1] * g, c[2] * g], smooth(0, 0.12, d) * 0.85 + 0.15);
      }
      for (const r of ridges) if (y >= r.ys[x] && y < hz + 1) c = mix3(c, r.col, clamp01(y - r.ys[x] + 0.5));
      if (a.objects) {
        if (x >= bx && x < bx + bw && y >= by0 && y < by1) {
          c = [150 - 30 * ((x - bx) / bw), 142 - 30 * ((x - bx) / bw), 132 - 26 * ((x - bx) / bw)];
          const u = ((x - bx) / bw) * nx, v = ((y - by0) / bh) * ny, fu = u - Math.floor(u), fv = v - Math.floor(v);
          if (fu > 0.22 && fu < 0.78 && fv > 0.2 && fv < 0.72) c = lit[Math.floor(v) * nx + Math.floor(u)] ? [252, 222, 128] : [38, 48, 70];
          if (y < by0 + 3) c = [60, 56, 54];
        }
        if (Math.abs(x - sgX) < poleW / 2 && y > sgY && y < poleB) c = [48, 44, 42];
        const ds = Math.hypot(x + 0.5 - sgX, y + 0.5 - sgY); if (ds < sgR) c = ds > sgR * 0.72 ? [204, 28, 34] : [244, 244, 240];
        if (x < bx) for (const sag of [m * 0.05, m * 0.08]) { const wy = wire(x, sag); if (Math.abs(y + 0.5 - wy) < 0.75) c = mix3(c, [20, 20, 24], 0.85); }
      }
      if (a.vignette > 0) { const dx = (x - w / 2) / (w / 2), dy = (y - h / 2) / (h / 2), vg = 1 - a.vignette * 0.5 * (dx * dx + dy * dy); c = [c[0] * vg, c[1] * vg, c[2] * vg]; }
      if (a.noise > 0) c = [c[0] + gauss(R) * a.noise, c[1] + gauss(R) * a.noise, c[2] + gauss(R) * a.noise];
      data[q] = c[0]; data[q + 1] = c[1]; data[q + 2] = c[2]; data[q + 3] = 255;
    }
    const features = { horizonY: hz, sun: { x: Math.round(sunX), y: Math.round(sunY), r: Math.round(sunR) }, mountainLayers: a.layers };
    if (a.objects) Object.assign(features, { building: { x: bx, y: by0, w: bw, h: bh, windows: [nx, ny] }, sign: { x: sgX, y: sgY, r: sgR }, wires: 2 });
    return finish('scene', a, { width: w, height: h, data }, { seed: a.seed, noise: a.noise, features });
  },
});

// ───────────────────────────────────────────────────────────── text ──
register({
  name: 'synth.text',
  description: 'Render a string to an image with the browser\'s text engine — ground truth for OCR and text-detection tests, or a quick label/caption maker. Multi-line (use \\n), optional word-wrap to a fixed width, any CSS font family, size, colours, alignment; rotation and Gaussian noise make recognition harder on purpose. With no width/height the image is sized to fit the text. The result returns the exact lines drawn and the bounding box of the ink. Glyph shapes depend on the fonts installed on this machine, so pixels (not content) can differ between machines.',
  schema: {
    properties: {
      text: { type: 'string', description: 'The text to draw; "\\n" starts a new line' },
      font: { type: 'string', default: 'monospace', description: 'CSS font-family, e.g. monospace, serif, sans-serif, "Courier New", Georgia' },
      size: { type: 'number', default: 32, minimum: 4, maximum: 512, description: 'Font size in pixels' },
      weight: { type: 'string', default: 'normal', description: 'CSS font-weight: normal, bold, or 100–900' },
      italic: { type: 'boolean', default: false, description: 'Italic style' },
      color: { type: 'string', default: '#000000', description: 'Text colour (any CSS colour)' },
      background: { type: 'string', default: '#ffffff', description: 'Background colour (any CSS colour; "transparent" allowed)' },
      width: { type: 'integer', minimum: 1, maximum: MAX, description: 'Image width; when set, long lines are word-wrapped to fit (default: fit the text)' },
      height: { type: 'integer', minimum: 1, maximum: MAX, description: 'Image height (default: fit the text)' },
      padding: { type: 'integer', default: 16, minimum: 0, maximum: 1024, description: 'Margin around the text in pixels' },
      align: { type: 'string', enum: ['left', 'center', 'right'], default: 'left', description: 'Horizontal alignment of the lines' },
      lineHeight: { type: 'number', default: 1.3, minimum: 0.5, maximum: 5, description: 'Line spacing as a multiple of the font size' },
      rotate: { type: 'number', default: 0, minimum: -180, maximum: 180, description: 'Rotate the text block by this many degrees (clockwise)' },
      noise: { type: 'number', default: 0, minimum: 0, maximum: 100, description: 'Standard deviation of Gaussian noise added after drawing' },
      ...SEED, ...OUT,
    },
    required: ['text'],
  },
  examples: ['synth.text text="The quick brown fox"', 'synth.text text="INVOICE 2041\\nTotal: 318.50 EUR" font=serif size=40 padding=32', 'synth.text text="rotated and noisy" rotate=7 noise=20 color=#222 background=#eee'],
  async run(a) {
    const font = `${a.italic ? 'italic ' : ''}${a.weight} ${a.size}px ${a.font}`, pad = a.padding;
    const probe = canvasOf(1, 1).getContext('2d'); probe.font = font;
    let lines = a.text.replace(/\\n/g, '\n').replace(/\r/g, '').split('\n');
    if (a.width) {
      const maxW = Math.max(1, a.width - 2 * pad), wrapped = [];
      for (const ln of lines) { let cur = ''; for (const word of ln.split(/(\s+)/)) { if (cur && probe.measureText((cur + word).trimEnd()).width > maxW) { wrapped.push(cur.trimEnd()); cur = word.trimStart(); } else cur += word; } wrapped.push(cur.trimEnd()); }
      lines = wrapped;
    }
    if (lines.length > 400) throw new Error(`text wraps to ${lines.length} lines — more than 400; use a larger width or smaller text`);
    const lh = a.size * a.lineHeight, tw = Math.max(1, ...lines.map((l) => probe.measureText(l).width)), th = lines.length * lh;
    const rad = (a.rotate * Math.PI) / 180, co = Math.abs(Math.cos(rad)), si = Math.abs(Math.sin(rad));
    const W = a.width || Math.ceil(tw * co + th * si + 2 * pad), H = a.height || Math.ceil(tw * si + th * co + 2 * pad);
    if (W > MAX || H > MAX) throw new Error(`the text needs ${W}×${H} pixels, above the ${MAX} limit — reduce size, or set width to wrap`);
    const c = canvasOf(W, H), g = c.getContext('2d', { willReadFrequently: true });
    const bgc = parseColor(a.background); parseColor(a.color);
    g.fillStyle = a.background; g.fillRect(0, 0, W, H);
    g.font = font; g.fillStyle = a.color; g.textBaseline = 'middle'; g.textAlign = a.align;
    g.translate(W / 2, H / 2); g.rotate(rad);
    const ax = a.align === 'left' ? -tw / 2 : a.align === 'right' ? tw / 2 : 0;
    lines.forEach((l, i) => g.fillText(l, ax, (i - (lines.length - 1) / 2) * lh));
    const id = g.getImageData(0, 0, W, H), d = id.data; let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0, q = 0; y < H; y++) for (let x = 0; x < W; x++, q += 4) if (Math.abs(d[q] - bgc[0]) + Math.abs(d[q + 1] - bgc[1]) + Math.abs(d[q + 2] - bgc[2]) + Math.abs(d[q + 3] - bgc[3]) > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (a.noise > 0) { const R = rng(a.seed); for (let q = 0; q < d.length; q += 4) { const n = gauss(R) * a.noise; d[q] += n; d[q + 1] += n; d[q + 2] += n; } }
    return finish('text', a, { width: W, height: H, data: d }, { text: lines.join('\n'), lines: lines.slice(0, 100), lineCount: lines.length, font: g.font, inkBox: x1 >= 0 ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null, clipped: x1 >= 0 && (x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === H - 1), rotate: a.rotate, noise: a.noise });
  },
});

// ─────────────────────────────────────────────────────────── sample ──
register({
  name: 'synth.sample',
  description: 'Drop a starter set of varied synthetic images into the VFS in one call, so there is something to work on immediately: a test card, a photo-like scene, counted shapes, a line of text, fractal noise, a Mandelbrot detail, a zone plate, a colour gradient, a Voronoi mosaic and a maze. Each is made by the corresponding synth.* tool with the given seed and size. Returns the list of files written and the ground truth that goes with them (shape count, the text string, maze solution length, …). Call the individual synth.* tools for full control.',
  schema: {
    properties: {
      prefix: { type: 'string', default: 'sample/', description: 'Path prefix for the files (existing files with the same names are overwritten)' },
      size: { type: 'integer', default: 384, minimum: 64, maximum: 2048, description: 'Height of every image in pixels; widths follow each image\'s natural aspect' },
      text: { type: 'string', default: 'The quick brown fox jumps over the lazy dog 0123456789', description: 'String rendered into text.png' },
      ...SEED, ...BACKEND,
    },
  },
  examples: ['synth.sample', 'synth.sample prefix=test/ size=512 seed=42'],
  async run({ prefix, size: s, text, seed, backend }, ctx) {
    const wide = Math.round((s * 3) / 2), p = (n) => `${prefix}${n}.png`;
    const jobs = [
      ['testcard', { width: Math.round((s * 4) / 3), height: s }, (r) => ({ bars: r.bars.map((b) => b.name), regions: r.regions.length })],
      ['scene', { width: wide, height: s, seed }, (r) => r.features],
      ['shapes', { width: s, height: s, seed, count: 12, minSize: Math.max(6, s / 20), maxSize: Math.max(12, s / 6) }, (r) => ({ count: r.count, byKind: r.byKind })],
      ['text', { text, size: Math.max(12, Math.round(s / 14)), width: wide, seed }, (r) => ({ text: r.text, lineCount: r.lineCount })],
      ['noise', { width: s, height: s, seed, type: 'perlin', scale: s / 5, octaves: 5, backend }, (r) => ({ type: r.type, backend: r.backend })],
      ['mandelbrot', { width: wide, height: s, centerX: -0.7436, centerY: 0.1318, zoom: 400, iterations: 1000, palette: 'magma', backend }, (r) => ({ backend: r.backend, insideFraction: r.insideFraction })],
      ['zoneplate', { width: s, height: s }, (r) => ({ cyclesPerPixelAtEdge: r.cyclesPerPixelAtEdge })],
      ['gradient', { width: wide, height: s, type: 'linear', angle: 20, stops: ['#0b1026', '#b5375c 0.5', '#ffe9a8'] }, () => ({ type: 'linear' })],
      ['voronoi', { width: s, height: s, seed, sites: 40 }, (r) => ({ sites: r.sites })],
      ['maze', { width: s, height: s, seed, cell: Math.max(4, Math.round(s / 24)), wall: Math.max(1, Math.round(s / 190)) }, (r) => ({ cols: r.cols, rows: r.rows, solutionCells: r.solutionCells })],
    ];
    const outputs = [], truth = {};
    for (let i = 0; i < jobs.length; i++) {
      const [name, args, pick] = jobs[i];
      const r = await M.run(`synth.${name}`, { ...args, output: p(name) });
      outputs.push(r.output); truth[r.output.path] = pick(r);
      ctx.progress((i + 1) / jobs.length, name);
    }
    return { outputs, count: outputs.length, truth, next: 'look at one with fs.preview, list tools with sys.tools, or pass any of these paths as `input` to an image/analysis tool' };
  },
});
