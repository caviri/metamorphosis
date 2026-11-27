// μεταμόρφωσις :: audio/dsp — plain typed-array DSP: FFT, windows, biquads, resampling, BS.1770 loudness,
// WSOLA time-stretch, YIN pitch, Goertzel, onset envelope. No dependencies.

export const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };
/** amplitude → dB; 0 → -Infinity */
export const adb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
/** power → dB */
export const pdb = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity);

// ───────────────────────────────────────────────────────────── fft ──
const plans = new Map();
function plan(n) {
  let p = plans.get(n);
  if (p) return p;
  if (n < 2 || (n & (n - 1))) throw new Error(`FFT size must be a power of two ≥ 2 (got ${n})`);
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r >>> 0; }
  const cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
  for (let i = 0; i < n >> 1; i++) { const a = -2 * Math.PI * i / n; cos[i] = Math.cos(a); sin[i] = Math.sin(a); }
  p = { rev, cos, sin };
  plans.set(n, p);
  return p;
}
/** In-place iterative radix-2 complex FFT. re/im: Float64Array (or Float32Array) of power-of-two length. */
export function fft(re, im, inverse = false) {
  const n = re.length;
  const { rev, cos, sin } = plan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k], wi = inverse ? -sin[k] : sin[k];
        const a = i + j, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export const WINDOWS = ['hann', 'hamming', 'blackman', 'blackmanharris', 'rect'];
/** periodic window of length n */
export function windowFn(name, n) {
  const w = new Float64Array(n);
  const c = { hann: [0.5, 0.5, 0, 0], hamming: [0.54, 0.46, 0, 0], blackman: [0.42, 0.5, 0.08, 0], blackmanharris: [0.35875, 0.48829, 0.14128, 0.01168], rect: [1, 0, 0, 0] }[name];
  if (!c) throw new Error(`unknown window "${name}" — one of ${WINDOWS.join(' | ')}`);
  for (let i = 0; i < n; i++) { const t = 2 * Math.PI * i / n; w[i] = c[0] - c[1] * Math.cos(t) + c[2] * Math.cos(2 * t) - c[3] * Math.cos(3 * t); }
  return w;
}

/** Short-time spectrum helper. power(x, center, out) fills out[0..N/2] with |X|² scaled so a full-scale sine peaks at 1.0 (0 dB). */
export class STFT {
  constructor(fftSize, window = 'hann') {
    this.n = fftSize; this.win = windowFn(window, fftSize);
    this.re = new Float64Array(fftSize); this.im = new Float64Array(fftSize);
    let s = 0, s2 = 0; for (const v of this.win) { s += v; s2 += v * v; }
    this.scale = 4 / (s * s);              // (2/Σw)²
    this.enbw = fftSize * s2 / (s * s);    // equivalent noise bandwidth in bins
    this.bins = (fftSize >> 1) + 1;
  }
  power(x, center, out) {
    const { n, win, re, im } = this; const start = Math.round(center) - (n >> 1); const len = x.length;
    for (let i = 0; i < n; i++) { const k = start + i; re[i] = k >= 0 && k < len ? x[k] * win[i] : 0; im[i] = 0; }
    fft(re, im);
    const s = this.scale;
    for (let k = 0; k < this.bins; k++) out[k] = (re[k] * re[k] + im[k] * im[k]) * s;
    return out;
  }
}

// ────────────────────────────────────────────────────────── biquad ──
export const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf', 'allpass'];
/** RBJ audio-EQ-cookbook biquad. Returns normalised {b0,b1,b2,a1,a2}. */
export function biquad(type, f0, fs, Q = Math.SQRT1_2, gainDb = 0) {
  const A = 10 ** (gainDb / 40), w0 = 2 * Math.PI * f0 / fs, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'notch': b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'allpass': b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf': { const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break; }
    case 'highshelf': { const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break; }
    default: throw new Error(`unknown filter type "${type}" — one of ${FILTER_TYPES.join(' | ')}`);
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
/** Filter x → new Float32Array (transposed direct form II, float64 state). */
export function applyBiquad(x, c, out = new Float32Array(x.length)) {
  const { b0, b1, b2, a1, a2 } = c; let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]; const y = b0 * v + z1; z1 = b1 * v - a1 * y + z2; z2 = b2 * v - a2 * y; out[i] = y; }
  return out;
}
/** |H(f)| of one biquad section (linear). */
export function biquadGain(c, f, fs) {
  const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2, di = -(c.a1 * s1 + c.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

// ──────────────────────────────────────────────────────── resample ──
function besselI0(x) { let s = 1, t = 1; const q = x * x / 4; for (let k = 1; k < 60; k++) { t *= q / (k * k); s += t; if (t < 1e-12 * s) break; } return s; }
const kernels = new Map();
const KRES = 512;
/** Kaiser-windowed sinc table: index u·KRES for u = |t|·fc in [0, zeros]. */
function kernel(zeros) {
  let k = kernels.get(zeros);
  if (k) return k;
  const beta = zeros >= 32 ? 12 : zeros >= 16 ? 9 : 6;
  const n = zeros * KRES; k = new Float64Array(n + 2); const i0 = besselI0(beta);
  for (let i = 0; i <= n; i++) {
    const u = i / KRES, r = u / zeros;
    const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0;
    k[i] = (u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * w;
  }
  k[n] = 0; k[n + 1] = 0;
  kernels.set(zeros, k);
  return k;
}
/**
 * Band-limited resampling by windowed-sinc interpolation (arbitrary ratio).
 * ratio = output rate / input rate. zeros: sinc zero crossings per side (8 fast, 16 good, 32 best).
 */
export function resample(x, ratio, zeros = 16, outLen = Math.max(1, Math.round(x.length * ratio))) {
  if (ratio === 1 && outLen === x.length) return Float32Array.from(x);
  const tab = kernel(zeros);
  const fc = Math.min(1, ratio) * (zeros >= 32 ? 0.98 : zeros >= 16 ? 0.96 : 0.92);
  const hw = zeros / fc, n = x.length, out = new Float32Array(outLen), fk = fc * KRES;
  for (let i = 0; i < outLen; i++) {
    const tc = i / ratio;
    let k0 = Math.ceil(tc - hw), k1 = Math.floor(tc + hw);
    if (k0 < 0) k0 = 0; if (k1 > n - 1) k1 = n - 1;
    let acc = 0, ws = 0;
    for (let k = k0; k <= k1; k++) {
      const u = Math.abs(tc - k) * fk; const ui = u | 0; const fr = u - ui;
      const w = tab[ui] + (tab[ui + 1] - tab[ui]) * fr;
      acc += x[k] * w; ws += w;
    }
    out[i] = ws !== 0 ? acc / ws : 0;
  }
  return out;
}

/**
 * True-peak estimate: 4× sinc oversampling, evaluated only between samples that lie within 6 dB of the sample peak
 * (inter-sample overshoot of quieter regions cannot exceed the result in practice). Returns linear peak ≥ sample peak.
 */
let tpFir = null;
export function truePeak(x, samplePeak) {
  if (!(samplePeak > 0)) return 0;
  const Z = 12;
  if (!tpFir) { // three fractional phases (¼, ½, ¾), 24 taps each, Kaiser-windowed sinc, unity DC gain
    const beta = 8, i0 = besselI0(beta); tpFir = [];
    for (let p = 1; p < 4; p++) {
      const h = new Float64Array(2 * Z); let sum = 0;
      for (let j = 0; j < 2 * Z; j++) { const t = (j - Z + 1) - p / 4, r = t / Z; h[j] = Math.sin(Math.PI * t) / (Math.PI * t) * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0; sum += h[j]; }
      for (let j = 0; j < 2 * Z; j++) h[j] /= sum;
      tpFir.push(h);
    }
  }
  const n = x.length, thr = samplePeak * 0.5;
  let best = samplePeak;
  for (let i = 0; i < n - 1; i++) {
    const a = x[i] < 0 ? -x[i] : x[i], b = x[i + 1] < 0 ? -x[i + 1] : x[i + 1];
    if (a < thr && b < thr) continue;
    for (let p = 0; p < 3; p++) {
      const h = tpFir[p]; let acc = 0;
      for (let j = 0; j < 2 * Z; j++) { const k = i - Z + 1 + j; if (k >= 0 && k < n) acc += x[k] * h[j]; }
      if (acc < 0) acc = -acc;
      if (acc > best) best = acc;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────── loudness ──
/** ITU-R BS.1770-4 K-weighting coefficients for any sample rate (analog prototype re-derived, as libebur128 does). */
export function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs); const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs); a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}
/** BS.1770 channel weights by channel count (5.1 = L R C LFE Ls Rs). */
export function channelWeights(n) {
  if (n === 6) return [1, 1, 1, 0, 1.41, 1.41];
  if (n === 5) return [1, 1, 1, 1.41, 1.41];
  return new Array(n).fill(1);
}
/**
 * Integrated loudness per ITU-R BS.1770-4 (K-weighting, 400 ms blocks, 75 % overlap, −70 LUFS absolute gate,
 * −10 LU relative gate), plus max momentary (400 ms), max short-term (3 s) and loudness range (EBU Tech 3342).
 * Returns nulls when the signal is shorter than one 400 ms block.
 */
export function loudness(chs, fs) {
  const n = chs[0].length, step = Math.round(fs / 10), segs = Math.floor(n / step);
  const weights = channelWeights(chs.length);
  const seg = new Float64Array(Math.max(0, segs)); // channel-weighted K-weighted energy per 100 ms
  const [s1, s2] = kWeighting(fs);
  for (let c = 0; c < chs.length; c++) {
    const g = weights[c]; if (!g) continue;
    const x = chs[c]; let z1 = 0, z2 = 0, y1 = 0, y2 = 0;
    for (let s = 0, i = 0; s < segs; s++) {
      let e = 0;
      for (let j = 0; j < step; j++, i++) {
        const v = x[i];
        const a = s1.b0 * v + z1; z1 = s1.b1 * v - s1.a1 * a + z2; z2 = s1.b2 * v - s1.a2 * a;
        const b = s2.b0 * a + y1; y1 = s2.b1 * a - s2.a1 * b + y2; y2 = s2.b2 * a - s2.a2 * b;
        e += b * b;
      }
      seg[s] += g * e / step;
    }
  }
  const lk = (p) => -0.691 + 10 * Math.log10(p);
  const blocks = (len) => { const out = []; let acc = 0; for (let i = 0; i < segs; i++) { acc += seg[i]; if (i >= len) acc -= seg[i - len]; if (i >= len - 1) out.push(Math.max(acc, 0) / len); } return out; };
  const res = { integrated: null, momentaryMax: null, shortTermMax: null, range: null, blocks: 0, gatedBlocks: 0 };
  const mom = blocks(4);
  if (!mom.length) return res;
  res.blocks = mom.length;
  const mMax = mom.reduce((a, b) => (b > a ? b : a), 0);
  res.momentaryMax = mMax > 0 ? lk(mMax) : null;
  const absGate = 10 ** ((-70 + 0.691) / 10);
  const a1 = mom.filter((p) => p > absGate);
  if (a1.length) {
    const rel = a1.reduce((a, b) => a + b, 0) / a1.length * 0.1; // −10 LU
    const a2 = a1.filter((p) => p > rel);
    res.gatedBlocks = a2.length;
    if (a2.length) res.integrated = lk(a2.reduce((a, b) => a + b, 0) / a2.length);
  }
  const st = blocks(30);
  if (st.length) {
    const sMax = st.reduce((a, b) => (b > a ? b : a), 0);
    res.shortTermMax = sMax > 0 ? lk(sMax) : null;
    const b1 = st.filter((p) => p > absGate);
    if (b1.length) {
      const rel = b1.reduce((a, b) => a + b, 0) / b1.length * 0.01; // −20 LU
      const b2 = b1.filter((p) => p > rel).map(lk).sort((a, b) => a - b);
      if (b2.length) { const q = (f) => b2[Math.min(b2.length - 1, Math.max(0, Math.round(f * (b2.length - 1))))]; res.range = q(0.95) - q(0.10); }
    }
  }
  return res;
}

// ─────────────────────────────────────────────────────────── wsola ──
/**
 * Pitch-preserving time-stretch (WSOLA: waveform-similarity overlap-add). speed > 1 = shorter/faster.
 * 40 ms Hann frames, 50 % overlap, ±10 ms similarity search (coarse on a decimated mono mix, refined at full rate).
 */
export function wsola(chs, fs, speed, onProgress) {
  const n = chs[0].length, nch = chs.length;
  const N = 2 * Math.max(16, Math.round(fs * 0.02)), Hs = N >> 1, tol = Math.max(4, Math.round(fs * 0.01));
  const outLen = Math.max(1, Math.round(n / speed));
  const mono = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) mono[i] += c[i];
  const D = Math.max(1, Math.round(fs / 11025)), nd = Math.floor(n / D), md = new Float32Array(nd);
  for (let i = 0; i < nd; i++) { let s = 0; for (let j = 0; j < D; j++) s += mono[i * D + j]; md[i] = s / D; }
  const Nd = Math.floor(N / D), told = Math.ceil(tol / D);
  const win = windowFn('hann', N);
  const out = chs.map(() => new Float32Array(outLen + N)), wsum = new Float32Array(outLen + N);
  const corr = (buf, a, b, len) => { // normalised cross-correlation of buf[a..a+len) with buf[b..b+len)
    if (b < 0 || a < 0 || a + len > buf.length || b + len > buf.length) return -Infinity;
    let c = 0, e = 0; for (let j = 0; j < len; j++) { const v = buf[b + j]; c += buf[a + j] * v; e += v * v; }
    return c / Math.sqrt(e + 1e-12);
  };
  let prev = 0; const maxPos = Math.max(0, n - N);
  const frames = Math.ceil(outLen / Hs) + 1;
  for (let k = 0; k < frames; k++) {
    let pos = Math.round(k * Hs * speed);
    if (k > 0) {
      const nat = prev + Hs; // where the previous frame would naturally continue
      if (nat + N <= n && pos <= maxPos + tol) {
        const natd = Math.floor(nat / D), pd = Math.floor(pos / D);
        let best = -Infinity, bd = 0;
        for (let d = -told; d <= told; d++) { const c = corr(md, natd, pd + d, Nd); if (c > best) { best = c; bd = d; } }
        let fine = pos + bd * D; best = -Infinity; let bf = fine;
        if (D > 1) { for (let d = -D; d <= D; d++) { const c = corr(mono, nat, fine + d, N); if (c > best) { best = c; bf = fine + d; } } fine = bf; }
        if (best > -Infinity || D === 1) pos = fine;
      }
    }
    if (pos < 0) pos = 0;
    prev = pos;
    const o = k * Hs;
    for (let c = 0; c < nch; c++) {
      const x = chs[c], y = out[c];
      for (let j = 0; j < N; j++) { const s = pos + j; if (s < n) y[o + j] += x[s] * win[j]; }
    }
    for (let j = 0; j < N; j++) if (pos + j < n) wsum[o + j] += win[j];
    if (onProgress && (k & 255) === 0) onProgress(k / frames);
  }
  return out.map((y) => { const r = new Float32Array(outLen); for (let i = 0; i < outLen; i++) r[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : y[i]; return r; });
}

// ───────────────────────────────────────────────────────────── yin ──
/**
 * YIN fundamental-frequency tracker (de Cheveigné & Kawahara 2002) with an FFT-computed difference function,
 * cumulative-mean normalisation, absolute threshold and parabolic interpolation.
 * Returns {times: Float64Array, f0: Float32Array (0 = unvoiced), clarity: Float32Array (1 − d′ at the pick)}.
 */
export function yin(x, fs, { fmin = 60, fmax = 1200, hop = Math.round(fs * 0.01), threshold = 0.15, silenceDb = -60 } = {}) {
  const tauMax = Math.min(Math.floor(fs / fmin), Math.floor(x.length / 2)), tauMin = Math.max(2, Math.floor(fs / fmax));
  const W = Math.max(2 * tauMax, Math.round(fs * 0.02));
  const M = nextPow2(2 * W + tauMax + 1);
  const frames = Math.max(0, Math.floor((x.length - (W + tauMax)) / hop) + 1);
  const times = new Float64Array(frames), f0 = new Float32Array(frames), clarity = new Float32Array(frames);
  if (tauMax <= tauMin + 1) return { times, f0, clarity, window: W + tauMax };
  const ar = new Float64Array(M), ai = new Float64Array(M), br = new Float64Array(M), bi = new Float64Array(M);
  const d = new Float64Array(tauMax + 1), sq = new Float64Array(W + tauMax + 1);
  const silence = 10 ** (silenceDb / 20);
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    times[f] = (s + (W + tauMax) / 2) / fs;
    ar.fill(0); ai.fill(0); br.fill(0); bi.fill(0);
    let mean = 0; for (let j = 0; j < W + tauMax; j++) mean += x[s + j]; mean /= (W + tauMax);
    sq[0] = 0;
    for (let j = 0; j < W + tauMax; j++) { const v = x[s + j] - mean; br[j] = v; if (j < W) ar[j] = v; sq[j + 1] = sq[j] + v * v; }
    if (Math.sqrt(sq[W] / W) < silence) continue;
    fft(ar, ai); fft(br, bi);
    for (let k = 0; k < M; k++) { const r = ar[k] * br[k] + ai[k] * bi[k], i = ar[k] * bi[k] - ai[k] * br[k]; ar[k] = r; ai[k] = i; } // conj(A)·B
    fft(ar, ai, true);
    // d(τ) = Σ_{j<W} (x_j − x_{j+τ})² = E(0) + E(τ) − 2·c(τ)
    let run = 0; d[0] = 1;
    let pick = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      const v = Math.max(0, sq[W] + (sq[tau + W] - sq[tau]) - 2 * ar[tau]);
      run += v; d[tau] = run > 0 ? v * tau / run : 1;
    }
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (d[tau] < threshold) { while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++; pick = tau; break; }
    }
    if (pick < 0) continue;
    let tau = pick;
    if (pick > 1 && pick < tauMax) { const a = d[pick - 1], b = d[pick], c = d[pick + 1], den = a - 2 * b + c; if (den > 0) tau = pick + 0.5 * (a - c) / den; }
    f0[f] = fs / tau; clarity[f] = 1 - d[pick];
  }
  return { times, f0, clarity, window: W + tauMax };
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Hz → {note:'A4', midi:69, cents:+3.1} */
export function noteOf(hz, a4 = 440) {
  if (!(hz > 0)) return null;
  const m = 69 + 12 * Math.log2(hz / a4), mi = Math.round(m);
  return { note: NOTE_NAMES[((mi % 12) + 12) % 12] + (Math.floor(mi / 12) - 1), midi: mi, cents: Math.round((m - mi) * 1000) / 10 };
}
/** 'A4' | 'C#3' | 'Db5' | '69' (MIDI) | '440' handled by the caller → Hz, or null */
export function noteToHz(name, a4 = 440) {
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + base + acc;
  return a4 * 2 ** ((midi - 69) / 12);
}

// ──────────────────────────────────────────────────────── goertzel ──
/** Power of frequency f in x[start..start+n) (Hamming-windowed Goertzel), scaled so a full-scale sine → 1.0. */
export function goertzel(x, start, n, f, fs, win) {
  const w = 2 * Math.PI * f / fs, coeff = 2 * Math.cos(w); let s1 = 0, s2 = 0, ws = 0;
  for (let i = 0; i < n; i++) { const wi = win ? win[i] : 1; const s0 = (x[start + i] || 0) * wi + coeff * s1 - s2; s2 = s1; s1 = s0; ws += wi; }
  const p = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return 4 * p / (ws * ws);
}

// ─────────────────────────────────────────────────────────── onset ──
/** Spectral-flux onset envelope (log-compressed magnitude, half-wave rectified). Returns {env, rate (Hz), fftSize, hop}. */
export function onsetEnvelope(x, fs, rate = 200) {
  const hop = Math.max(1, Math.round(fs / rate)), N = nextPow2(Math.max(256, Math.round(fs * 0.023)));
  const st = new STFT(N, 'hann'), frames = Math.max(1, Math.floor(x.length / hop));
  const env = new Float32Array(frames), cur = new Float32Array(st.bins); let prev = new Float32Array(st.bins), mag = new Float32Array(st.bins);
  for (let f = 0; f < frames; f++) {
    st.power(x, f * hop, cur);
    let flux = 0;
    for (let k = 1; k < st.bins; k++) { const m = Math.log1p(1000 * Math.sqrt(cur[k])); const dlt = m - prev[k]; if (dlt > 0) flux += dlt; mag[k] = m; }
    env[f] = f === 0 ? 0 : flux / st.bins;
    const t = prev; prev = mag; mag = t;
  }
  return { env, rate: fs / hop, fftSize: N, hop };
}

/** deterministic PRNG (mulberry32) → () => [0,1) */
export function prng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
